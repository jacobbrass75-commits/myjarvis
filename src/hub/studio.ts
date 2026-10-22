import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MiniAppInfo } from "../shared/miniapp.js";
import { type StudioAppInfo, type StudioBuild, type StudioJob, type StudioModel, type StudioModelOption, clip } from "../shared/protocol.js";
import { codexBin } from "../node/codex.js";
import { type StudioModels, claudeCodeEnv, codexArgs, codexEnv, engineName, modelId, provider, studioModels, studioEffort } from "./studio-models.js";

// Studio: describe an app ("a snake game", "a flashcard quiz on Spanish verbs") and Claude Code
// writes it as a mini-app (see src/shared/miniapp.ts). Each build is checked by actually running
// the app in a separate process; failures go back to Claude to fix. Published apps appear on the
// glasses right away. Changing an app resumes the same Claude session, so it knows the code.
// Claude edits miniapps/<id>/app.js; the glasses are served the copy that passed the check
// (versions/v<N>.js), so a build in progress or a failed change never reaches them.
// Each build picks a model (studio-models.ts): Claude Haiku / Sonnet / Opus, DeepSeek through the same
// Claude Code agent, or the Codex CLI. Every engine gets the same folder confinement, check and retries.

const ROOT = resolve(import.meta.dirname, "../..");
export const MINIAPPS_DIR = process.env.G2_MINIAPPS_DIR || join(ROOT, "miniapps");
mkdirSync(MINIAPPS_DIR, { recursive: true });
/** One Claude run (write or fix) is abandoned after this long, so a stuck build can't block the queue. */
const ATTEMPT_TIMEOUT = (Number(process.env.STUDIO_TIMEOUT_S) > 0 ? Number(process.env.STUDIO_TIMEOUT_S) : 300) * 1000;
const SAFE_ID = /^[a-z0-9-]+$/;
// The test run executes code nobody has reviewed: under Node's permission model it can read only its
// own file (no other files such as .env, no child processes, workers or native addons). Its env is
// just PATH, so the network (still open) has nothing secret to carry.
const SANDBOX = ["--permission", "--experimental-permission"].find((f) => process.allowedNodeEnvironmentFlags.has(f));
if (!SANDBOX) console.warn("studio: this Node has no permission model, so app test runs are not sandboxed");

interface Meta extends MiniAppInfo {
  prompts: string[];
  sessionId?: string;
  /** Who sessionId belongs to (absent: Claude, from before models): only that provider can resume it. */
  sessionProvider?: string;
  /** One entry per published version: model, time taken, tries. */
  builds?: StudioBuild[];
  /** Automatic crash fixes already attempted, by version. */
  autoFixed?: number[];
  /** The last change never passed the check, so app.js was put back to the published version. */
  reverted?: boolean;
}

type Checked = { ok: boolean; title?: string; kind?: "text" | "pixels"; error?: string };

const CONTRACT = readFileSync(join(ROOT, "src/shared/miniapp.ts"), "utf8");

const EXAMPLE = `// Example "pixels" app: a dot you move with swipes; tap to change brightness.
let y = 36, x = 0, level = 15, api;
export default {
  title: "Dot",
  kind: "pixels",
  init(a) { api = a; },
  tick(dt) { x = (x + dt * 20) % 144; },          // ~20 px/s: fine at 6-8 fps
  header() { return "Dot · swipe up/down"; },
  draw(px) {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++)
      if (dx * dx + dy * dy <= 9) px[(Math.round(y) + dy) * 144 + ((Math.round(x) + dx + 144) % 144)] = level;
  },
  input(g) {
    if (g === "up") { y = Math.max(4, y - 6); return true; }
    if (g === "down") { y = Math.min(67, y + 6); return true; }
    if (g === "tap") { level = level === 15 ? 6 : 15; return true; }
    return false; // double tap falls through and exits
  },
};`;

const SYSTEM = `You build mini-apps for Even G2 smart glasses. A mini-app is ONE JavaScript ES module,
app.js, in the current folder, whose default export follows this contract exactly:

<contract file="miniapp.ts">
${CONTRACT}
</contract>

<example>
${EXAMPLE}
</example>

How to work:
- Write or edit app.js in the current folder (only that file). Plain modern JavaScript, no TypeScript
  syntax, no imports, no DOM, no timers of your own.
- Design for the hardware: a tiny monochrome display, ~46 x 6 characters of text or a 144x72
  picture, 6-8 picture updates per second on real glasses, and input that is only tap, double
  tap, swipe up/down and long press (from a ring on your finger). Keep it simple, readable at a
  glance, and fun. Games: big shapes, slow or turn-based, clear score in header().
- Use double tap only if the app really needs it (otherwise it exits). Save high scores with api.store.
- Use api.ask(...) when an app benefits from AI (trivia, riddles, stories, quizzes, coaching).
- api.ask and api.fetchJson can fail: always handle a rejected promise and show something useful.
- When done, reply with one short sentence saying what you built (the wearer reads it on glasses).
  The hub test-runs app.js after you finish and sends you any error, so don't mention testing.`;

/** Run app.js for a moment in a separate Node process, like the glasses would. */
export function check(file: string): Promise<Checked> {
  const harness = `
const out = { ok: false };
// The result line carries a nonce the app can't see, so an app printing its own "ok" can't pass.
const nonce = process.env.CHECK_NONCE, write = process.stdout.write.bind(process.stdout), stringify = JSON.stringify, exit = process.exit.bind(process);
delete process.env.CHECK_NONCE;
// A throw in a callback (say, once api.ask resolves) skips the try below and would kill the process.
let late;
process.on("unhandledRejection", (e) => (late ??= e ?? new Error("a promise was rejected")));
process.on("uncaughtException", (e) => (late ??= e));
try {
  const app = (await import(process.env.APP_URL)).default;
  if (!app || typeof app !== "object") throw new Error("app.js must 'export default' an object");
  if (typeof app.title !== "string" || !app.title.trim()) throw new Error("title must be a non-empty string");
  const kind = app.kind ?? "text";
  if (kind !== "text" && kind !== "pixels") throw new Error('kind must be "text" or "pixels"');
  if (kind === "pixels" && typeof app.draw !== "function") throw new Error("pixels apps need draw(px)");
  if (kind === "text" && typeof app.screen !== "function") throw new Error("text apps need screen()");
  const store = new Map();
  const api = { W: 144, H: 72, store: { get: (k) => store.get(k), set: (k, v) => store.set(k, String(v)) },
    ask: async () => "Test answer from Claude.", fetchJson: async () => ({}), toast() {}, refresh() {}, exit() {} };
  app.init?.(api);
  const px = new Uint8Array(144 * 72);
  const gestures = ["tap", "up", "down", "tap", "hold", "release", "down", "up"];
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    app.tick?.(1 / 30);
    if (i % 8 === 0) app.input?.(gestures[(i / 8) % gestures.length], 0);
    if (kind === "pixels") {
      px.fill(0);
      app.draw(px);
      for (let j = 0; j < px.length; j++) if (px[j] > 15) throw new Error("draw() wrote " + px[j] + " at index " + j + " (max 15)");
      const h = app.header?.();
      if (h !== undefined && typeof h !== "string") throw new Error("header() must return a string");
    } else {
      const s = app.screen();
      if (!s || typeof s.header !== "string") throw new Error("screen() must return { header: string, body?: string, list?: string[] }");
      if (s.list !== undefined && !Array.isArray(s.list)) throw new Error("screen().list must be an array of strings");
    }
  }
  const ms = Date.now() - t0;
  if (ms > 3000) throw new Error("too slow: 120 frames took " + ms + " ms (must be well under 33 ms per frame)");
  await new Promise((r) => setTimeout(r, 50)); // let api.ask promises settle
  app.exit?.();
  if (late) throw late;
  Object.assign(out, { ok: true, title: app.title.trim(), kind });
} catch (e) {
  out.error = (e === late ? "In a callback (e.g. after api.ask/fetchJson resolved): " : "") + String((e && e.stack) || e).split("\\n").slice(0, 6).join("\\n").slice(0, 1500);
}
write("\\n" + nonce + stringify(out) + "\\n");
exit(0);
`;
  const url = pathToFileURL(file).href + `?t=${Date.now()}`;
  const nonce = `@check-${Math.random().toString(36).slice(2)}@`;
  return new Promise((done) => {
    execFile(
      process.execPath,
      [...(SANDBOX ? [SANDBOX, `--allow-fs-read=${file}`] : []), "--input-type=module", "-e", harness],
      { env: { PATH: process.env.PATH, APP_URL: url, CHECK_NONCE: nonce }, timeout: 8000 },
      (err, stdout, stderr) => {
        let r: Checked;
        try {
          r = JSON.parse(stdout.split("\n").find((l) => l.startsWith(nonce))?.slice(nonce.length) ?? "");
        } catch {
          // (err.message would be the whole command line, i.e. this harness; stderr has the actual error.)
          r = { ok: false, error: err?.killed ? "the app hung (infinite loop?) — it must return quickly from every call" : (stderr.trim().split("\n").slice(-8).join("\n") || (err ? "the check crashed" : "the app ended the test run itself (it must never exit the process)")).slice(0, 1500) };
        }
        if (r.error) r.error = r.error.replaceAll(url, "app.js").replace(/file:\/\/\S*\[eval1\]/g, "harness");
        if (!r.ok && r.error?.startsWith("SyntaxError")) void syntaxError(file).then((where) => done({ ...r, error: where || r.error }));
        else done(r);
      },
    );
  });
}

/** import() reports a syntax error without its line; `node --check` shows the line and a caret. */
function syntaxError(file: string): Promise<string> {
  return new Promise((done) => {
    // On stdin as a module: given the path, a folder outside a "type": "module" package would be
    // checked as CommonJS, which reports nothing for an ES module.
    const child = execFile(process.execPath, ["--input-type=module", "--check"], { env: { PATH: process.env.PATH }, timeout: 8000 }, (_err, _stdout, stderr) =>
      done(
        stderr
          .split("\n")
          .filter((l) => !/^\s+at |^Node\.js v/.test(l))
          .map((l) => l.replaceAll("[stdin]", "app.js").slice(0, 300))
          .join("\n")
          .trim()
          .slice(0, 1500),
      ),
    );
    try {
      child.stdin?.end(readFileSync(file));
    } catch {
      child.kill();
    }
  });
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/^(please\s+)?((make|build|create|write|code|give)(\s+me)?\s+)?((a|an|the|my)\s+)?/, "")
    .split(/[,.:;!?()]/)[0] // "A reaction-time game: wait for GO…" → "reaction-time game"
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .join("-") || "app";

/** What one model run (write or fix) left behind. */
type Run = { sessionId?: string; summary: string; problem?: string };
type Progress = (log: string) => void;

export interface StudioDeps {
  /** The Agent SDK's query (tests pass a fake). */
  query?: typeof query;
  models?: StudioModels;
  codexBin?: () => string | null;
}

export class Studio {
  private queue: { id: string; run: () => Promise<void> }[] = [];
  private busy = false;
  /** The run in progress, so deleting its app can stop it. */
  private building: { id: string; abort: AbortController } | null = null;
  private query: typeof query;
  private codexBin: () => string | null;
  readonly models: StudioModels;

  constructor(
    private emitJob: (job: StudioJob) => void,
    private emitList: (apps: MiniAppInfo[]) => void,
    deps: StudioDeps = {},
  ) {
    this.query = deps.query ?? query;
    this.codexBin = deps.codexBin ?? codexBin;
    this.models = deps.models ?? studioModels(process.env, this.codexBin);
    // A new app whose first build was cut short by a restart never worked: leave nothing behind.
    for (const d of readdirSync(MINIAPPS_DIR, { withFileTypes: true }))
      if (d.isDirectory() && this.meta(d.name)?.version === 0) rmSync(join(MINIAPPS_DIR, d.name), { recursive: true, force: true });
  }

  list(): StudioAppInfo[] {
    return readdirSync(MINIAPPS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(MINIAPPS_DIR, d.name, "meta.json")))
      .map((d) => this.meta(d.name))
      .filter((m): m is Meta => !!m && m.version > 0)
      .map((m) => ({ id: m.id, title: m.title, kind: m.kind, version: m.version, description: m.description, updatedAt: m.updatedAt, ...(m.builds?.length ? { builds: m.builds } : {}) }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The models a client can pick from, and the one used when none is asked for. */
  modelOptions(): { models: StudioModelOption[]; default: StudioModel } {
    return { models: this.models.options(), default: this.models.default };
  }

  /** Find an app by id or (fuzzy) title: "the reaction game" finds "Reaction". */
  find(ref: string): MiniAppInfo | undefined {
    const r = ref.toLowerCase().trim();
    if (!r) return undefined;
    const all = this.list();
    const s = slug(r);
    // Whole words only, and nothing too short: "a" or "the app" mustn't match whatever comes first.
    const has = (text: string, part: string) => part.length > 2 && new RegExp(`(^|[^a-z0-9])${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(text);
    return (
      all.find((a) => a.id === r) ??
      all.find((a) => a.title.toLowerCase() === r) ??
      all.find((a) => {
        const t = a.title.toLowerCase();
        return has(t, r) || has(r, t) || (s !== "app" && has(a.id, s));
      })
    );
  }

  file(id: string) {
    return join(MINIAPPS_DIR, id, "app.js");
  }

  /**
   * The code to serve: the given (or latest) version that passed the check, or null while none has
   * (a first build in progress writes app.js too). app.js only for an app from before versions/.
   */
  published(id: string, version?: number): string | null {
    const m = this.meta(id);
    if (!m || !(m.version > 0)) return null;
    const v = version && Number.isInteger(version) && version > 0 && version <= m.version ? version : m.version;
    const kept = join(MINIAPPS_DIR, id, "versions", `v${v}.js`);
    return existsSync(kept) ? kept : this.file(id);
  }

  private meta(id: string): Meta | null {
    if (!SAFE_ID.test(String(id))) return null; // ids arrive from clients: one folder under miniapps/, never a path
    try {
      return JSON.parse(readFileSync(join(MINIAPPS_DIR, id, "meta.json"), "utf8"));
    } catch {
      return null;
    }
  }

  private saveMeta(m: Meta) {
    writeFileSync(join(MINIAPPS_DIR, m.id, "meta.json"), JSON.stringify(m, null, 2));
  }

  /**
   * Build a new app, or change an existing one, with the model asked for ("fast", "opus"…; default
   * STUDIO_MODEL, else balanced). Returns the app id and model once queued, or why it can't be.
   */
  make(prompt: string, id?: string, model?: unknown): { id: string; model: StudioModel } | { error: string } {
    prompt = String(prompt ?? "").trim();
    if (!prompt) return { error: "Describe the app first." };
    const chosen = this.models.choose(model);
    if ("error" in chosen) return chosen;
    let m = id ? this.meta(id) : null;
    if (!m) {
      let base = slug(prompt);
      let n = 1;
      while (existsSync(join(MINIAPPS_DIR, n === 1 ? base : `${base}-${n}`))) n++;
      id = n === 1 ? base : `${base}-${n}`;
      mkdirSync(join(MINIAPPS_DIR, id, "versions"), { recursive: true });
      m = { id, title: prompt.slice(0, 40), kind: "text", version: 0, description: prompt, updatedAt: Date.now(), prompts: [] };
      this.saveMeta(m);
    }
    const appId = m.id;
    // Builds run one at a time; say so rather than leaving the request silent.
    if (this.building || this.queue.length) this.emitJob({ id: appId, title: m.title, status: "working", log: "Waiting for another build to finish…", version: m.version, prompt, model: chosen.model, at: Date.now() });
    this.enqueue(appId, () => this.build(appId, prompt, chosen.model));
    return { id: appId, model: chosen.model };
  }

  /** A running app crashed on the glasses: one automatic fix attempt per version. */
  crashed(id: string, version: number, error: string) {
    const m = this.meta(id);
    if (!m || m.version !== version || m.autoFixed?.includes(version)) return;
    m.autoFixed = [...(m.autoFixed ?? []), version];
    this.saveMeta(m);
    error = String(error).slice(0, 2000).replace(/([?&])token=[^&\s:)]*/g, "$1token=…"); // stack URLs carry the hub token
    const token = process.env.HUB_TOKEN;
    if (token && token.length >= 8) error = error.replaceAll(token, "…").replaceAll(encodeURIComponent(token), "…"); // anywhere else
    this.enqueue(id, async () => {
      // A change may have replaced the crashing version while this waited.
      // Fixed by whoever built the crashing version, if it's still usable here.
      const by = this.meta(id)?.builds?.filter((b) => b.version === version).pop()?.model;
      if (this.meta(id)?.version === version)
        await this.build(id, `It crashed on the glasses with this error. Fix the cause (keep everything else the same):\n${error}`, by && this.models.available(by) ? by : this.models.default, true);
    });
  }

  delete(id: string) {
    if (!SAFE_ID.test(String(id))) return;
    this.queue = this.queue.filter((j) => j.id !== id);
    if (this.building?.id === id) this.building.abort.abort();
    rmSync(join(MINIAPPS_DIR, id), { recursive: true, force: true });
    this.emitList(this.list());
  }

  private enqueue(id: string, run: () => Promise<void>) {
    this.queue.push({ id, run });
    void this.pump();
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) await this.queue.shift()!.run().catch((e) => console.warn(`studio: ${e?.message ?? e}`));
    this.busy = false;
  }

  private async build(id: string, prompt: string, model: StudioModel, isFix = false) {
    const m = this.meta(id);
    if (!m) return; // deleted while it waited
    const t0 = Date.now();
    const gone = () => !existsSync(join(MINIAPPS_DIR, id, "meta.json"));
    const job = (status: StudioJob["status"], log: string, ms?: number) =>
      gone() || this.emitJob({ id, title: m.title, status, log: log.slice(0, 200), version: m.version, prompt: isFix ? undefined : prompt, model, ...(ms !== undefined ? { ms } : {}), at: Date.now() });
    const busy = isFix ? "fixing" : "working";
    job(busy, isFix ? "Fixing a crash…" : m.version ? `Changing ${m.title}…` : "Writing the app…");

    const ask = m.version || existsSync(this.file(id)) ? `Change the app in app.js: ${prompt}` : `Build this app: ${prompt}`;
    // Another provider's session can't be resumed: start a fresh one that reads the code first.
    if (m.sessionId && (m.sessionProvider ?? "claude") !== provider(model)) delete m.sessionId;
    let request = m.reverted ? `(Your last change never passed the test run, so app.js was put back to the last working version. Read it again before editing.)\n${ask}` : ask;
    if (!m.sessionId && existsSync(this.file(id)) && !m.reverted) request = `(app.js already has the current version: read it before changing it.)\n${request}`;
    let problem = "";
    const dir = join(MINIAPPS_DIR, id);
    const engine = engineName(model);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (gone()) break; // deleted between attempts (say, during the test run)
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), ATTEMPT_TIMEOUT);
      this.building = { id, abort };
      try {
        const run = model === "codex"
          ? await this.runCodex(dir, request, m.sessionId, abort, (log) => job(busy, log))
          : await this.runClaude(model, dir, request, m.sessionId, abort, (log) => job(busy, log));
        if (run.sessionId) {
          m.sessionId = run.sessionId;
          m.sessionProvider = provider(model);
        }
        if (run.problem) problem = run.problem;
        this.saveMeta(m);
        if (!existsSync(this.file(id))) {
          problem ||= "no app.js was written";
          request = `${ask}\n(You didn't write app.js last time. Write the complete app to app.js in the current folder.)`;
          continue;
        }
        job("checking", "Test-running it…");
        const r = await check(this.file(id));
        if (!r.ok) {
          const lines = (r.error ?? "").split("\n");
          problem = lines.find((l) => /Error\b|hung|slow|must|need/.test(l)) ?? lines[0];
          job("fixing", `Check failed: ${problem}`);
          request = `The app failed when run like the glasses would run it:\n${r.error}\nFix app.js.`;
          continue;
        }
        m.version += 1;
        m.title = r.title!;
        m.kind = r.kind!;
        m.updatedAt = Date.now();
        delete m.reverted;
        if (!isFix) {
          m.prompts.push(prompt);
          if (m.version === 1) m.description = prompt;
        }
        const ms = Date.now() - t0;
        const id_ = modelId(this.models, model);
        (m.builds ??= []).push({ version: m.version, model, ...(id_ ? { modelId: id_ } : {}), ms, tries: attempt + 1, ...(isFix ? { fix: true } : {}), at: m.updatedAt });
        copyFileSync(this.file(id), join(MINIAPPS_DIR, id, "versions", `v${m.version}.js`));
        this.saveMeta(m);
        this.emitList(this.list());
        job("ready", run.summary.trim().split("\n")[0] || `${m.title} is ready`, ms);
        return;
      } catch (e: any) {
        if (gone()) break;
        const limit = ATTEMPT_TIMEOUT >= 60_000 ? `${Math.round(ATTEMPT_TIMEOUT / 60_000)} min` : `${Math.round(ATTEMPT_TIMEOUT / 1000)} s`;
        problem = abort.signal.aborted ? `${engine} took over ${limit}` : String(e?.message ?? e).split("\n")[0];
        job(busy, `Retrying: ${problem}`);
        // Start over in a fresh session: the old one may be what failed (say, it can't be resumed).
        delete m.sessionId;
        request = `${ask}\n(An earlier attempt failed: ${problem}. If app.js exists, read it first and make sure it is complete and correct.)`;
      } finally {
        clearTimeout(timer);
        this.building = null;
      }
    }
    if (gone()) {
      // Deleted mid-build (the model may have recreated the folder while writing).
      rmSync(join(MINIAPPS_DIR, id), { recursive: true, force: true });
      return;
    }
    job("failed", `Couldn't get it working after 3 tries${problem ? ` (${clip(problem, 110)})` : ""}. Try again, or describe it differently.`);
    if (m.version === 0) {
      // A brand-new app that never worked leaves nothing behind.
      rmSync(join(MINIAPPS_DIR, id), { recursive: true, force: true });
    } else {
      // Start the next change from the working version, not the broken attempt.
      const good = join(MINIAPPS_DIR, id, "versions", `v${m.version}.js`);
      if (existsSync(good)) {
        copyFileSync(good, this.file(id));
        m.reverted = true;
        this.saveMeta(m);
      }
    }
  }

  /** One Claude Code run in the app folder: Claude (any tier) on the hub's login, or DeepSeek's or OpenRouter's API. */
  private async runClaude(model: StudioModel, dir: string, request: string, sessionId: string | undefined, abort: AbortController, progress: Progress): Promise<Run> {
    const inside = (p: string) => {
      const r = relative(dir, resolve(dir, p));
      return !r.startsWith("..") && !isAbsolute(r);
    };
    const q = this.query({
      prompt: request,
      options: {
        cwd: dir,
        systemPrompt: SYSTEM,
        // Web search/fetch so it can look up APIs, docs and data sources for the app; files stay
        // confined to the app folder (canUseTool below), and the app itself runs sandboxed.
        tools: ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
        // This app's folder only. acceptEdits lets Claude read and edit inside it; anything that
        // still asks goes to canUseTool, which refuses paths outside it (e.g. the hub's .env).
        // (Listing the tools in allowedTools would allow them on any path.)
        permissionMode: "acceptEdits",
        canUseTool: async (tool, input) => {
          const paths = [input.file_path, input.path, input.notebook_path].filter((p): p is string => typeof p === "string");
          const globs = [tool === "Glob" ? input.pattern : undefined, input.glob].filter((g): g is string => typeof g === "string");
          return paths.every(inside) && globs.every((g) => !/^[\\/~]|(^|[\\/])\.\.([\\/]|$)/.test(g))
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "Only files in this app's folder can be used." };
        },
        settingSources: [],
        model: modelId(this.models, model),
        effort: studioEffort(model),
        resume: sessionId,
        abortController: abort,
        // Replaces the child's environment: DeepSeek's or OpenRouter's URL and key exist only in this run's process.
        env: claudeCodeEnv(this.models, model),
      },
    });
    const run: Run = { summary: "" };
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const b of msg.message.content as any[]) {
          if (b.type === "text" && b.text.trim()) progress(b.text.trim().split("\n")[0]);
          if (b.type === "tool_use" && /Write|Edit/.test(b.name)) progress("Writing app.js…");
        }
      } else if (msg.type === "result") {
        run.sessionId = msg.session_id;
        run.summary = msg.subtype === "success" ? msg.result : "";
        if (msg.subtype !== "success") run.problem = `${engineName(model)} stopped (${msg.subtype})`;
      }
    }
    return run;
  }

  /**
   * One Codex CLI run in the app folder. Its own config is ignored and a permission profile limits its
   * commands to reading and writing this folder, without network; its env carries no hub secrets.
   */
  private runCodex(dir: string, request: string, thread: string | undefined, abort: AbortController, progress: Progress): Promise<Run> {
    const bin = this.codexBin();
    if (!bin) return Promise.reject(new Error("Codex isn't installed on the hub"));
    // Codex has no system prompt option: a new thread gets the instructions with its first request.
    const prompt = thread ? request : `${SYSTEM}\n\n${request}`;
    return new Promise((done, fail) => {
      const p = spawn(bin, codexArgs(dir, thread), { cwd: dir, env: codexEnv(), stdio: ["pipe", "pipe", "pipe"], signal: abort.signal, killSignal: "SIGKILL" });
      const run: Run = { summary: "" };
      let buf = "", stderr = "";
      const event = (line: string) => {
        let e: any;
        try { e = JSON.parse(line); } catch { return; }
        if (e.type === "thread.started" && e.thread_id) run.sessionId = e.thread_id;
        const item = e.item;
        if (e.type === "item.completed" && item?.type === "agent_message" && item.text) {
          run.summary = item.text;
          progress(String(item.text).trim().split("\n")[0]);
        } else if (e.type === "item.completed" && item?.type === "file_change") progress("Writing app.js…");
        else if (e.type === "turn.failed" || e.type === "error") run.problem = `Codex: ${clip(String(e.error?.message ?? e.message ?? "error"), 150)}`;
      };
      p.stdout!.on("data", (d) => {
        buf += String(d);
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          event(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      p.stderr!.on("data", (d) => { stderr = (stderr + String(d)).slice(-2000); });
      p.on("error", (err) => fail(err));
      p.stdin!.on("error", () => {}); // EPIPE when startup fails before reading the prompt
      p.stdin!.end(prompt);
      p.on("close", (code, signal) => {
        if (buf.trim()) event(buf);
        if (abort.signal.aborted) return fail(new Error("aborted"));
        if (code !== 0) return fail(new Error(`Codex exited (${code ?? signal}): ${stderr.trim().split("\n").pop() || run.problem || "no detail"}`));
        done(run);
      });
    });
  }
}

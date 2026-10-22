import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { StudioJob, StudioModel } from "../src/shared/protocol.js";
import { claudeCodeEnv, codexArgs, codexEnv, DEEPSEEK_BASE_URL, OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODELS, openRouterModels, parseStudioModel, studioModels } from "../src/hub/studio-models.js";

// Studio's model choice: parsing what the wearer or phone asks for, the STUDIO_MODEL default,
// meta.json's per-version build record, and that a DeepSeek build's API settings live only in that
// run's environment. No model is called: the Agent SDK's query and the Codex CLI are faked.

// The real path: the check's --allow-fs-read must name the file as Node resolves it (/var -> /private/var).
const dir = realpathSync(mkdtempSync(join(tmpdir(), "studio-test-")));
process.env.G2_MINIAPPS_DIR = dir;
const { Studio } = await import("../src/hub/studio.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const APP = `let n = 0;
export default { title: "Counter", kind: "text", screen() { return { header: "Count " + n }; }, input(g) { if (g === "tap") { n++; return true; } return false; } };`;

const noCodex = () => null;

// ---------------- parsing & options ----------------

test("parse: names, aliases and phrases map to a model; anything else is null", () => {
  const cases: [string, StudioModel | null][] = [
    ["fast", "fast"], ["the fast model", "fast"], ["Haiku", "fast"], ["quick one", "fast"], ["claude-haiku-5-5", "fast"],
    ["balanced", "balanced"], ["sonnet", "balanced"], ["claude-sonnet-5-5", "balanced"],
    ["best", "best"], ["Opus", "best"], ["the smartest model", "best"], ["claude-opus-5-5", "best"],
    ["deepseek", "deepseek"], ["Deep Seek", "deepseek"], ["codex", "codex"], ["ChatGPT", "codex"],
    ["", null], ["banana", null], ["default", null],
  ];
  for (const [input, want] of cases) assert.equal(parseStudioModel(input), want, input);
  assert.equal(parseStudioModel(undefined), null);
});

test("default: balanced, or STUDIO_MODEL by any name; an exact Claude id is kept for its tier", () => {
  assert.equal(studioModels({}, noCodex).default, "balanced");
  assert.equal(studioModels({ STUDIO_MODEL: "opus" }, noCodex).default, "best");
  assert.equal(studioModels({ STUDIO_MODEL: "fast" }, noCodex).default, "fast");
  const exact = studioModels({ STUDIO_MODEL: "claude-opus-4-7" }, noCodex);
  assert.equal(exact.default, "best");
  assert.equal(exact.claudeId("best"), "claude-opus-4-7");
  assert.equal(exact.claudeId("fast"), "claude-sonnet-5-5");
  // Unusable or unknown defaults fall back to balanced.
  assert.equal(studioModels({ STUDIO_MODEL: "deepseek" }, noCodex).default, "balanced");
  assert.equal(studioModels({ STUDIO_MODEL: "deepseek", DEEPSEEK_API_KEY: "sk-test" }, noCodex).default, "deepseek");
  assert.equal(studioModels({ STUDIO_MODEL: "banana" }, noCodex).default, "balanced");
});

test("choose: DeepSeek only with its key, Codex only when installed, unknown names are refused", () => {
  const bare = studioModels({}, noCodex);
  assert.deepEqual(bare.choose(undefined), { model: "balanced" });
  assert.deepEqual(bare.choose(""), { model: "balanced" });
  assert.deepEqual(bare.choose("default"), { model: "balanced" });
  assert.deepEqual(bare.choose("the fast model"), { model: "fast" });
  assert.match((bare.choose("deepseek") as { error: string }).error, /DEEPSEEK_API_KEY/);
  assert.match((bare.choose("codex") as { error: string }).error, /Codex/);
  assert.match((bare.choose("banana") as { error: string }).error, /no "banana" model/);
  const all = studioModels({ DEEPSEEK_API_KEY: "sk-test" }, () => "/bin/codex");
  assert.deepEqual(all.choose("deepseek"), { model: "deepseek" });
  assert.deepEqual(all.choose("codex"), { model: "codex" });
  assert.deepEqual(bare.options().map((o) => [o.id, o.available]), [["fast", true], ["balanced", true], ["best", true], ["deepseek", false], ["codex", false]]);
  assert.ok(all.options().every((o) => o.available && !o.why));
  assert.equal(all.options().find((o) => o.id === "deepseek")!.detail, "DeepSeek (deepseek-flash)");
  assert.equal(studioModels({ DEEPSEEK_API_KEY: "k", DEEPSEEK_MODEL: "deepseek-v4-pro" }, noCodex).deepseekId(), "deepseek-v4-pro");
});

// ---------------- environment isolation ----------------

test("env: a DeepSeek run gets DeepSeek's URL and key and no Claude login; a Claude run is unchanged; nothing leaks back", () => {
  const base = { PATH: "/bin", HOME: "/home/x", CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", DEEPSEEK_API_KEY: "sk-deep", HUB_TOKEN: "hub-secret" };
  const copy = { ...base };
  const models = studioModels(base, noCodex);
  const deep = claudeCodeEnv(models, "deepseek", base);
  assert.equal(deep.ANTHROPIC_BASE_URL, DEEPSEEK_BASE_URL);
  assert.equal(deep.ANTHROPIC_AUTH_TOKEN, "sk-deep");
  for (const k of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) assert.equal(deep[k], "deepseek-flash", k);
  assert.equal(deep.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(deep.DEEPSEEK_API_KEY, undefined);
  assert.equal(deep.HUB_TOKEN, undefined);
  assert.equal(deep.PATH, "/bin");
  for (const m of ["fast", "balanced", "best"] as const) {
    const claude = claudeCodeEnv(models, m, base);
    assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, "oauth-secret");
    assert.equal(claude.ANTHROPIC_BASE_URL, undefined);
    assert.equal(claude.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(claude.DEEPSEEK_API_KEY, undefined);
    assert.equal(claude.G2_HOOK_DISABLE, "1");
  }
  assert.deepEqual(base, copy);
  assert.equal(claudeCodeEnv(studioModels({ ...base, DEEPSEEK_BASE_URL: "https://proxy.example/anthropic" }, noCodex), "deepseek", { ...base, DEEPSEEK_BASE_URL: "https://proxy.example/anthropic" }).ANTHROPIC_BASE_URL, "https://proxy.example/anthropic");
  const cx = codexEnv(base);
  assert.deepEqual(Object.keys(cx).sort(), ["G2_HOOK_DISABLE", "HOME", "PATH"]);
});

// ---------------- OpenRouter ----------------

const OR_KEY = { OPENROUTER_API_KEY: "sk-or-test" };

test("openrouter list: the default, or OPENROUTER_MODELS (slug=Label, bad entries skipped, no duplicates)", () => {
  assert.deepEqual(openRouterModels({}), [...OPENROUTER_DEFAULT_MODELS]);
  assert.ok(OPENROUTER_DEFAULT_MODELS.length >= 4 && OPENROUTER_DEFAULT_MODELS.every((o) => /^[\w.-]+\/[\w.-]+$/.test(o.slug) && o.label));
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(openRouterModels({ OPENROUTER_MODELS: " z-ai/glm-5.3=GLM , qwen/qwen3.8-flash, not a slug, openrouter:z-ai/glm-5.3, moonshotai/kimi-k3=Kimi = K3,~deepseek/deepseek-flash-latest" }), [
      { slug: "z-ai/glm-5.3", label: "GLM" },
      { slug: "qwen/qwen3.8-flash", label: "Qwen Flash" }, // a default slug keeps its default label
      { slug: "moonshotai/kimi-k3", label: "Kimi = K3" },
      { slug: "~deepseek/deepseek-flash-latest", label: "deepseek-flash-latest" },
    ]);
  } finally {
    console.warn = warn;
  }
});

test("openrouter parse: spoken names pick a listed model; built-in names win unless a word says more", () => {
  const or = studioModels(OR_KEY, noCodex);
  const cases: [string, string | null][] = [
    ["kimi", "openrouter:moonshotai/kimi-k3"], ["Kimi K3", "openrouter:moonshotai/kimi-k3"], ["moonshot", "openrouter:moonshotai/kimi-k3"],
    ["GLM", "openrouter:z-ai/glm-5.3"], ["glm 5.3", "openrouter:z-ai/glm-5.3"], ["the qwen model", "openrouter:qwen/qwen3.8-flash"],
    ["Gemini Flash", "openrouter:google/gemini-3.8-flash"], ["GPT Luna", "openrouter:openai/gpt-6-luna"],
    ["openrouter", "openrouter:deepseek/deepseek-v4.1-flash"], ["open router glm", "openrouter:z-ai/glm-5.3"],
    ["openrouter:z-ai/glm-5.3", "openrouter:z-ai/glm-5.3"], ["openai/gpt-6-luna", "openrouter:openai/gpt-6-luna"],
    ["deepseek flash", "openrouter:deepseek/deepseek-v4.1-flash"],
    // Without DeepSeek's own key or Codex, their names fall to OpenRouter's model of that vendor.
    ["deep seek", "openrouter:deepseek/deepseek-v4.1-flash"], ["chatgpt", "openrouter:openai/gpt-6-luna"],
    ["fast", "fast"], ["opus", "best"], ["the fast model", "fast"], ["banana", null],
  ];
  for (const [input, want] of cases) assert.equal(or.parse(input), want, input);
  // With DeepSeek's key and Codex, the plain names are theirs again.
  const all = studioModels({ ...OR_KEY, DEEPSEEK_API_KEY: "sk-deep" }, () => "/bin/codex");
  assert.equal(all.parse("deepseek"), "deepseek");
  assert.equal(all.parse("gpt"), "codex");
  assert.equal(all.parse("gpt luna"), "openrouter:openai/gpt-6-luna");
  assert.equal(all.label("openrouter:moonshotai/kimi-k3"), "Kimi K3");
  assert.equal(all.label("fast"), "Fast");
});

test("openrouter options & choose: only with the key, grouped; unlisted or keyless picks are refused", () => {
  const bare = studioModels({}, noCodex);
  assert.ok(!bare.options().some((o) => o.id.startsWith("openrouter:")));
  assert.match((bare.choose("kimi") as { error: string }).error, /OPENROUTER_API_KEY/);
  assert.match((bare.choose("deepseek") as { error: string }).error, /DEEPSEEK_API_KEY/); // its own reason, not OpenRouter's
  const or = studioModels(OR_KEY, noCodex);
  const listed = or.options().filter((o) => o.group === "OpenRouter");
  assert.deepEqual(listed.map((o) => o.id), OPENROUTER_DEFAULT_MODELS.map((o) => `openrouter:${o.slug}`));
  assert.ok(listed.every((o) => o.available && o.label && o.detail === o.id.slice("openrouter:".length)));
  assert.deepEqual(or.options().slice(0, 5).map((o) => o.id), ["fast", "balanced", "best", "deepseek", "codex"]);
  assert.deepEqual(or.choose("make it with kimi"), { model: "openrouter:moonshotai/kimi-k3" });
  assert.match((or.choose("openrouter:x-ai/grok-4.7") as { error: string }).error, /isn't in the OpenRouter list/);
  assert.match((or.choose("banana") as { error: string }).error, /Kimi K3/);
  // STUDIO_MODEL can name one; without the key it falls back to balanced.
  assert.equal(studioModels({ ...OR_KEY, STUDIO_MODEL: "glm" }, noCodex).default, "openrouter:z-ai/glm-5.3");
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(studioModels({ STUDIO_MODEL: "openrouter:z-ai/glm-5.3" }, noCodex).default, "balanced");
  } finally {
    console.warn = warn;
  }
});

test("openrouter env: its URL and key with ANTHROPIC_API_KEY empty, no Claude login; its key never reaches other runs", () => {
  const base = { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", ANTHROPIC_API_KEY: "sk-ant", DEEPSEEK_API_KEY: "sk-deep", OPENROUTER_API_KEY: "sk-or-secret", HUB_TOKEN: "hub-secret" };
  const copy = { ...base };
  const models = studioModels(base, noCodex);
  const e = claudeCodeEnv(models, "openrouter:z-ai/glm-5.3", base);
  assert.equal(e.ANTHROPIC_BASE_URL, OPENROUTER_BASE_URL);
  assert.equal(e.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
  assert.equal(e.ANTHROPIC_AUTH_TOKEN, "sk-or-secret");
  assert.equal(e.ANTHROPIC_API_KEY, "");
  for (const k of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) assert.equal(e[k], "z-ai/glm-5.3", k);
  assert.equal(e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "HUB_TOKEN"]) assert.equal(e[k], undefined, k);
  assert.doesNotMatch(JSON.stringify(e), /oauth-secret|sk-deep|sk-ant|hub-secret/);
  for (const m of ["fast", "best", "deepseek"] as const) {
    const other = claudeCodeEnv(models, m, base);
    assert.equal(other.OPENROUTER_API_KEY, undefined, m);
    assert.doesNotMatch(JSON.stringify(other), /sk-or-secret/, m);
  }
  assert.equal(claudeCodeEnv(models, "openrouter:z-ai/glm-5.3", { ...base, OPENROUTER_BASE_URL: "https://proxy.example/api" }).ANTHROPIC_BASE_URL, "https://proxy.example/api");
  assert.doesNotMatch(JSON.stringify(codexEnv(base)), /sk-or-secret/);
  assert.deepEqual(base, copy);
});

test("codex args: user config ignored, folder-only permission profile, resume keeps it", () => {
  const fresh = codexArgs("/apps/x", undefined, {});
  assert.ok(fresh.includes("--ignore-user-config"));
  assert.ok(fresh.includes('default_permissions="studio"'));
  assert.ok(fresh.some((a) => a.includes('":root"="deny"') && a.includes('":workspace_roots"={"."="write"}')));
  assert.ok(fresh.includes("permissions.studio.network.enabled=false"));
  assert.ok(!fresh.includes("--sandbox") && !fresh.some((a) => a.includes("dangerously")));
  assert.deepEqual(fresh.slice(-3), ["--cd", "/apps/x", "-"]);
  assert.deepEqual(codexArgs("/apps/x", "thread-1", {}).slice(-3), ["resume", "thread-1", "-"]);
  assert.deepEqual(codexArgs("/apps/x", undefined, { STUDIO_CODEX_MODEL: "gpt-x" }).slice(5, 7), ["-m", "gpt-x"]);
});

// ---------------- builds & meta.json ----------------

type Call = { prompt: string; options: any; envDuringRun: string | undefined };

/** A fake Agent SDK query: writes app.js (broken on the runs listed) and reports a session. */
function fakeQuery(calls: Call[], broken: Set<number> = new Set()) {
  return ((args: { prompt: string; options: any }) => {
    const n = calls.length;
    calls.push({ prompt: args.prompt, options: args.options, envDuringRun: process.env.ANTHROPIC_BASE_URL });
    return (async function* () {
      writeFileSync(join(args.options.cwd, "app.js"), broken.has(n) ? "export default { title: 1 };" : APP);
      yield { type: "assistant", message: { content: [{ type: "text", text: "Writing a counter." }] } };
      yield { type: "result", subtype: "success", result: "Built a counter.", session_id: `sess-${n}` };
    })();
  }) as any;
}

function studioWith(deps: ConstructorParameters<typeof Studio>[2]) {
  const jobs: StudioJob[] = [];
  const waiters: ((j: StudioJob) => void)[] = [];
  const studio = new Studio((j) => { jobs.push(j); waiters.forEach((w) => w(j)); }, () => {}, deps);
  const done = (id: string) =>
    new Promise<StudioJob>((res) => waiters.push((j) => j.id === id && (j.status === "ready" || j.status === "failed") && res(j)));
  return { studio, jobs, done };
}
const meta = (id: string) => JSON.parse(readFileSync(join(dir, id, "meta.json"), "utf8"));

test("builds: each version records its model, model id, time and tries; sessions resume only within a provider", async () => {
  const calls: Call[] = [];
  const env = { ...process.env, DEEPSEEK_API_KEY: "sk-deep" };
  const { studio, done } = studioWith({ query: fakeQuery(calls, new Set([2])), models: studioModels(env, noCodex), codexBin: noCodex });
  const before = { ...process.env };

  const made = studio.make("a tap counter", undefined, "fast");
  assert.ok(!("error" in made));
  const id = made.id;
  const ready = await done(id);
  assert.equal(ready.model, "fast");
  assert.ok(typeof ready.ms === "number" && ready.ms >= 0);
  assert.equal(calls[0].options.model, "claude-sonnet-5-5");
  assert.equal(calls[0].options.effort, "low"); // Fast = Sonnet at low effort
  assert.equal(calls[0].options.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL); // the hub's own, untouched
  assert.equal(calls[0].options.resume, undefined);

  // DeepSeek: its settings are in that run's env only, and Claude's session isn't resumed.
  const changed = studio.make("count down on long press", id, "deep seek");
  assert.deepEqual(changed, { id, model: "deepseek" });
  await done(id);
  assert.equal(calls[1].options.env.ANTHROPIC_BASE_URL, DEEPSEEK_BASE_URL);
  assert.equal(calls[1].options.env.ANTHROPIC_AUTH_TOKEN, "sk-deep");
  assert.equal(calls[1].options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(calls[1].options.model, "deepseek-flash");
  assert.equal(calls[1].options.resume, undefined);
  assert.match(calls[1].prompt, /read it before changing/);
  assert.equal(calls[1].envDuringRun, process.env.ANTHROPIC_BASE_URL);
  assert.deepEqual({ ...process.env }, before);

  // Back to Claude (fresh session again), first write fails the check, second passes.
  studio.make("bigger digits", id, "best");
  await done(id);
  assert.equal(calls[2].options.resume, undefined);
  assert.equal(calls[3].options.resume, "sess-2");
  assert.equal(calls[3].options.model, "claude-opus-5-5");
  // Same provider, no model named: the default (balanced), resuming Claude's session.
  studio.make("add a reset", id);
  await done(id);
  assert.equal(calls[4].options.resume, "sess-3");
  assert.equal(calls[4].options.model, "claude-sonnet-5-5");

  const m = meta(id);
  assert.equal(m.version, 4);
  assert.equal(m.sessionProvider, "claude");
  assert.deepEqual(m.builds.map((b: any) => [b.version, b.model, b.modelId, b.tries]), [
    [1, "fast", "claude-sonnet-5-5", 1],
    [2, "deepseek", "deepseek-flash", 1],
    [3, "best", "claude-opus-5-5", 2],
    [4, "balanced", "claude-sonnet-5-5", 1],
  ]);
  for (const b of m.builds) assert.ok(b.ms >= 0 && b.at > 0 && !b.fix);
  assert.deepEqual(studio.list().find((a) => a.id === id)!.builds, m.builds);
  for (let v = 1; v <= 4; v++) assert.ok(existsSync(join(dir, id, "versions", `v${v}.js`)));
});

test("openrouter builds: the slug is the run's model and the recorded model id; each OpenRouter model is its own session", async () => {
  const calls: Call[] = [];
  const env = { ...process.env, ...OR_KEY };
  const { studio, done } = studioWith({ query: fakeQuery(calls), models: studioModels(env, noCodex), codexBin: noCodex });
  const before = { ...process.env };
  const made = studio.make("an openrouter counter", undefined, "kimi");
  assert.deepEqual(made, { id: "openrouter-counter", model: "openrouter:moonshotai/kimi-k3" });
  const j = await done(made.id);
  assert.equal(j.status, "ready", j.log);
  assert.equal(calls[0].options.model, "moonshotai/kimi-k3");
  assert.equal(calls[0].options.env.ANTHROPIC_BASE_URL, OPENROUTER_BASE_URL);
  assert.equal(calls[0].options.env.ANTHROPIC_AUTH_TOKEN, "sk-or-test");
  assert.equal(calls[0].options.env.ANTHROPIC_API_KEY, "");
  assert.equal(calls[0].envDuringRun, process.env.ANTHROPIC_BASE_URL);
  assert.ok(calls[0].options.canUseTool, "folder confinement still applies");
  // Same model resumes its session; another OpenRouter model starts fresh.
  studio.make("count by two", made.id, "kimi");
  await done(made.id);
  assert.equal(calls[1].options.resume, "sess-0");
  studio.make("count by three", made.id, "glm");
  await done(made.id);
  assert.equal(calls[2].options.resume, undefined);
  assert.equal(calls[2].options.model, "z-ai/glm-5.3");
  const m = meta(made.id);
  assert.equal(m.sessionProvider, "openrouter:z-ai/glm-5.3");
  assert.deepEqual(m.builds.map((b: any) => [b.version, b.model, b.modelId]), [
    [1, "openrouter:moonshotai/kimi-k3", "moonshotai/kimi-k3"],
    [2, "openrouter:moonshotai/kimi-k3", "moonshotai/kimi-k3"],
    [3, "openrouter:z-ai/glm-5.3", "z-ai/glm-5.3"],
  ]);
  assert.deepEqual({ ...process.env }, before);
});

test("make: an unavailable or unknown model is refused before anything is created", () => {
  const { studio } = studioWith({ query: fakeQuery([]), models: studioModels({}, noCodex), codexBin: noCodex });
  const r = studio.make("a snake game", undefined, "deepseek");
  assert.ok("error" in r && /DEEPSEEK_API_KEY/.test(r.error));
  assert.ok("error" in studio.make("a snake game", undefined, "banana"));
  assert.ok("error" in studio.make("   "));
  assert.ok(!existsSync(join(dir, "snake-game")));
  assert.deepEqual(studio.modelOptions().default, "balanced");
});

test("codex: builds in the app folder with a minimal env, records its thread and resumes it", async () => {
  // A fake codex CLI: reads the prompt on stdin, writes app.js, prints Codex's JSONL events.
  const bin = join(dir, "fake-codex.sh");
  writeFileSync(
    bin,
    `#!/bin/sh
cat > prompt.txt
printf '%s\\n' "$@" > args.txt
env > env.txt
cat > app.js <<'APP'
${APP}
APP
echo '{"type":"thread.started","thread_id":"th-1"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"Made a counter."}}'
`,
  );
  chmodSync(bin, 0o755);
  const prev = { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret";
  process.env.DEEPSEEK_API_KEY = "sk-deep";
  try {
    const { studio, done } = studioWith({ query: fakeQuery([]), models: studioModels({}, () => bin), codexBin: () => bin });
    const made = studio.make("a codex counter", undefined, "codex");
    assert.ok(!("error" in made));
    const j = await done(made.id);
    assert.equal(j.status, "ready", j.log);
    const appDir = join(dir, made.id);
    const env = readFileSync(join(appDir, "env.txt"), "utf8");
    assert.doesNotMatch(env, /oauth-secret|sk-deep|CLAUDE_CODE_OAUTH_TOKEN|DEEPSEEK_API_KEY|HUB_TOKEN/);
    assert.match(readFileSync(join(appDir, "prompt.txt"), "utf8"), /You build mini-apps for Even G2/);
    assert.match(readFileSync(join(appDir, "args.txt"), "utf8"), /--ignore-user-config/);
    let m = meta(made.id);
    assert.equal(m.sessionId, "th-1");
    assert.equal(m.sessionProvider, "codex");
    assert.equal(m.builds[0].model, "codex");
    studio.make("count by two", made.id, "codex");
    await done(made.id);
    assert.match(readFileSync(join(appDir, "args.txt"), "utf8"), /resume\nth-1\n-/);
    assert.doesNotMatch(readFileSync(join(appDir, "prompt.txt"), "utf8"), /You build mini-apps/);
    m = meta(made.id);
    assert.equal(m.version, 2);
  } finally {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

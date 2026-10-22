import { codexBin } from "../node/codex.js";
import type { StudioModel, StudioModelOption } from "../shared/protocol.js";

// Who writes a Studio app. Fast / Balanced / Best are Claude on your Claude Code login; DeepSeek runs
// the same Claude Code agent against DeepSeek's Anthropic-compatible API (only with DEEPSEEK_API_KEY);
// OpenRouter models run it against OpenRouter's Anthropic-compatible API (only with OPENROUTER_API_KEY);
// Codex runs the Codex CLI on its own login (only when it's installed).

type Env = Record<string, string | undefined>;
type Fixed = "fast" | "balanced" | "best" | "deepseek" | "codex";

export const STUDIO_MODELS: readonly Fixed[] = ["fast", "balanced", "best", "deepseek", "codex"];

const CLAUDE: Record<"fast" | "balanced" | "best", { id: string; detail: string }> = {
  // Measured on "a tap counter with a seven-segment display": Haiku 5.5 averaged ~21 s (it thinks ~14 s
  // first), Sonnet 5.5 ~9.6 s. So Fast is Sonnet at low effort (see studioEffort); STUDIO_MODEL=claude-haiku-5-5 still pins Haiku.
  fast: { id: "claude-sonnet-5-5", detail: "Claude Sonnet 5.5, low effort" },
  balanced: { id: "claude-sonnet-5-5", detail: "Claude Sonnet 5.5" },
  best: { id: "claude-opus-5-5", detail: "Claude Opus 5.5" },
};
const LABEL: Record<Fixed, string> = { fast: "Fast", balanced: "Balanced", best: "Best", deepseek: "DeepSeek", codex: "Codex" };

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic";
/** DeepSeek's newest model (V4.1 Flash); DEEPSEEK_MODEL picks another, e.g. deepseek-v4-pro. */
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";

/**
 * OpenRouter's Anthropic-compatible API, as its Claude Code / Agent SDK guides set it up:
 * ANTHROPIC_BASE_URL=https://openrouter.ai/api, ANTHROPIC_AUTH_TOKEN=<key>, ANTHROPIC_API_KEY="".
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
/**
 * Strong, fast coding models on OpenRouter that do tool use through its Messages API (each answered a
 * tool call there, Oct 2026). OPENROUTER_MODELS replaces the list: "slug=Label, slug, …".
 */
export const OPENROUTER_DEFAULT_MODELS: readonly { slug: string; label: string }[] = [
  { slug: "deepseek/deepseek-v4.1-flash", label: "DeepSeek Flash" },
  { slug: "z-ai/glm-5.3", label: "GLM 5.3" },
  { slug: "moonshotai/kimi-k3", label: "Kimi K3" },
  { slug: "qwen/qwen3.8-flash", label: "Qwen Flash" },
  { slug: "google/gemini-3.8-flash", label: "Gemini Flash" },
  { slug: "openai/gpt-6-luna", label: "GPT-6 Luna" },
];
const OR = "openrouter:";

export const isClaude = (m: StudioModel): m is "fast" | "balanced" | "best" => m === "fast" || m === "balanced" || m === "best";
export const isOpenRouter = (m: StudioModel): m is `openrouter:${string}` => m.startsWith(OR);
/** "z-ai/glm-5.3" for "openrouter:z-ai/glm-5.3". */
export const openRouterSlug = (m: `openrouter:${string}`) => m.slice(OR.length);

/**
 * Sessions can only be resumed by the same provider (Claude's thinking blocks mean nothing to DeepSeek);
 * each OpenRouter model is its own.
 */
export const provider = (m: StudioModel) => (isClaude(m) ? "claude" : m);

/** Who is writing, for progress and errors: "Claude", "DeepSeek", "Codex", "OpenRouter (z-ai/glm-5.3)". */
export const engineName = (m: StudioModel) =>
  isClaude(m) ? "Claude" : isOpenRouter(m) ? `OpenRouter (${openRouterSlug(m)})` : LABEL[m];

/** OPENROUTER_MODELS ("z-ai/glm-5.3=GLM, qwen/qwen3.8-flash") or the default list. Bad entries are skipped. */
export function openRouterModels(env: Env = process.env): { slug: string; label: string }[] {
  const raw = (env.OPENROUTER_MODELS ?? "").trim();
  if (!raw) return [...OPENROUTER_DEFAULT_MODELS];
  const out: { slug: string; label: string }[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const [s, ...l] = part.split("=");
    const slug = s.trim().replace(/^openrouter:/, "");
    if (!/^~?[a-z0-9][\w.-]*\/[\w.:-]+$/i.test(slug)) {
      if (part.trim()) console.warn(`studio: OPENROUTER_MODELS entry "${part.trim().slice(0, 60)}" isn't a model slug like z-ai/glm-5.3; skipped`);
      continue;
    }
    if (out.some((o) => o.slug === slug)) continue;
    out.push({ slug, label: l.join("=").trim() || OPENROUTER_DEFAULT_MODELS.find((d) => d.slug === slug)?.label || slug.split("/").pop()! });
  }
  return out;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/deep\s*-?\s*seek/g, "deepseek")
    .replace(/open\s*-?\s*router/g, "openrouter")
    .replace(/chat\s*-?\s*gpt/g, "chatgpt")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !/^(the|model|one|engine|please|with|use|using|on|via|through|make|it|a|an)$/.test(w));
/** What else a vendor goes by when spoken. */
const VENDOR: Record<string, string[]> = {
  openai: ["gpt", "chatgpt", "openai"],
  "z-ai": ["glm", "zai", "zhipu"],
  moonshotai: ["kimi", "moonshot"],
  qwen: ["qwen", "alibaba"],
  google: ["gemini", "google"],
  deepseek: ["deepseek"],
  "x-ai": ["grok", "xai"],
  mistralai: ["mistral"],
  minimax: ["minimax"],
};

/**
 * A model as the wearer or a client names it: "fast", "the fast model", "haiku", "Opus",
 * "deep seek", "claude-sonnet-5-5"… null when it names none of them.
 */
export function parseStudioModel(input: unknown): StudioModel | null {
  const s = String(input ?? "")
    .toLowerCase()
    .replace(/\b(the|model|one|engine|please|with|use|using)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  if ((STUDIO_MODELS as readonly string[]).includes(s)) return s as StudioModel;
  if (/deep\s*-?\s*seek/.test(s)) return "deepseek";
  if (/codex|openai|chat\s*gpt|\bgpt\b/.test(s)) return "codex";
  if (/haiku|fast|quick|speedy|cheap/.test(s)) return "fast";
  if (/opus|best|smart|strong|careful/.test(s)) return "best";
  if (/sonnet|balanced|normal|medium|standard/.test(s)) return "balanced";
  return null;
}

export interface StudioModels {
  /** The environment these were read from (the hub's process.env), also the base for each run's env. */
  env: Env;
  default: StudioModel;
  /** Claude model id per tier (STUDIO_MODEL can name an exact Claude id for its tier). */
  claudeId(m: "fast" | "balanced" | "best"): string;
  deepseekId(): string;
  /** The OpenRouter models offered (OPENROUTER_MODELS or the default list), whether or not there's a key. */
  openRouter(): { slug: string; label: string }[];
  /** A model by any name, including the OpenRouter ones ("kimi", "GPT Luna", "openrouter glm"). */
  parse(input: unknown): StudioModel | null;
  /** Its short name: "Fast", "Kimi K3". */
  label(m: StudioModel): string;
  options(): StudioModelOption[];
  available(m: StudioModel): boolean;
  /**
   * The model to build with: the one asked for (by any name), else the default. An error (for the
   * wearer) when it can't be used here.
   */
  choose(asked?: unknown): { model: StudioModel } | { error: string };
}

/** Read from env each time it's asked, so tests (and a changed .env after restart) see current values. */
export function studioModels(env: Env = process.env, findCodex: () => string | null = codexBin): StudioModels {
  const orList = openRouterModels(env);
  const orKey = () => !!(env.OPENROUTER_API_KEY ?? "").trim();
  const orEntry = (m: StudioModel) => (isOpenRouter(m) ? orList.find((o) => o.slug === openRouterSlug(m)) : undefined);
  /** The OpenRouter model a name means: an exact slug, or the first whose name and vendor cover every word. */
  const parseOR = (input: string): StudioModel | null => {
    const exact = input.trim().replace(/^openrouter:/i, "").toLowerCase();
    const hit = orList.find((o) => o.slug.toLowerCase() === exact);
    if (hit) return `${OR}${hit.slug}`;
    const ws = words(input);
    const said = ws.includes("openrouter");
    const rest = ws.filter((w) => w !== "openrouter");
    if (!rest.length) return said && orList.length ? `${OR}${orList[0].slug}` : null;
    const found = orList.find((o) => {
      const vendor = o.slug.replace(/^~/, "").split("/")[0];
      const known = new Set([...words(o.slug.replace(/\//g, " ")), ...words(o.label), ...words(vendor), ...(VENDOR[vendor] ?? [])]);
      return rest.every((w) => known.has(w));
    });
    return found ? `${OR}${found.slug}` : null;
  };
  const why = (m: StudioModel) =>
    m === "deepseek" && !(env.DEEPSEEK_API_KEY ?? "").trim()
      ? "DeepSeek needs DEEPSEEK_API_KEY in the hub's .env."
      : m === "codex" && !findCodex()
        ? "Codex isn't installed on the hub (install the Codex app or CLI, or set CODEX_BIN)."
        : isOpenRouter(m) && !orKey()
          ? "OpenRouter models need OPENROUTER_API_KEY in the hub's .env."
          : isOpenRouter(m) && !orEntry(m)
            ? `${openRouterSlug(m)} isn't in the OpenRouter list (OPENROUTER_MODELS).`
            : undefined;
  const available = (m: StudioModel) => !why(m);
  const label = (m: StudioModel) => (isOpenRouter(m) ? orEntry(m)?.label ?? openRouterSlug(m) : LABEL[m]);
  const parse = (input: unknown): StudioModel | null => {
    const s = String(input ?? "");
    const fixed = parseStudioModel(s);
    const or = parseOR(s);
    if (!or) return fixed;
    if (!fixed || /open\s*-?\s*router/i.test(s)) return or;
    // Both fit ("deepseek", "gpt"): the built-in one when every word names it and it can be used (or
    // neither can, so its own reason is given), the OpenRouter one when a word says more ("gpt luna").
    const allFixed = words(s).every((w) => parseStudioModel(w) === fixed);
    return allFixed && (available(fixed) || !available(or)) ? fixed : or;
  };
  const raw = (env.STUDIO_MODEL ?? "").trim();
  const parsed = raw ? parse(raw) : null;
  if (raw && !parsed) console.warn(`studio: STUDIO_MODEL="${raw}" isn't fast, balanced, best, deepseek, codex, an OpenRouter model or a Claude model; using balanced`);
  // An exact Claude id (STUDIO_MODEL=claude-opus-4-7) keeps working: it's what its tier builds with.
  const exact = parsed && isClaude(parsed) && /^claude-/.test(raw) ? { [parsed]: raw } : {};
  const claudeId = (m: "fast" | "balanced" | "best") => (exact as Record<string, string>)[m] ?? CLAUDE[m].id;
  const deepseekId = () => (env.DEEPSEEK_MODEL ?? "").trim() || DEEPSEEK_DEFAULT_MODEL;
  let def: StudioModel = parsed ?? "balanced";
  if (!available(def)) {
    console.warn(`studio: STUDIO_MODEL=${def} can't be used here (${why(def)}); using balanced`);
    def = "balanced";
  }
  return {
    env,
    default: def,
    claudeId,
    deepseekId,
    openRouter: () => orList.map((o) => ({ ...o })),
    parse,
    label,
    available,
    options: () => [
      ...STUDIO_MODELS.map((id): StudioModelOption => {
        const w = why(id);
        const detail = isClaude(id) ? (exact as Record<string, string>)[id] ?? CLAUDE[id].detail : id === "deepseek" ? `DeepSeek (${deepseekId()})` : "Codex CLI (your ChatGPT login)";
        return { id, label: LABEL[id], detail, available: !w, ...(w ? { why: w } : {}) };
      }),
      // Offered only with the key: without it the picker would list half a dozen dead buttons.
      ...(orKey() ? orList.map((o): StudioModelOption => ({ id: `${OR}${o.slug}`, label: o.label, detail: o.slug, available: true, group: "OpenRouter" })) : []),
    ],
    choose(asked) {
      if (asked === undefined || asked === null || /^\s*(default|auto|any)?\s*$/i.test(String(asked))) return { model: def };
      const m = parse(asked);
      const slug = String(asked).trim().replace(/^openrouter:/i, "");
      if (!m && /^~?[\w.-]+\/[\w.:-]+$/.test(slug)) return { error: `${slug.slice(0, 60)} isn't in the OpenRouter list (OPENROUTER_MODELS).` };
      if (!m) return { error: `There's no "${String(asked).slice(0, 40)}" model; pick fast, balanced, best, deepseek${orKey() && orList.length ? `, ${orList.map((o) => o.label).join(", ")}` : ""} or codex.` };
      const w = why(m);
      return w ? { error: w } : { model: m };
    },
  };
}

/** The model id a build records (and Claude Code is given). */
export function modelId(models: StudioModels, m: StudioModel, env: Env = models.env): string | undefined {
  if (isClaude(m)) return models.claudeId(m);
  if (m === "deepseek") return models.deepseekId();
  if (isOpenRouter(m)) return openRouterSlug(m);
  return (env.STUDIO_CODEX_MODEL ?? "").trim() || undefined;
}

const SECRETS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "HUB_TOKEN", "G2_HUB_TOKEN"];

/**
 * The environment for one Claude Code run (the SDK starts Claude Code as a child process and this
 * REPLACES its environment), so pointing a DeepSeek build at DeepSeek never touches the hub's own
 * process.env or any other Claude call. A Claude build keeps the hub's login; a DeepSeek (or OpenRouter)
 * build gets no Claude credentials at all, only that provider's key, and every model slot names its model.
 */
export function claudeCodeEnv(models: StudioModels, m: StudioModel, base: Env = models.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.G2_HOOK_DISABLE = "1";
  delete env.DEEPSEEK_API_KEY; // only a DeepSeek run needs it, as its auth token
  delete env.OPENROUTER_API_KEY; // likewise for OpenRouter
  delete env.HUB_TOKEN;
  delete env.G2_HUB_TOKEN;
  if (m !== "deepseek" && !isOpenRouter(m)) return env;
  for (const k of SECRETS) delete env[k];
  const id = modelId(models, m)!;
  Object.assign(
    env,
    isOpenRouter(m)
      ? {
          ANTHROPIC_BASE_URL: (base.OPENROUTER_BASE_URL ?? "").trim() || OPENROUTER_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: (base.OPENROUTER_API_KEY ?? "").trim(),
          // OpenRouter's guides: must be explicitly empty, so Claude Code uses the auth token.
          ANTHROPIC_API_KEY: "",
        }
      : {
          ANTHROPIC_BASE_URL: (base.DEEPSEEK_BASE_URL ?? "").trim() || DEEPSEEK_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: (base.DEEPSEEK_API_KEY ?? "").trim(),
        },
  );
  Object.assign(env, {
    ANTHROPIC_MODEL: id,
    ANTHROPIC_DEFAULT_OPUS_MODEL: id,
    ANTHROPIC_DEFAULT_SONNET_MODEL: id,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: id,
    CLAUDE_CODE_SUBAGENT_MODEL: id,
    // No telemetry or other side traffic to Anthropic from a run that isn't Claude.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  return env;
}

/** Codex gets only what it needs to start and find its own login: no hub tokens or API keys. */
export function codexEnv(base: Env = process.env): Record<string, string> {
  const env: Record<string, string> = { G2_HOOK_DISABLE: "1" };
  for (const k of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "CODEX_HOME"]) if (base[k]) env[k] = base[k]!;
  return env;
}

/**
 * Codex exec arguments: its own config (~/.codex/config.toml may say danger-full-access) is ignored,
 * and a permission profile lets its commands read and write only the app folder (plus the system
 * paths tools need), with no network.
 */
export function codexArgs(dir: string, thread: string | undefined, env: Env = process.env): string[] {
  const model = (env.STUDIO_CODEX_MODEL ?? "").trim();
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--skip-git-repo-check",
    ...(model ? ["-m", model] : []),
    "-c", 'model_reasoning_effort="medium"',
    "-c", 'default_permissions="studio"',
    "-c", 'permissions.studio.extends=":workspace"',
    "-c", 'permissions.studio.filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny",":workspace_roots"={"."="write"}}',
    "-c", "permissions.studio.network.enabled=false",
    ...(thread ? ["resume", thread, "-"] : ["--cd", dir, "-"]),
  ];
}

/** Reasoning effort per Studio model: Fast trades thinking for speed. */
export const studioEffort = (m: StudioModel): "low" | "medium" => (m === "fast" ? "low" : "medium");

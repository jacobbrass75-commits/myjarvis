import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./store.js";

// Which Claude model the voice assistant (router) and the conversation Copilot use. Switchable by
// voice ("use Haiku for the assistant") or from the phone page; kept in DATA_DIR/models.json.
// Copilot defaults to Haiku: it runs every few sentences and speed matters more than depth there.

export type ModelRole = "assistant" | "copilot";
export type ModelChoice = "haiku" | "sonnet" | "opus";

export const MODEL_IDS: Record<ModelChoice, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

const FILE = join(DATA_DIR, "models.json");
const DEFAULTS: Record<ModelRole, ModelChoice> = { assistant: "sonnet", copilot: "haiku" };

/** "Haiku", "the fast one", "claude-sonnet-5-5" -> a choice; undefined if it names none. */
export function parseChoice(s: string | undefined): ModelChoice | undefined {
  const t = (s ?? "").toLowerCase();
  if (/haiku|fast|quick/.test(t)) return "haiku";
  if (/opus|best|smart/.test(t)) return "opus";
  if (/sonnet|balanced|default/.test(t)) return "sonnet";
  return undefined;
}

let saved: Partial<Record<ModelRole, ModelChoice>> = {};
try {
  saved = JSON.parse(readFileSync(FILE, "utf8"));
} catch {}

const listeners = new Set<(role: ModelRole) => void>();

/** The model id for a role: the saved choice, else ROUTER_MODEL / COPILOT_MODEL, else the default. */
export function modelFor(role: ModelRole): string {
  const pick = saved[role];
  if (pick) return MODEL_IDS[pick];
  const env = role === "assistant" ? process.env.ROUTER_MODEL : process.env.COPILOT_MODEL;
  return env || MODEL_IDS[DEFAULTS[role]];
}

export function choices(): Record<ModelRole, ModelChoice> {
  const of = (role: ModelRole) => saved[role] ?? (Object.entries(MODEL_IDS).find(([, id]) => id === modelFor(role))?.[0] as ModelChoice) ?? DEFAULTS[role];
  return { assistant: of("assistant"), copilot: of("copilot") };
}

export function setModel(role: ModelRole, choice: ModelChoice) {
  saved = { ...saved, [role]: choice };
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(saved, null, 2));
  } catch {}
  for (const f of listeners) f(role);
}

export function onModelChange(f: (role: ModelRole) => void) {
  listeners.add(f);
}

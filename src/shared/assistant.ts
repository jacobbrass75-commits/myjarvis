// Who the voice assistant is. She is shown and introduces herself as Bocchi (Hitori Gotoh from Bocchi
// the Rock); "Jarvis", her old name, still works everywhere. Pure (no DOM, no Node): the hub and the
// glasses share it.

/** The name on the lens and in replies. */
export const ASSISTANT_NAME = "Bocchi";

/** Every name she answers to (first = the display name). */
export const ASSISTANT_NAMES = ["Bocchi", "Jarvis"] as const;

// How speech-to-text tends to spell them ("Bocchi" is rarely in its vocabulary).
const NAME = String.raw`(?:bo(?:cc|c|tc|t)h?(?:i|ie|y|ee)|jarvis|jarvas|jervis)`;
const GREETING = String.raw`(?:(?:hey|hi|hello|ok|okay|yo|oi|um|uh)[\s,.!]+)?`;
// The name at the start of an utterance (after an optional "hey"), followed by punctuation, a
// space or the end: "Jarvis, ...", "Hey Bocchi ...", "Botchy?" (but not "bochie" inside a word).
const LEADING = new RegExp(String.raw`^\s*${GREETING}${NAME}(?=$|[\s,.!?:;])[\s,.!?:;-]*`, "i");

/**
 * "Hey Bocchi, open my notes" -> "open my notes"; "Jarvis?" -> "" (only her name). Text that
 * doesn't start with one of her names comes back unchanged.
 */
export function stripWakeName(text: string): string {
  const m = LEADING.exec(text);
  return m ? text.slice(m[0].length).trim() : text.trim();
}

/** A tool call as a short lens label: "mcp__hub__start_agent" -> "start agent", "WebSearch" -> "web search". */
export function toolLabel(name: string): string {
  const known: Record<string, string> = { WebSearch: "web search", WebFetch: "reading a page" };
  if (known[name]) return known[name];
  return name
    .replace(/^mcp__[^_]+__/, "")
    .replace(/^app_/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

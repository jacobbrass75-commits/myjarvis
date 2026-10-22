import type { HubMsg, Script } from "../../../src/shared/protocol";
import { ROWS, core, startListening, stopListening, wrap, type Mode } from "../core";

// Teleprompter for a script you paste on the phone page. Swipe to move; tap to turn on "follow me":
// it listens and scrolls along as you say the words.

let script: Script | null = null;
let lines: string[] = [];
let top = 0;
let follow = false;
const VISIBLE = ROWS - 2;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

/** Move to the line where the last few spoken words best match the script, near the current spot. */
function followSpeech(text: string) {
  const said = norm(text).slice(-6);
  if (said.length < 2) return;
  let best = -1;
  let bestScore = 1;
  for (let i = Math.max(0, top - 2); i < Math.min(lines.length, top + VISIBLE + 6); i++) {
    const window = norm(lines.slice(i, i + 2).join(" "));
    const score = said.filter((w) => window.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best >= 0) top = Math.max(0, best - 1); // keep the line you're on near the top
}

export const teleprompter: Mode = {
  id: "teleprompter",
  title: "Teleprompter",
  quiet: true,
  enter() {
    top = 0;
    follow = false;
  },
  exit() {
    stopListening();
  },
  resume() {
    if (follow) startListening("teleprompter", navigator.language || "en-US");
  },
  onHub(m: HubMsg) {
    if (m.t === "script") {
      script = m.script;
      lines = script ? wrap(script.text) : [];
      top = 0;
    } else if (m.t === "transcript" && follow && core.listening === "teleprompter") followSpeech(m.line.text);
  },
  screen() {
    if (!script) return { header: "Teleprompter", body: "\nNo script yet.\n\nPaste one on the phone page\n(Teleprompter section)." };
    const pct = lines.length ? Math.round((Math.min(top + VISIBLE, lines.length) / lines.length) * 100) : 100;
    return {
      header: `${follow ? "● " : ""}${script.title || "Script"} · ${pct}%${follow ? " · following" : " · tap: follow me"}`.slice(0, 46),
      body: lines.slice(top, top + VISIBLE).join("\n"),
    };
  },
  gesture(g) {
    if (g === "down") top = Math.min(Math.max(0, lines.length - VISIBLE), top + VISIBLE - 1);
    else if (g === "up") top = Math.max(0, top - (VISIBLE - 1));
    else if (g === "tap" && script) {
      follow = !follow;
      if (follow) startListening("teleprompter", navigator.language || "en-US");
      else stopListening();
    } else return false;
    return true;
  },
};

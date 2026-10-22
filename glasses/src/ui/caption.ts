import { ASSISTANT_NAME } from "../../../src/shared/assistant";
import type { HubMsg } from "../../../src/shared/protocol";
import { render, wrap, type Gesture } from "../core";
import { G } from "./kit";

// Live words while you talk. Push-to-talk and notes: the hub streams the clip to speech-to-text as
// you hold and sends `caption` messages (~8/s); core shows them in the screen's caption box, its
// header, or the full-lens takeover. Listening modes (Copilot, Translate) read the wearer's own words
// from the `transcript` partials through captionLines({ source: "listen" }).
//
// Phases: live (held) → sent (released; the final words and "BOCCHI > …") → reply (6 s, or until a
// gesture) → idle. The router decides on voice_reply: captionReply() when this screen keeps its own
// content, else captionStop("sent") and the reply opens Agents as before. A note: sent ("SAVING")
// → reply ("SAVED", 2 s). While sent, voice_working says which tool the assistant is running.

export type CaptionPhase = "idle" | "live" | "sent" | "reply";

export const caption = {
  phase: "idle" as CaptionPhase,
  source: "ptt" as "ptt" | "note",
  /** core's number for this press (audio_start.clip); captions for any other are stale. */
  clip: 0,
  text: "",
  /** Length of the start of `text` the recogniser won't change any more. */
  stable: 0,
  reply: "",
  /** When the reply came (the avatar talks for a while after). */
  repliedAt: 0,
  /** While sent: the tool the assistant is running for this clip ("web search"), else "". */
  working: "",
  /** Mic level 0..1. */
  level: 0,
  /** The latest line from a listening session (Copilot, Translate, Teleprompter). */
  listen: null as { text: string; final: boolean; who?: "me" | "them"; at: number } | null,
};

/** The hub's final words for this clip arrived (later partials are stale). */
let final = false;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Recent finished sentences of the listening session, oldest first. */
let heard: { text: string; who?: "me" | "them" }[] = [];

const SENT_MS = 30_000;
const REPLY_MS = 6000;
const SAVED_MS = 2000;
/** A partial with nothing after it for this long is dropped (the engine moved on without a final). */
const STALE_MS = 10_000;

function phase(p: CaptionPhase, ms = 0) {
  caption.phase = p;
  clearTimeout(timer);
  timer = ms ? setTimeout(() => captionStop(p), ms) : undefined;
  if (p === "idle") caption.level = 0;
}

export function onCaptionHub(m: HubMsg): void {
  if (m.t === "caption") {
    const mine = m.clip !== undefined ? m.clip === caption.clip : m.source === caption.source;
    if ((caption.phase !== "live" && caption.phase !== "sent") || final || !mine) return;
    caption.text = m.text;
    caption.stable = Math.min(m.stable, m.text.length);
    if (!m.final) return;
    final = true;
    // Nothing heard: the hub's "Didn't catch that." toast says so.
    if (!m.text.trim()) phase("idle");
  } else if (m.t === "toast" && caption.phase === "sent" && final) {
    // Only after this clip's final caption: the hub sends its toast right after it, so an earlier
    // toast belongs to an earlier press.
    if (/^Note saved/i.test(m.text)) {
      caption.reply = "SAVED";
      phase("reply", SAVED_MS);
    } else if (/^(Didn't catch|Speech-to-text failed)/i.test(m.text)) phase("idle");
  } else if (m.t === "voice_working") {
    if (captionOwns(m.heard)) caption.working = m.tool;
  } else if (m.t === "transcript") {
    caption.listen = { text: m.line.text, final: m.line.final, who: m.line.who, at: m.line.at };
    if (m.line.final) {
      heard.push({ text: m.line.text, who: m.line.who });
      if (heard.length > 6) heard.shift();
    }
  } else if (m.t === "listening") {
    heard = [];
    caption.listen = null;
  }
}

/** A push-to-talk or note caption is showing (phase != idle). */
export function captionActive(): boolean {
  return caption.phase !== "idle";
}

const WHO = { me: "YOU > ", them: "THEM > " } as const;
/** "BOCCHI > " */
export const SPEAKER = `${ASSISTANT_NAME.toUpperCase()} > `;

/** Wrapped rows of s (none for empty text). */
const rowsOf = (s: string, cols: number) => (s.trim() ? wrap(s.trim(), cols).filter(Boolean) : []);

/**
 * Lines for a caption area of cols x rows. Bottom-anchored (newest last): live ≤ liveRows (default 2)
 * rows ending in "_", earlier rows of words still being heard move up into done, done + live ≤ rows.
 * A reply is top-anchored instead: its first rows, "…" where it is cut.
 * source "listen" = the listening session's sentences, with YOU > / THEM > (or "> ") when who is set.
 * tag false = the reply without "BOCCHI > " (her avatar is beside it).
 */
export function captionLines(cols: number, rows: number, o: { source?: "ptt" | "listen"; who?: boolean; liveRows?: number; tag?: boolean } = {}): { done: string[]; live: string[] } {
  if (rows <= 0 || cols <= 0) return { done: [], live: [] };
  const liveRows = Math.max(1, Math.min(rows, o.liveRows ?? 2));
  let done: string[] = [];
  let live: string[] = [];
  if (o.source === "listen") {
    // Whole sentences, newest last; one that doesn't fit keeps its tag and its end ("THEM > …this quarter.").
    const tag = (who?: "me" | "them") => (o.who ? (who ? WHO[who] : "> ") : "");
    const fit = (t: string, text: string, room: number) => {
      const words = text.trim().split(/\s+/);
      let r = rowsOf(t + words.join(" "), cols);
      while (r.length > room && words.length > 1) {
        words.shift();
        r = rowsOf(t + G.ell + words.join(" "), cols);
      }
      return r.slice(-room);
    };
    const p = caption.listen;
    if (p && !p.final && p.text.trim() && Date.now() - p.at < STALE_MS) live = fit(tag(p.who), `${p.text.trim()}_`, liveRows);
    let room = rows - live.length;
    for (let i = heard.length - 1; i >= 0 && room > 0; i--) {
      const r = rowsOf(tag(heard[i].who) + heard[i].text, cols);
      if (r.length > room) {
        if (!done.length) done = fit(tag(heard[i].who), heard[i].text, room);
        break;
      }
      done.unshift(...r);
      room -= r.length;
    }
    return { done, live };
  } else {
    const said = caption.text.trim();
    if (caption.phase === "reply") {
      const note = caption.source === "note";
      const answer = rowsOf(note || o.tag === false ? caption.reply : SPEAKER + caption.reply, cols);
      const you = rowsOf(`> ${said}`, cols);
      if (you.length + answer.length <= rows) return { done: [...you, ...answer], live: [] };
      const top = answer.slice(0, rows);
      if (answer.length > rows) top[rows - 1] = top[rows - 1].slice(0, Math.max(0, cols - G.ell.length)) + G.ell;
      return { done: top, live: [] };
    }
    if (caption.phase === "sent") {
      done = rowsOf(said, cols);
      live = [caption.source === "note" ? `SAVING${G.ell}` : SPEAKER + G.ell];
    } else if (caption.phase === "live") {
      // Words the recogniser may still change go in live; finals in done.
      const cut = Math.min(caption.stable, caption.text.length);
      done = rowsOf(caption.text.slice(0, cut), cols);
      const rest = caption.text.slice(cut).trim();
      live = rest ? rowsOf(`${rest}_`, cols) : ["_"];
    }
  }
  if (live.length > liveRows) {
    done.push(...live.slice(0, -liveRows));
    live = live.slice(-liveRows);
  }
  return { done: done.slice(Math.max(0, done.length - (rows - live.length))), live };
}

/** "[||||......]" */
export function micMeter(width: number): string {
  const n = Math.max(0, Math.min(width, Math.round(caption.level * width)));
  return `[${"|".repeat(n)}${".".repeat(width - n)}]`;
}

/**
 * While "sent" or "reply" covers the screen, any gesture closes it (the screen under it is hidden, so
 * a tap must not act on it). Returns true when it took the gesture. Core calls this only when the
 * caption is on the lens (not under an approval card).
 */
export function captionGesture(g: Gesture): boolean {
  if (caption.phase !== "sent" && caption.phase !== "reply") return false;
  if (g === "hold" || g === "release") return false;
  phase("idle");
  return true;
}

/** The button went down (talk() / record()). */
export function captionStart(source: "ptt" | "note", clip = 0): void {
  caption.source = source;
  caption.clip = clip;
  caption.text = "";
  caption.stable = 0;
  caption.reply = "";
  caption.working = "";
  caption.level = 0;
  final = false;
  phase("live");
}

/** The button came up: show what was heard while the hub thinks (or saves the note). */
export function captionRelease(): void {
  if (caption.phase !== "live") return;
  phase("sent", SENT_MS);
}

/**
 * This voice_reply answers the clip on the lens: its final words came and match what was heard
 * (a reply to an earlier press, or to the phone, doesn't).
 */
export function captionOwns(heard: string): boolean {
  return caption.phase === "sent" && caption.source === "ptt" && final && heard.trim() === caption.text.trim();
}

/** The assistant answered the clip being shown: show the answer in place (false = not ours to show). */
export function captionReply(heard: string, text: string): boolean {
  if (!captionOwns(heard)) return false;
  caption.reply = text.trim();
  caption.repliedAt = Date.now();
  phase("reply", REPLY_MS);
  return true;
}

/** End the caption now (or only if it is in `only`). */
export function captionStop(only?: CaptionPhase): void {
  if (caption.phase === "idle" || (only && caption.phase !== only)) return;
  phase("idle");
  render();
}

import {
  AudioInputSource,
  CreateStartUpPageContainer,
  EventSourceType,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import type { Approval, ClientMsg, HubMsg, HubState, ListenPurpose } from "../../src/shared/protocol";
import type { Raster } from "../../src/shared/raster";
import { bytesToBase64, encodeGray4Bmp, encodeGrayPng } from "./png";
import { ASSISTANT_NAME } from "../../src/shared/assistant";
import { AVATAR_H, AVATAR_W, bocchiTile, captionMood } from "./ui/bocchi";
import { caption, captionActive, captionGesture, captionLines, captionRelease, captionStart, captionStop, micMeter } from "./ui/caption";
import { clip, G, LV } from "./ui/kit";
import { checkLayout, colsFor, rowsFor } from "./ui/layout";

// Everything the modes share: the hub connection, rendering to the lens, input, and the mic.

export const W = 576;
export const H = 288;
// Estimates for the default G2 font; tune on device.
export const COLS = 46;
export const ROWS = 8;

export type Gesture = "tap" | "double" | "up" | "down" | "hold" | "release";

/** An image container: up to 288x144 of our own pixels (ids 4..7, names tile0..tile3). */
export interface Tile {
  slot: 0 | 1 | 2 | 3;
  x: number;
  y: number;
  /** img.w 20..288, img.h 20..144, levels 0..15. Pushed only when its bytes change. */
  img: Raster;
  /** Push order when several changed, lower first (default: slot). */
  prio?: number;
  /** LENS TEST only: force this payload format in the iPhone app (G2Kit ImageFormat, e.g. "rle4"). */
  format?: string;
}

/** A firmware text box beside the main body/list (ids 8..11, names box0..box3). */
export interface Box {
  slot: 0 | 1 | 2 | 3;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** Border width; colour is borderLevel (default LV.frame). Corners are always square. */
  border?: 0 | 1 | 2;
  borderLevel?: number;
  /** Default 6. */
  pad?: number;
  /** Takes input when the screen has no body or list. */
  capture?: boolean;
  /** Text brightness 0..4 (textColor). Only the emulator shows it until the iPhone app sends it. */
  bright?: 0 | 1 | 2 | 3 | 4;
}

/**
 * What a mode wants on the lens: a header line plus either a text body or a selectable list, or a
 * picture; or (Lagonda screens) any of those sharing the lens with image tiles and text boxes.
 */
export interface Screen {
  header: string;
  body?: string;
  list?: string[];
  /** A 144x72 picture (levels 0..15), shown 2x in the middle of the lens. */
  pixels?: Uint8Array;
  tiles?: Tile[];
  boxes?: Box[];
  noHeader?: boolean;
  /** body (id 3) or list (id 2) geometry when sharing the lens; default 0,40,576,248, no border. */
  main?: { x: number; y: number; w: number; h: number; border?: 0 | 1 | 2; borderLevel?: number; pad?: number };
  /** Push-to-talk live words: a box slot (its text replaced), "takeover" (default), or "header" (default for pixels screens). */
  captionSlot?: number | "takeover" | "header";
  /** Toasts: a box slot (its first line replaced) or "header" (default). */
  toastSlot?: number | "header";
}

export { colsFor, rowsFor };

export const PX_W = 144;
export const PX_H = 72;

export interface Mode {
  id: string;
  title: string;
  enter?(): void;
  exit?(): void;
  /** The hub reconnected while this mode was listening: re-open the mic as it was (default: enter()). */
  resume?(): void;
  screen(): Screen;
  /** Return true if handled. Unhandled double tap goes back to the launcher. */
  gesture(g: Gesture, listIndex: number): boolean;
  /** Long press on the ring/temple. Return true to take it; otherwise it's push-to-talk to Jarvis. */
  hold?(down: boolean): boolean;
  onHub?(m: HubMsg): void;
  /** Conversation modes don't get interrupted by approval cards (a counter shows instead). */
  quiet?: boolean;
}

// Works in the Even App WebView, a browser, and headless in Node (the native/ Mac runner).
const $ = (id: string): { textContent: string | null } =>
  (globalThis as any).document?.getElementById(id) ?? { textContent: "" };
export const log = (s: string) => {
  const el = $("log");
  if (!(globalThis as any).document) return console.log(`[glasses] ${s}`);
  el.textContent = `${new Date().toLocaleTimeString()} ${s}\n${el.textContent}`.slice(0, 4000);
};

/** Log on the page and in the hub log (the WebView's console isn't visible on the glasses). */
let reported = 0;
export function report(s: string) {
  log(s);
  if (++reported <= 50) send({ t: "glasses_log", text: s.slice(0, 500) });
}

// ---------------- text helpers ----------------

export function wrap(text: string, cols = COLS): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if ((line + " " + word).trim().length > cols) {
        if (line) out.push(line);
        line = word.length > cols ? word.slice(0, cols) : word;
      } else line = (line + " " + word).trim();
    }
    out.push(line);
  }
  return out;
}

// CJK, kana, hangul, full-width forms and emoji are about two Latin columns wide on the lens.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;
// Punctuation that stays with the character before it rather than starting a line.
const NO_START = /[、。，．：；？！）」』】〕〉》”’…ー～,.!?;:)\]}%]/;
const NO_END = /[（「『【〔〈《“‘(\[{]/;

/** Width in lens columns (wrap()'s units): wide characters count 2. */
export function textWidth(s: string): number {
  let w = 0;
  for (const c of s) w += WIDE.test(c) ? 2 : 1;
  return w;
}

/** The longest start of s that fits in `cols` columns. */
export function fitWidth(s: string, cols: number): string {
  let out = "";
  let w = 0;
  for (const c of s) {
    w += WIDE.test(c) ? 2 : 1;
    if (w > cols) break;
    out += c;
  }
  return out;
}

/**
 * wrap() for text that may hold Chinese/Japanese/Korean: counts wide characters as two columns and
 * breaks between them (there are no spaces to break at), keeping punctuation off the start of a line.
 * Text without wide characters wraps exactly as wrap() does.
 */
export function wrapWide(text: string, cols = COLS): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    // Break units: a run of narrow characters (a word), or one wide character, plus any punctuation
    // that must not start a line; `sp` = whitespace before it (joined with a space, else glued).
    const units: { s: string; sp: boolean }[] = [];
    let sp = false;
    let prev = "";
    for (const c of para) {
      if (/\s/.test(c)) {
        sp = true;
        continue;
      }
      const last = units[units.length - 1];
      const join = last && !sp && ((!WIDE.test(c) && !WIDE.test(prev)) || NO_START.test(c) || NO_END.test(prev));
      if (join) last.s += c;
      else units.push({ s: c, sp: sp && !!last });
      sp = false;
      prev = c;
    }
    let line = "";
    let w = 0;
    for (const u of units) {
      const uw = textWidth(u.s);
      const gap = line && u.sp ? 1 : 0;
      if (w + gap + uw > cols) {
        if (line) out.push(line);
        line = uw > cols ? fitWidth(u.s, cols) : u.s;
        w = textWidth(line);
      } else {
        line += (gap ? " " : "") + u.s;
        w += gap + uw;
      }
    }
    out.push(line);
  }
  return out;
}

export function paged(text: string, page: number, rows = ROWS - 2) {
  const lines = wrap(text);
  const pages = Math.max(1, Math.ceil(lines.length / rows));
  const p = Math.max(0, Math.min(page, pages - 1));
  return { body: lines.slice(p * rows, p * rows + rows).join("\n"), page: p, pages };
}

// ---------------- shared state ----------------

export const core = {
  state: { agents: [], approvals: [], nodes: [], apps: [], voice: { listening: false, lastHeard: "", lastReply: "" } } as HubState,
  bridge: null as EvenAppBridge | null,
  ws: null as WebSocket | null,
  toast: "",
  /** Push-to-talk in progress. */
  talking: false,
  /** Continuous listening in progress (copilot, translate, teleprompter). */
  listening: null as ListenPurpose | null,
  approvalIndex: 0,
  selected: 0,
  modes: new Map<string, Mode>(),
  /** The hub we're connected to (mini-apps are loaded from it). */
  hubUrl: "",
  token: "",
  stack: [] as Mode[],
  /** Screen off: the lens shows nothing (black is see-through) until a tap, swipe or hold. */
  dark: false,
};

/** Turn the lens off or back on. Approval cards still show while it's off. */
export function setDark(on: boolean) {
  if (core.dark === on) return;
  core.dark = on;
  render();
}

export const current = () => core.stack[core.stack.length - 1];

export function send(m: ClientMsg) {
  if (core.ws?.readyState === 1) core.ws.send(JSON.stringify(m));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function flash(text: string, ms = 3000) {
  core.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    core.toast = "";
    render();
  }, ms);
  render();
}

export function openMode(id: string) {
  const m = core.modes.get(id);
  if (!m) return;
  core.stack.push(m);
  m.enter?.();
  render();
}

export function back() {
  if (core.stack.length <= 1) return;
  const m = core.stack.pop()!;
  m.exit?.();
  render();
}

// ---------------- mic ----------------

async function micOn(): Promise<boolean> {
  if (!core.bridge) return false;
  const ok = await core.bridge.audioControl(true, AudioInputSource.Glasses);
  if (!ok) flash("Mic unavailable");
  return ok;
}

export async function startListening(purpose: ListenPurpose, lang?: string, target?: string) {
  if (core.listening === purpose) return;
  if (core.listening) await stopListening();
  send({ t: "listen_start", purpose, sampleRate: 16000, lang, target });
  core.listening = purpose;
  if (!(await micOn())) core.listening = null;
  render();
}

export async function stopListening() {
  if (!core.listening) return;
  core.listening = null;
  if (!core.talking) await core.bridge?.audioControl(false);
  send({ t: "listen_stop" });
  render();
}

// Push-to-talk: the hub transcribes while you hold and sends the words back as `caption`s
// (ui/caption.ts), so the lens shows them as you speak; after release they stay up with
// "BOCCHI > …" (or SAVING for a note) until the reply.

async function talk(down: boolean) {
  if (current()?.hold?.(down)) return;
  await pushToTalk(down);
}

/** Push-to-talk without asking the mode first: for a mode that took a long press, then let it go (Apps). */
export async function pushToTalk(down: boolean) {
  const mode = current();
  if (down) {
    if (core.talking || core.listening) return;
    await beginClip("command", (mode as any)?.voiceContext?.());
  } else if (core.talking) await endClip();
}

/** Push-to-talk with a purpose other than a command (used by Notes). */
export async function record(down: boolean, purpose: "note") {
  if (down) {
    if (core.talking) return;
    await beginClip(purpose);
  } else if (core.talking) await endClip();
}

/** This press's number (audio_start.clip), so captions for an earlier one are ignored. */
let clipSeq = 0;
/** A press whose mic didn't open: its release sends nothing. */
let droppedClip = 0;
let clipChain = Promise.resolve();
/**
 * Clip messages go out in order: a quick second press waits for the first one's audio_end (sent
 * after the mic is off, so its last words are in), else the hub would end the second clip with it.
 * A bridge call that never answers holds the next step back 3 s at most.
 */
function clipStep(f: () => Promise<void>) {
  const step = clipChain.then(f).catch((e) => log(`clip: ${e?.message ?? e}`));
  clipChain = Promise.race([step, new Promise<void>((r) => setTimeout(r, 3000))]);
  return step;
}

function beginClip(purpose: "command" | "note", agentId?: string) {
  core.talking = true;
  const clip = ++clipSeq;
  captionStart(purpose === "note" ? "note" : "ptt", clip);
  render();
  return clipStep(async () => {
    send({ t: "audio_start", sampleRate: 16000, purpose, clip });
    if (agentId) send({ t: "voice_context", agentId });
    if (await micOn()) return;
    // micOn() said "Mic unavailable": drop the clip here and on the hub (no "Didn't catch that").
    droppedClip = clip;
    send({ t: "audio_cancel", clip });
    if (clipSeq !== clip) return;
    core.talking = false;
    captionStop();
  });
}

function endClip() {
  core.talking = false;
  captionRelease();
  render();
  const clip = clipSeq;
  return clipStep(async () => {
    if (droppedClip === clip) return;
    await core.bridge?.audioControl(false);
    send({ t: "audio_end", clip });
  });
}

/** Mic level for the takeover's meter: about -50 dBFS (silence) to -10 dBFS (loud), fast attack, slow fall. */
let meterAt = 0;
function meter(pcm: Uint8Array) {
  let sum = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = ((pcm[i] | (pcm[i + 1] << 8)) << 16) >> 16;
    sum += v * v;
  }
  const db = n ? 10 * Math.log10(sum / n / (32768 * 32768) + 1e-12) : -100;
  const level = Math.max(0, Math.min(1, (db + 50) / 40));
  caption.level = Math.max(level, caption.level * 0.7);
  const now = Date.now();
  if (now - meterAt >= 250) {
    meterAt = now;
    render();
  }
}

// ---------------- rendering ----------------

let pageCreated = false;
let shape = "";
/** Text last sent per container id (header, body, boxes): only changes go out as upgrades. */
const sentText = new Map<number, string>();
let chain = Promise.resolve();
/** A draw is queued and hasn't started: more render() calls fold into it. */
let queued = false;

const TILE_ID = 4; // tile0..tile3 = 4..7 (the legacy picture is 4 too, on its own page)
const BOX_ID = 8; // box0..box3 = 8..11

/** Header suffixes a feature shows on every screen but its own mode (" [2 MSG]": texts that came in quietly). */
export const badges = new Map<string, () => string>();
const headerBadges = (modeId?: string) => [...badges].map(([id, f]) => (id === modeId ? "" : f())).join("");

function screen(): Screen {
  const mode = current();
  const approvals = core.state.approvals;
  const card = approvals.length > 0 && !mode?.quiet;
  // Screen off: nothing at all, not even toasts; an approval card or holding to talk still shows.
  if (core.dark && !card && !core.talking) return { header: " ", body: " " };
  let s: Screen;
  if (card) s = approvalCard(approvals);
  else {
    const m = mode?.screen() ?? { header: "…", body: "" };
    const badge = (approvals.length && mode?.quiet ? ` [${approvals.length}!]` : "") + headerBadges(mode?.id);
    s = { ...m, header: m.header + badge };
  }
  // Live words. Over an approval card only while the button is held, so a later tap is never an
  // approval of a card you couldn't see.
  if (core.talking || (captionActive() && !card)) s = withCaption(s);
  return withToast(s);
}

/**
 * An agent asks to run a tool: tap allows, double tap denies, swipe to the next one. Hub confirm
 * cards (no device: sending an email, adding an event) read "CONFIRM?" and show the action itself.
 */
function approvalCard(approvals: Approval[]): Screen {
  core.approvalIndex = Math.min(core.approvalIndex, approvals.length - 1);
  const a = approvals[core.approvalIndex];
  const n = approvals.length > 1 ? ` ${core.approvalIndex + 1}/${approvals.length}` : "";
  const node = core.state.nodes.find((x) => x.id === a.nodeId)?.name ?? a.nodeId;
  return {
    header: a.nodeId ? `APPROVE?${n}  ${a.agentName.toUpperCase()} @ ${node.toUpperCase()}` : `CONFIRM?${n}  ${a.agentName.toUpperCase()}`,
    main: { x: 12, y: 44, w: 552, h: 190, border: 2, borderLevel: LV.focus, pad: 8 },
    body: [a.nodeId ? `TOOL: ${a.tool}` : a.tool, "", ...wrap(a.summary, 42).slice(0, 4)].join("\n"),
    boxes: [{ slot: 0, x: 12, y: 242, w: 552, h: 40, border: 1, pad: 4, text: "TAP: YES   DOUBLE: NO   SWIPE: NEXT" }],
  };
}

const micLine = () => `${G.dot} ${caption.source === "note" ? "NOTE" : "MIC"} ${micMeter(10)}  RELEASE TO SEND`;

/** Push-to-talk words: in the screen's caption box, its header, or the full-lens takeover. */
function withCaption(s: Screen): Screen {
  const slot = s.captionSlot ?? (s.pixels ? "header" : "takeover");
  const b = typeof slot === "number" ? s.boxes?.find((x) => x.slot === slot) : undefined;
  if (b) {
    const { done, live } = captionLines(colsFor(b.w, b.pad ?? 6, b.border ?? 0), rowsFor(b.h, b.pad ?? 6));
    const text = [...done, ...live].join("\n") || clip(micLine(), colsFor(b.w, b.pad ?? 6, b.border ?? 0));
    return { ...s, boxes: s.boxes!.map((x) => (x === b ? { ...x, text } : x)) };
  }
  if (slot === "header" && !s.noHeader) {
    const { done, live } = captionLines(44, 1);
    return { ...s, header: clip([...done, ...live].pop() ?? micLine(), 44) };
  }
  return takeover();
}

/** Text only: what you said so far (bright) above the words still being recognised (dim, ending "_"). */
function takeover(): Screen {
  const note = caption.source === "note";
  const name = ASSISTANT_NAME.toUpperCase();
  const header =
    caption.phase === "sent" ? (note ? "NOTE  SAVING" : caption.working ? clip(`${name}  WORKING: ${caption.working.toUpperCase()}`, 44) : `${name}  THINKING`)
    : caption.phase === "reply" ? (note ? "NOTE  SAVED" : `${name}   TAP: CLOSE`)
    : micLine();
  // Commands (not notes): Bocchi on the left, your words and her reply in the bright box beside her.
  const avatar = !note;
  const bx = avatar ? 12 + AVATAR_W + 12 : 12;
  const rows = rowsFor(176, 8);
  const liveRows = rowsFor(56, 8);
  const reply = caption.phase === "reply";
  // A reply fills the bright box from the top (beside her, running on into the line below);
  // otherwise the newest words sit at the bottom.
  const { done, live } = captionLines(colsFor(564 - bx, 8, 1), reply ? rows + (avatar ? liveRows : 0) : rows + liveRows, { liveRows, tag: !avatar });
  const shown = reply ? done.slice(0, rows) : done.slice(-rows);
  const below = reply ? done.slice(rows) : live;
  if (!shown.length && (live.join("") === "_" || !live.length) && !reply) shown.push(note ? "SPEAK YOUR NOTE" : "SPEAK NOW");
  return {
    header,
    ...(avatar && { tiles: [bocchiTile(captionMood(), 0, 12, 44 + (176 - AVATAR_H) / 2)] }),
    boxes: [
      { slot: 0, x: bx, y: 44, w: 564 - bx, h: 176, border: 1, pad: 8, bright: 4, capture: true, text: "\n".repeat(reply ? 0 : Math.max(0, rows - shown.length)) + shown.join("\n") },
      { slot: 1, x: 12, y: 224, w: 552, h: 56, border: 0, pad: 8, bright: 2, text: below.join("\n") || " " },
    ],
  };
}

function withToast(s: Screen): Screen {
  if (!core.toast) return s;
  const t = `${G.toast} ${core.toast}`;
  const slot = s.toastSlot ?? "header";
  const b = typeof slot === "number" ? s.boxes?.find((x) => x.slot === slot) : s.noHeader ? s.boxes?.[0] : undefined;
  if (!b) return { ...s, header: t };
  const lines = b.text.split("\n");
  lines[0] = clip(t, colsFor(b.w, b.pad ?? 6, b.border ?? 0));
  return { ...s, boxes: s.boxes!.map((x) => (x === b ? { ...x, text: lines.join("\n") } : x)) };
}

/** Lagonda screens (tiles, boxes, own geometry); the rest keep the original one-header layouts. */
const composed = (s: Screen) => !s.pixels && !!(s.tiles?.length || s.boxes?.length || s.main || s.noHeader);

/** The firmware rejects more than 1000 bytes of text in a container. */
function fit1000(s: string): string {
  if (s.length <= 250) return s || " ";
  const enc = new TextEncoder();
  while (enc.encode(s).length > 1000) s = s.slice(0, -10);
  return s || " ";
}

/** The page containers for a screen (exported for tests and previews). */
export function containers(s: Screen) {
  const header = new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: W, height: 36, containerID: 1, containerName: "header",
    content: s.header, isEventCapture: 0, borderWidth: 0, paddingLength: 4,
  });
  if (s.pixels) {
    // Image containers can't take input, so a blank full-screen text box behind it does.
    header.zOrderIndex = 1;
    const input = new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: W, height: H, containerID: 3, containerName: "body",
      content: " ", isEventCapture: 1, borderWidth: 0, zOrderIndex: 0,
    });
    const image = new ImageContainerProperty({
      xPosition: (W - PX_W * 2) / 2, yPosition: 40 + (H - 40 - PX_H * 2) / 2, width: PX_W * 2, height: PX_H * 2,
      containerID: 4, containerName: "picture", zOrderIndex: 2,
    });
    return { containerTotalNum: 3, textObject: [input, header], imageObject: [image] };
  }
  if (composed(s)) return composedContainers(s, header);
  if (s.list) {
    const list = new ListContainerProperty({
      xPosition: 0, yPosition: 40, width: W, height: H - 40, containerID: 2, containerName: "list",
      isEventCapture: 1, borderWidth: 0, paddingLength: 4,
      itemContainer: new ListItemContainerProperty({ itemCount: s.list.length, itemWidth: W - 8, isItemSelectBorderEn: 1, itemName: s.list.map((x) => x.slice(0, 44)) }),
    });
    return { containerTotalNum: 2, textObject: [header], listObject: [list] };
  }
  const body = new TextContainerProperty({
    xPosition: 0, yPosition: 40, width: W, height: H - 40, containerID: 3, containerName: "body",
    content: s.body ?? "", isEventCapture: 1, borderWidth: 0, paddingLength: 6,
  });
  return { containerTotalNum: 2, textObject: [header, body] };
}

/**
 * Header (1), list (2) or body (3) in `main`, boxes (8..11), tiles (4..7). Input goes to the body,
 * else the list, else the box marked capture, else a blank full-lens text box (id 3).
 * No z-order: text never overlaps a tile (checkLayout), except that blank input box.
 */
function composedContainers(s: Screen, header: TextContainerProperty) {
  const text: TextContainerProperty[] = [];
  const lists: ListContainerProperty[] = [];
  if (!s.noHeader) text.push(header);
  const m = s.main ?? { x: 0, y: 40, w: W, h: H - 40 };
  const pad = m.pad ?? (s.list ? 4 : 6);
  const border = m.border ?? 0;
  const geo = { xPosition: m.x, yPosition: m.y, width: m.w, height: m.h, borderWidth: border, borderColor: m.borderLevel ?? LV.frame, borderRadius: 0, paddingLength: pad };
  let captured = true;
  if (s.list)
    lists.push(new ListContainerProperty({
      ...geo, containerID: 2, containerName: "list", isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({ itemCount: s.list.length, itemWidth: m.w - 2 * (pad + 2 * border), isItemSelectBorderEn: 1, itemName: s.list.map((x) => x.slice(0, 44)) }),
    }));
  else if (s.body !== undefined) text.push(new TextContainerProperty({ ...geo, containerID: 3, containerName: "body", content: fit1000(s.body), isEventCapture: 1 }));
  else captured = false;
  const capBox = captured ? undefined : s.boxes?.find((b) => b.capture);
  for (const b of s.boxes ?? [])
    text.push(new TextContainerProperty({
      xPosition: b.x, yPosition: b.y, width: b.w, height: b.h, containerID: BOX_ID + b.slot, containerName: `box${b.slot}`,
      content: fit1000(b.text), isEventCapture: b === capBox ? 1 : 0,
      borderWidth: b.border ?? 0, borderColor: b.borderLevel ?? LV.frame, borderRadius: 0, paddingLength: b.pad ?? 6,
      ...(b.bright !== undefined ? { textColor: b.bright } : {}),
    }));
  if (!captured && !capBox)
    text.unshift(new TextContainerProperty({ xPosition: 0, yPosition: 0, width: W, height: H, containerID: 3, containerName: "body", content: " ", isEventCapture: 1, borderWidth: 0 }));
  const images = (s.tiles ?? []).map((t) => new ImageContainerProperty({ xPosition: t.x, yPosition: t.y, width: t.img.w, height: t.img.h, containerID: TILE_ID + t.slot, containerName: `tile${t.slot}` }));
  return {
    containerTotalNum: text.length + lists.length + images.length,
    textObject: text,
    ...(lists.length ? { listObject: lists } : {}),
    ...(images.length ? { imageObject: images } : {}),
  };
}

type Page = ReturnType<typeof containers>;

/** What forces a rebuild: containers, geometry, borders, brightness, input, list rows. Text alone doesn't. */
function shapeOf(s: Screen, page: Page): string {
  if (s.pixels) return "pixels";
  if (!composed(s)) return s.list ? `list:${s.list.join("|")}` : "text";
  const key = (c: any) => [c.containerID, c.xPosition, c.yPosition, c.width, c.height, c.borderWidth ?? 0, c.borderColor ?? 0, c.paddingLength ?? 0, c.isEventCapture ?? 0, c.textColor ?? ""].join(",");
  const lists = "listObject" in page ? page.listObject! : [];
  const images = "imageObject" in page ? page.imageObject! : [];
  return ["c", ...page.textObject.map(key), ...lists.map((l) => key(l) + ":" + (l.itemContainer?.itemName ?? []).join("|")), ...images.map(key)].join(";");
}

/** Pages the iPhone app would reject, or that would draw wrongly, go to the hub log (once each). */
const layoutErrors = new Set<string>();
function checkPage(page: Page) {
  try {
    checkLayout(page);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!layoutErrors.has(msg)) {
      layoutErrors.add(msg);
      report(msg);
    }
  }
}

export function render() {
  if (queued) return; // partial-transcript floods collapse into one draw
  queued = true;
  chain = chain
    .then(() => {
      queued = false;
      return draw();
    })
    .catch((e) => log(`render: ${e?.message ?? e}`));
}

/** Resolves when the queued draws are done (tests, previews, the picture pump). */
export const rendered = () => chain;

async function draw() {
  const b = core.bridge;
  if (!b) return;
  const s = screen();
  const page = containers(s);
  const next = shapeOf(s, page);
  if (!pageCreated || next !== shape) {
    checkPage(page);
    if (!pageCreated) {
      const r = await b.createStartUpPageContainer(new CreateStartUpPageContainer(page));
      if (r !== StartUpPageCreateResult.success) return log(`createStartUpPage failed: ${r}`);
      pageCreated = true;
    } else {
      core.selected = 0; // a rebuilt list starts with its first row highlighted
      await b.rebuildPageContainer(new RebuildPageContainer(page));
    }
    lastFrame = null;
    sentTiles.clear();
    tileSentAt.clear();
    firstTile = true;
    resendTile = -1;
    sentText.clear();
    for (const t of page.textObject) sentText.set(t.containerID!, t.content ?? "");
  } else {
    // Text first, so words never wait behind image pushes.
    for (const t of page.textObject) {
      const content = t.content ?? "";
      if (sentText.get(t.containerID!) === content) continue;
      sentText.set(t.containerID!, content);
      await b.textContainerUpgrade(new TextContainerUpgrade({
        containerID: t.containerID, containerName: t.containerName, content,
        ...(t.textColor !== undefined ? { textColor: t.textColor } : {}),
      }));
    }
  }
  shape = next;
  if (s.pixels) await pushFrame(s.pixels);
  if (s.tiles?.length) await pushTiles(s.tiles);
}

// ---------------- tiles ----------------

/** Bytes last pushed per tile id; a tile goes out again only when its pixels change. */
const sentTiles = new Map<number, Uint8Array>();
const tileFailures = new Map<number, number>();
/** When each tile was last pushed (cleared on a page rebuild). */
const tileSentAt = new Map<number, number>();
/** The first image after a create/rebuild may be dropped by the glasses: it is sent once more at the end. */
let firstTile = false;
let resendTile = -1;

const samePx = (a: Uint8Array | undefined, b: Uint8Array) => {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Native image path (the iPhone app's EvenHubHost sets __jarvisImageHost): the BMP the lenses take, as
 * base64, through its own bridge call. Skips the PNG/zlib encode here, the 4x-larger number[] JSON the
 * SDK makes of image bytes, and the PNG decode + grey conversion on the phone. Off for the session if
 * the call throws (an older app); the Even App and the emulator keep the SDK's PNG path.
 */
let nativeImages = true;
/** Last push per container name: the result and how long the page waited for it (LENS TEST shows it). */
export const imageResults = new Map<string, { result: string; ms: number; format?: string }>();
async function sendImage(id: number, name: string, levels: Uint8Array, w: number, h: number, format?: string): Promise<string> {
  const t0 = performance.now();
  const r = await sendImageNow(id, name, levels, w, h, format);
  imageResults.set(name, { result: r, ms: Math.round(performance.now() - t0), format });
  return r;
}
async function sendImageNow(id: number, name: string, levels: Uint8Array, w: number, h: number, format?: string): Promise<string> {
  const g = globalThis as any;
  if (nativeImages && g.__jarvisImageHost && g.flutter_inappwebview) {
    const t = performance.now();
    const bmp = bytesToBase64(encodeGray4Bmp(levels, w, h));
    try {
      return String(await g.flutter_inappwebview.callHandler("jarvisImage", {
        containerID: id, containerName: name, bmp, sentAt: Date.now(), encodeMs: Math.round(performance.now() - t),
        ...(format ? { format } : {}),
      }));
    } catch (e: any) {
      nativeImages = false;
      report(`native image call failed (${e?.message ?? e}); using the SDK's PNG path`);
    }
  }
  const png = await encodeGrayPng(levels, w, h, 4);
  return String(await core.bridge!.updateImageRawData(new ImageRawDataUpdate({ containerID: id, containerName: name, imageData: Array.from(png) })));
}

/** At most one tile per draw (each is a ~21 KB BLE transfer); another render() follows if more changed. */
async function pushTiles(tiles: Tile[]) {
  const b = core.bridge;
  if (!b) return;
  // Fairness: a tile that has waited longest goes first (never-sent tiles first of all), priority only
  // breaks ties. Sorting by slot alone starved the others when tile 0 changed every frame (an animated
  // map: one ~1.7 s push each, so tiles 1-3 never reached the lens).
  const age = (t: Tile) => tileSentAt.get(TILE_ID + t.slot) ?? -1;
  // A fresh image container is already black: an all-black tile needs no ~1.5 s push.
  for (const t of tiles) if (!sentTiles.has(TILE_ID + t.slot) && t.img.px.every((v) => v === 0)) sentTiles.set(TILE_ID + t.slot, t.img.px.slice());
  const dirty = tiles
    .filter((t) => !samePx(sentTiles.get(TILE_ID + t.slot), t.img.px))
    .sort((p, q) => age(p) - age(q) || (p.prio ?? p.slot) - (q.prio ?? q.slot));
  let t: Tile | undefined = dirty[0];
  if (!t && resendTile >= 0) {
    t = tiles.find((x) => TILE_ID + x.slot === resendTile);
    resendTile = -1;
  }
  if (!t) return;
  const id = TILE_ID + t.slot;
  const px = t.img.px.slice();
  const r = await sendImage(id, `tile${t.slot}`, px, t.img.w, t.img.h, t.format);
  if (r !== "success") {
    // Try again shortly, a few times, then treat it as sent so a bad tile can't loop forever.
    const n = (tileFailures.get(id) ?? 0) + 1;
    tileFailures.set(id, n);
    if (n === 1) report(`tile${t.slot} push: ${r}`);
    if (n < 4) return void setTimeout(render, 500 * n);
  }
  tileFailures.delete(id);
  sentTiles.set(id, px);
  tileSentAt.set(id, Date.now());
  if (firstTile) {
    firstTile = false;
    resendTile = id;
  }
  // A forced-format push (LENS TEST) redraws once so its result shows.
  if (dirty.length > 1 || resendTile >= 0 || t.format) render();
}

// ---------------- pictures ----------------

let lastFrame: Uint8Array | null = null;
const scaled = new Uint8Array(PX_W * 2 * PX_H * 2);
let frames = 0;
let fpsStart = Date.now();
export let pictureFps = 0;

/** Send a 144x72 frame (scaled 2x) if it changed. Runs inside the render chain, so one at a time. */
async function pushFrame(px: Uint8Array) {
  const b = core.bridge;
  if (!b || (lastFrame && samePx(lastFrame, px))) return;
  lastFrame = px.slice();
  const W2 = PX_W * 2;
  for (let y = 0; y < PX_H; y++)
    for (let x = 0; x < PX_W; x++) {
      const v = px[y * PX_W + x] & 15;
      const o = y * 2 * W2 + x * 2;
      scaled[o] = scaled[o + 1] = scaled[o + W2] = scaled[o + W2 + 1] = v;
    }
  await sendImage(4, "picture", scaled, W2, PX_H * 2);
  frames++;
  if (Date.now() - fpsStart > 2000) {
    pictureFps = (frames * 1000) / (Date.now() - fpsStart);
    frames = 0;
    fpsStart = Date.now();
  }
}

let pumping = false;
/** Keep redrawing while the current screen is a picture (games): as fast as the glasses accept frames. */
export function startPicturePump() {
  if (pumping) return;
  pumping = true;
  const loop = async () => {
    while (pumping) {
      render();
      await chain;
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  void loop();
}
export function stopPicturePump() {
  pumping = false;
}

// ---------------- input ----------------

let lastGesture = { g: "", at: 0 };
let lastRole = "";

function gestureOf(type: OsEventTypeList | undefined): Gesture | null {
  switch (type) {
    case undefined: // the SDK normalizes CLICK_EVENT (0) to undefined
    case OsEventTypeList.CLICK_EVENT: return "tap";
    case OsEventTypeList.DOUBLE_CLICK_EVENT: return "double";
    case OsEventTypeList.SCROLL_TOP_EVENT: return "up";
    case OsEventTypeList.SCROLL_BOTTOM_EVENT: return "down";
    case OsEventTypeList.LONG_PRESS_EVENT: return "hold";
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT: return "release";
    default: return null;
  }
}

export function onBridgeEvent(e: EvenHubEvent) {
  if (e.audioEvent) {
    if ((core.talking || core.listening) && core.ws?.readyState === 1) {
      // The Even App classifies each frame as the wearer or someone else; pass changes along.
      const role = String(e.audioEvent.speakerRole ?? "unknown") as "self" | "other" | "unknown";
      if (core.listening && role !== lastRole) {
        lastRole = role;
        send({ t: "speaker", role });
      }
      core.ws.send(e.audioEvent.audioPcm);
      if (core.talking && e.audioEvent.audioPcm instanceof Uint8Array) meter(e.audioEvent.audioPcm);
    }
    return;
  }
  const raw = e.listEvent ?? e.textEvent ?? e.sysEvent;
  if (!raw) return;
  const type = raw.eventType;
  if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) return render();
  if (type !== undefined && type >= 4 && type <= 8) return; // lifecycle + IMU
  const g = gestureOf(type);
  if (!g) return;
  if (e.listEvent?.currentSelectItemIndex !== undefined) core.selected = e.listEvent.currentSelectItemIndex;
  const now = Date.now();
  if (lastGesture.g === g && now - lastGesture.at < 200) return; // same press, reported twice
  lastGesture = { g, at: now };
  void (e.sysEvent?.eventSource === EventSourceType.TOUCH_EVENT_FROM_RING);
  handle(g);
}

function handle(g: Gesture) {
  // Screen off: the first tap or swipe only wakes it (a hold still talks, and wakes it too).
  if (core.dark && !(core.state.approvals.length && !current()?.quiet)) {
    if (g === "release") return void talk(false);
    core.dark = false;
    if (g !== "hold") return render();
  }
  if (g === "hold" || g === "release") return void talk(g === "hold");
  const mode = current();
  const approvals = core.state.approvals;
  // Only while the caption is what you see: under an approval card, a tap answers the card.
  if (!(approvals.length && !mode?.quiet) && captionGesture(g)) return render();
  if (approvals.length && !mode?.quiet) {
    const a = approvals[Math.min(core.approvalIndex, approvals.length - 1)];
    if (g === "tap") send({ t: "approve", id: a.id, decision: "allow" });
    else if (g === "double") send({ t: "approve", id: a.id, decision: "deny", message: "Denied from glasses." });
    else if (g === "down") core.approvalIndex = (core.approvalIndex + 1) % approvals.length;
    else if (g === "up") core.approvalIndex = (core.approvalIndex - 1 + approvals.length) % approvals.length;
    flash(g === "tap" ? "Approved" : g === "double" ? "Denied" : "");
    return;
  }
  // Lists: the firmware moves the highlight on swipes; mirror it so a tap knows the row.
  const s = mode?.screen();
  if (s?.list && (g === "up" || g === "down")) {
    core.selected = Math.max(0, Math.min(s.list.length - 1, core.selected + (g === "down" ? 1 : -1)));
  }
  const handled = mode?.gesture(g, core.selected) ?? false;
  if (!handled && g === "double") back();
  else render();
}

// ---------------- hub connection ----------------

export function connect(hubs: string[], token: string) {
  core.token = token;
  let i = 0;
  const open = () => {
    const url = hubs[i % hubs.length];
    core.hubUrl = url;
    $("hub").textContent = url;
    const sock = new WebSocket(url.replace(/^http/, "ws") + "/ws");
    let opened = false;
    sock.binaryType = "arraybuffer";
    sock.onopen = () => {
      core.ws = sock;
      opened = true;
      sock.send(JSON.stringify({ t: "hello", role: "glasses", token }));
      $("conn").textContent = "connected";
      // Resume continuous listening after a reconnect.
      const l = core.listening;
      if (l) {
        core.listening = null;
        const mode = current();
        if (mode?.resume) mode.resume();
        else mode?.enter?.();
      }
    };
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data) as HubMsg;
      if (m.t === "state") core.state = m.state;
      else if (m.t === "toast") flash(m.text);
      else if (m.t === "error") log(`hub: ${m.text}`);
      // One mode throwing must not stop the others (the router that opens modes runs last).
      for (const mode of core.modes.values()) {
        try {
          mode.onHub?.(m);
        } catch (e: any) {
          report(`${mode.id}.onHub(${m.t}) threw: ${e?.stack ?? e}`);
        }
      }
      render();
    };
    sock.onclose = () => {
      if (core.ws === sock) core.ws = null;
      if (!opened) i++; // couldn't reach this address: try the next one
      $("conn").textContent = "reconnecting";
      flash("Hub offline");
      setTimeout(open, 2000);
    };
  };
  open();
}

import type { Tile } from "../core";
import { render } from "../core";
import { caption } from "./caption";
import { Raster } from "./kit";

// The assistant's face: Hitori "Bocchi" Gotoh (Bocchi the Rock), long hair over her eyes, cube hair
// clips, track jacket and guitar. Ported from the "Anime Girl" mini-app (miniapps/show-a-cute-anime,
// drawn on its 144x72 canvas), with her expressions tied to what the assistant is doing:
//   listening / idle  shy, blinks now and then
//   thinking          looks aside, "..." grows beside her
//   working           (a tool is running) tiny pupils, gloom lines, sweat drops, jitter
//   talking           (a reply is up) mouth moves for about as long as the reply takes to say
// Frames step every FRAME_MS and only change when something moves, so an idle avatar costs the
// glasses an image push only per blink (tiles go out only when their pixels change).

export type BocchiMood = "idle" | "listening" | "thinking" | "working" | "talking";

/** The tile: the middle 80x72 of the sprite canvas at 2x. */
export const AVATAR_W = 160;
export const AVATAR_H = 144;
const FRAME_MS = 250;

const W = 144, H = 72;
const CROP_X = 32;
let buf: Uint8Array = new Uint8Array(W * H);

function set(x: number, y: number, v: number) {
  x = Math.round(x);
  y = Math.round(y);
  if (x >= 0 && x < W && y >= 0 && y < H) buf[y * W + x] = v;
}

/** Fill every pixel where pred is true; border pixels get `edge`. */
function region(pred: (x: number, y: number) => boolean, fill: number, edge: number) {
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!pred(x, y)) continue;
      const border = !pred(x - 1, y) || !pred(x + 1, y) || !pred(x, y - 1) || !pred(x, y + 1);
      buf[y * W + x] = border ? edge : fill;
    }
}

function inEll(x: number, y: number, cx: number, cy: number, rx: number, ry: number) {
  const a = (x - cx) / rx, b = (y - cy) / ry;
  return a * a + b * b <= 1;
}

function segDist(x: number, y: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const k = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  const ex = x - (x1 + k * dx), ey = y - (y1 + k * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

// ---- eyes ----
function normalEye(ex: number, ey: number, look: number) {
  region((x, y) => inEll(x, y, ex, ey, 3.5, 4.2), 11, 9);
  region((x, y) => inEll(x, y, ex + look, ey + 0.8, 1.8, 2.4), 3, 4);
  set(ex + look - 1, ey - 1, 15);
  set(ex + look - 1, ey, 15);
  set(ex + look + 1, ey + 2, 14);
}
function tinyPupilEye(ex: number, ey: number) {
  region((x, y) => inEll(x, y, ex, ey, 3.5, 4.2), 1, 12);
  set(ex, ey + 1, 15);
  set(ex + 1, ey + 1, 15);
  set(ex, ey + 2, 15);
  set(ex + 1, ey + 2, 15);
}
function closedEye(ex: number, ey: number) {
  for (let dx = -4; dx <= 4; dx++) {
    const y = ey + 1 + Math.round((16 - dx * dx) / 9);
    set(ex + dx, y, 15);
    set(ex + dx, y - 1, 13);
  }
}

function sweat(x: number, y: number) {
  region((px, py) => inEll(px, py, x, y, 1.6, 2.1), 4, 15);
  set(x, y - 3, 15);
}
/** A little 3D cube hair clip: front square + top/side faces. */
function cube(x: number, y: number) {
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) set(x + i, y + j, i === 0 || j === 0 || i === 4 || j === 4 ? 15 : 9);
  for (let i = 1; i <= 2; i++) {
    set(x + i, y - i, 15);
    set(x + 4 + i, y - i, 15);
    set(x + 4 + i, y + 4 - i, 15);
  }
  for (let i = 1; i <= 6; i++) set(x + i, y - 2, 15);
  set(x + 6, y, 15);
  set(x + 6, y + 1, 15);
}

/** One blink (one frame) at a pseudo-random moment in every 3.5 s. */
function blinkAt(frame: number) {
  const win = 14;
  const k = Math.floor(frame / win);
  const h = Math.imul(k + 1, 2654435761) >>> 0;
  return frame % win === 3 + (h % 9);
}

/** Mouth openness while talking: 0 closed, 1 small, 2 wide. */
const TALK = [1, 2, 1, 0, 2, 1, 2, 0, 1, 1, 2, 0];

/** Draw her on a 144x72 canvas (levels 0..15, cleared to 0 first) at animation step `frame`. */
export function drawBocchi(px: Uint8Array, mood: BocchiMood, frame: number) {
  buf = px;
  px.fill(0);
  const working = mood === "working";
  const bob = mood === "talking" || mood === "thinking" ? Math.floor(frame / 4) % 2 : 0;
  const jit = working ? (frame % 2 ? 1 : -1) : 0;
  const cx = 72 + jit, cy = 23 + bob;

  // Long hair (back), past the shoulders
  region((x, y) => {
    if (inEll(x, y, cx, cy - 2, 18, 17)) return true;
    if (y < cy - 2) return false;
    const tip = Math.abs(((x - cx + 40) % 7) - 3.5);
    return Math.abs(x - cx) <= 17 + (y - cy) / 6 && y <= cy + 42 - tip;
  }, 7, 13);

  // Neck
  region((x, y) => Math.abs(x - cx) <= 3 && y >= cy + 10 && y <= cy + 18, 2, 12);

  // Baggy track jacket, high collar + zipper
  const top = cy + 16;
  region((x, y) => y >= top && Math.abs(x - cx) <= 13 + (y - top) * 0.55 + (y < top + 3 ? -2 : 0), 5, 12);
  region((x, y) => y >= top - 1 && y <= top + 2 && Math.abs(x - cx) <= 6, 6, 13);
  for (let y = top + 3; y < H; y++) set(cx, y, y % 2 ? 11 : 8);
  set(cx + 1, top + 4, 14);
  set(cx + 1, top + 5, 14);

  // Front hair locks over the shoulders
  region((x, y) => {
    if (y < cy + 6 || y > cy + 34 - Math.abs(((x + 20) % 5) - 2.5)) return false;
    const d = Math.abs(x - cx);
    return d >= 11 + (y - cy) / 10 && d <= 16 + (y - cy) / 7;
  }, 7, 13);

  // Guitar (body lower right, neck up to the left)
  const gx = cx + 5, gy = cy + 41;
  region((x, y) => segDist(x, y, gx - 6, gy - 4, cx - 32, cy + 22) <= 1.6, 10, 14);
  region((x, y) => Math.abs(x - (cx - 34)) <= 2.5 && Math.abs(y - (cy + 21)) <= 2, 12, 15);
  region((x, y) => inEll(x, y, gx, gy, 13, 8) || inEll(x, y, gx + 4, gy - 6, 8, 5.5), 10, 15);
  for (let i = -3; i <= 3; i++) {
    set(gx - 2 + i, gy - 1, 3);
    set(gx + 3 + i, gy + 2, 3);
  }
  for (let i = -6; i <= 6; i++) set(gx + i, gy + 4, 13); // bridge
  // Sleeves + hands
  region((x, y) => segDist(x, y, cx - 13, top + 3, cx - 22, cy + 28) <= 3.5, 5, 12);
  region((x, y) => inEll(x, y, cx - 23, cy + 27, 2.6, 2.2), 2, 12);
  region((x, y) => segDist(x, y, cx + 14, top + 3, cx + 9, gy - 2) <= 3.8, 5, 12);
  region((x, y) => inEll(x, y, cx + 8, gy, 2.6, 2.2), 2, 12);

  // Face
  const face = (x: number, y: number) => inEll(x, y, cx, cy + 1, y > cy + 1 ? 13 - (y - cy - 1) * 0.35 : 13, 12);
  region(face, 2, 12);

  // Eyes (under the bangs): aside while thinking, at you while listening or talking
  const ey = cy + 5, lx = cx - 6, rx = cx + 6;
  const look = mood === "thinking" ? -2 : mood === "idle" ? -1 : 0;
  if (working) {
    tinyPupilEye(lx, ey);
    tinyPupilEye(rx, ey);
  } else if (blinkAt(frame)) {
    closedEye(lx, ey);
    closedEye(rx, ey);
  } else {
    normalEye(lx, ey, look);
    normalEye(rx, ey, look);
  }

  // Heavy bangs over the eyes + side locks
  region((x, y) => {
    if (!face(x, y)) return false;
    const spike = 3 - Math.abs(((x - cx + 33) % 6) - 3);
    if (y < cy + spike) return true;
    return Math.abs(x - cx) >= 10 && y < cy + 11;
  }, 7, 13);
  // Ahoge
  for (const [dx, dy] of [[1, -19], [2, -21], [3, -22], [4, -22], [5, -21], [5, -20]]) set(cx + dx, cy + dy, 13);
  // Cube hair clips on one side
  cube(cx + 11, cy - 11);
  cube(cx + 13, cy - 4);

  // Blush
  for (const bx of [cx - 9, cx + 7])
    for (const i of [0, 2]) {
      set(bx + i, cy + 11, 6);
      set(bx + i + 1, cy + 10, 6);
    }

  // Mouth
  const my = cy + 10;
  const open = mood === "talking" ? TALK[frame % TALK.length] : 0;
  if (working) {
    for (let dx = -4; dx <= 4; dx++) set(cx + dx, my + ((dx + 10) % 2), 13); // zigzag
  } else if (open === 2) {
    const hw = [3, 3, 2, 1];
    for (let dy = 0; dy < 4; dy++) for (let dx = -hw[dy]; dx <= hw[dy]; dx++) set(cx + dx, my + dy, dy === 0 ? 14 : dy === 3 ? 12 : 9);
  } else if (open === 1) {
    region((x, y) => inEll(x, y, cx, my + 1, 2.2, 1.6), 9, 14);
  } else {
    for (const [dx, dy] of [[-2, 0], [-1, 1], [0, 0], [1, 1], [2, 0]]) set(cx + dx, my + dy, 12); // shy wavy
  }

  // Effects
  if (mood === "thinking") {
    const n = Math.floor(frame / 2) % 4; // a growing "..."
    for (let i = 0; i < n; i++) {
      set(cx - 28 + i * 3, cy - 8, 12);
      set(cx - 27 + i * 3, cy - 8, 12);
      set(cx - 28 + i * 3, cy - 7, 12);
      set(cx - 27 + i * 3, cy - 7, 12);
    }
  } else if (working) {
    for (let x = cx - 8; x <= cx + 6; x += 3) for (let y = cy - 9; y <= cy - 3; y++) set(x, y, 2); // gloom lines
    const s = (frame * 2) % 10;
    sweat(cx + 16, cy - 1 + s);
    sweat(cx - 16, cy + 3 + ((s + 5) % 10));
  }
}

/** Her picture for a mood at a frame: the middle of the canvas, doubled. */
export function bocchiRaster(mood: BocchiMood, frame: number): Raster {
  const small = new Uint8Array(W * H);
  drawBocchi(small, mood, frame);
  const r = new Raster(AVATAR_W, AVATAR_H);
  const cw = AVATAR_W / 2;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < cw; x++) {
      const v = small[y * W + CROP_X + x];
      if (!v) continue;
      const o = y * 2 * AVATAR_W + x * 2;
      r.px[o] = r.px[o + 1] = r.px[o + AVATAR_W] = r.px[o + AVATAR_W + 1] = v;
    }
  return r;
}

/** About as long as `text` takes to say (her mouth moves this long, then she just blinks). */
export const talkMs = (text: string) => Math.max(1500, Math.min(8000, text.length * 55));

/** Talking while a reply that came at `since` is still being "said". */
export const talkingFor = (since: number, text: string): BocchiMood => (Date.now() - since < talkMs(text) ? "talking" : "idle");

/** Her mood for the push-to-talk caption: listening, thinking or working, then talking. */
export function captionMood(): BocchiMood {
  if (caption.phase === "sent") return caption.working ? "working" : "thinking";
  if (caption.phase === "reply") return talkingFor(caption.repliedAt, caption.reply);
  return "listening";
}

// ---- animation ----

let next: ReturnType<typeof setTimeout> | undefined;

/** Redraw at the next frame step; each draw that still shows her books the one after. */
function keepAnimating() {
  if (next) return;
  next = setTimeout(() => {
    next = undefined;
    render();
  }, FRAME_MS - (Date.now() % FRAME_MS) + 5);
  (next as any).unref?.(); // Node (tests, the Mac runner): never what keeps the process alive
}

/** Her image tile, for a screen's `tiles`. Calling it keeps her animating. */
export function bocchiTile(mood: BocchiMood, slot: Tile["slot"], x: number, y: number): Tile {
  keepAnimating();
  return { slot, x, y, img: bocchiRaster(mood, Math.floor(Date.now() / FRAME_MS)) };
}

import { digits, digitsWidth, label, labelWidth, LABEL_H } from "../../../src/shared/glyphs";
import { Raster } from "../../../src/shared/raster";

/**
 * LAGONDA DIGITAL: the style kit for the lens (576x288, 16 green levels, black = see-through).
 * Every screen that draws its own pixels, or styles firmware text, goes through this module.
 *
 * Levels
 *   LV.value 15 live values and text · LV.focus 15 critical · LV.accent 12 emphasis · LV.label 9 labels
 *   and units · LV.frame 6 hairlines · LV.minor 5 dotted paths · LV.walked 4 · LV.ghost 2 range rings and
 *   unlit segments. Never 1; nothing meaningful below 4. Outlines, not fills; < 15% lit per tile.
 *
 * Image tiles (Raster 288x144 or smaller, levels 0..15; pushed only when their bytes change)
 *   tile(w?, h?)                       blank Raster, default 288x144
 *   frame(r, x, y, w, h, {cut, weight, level, notch})
 *                                      45-degree cut corners (4 small, 8 large), 1 px at 6 or 2 px for
 *                                      emphasis; `notch` = a CAPS label set into the top border
 *   ladder(r, x, y, n, lit, {...})     LED bar of n segments, the first `lit` filled (countdowns)
 *   clockTile(now?, {notch, hour12})   the 288x144 clock (XL digits, AM/PM, date); cached per minute
 *   fmtClock(d) / fmtDate(d)           "9:05" + "AM" (or "21:05"), "WED 21 OCT"
 *   digits(r, x, y, text, "XL"|"L"|"M", {level, ghost, slant}) / digitsWidth(text, size)
 *                                      seven-segment numbers: XL 40x72 (spacing 52), L 24x44 (32),
 *                                      M 14x24 (19); XL/L lean ~7 degrees. 0-9 : . - space AC EF HLPU bdnort
 *   label(r, x, y, text, {level, scale}) / labelWidth(text, scale)
 *                                      square capitals: scale 2 = 12x14 (normal), scale 1 = 7 px (decor)
 *   chevron(r, cx, cy, w, h, {angle, level, knockout})   filled delta (map position, markers)
 *   Raster, pack4/unpack4, toB64/fromB64                  from src/shared/raster (hub and glasses)
 *
 * Firmware text (the glasses' own font: can't be styled, ~12.5 px per character, ~36 px per line)
 *   G.dot G.toast G.sel G.ell G.swap G.deg G.mid   every non-ASCII glyph a string uses, with ASCII
 *                                      fallbacks (localStorage "lensGlyphs" = "ascii" | "unicode")
 *   caps(s), lr(left, right, cols), rule(cols), clip(s, cols)   CAPS labels and fixed-column rows
 *   colsFor(w, pad, border) / rowsFor(h, pad)                   how much text a box holds
 *   checkLayout(page)                  throws on a page the glasses would reject or draw wrongly
 *
 * Screens put tiles and boxes on the lens through core's Screen { tiles, boxes, main, ... }.
 */

export { Raster, pack4, unpack4, toB64, fromB64 } from "../../../src/shared/raster";
export { chevron, digitBox, digits, digitsWidth, hasLabelGlyph, label, labelWidth, LABEL_H, type DigitSize } from "../../../src/shared/glyphs";
export { checkLayout, colsFor, rowsFor } from "./layout";

export const LV = { value: 15, focus: 15, accent: 12, label: 9, frame: 6, minor: 5, walked: 4, ghost: 2 } as const;

// ---------------- firmware glyphs ----------------

// [unicode, ascii]. Glyphs already shown on the lens in production default to unicode; new ones to
// ASCII until LENS TEST shows they render.
const GLYPHS = {
  dot: ["●", "*"],
  toast: ["»", ">"],
  sel: ["›", ">"],
  ell: ["…", "..."],
  swap: ["⇄", "<>"],
  deg: ["°", ""],
  mid: ["·", "-"],
} as const;
type GlyphName = keyof typeof GLYPHS;
const IN_PRODUCTION = new Set<GlyphName>(["dot", "toast", "sel", "ell", "mid"]);

export type GlyphMode = "ascii" | "unicode" | "";
let glyphMode: GlyphMode = readGlyphMode();

function readGlyphMode(): GlyphMode {
  try {
    const v = (globalThis as any).localStorage?.getItem("lensGlyphs");
    return v === "ascii" || v === "unicode" ? v : "";
  } catch {
    return "";
  }
}

/** Force every glyph to ASCII or unicode ("" = per-glyph defaults); remembered in localStorage. */
export function setGlyphMode(m: GlyphMode) {
  glyphMode = m;
  try {
    if (m) (globalThis as any).localStorage?.setItem("lensGlyphs", m);
    else (globalThis as any).localStorage?.removeItem("lensGlyphs");
  } catch {}
}
export const getGlyphMode = () => glyphMode;

const pick = (k: GlyphName) => GLYPHS[k][(glyphMode || (IN_PRODUCTION.has(k) ? "unicode" : "ascii")) === "unicode" ? 0 : 1];
export const G: Record<GlyphName, string> = Object.defineProperties({} as Record<GlyphName, string>, Object.fromEntries(Object.keys(GLYPHS).map((k) => [k, { get: () => pick(k as GlyphName), enumerable: true }])));

// ---------------- firmware text helpers ----------------

export const caps = (s: string) => s.toUpperCase();
/** Cut to `cols` characters. */
export const clip = (s: string, cols: number) => ([...s].length > cols ? [...s].slice(0, cols).join("") : s);
/** `left` and `right` on one row of `cols` characters, right-aligned (left is cut to make room). */
export function lr(left: string, right: string, cols: number): string {
  const l = clip(left, Math.max(0, cols - [...right].length - 1));
  return l + " ".repeat(Math.max(1, cols - [...l].length - [...right].length)) + right;
}
export const rule = (cols: number, ch = "-") => ch.repeat(Math.max(0, cols));

// ---------------- tiles ----------------

export const tile = (w = 288, h = 144) => new Raster(w, h);

/** One 45-degree-cornered outline. */
function outline(r: Raster, x: number, y: number, w: number, h: number, c: number, v: number) {
  const x1 = x + w - 1, y1 = y + h - 1;
  r.polyline([[x + c, y], [x1 - c, y], [x1, y + c], [x1, y1 - c], [x1 - c, y1], [x + c, y1], [x, y1 - c], [x, y + c], [x + c, y]], v);
}

/**
 * A panel outline with 45-degree cut corners. With `notch`, the label sits in a gap in the top border
 * (4 px each side), centred on it, so the border itself moves down half a label height.
 */
export function frame(r: Raster, x: number, y: number, w: number, h: number, o?: { cut?: 4 | 8; weight?: 1 | 2; level?: number; notch?: string; notchLevel?: number }): void {
  const cut = o?.cut ?? 8, weight = o?.weight ?? 1, level = o?.level ?? LV.frame;
  const top = o?.notch ? y + LABEL_H[2] / 2 : y;
  // the inner line of a 2 px frame cuts one less so the diagonals stay solid
  for (let i = 0; i < weight; i++) outline(r, x + i, top + i, w - 2 * i, y + h - top - 2 * i, Math.max(0, cut - i), level);
  if (o?.notch) {
    const lx = x + cut + 8;
    r.fillRect(lx - 4, top, labelWidth(o.notch) + 8, weight, 0);
    label(r, lx, y, o.notch, { level: o.notchLevel ?? LV.label });
  }
}

/** An LED ladder: n segments, the first `lit` filled at `level`, the rest outlined at `ghostLevel` (0 = hidden). */
export function ladder(
  r: Raster, x: number, y: number, n: number, lit: number,
  o?: { segW?: number; segH?: number; gap?: number; vertical?: boolean; level?: number; ghostLevel?: number },
): void {
  const sw = o?.segW ?? 12, sh = o?.segH ?? 6, gap = o?.gap ?? 3, level = o?.level ?? LV.value, ghost = o?.ghostLevel ?? LV.ghost;
  for (let i = 0; i < n; i++) {
    // vertical ladders fill from the bottom up
    const sx = o?.vertical ? x : x + i * (sw + gap);
    const sy = o?.vertical ? y + (n - 1 - i) * (sh + gap) : y;
    if (i < lit) r.fillRect(sx, sy, sw, sh, level);
    else if (ghost) r.rect(sx, sy, sw, sh, ghost);
  }
}

// ---------------- clock ----------------

const HOUR12 = (() => {
  try {
    return Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 ?? true;
  } catch {
    return true;
  }
})();
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "9:05" + "AM" on a 12-hour locale, "21:05" on a 24-hour one. */
export function fmtClock(d: Date, hour12 = HOUR12): { hm: string; ampm?: "AM" | "PM" } {
  const h = d.getHours(), m = pad2(d.getMinutes());
  return hour12 ? { hm: `${h % 12 || 12}:${m}`, ampm: h < 12 ? "AM" : "PM" } : { hm: `${pad2(h)}:${m}` };
}

/** "WED 21 OCT" (English capitals: the label font is A-Z only). */
export const fmtDate = (d: Date) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;

let clockCache: { key: string; r: Raster } | null = null;

/**
 * The 288x144 clock tile: frame with a notch, XL time, AM/PM stacked to its right (lit one bright),
 * date below. The same Raster comes back until the minute changes, so don't draw on it.
 */
export function clockTile(now = new Date(), o?: { notch?: string; hour12?: boolean }): Raster {
  const { hm, ampm } = fmtClock(now, o?.hour12);
  const date = fmtDate(now);
  const notch = o?.notch ?? "TIME";
  const key = `${hm}|${ampm}|${date}|${notch}`;
  if (clockCache?.key === key) return clockCache.r;
  const r = tile();
  frame(r, 0, 0, 288, 144, { cut: 8, notch });
  const dw = digitsWidth(hm, "XL");
  const lean = 9; // XL's slant overhang at the top
  const apW = ampm ? 6 + labelWidth("AM", 1) : 0;
  const x = Math.round((288 - dw - lean - apW) / 2);
  digits(r, x, 28, hm, "XL", { level: LV.value });
  if (ampm) {
    const ax = x + dw + lean + 6;
    label(r, ax, 30, "AM", { scale: 1, level: ampm === "AM" ? LV.value : 3 });
    label(r, ax, 41, "PM", { scale: 1, level: ampm === "PM" ? LV.value : 3 });
  }
  label(r, Math.round((288 - labelWidth(date)) / 2), 112, date, { level: LV.label });
  clockCache = { key, r };
  return r;
}

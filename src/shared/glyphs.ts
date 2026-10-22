import { Raster } from "./raster.js";

// "Lagonda digital" lettering for image tiles: seven-segment digits and a small square-cornered,
// extended capital font (Microgramma/Eurostile in spirit; no font file). Pure, like raster.ts, so the
// hub's map renderer and the glasses both draw with it.

// ---------------- seven-segment digits ----------------

export type DigitSize = "XL" | "L" | "M";

/** Box w x h, segment thickness t, joint gap g, digit spacing (advance), sheared or upright by default. */
const SIZES: Record<DigitSize, { w: number; h: number; t: number; g: number; sp: number; slant: boolean }> = {
  XL: { w: 40, h: 72, t: 8, g: 2, sp: 52, slant: true },
  L: { w: 24, h: 44, t: 5, g: 2, sp: 32, slant: true },
  M: { w: 14, h: 24, t: 3, g: 1, sp: 19, slant: false },
};

// Segments: a top, b top right, c bottom right, d bottom, e bottom left, f top left, g middle.
const SEGS: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg", "5": "acdfg", "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg",
  "-": "g", " ": "",
  A: "abcefg", C: "adef", E: "adefg", F: "aefg", H: "bcefg", L: "def", P: "abefg", U: "bcdef",
  b: "cdefg", d: "bcdeg", n: "ceg", o: "cdeg", r: "eg", t: "defg",
};

// A colon or decimal point takes half the digit spacing and sits centred in the black gap between
// the digits around it: its centre is this far from the start of its half cell.
const markX = (s: { w: number; sp: number }) => (s.sp / 2 - (s.sp - s.w)) / 2;

/** Width in pixels of `text` drawn with digits() (the slant overhang is not counted). */
export function digitsWidth(text: string, size: DigitSize): number {
  const s = SIZES[size];
  let x = 0;
  let right = 0;
  for (const c of text) {
    if (c === "." || c === ":") {
      right = x + markX(s) + s.t / 2;
      x += s.sp / 2;
    } else if (c in SEGS) {
      right = x + s.w;
      x += s.sp;
    }
  }
  return Math.round(right);
}

/**
 * Seven-segment text at (x, y) = top left of the first digit box. Segments are six-sided bars with
 * 45-degree points, shortened by g at each end so the joints show black. Returns the width drawn.
 * Supported: 0-9 : . - space and A C E F H L P U b d n o r t (anything else is skipped).
 */
export function digits(r: Raster, x: number, y: number, text: string, size: DigitSize, o?: { level?: number; ghost?: boolean; slant?: boolean }): number {
  const s = SIZES[size];
  const level = o?.level ?? 15;
  const slant = o?.slant ?? s.slant;
  const shear = (px: number, py: number): [number, number] => [x0 + px + (slant ? (s.h - py) / 8 : 0), y + py];
  let x0 = x;
  const { w, h, t, g } = s;
  const ht = t / 2;
  const hSeg = (cy: number): [number, number][] => {
    const a = ht + g, b = w - ht - g;
    return [[a, cy], [a + ht, cy - ht], [b - ht, cy - ht], [b, cy], [b - ht, cy + ht], [a + ht, cy + ht]];
  };
  const vSeg = (cx: number, top: number, bottom: number): [number, number][] => {
    const a = top + g, b = bottom - g;
    return [[cx, a], [cx + ht, a + ht], [cx + ht, b - ht], [cx, b], [cx - ht, b - ht], [cx - ht, a + ht]];
  };
  const shapes: Record<string, [number, number][]> = {
    a: hSeg(ht), g: hSeg(h / 2), d: hSeg(h - ht),
    f: vSeg(ht, ht, h / 2), b: vSeg(w - ht, ht, h / 2), e: vSeg(ht, h / 2, h - ht), c: vSeg(w - ht, h / 2, h - ht),
  };
  const square = (cx: number, cy: number) => {
    const pts: [number, number][] = [[cx - ht, cy - ht], [cx + ht, cy - ht], [cx + ht, cy + ht], [cx - ht, cy + ht]];
    r.fillPoly(pts.map(([px, py]) => shear(px, py)), level);
  };
  for (const c of text) {
    if (c === "." || c === ":") {
      const cx = markX(s);
      if (c === ".") square(cx, h - ht);
      else {
        square(cx, Math.round(h * 0.3));
        square(cx, Math.round(h * 0.7));
      }
      x0 += s.sp / 2;
      continue;
    }
    const on = SEGS[c];
    if (on === undefined) continue;
    for (const k of "abcdefg") {
      const lit = on.includes(k);
      if (!lit && !o?.ghost) continue;
      r.fillPoly(shapes[k].map(([px, py]) => shear(px, py)), lit ? level : 2);
    }
    x0 += s.sp;
  }
  return digitsWidth(text, size);
}

/** The pixel size of one digit box, for layout. */
export function digitBox(size: DigitSize): { w: number; h: number; t: number } {
  const s = SIZES[size];
  return { w: s.w, h: s.h, t: s.t };
}

// ---------------- label font ----------------

// 7 rows each; '#' = ink. Most capitals are 6 wide; I, 1 and punctuation are narrower, M/T/W/Y wider.
const FONT: Record<string, string> = {
  A: "######|#....#|#....#|######|#....#|#....#|#....#",
  B: "#####.|#....#|#....#|######|#....#|#....#|######",
  C: "######|#.....|#.....|#.....|#.....|#.....|######",
  D: "#####.|#....#|#....#|#....#|#....#|#....#|#####.",
  E: "######|#.....|#.....|#####.|#.....|#.....|######",
  F: "######|#.....|#.....|#####.|#.....|#.....|#.....",
  G: "######|#.....|#.....|#..###|#....#|#....#|######",
  H: "#....#|#....#|#....#|######|#....#|#....#|#....#",
  I: "#|#|#|#|#|#|#",
  J: ".....#|.....#|.....#|.....#|.....#|#....#|######",
  K: "#....#|#...#.|#..#..|###...|#..#..|#...#.|#....#",
  L: "#.....|#.....|#.....|#.....|#.....|#.....|######",
  M: "#######|#..#..#|#..#..#|#..#..#|#.....#|#.....#|#.....#",
  N: "#....#|##...#|#.#..#|#..#.#|#...##|#....#|#....#",
  O: "######|#....#|#....#|#....#|#....#|#....#|######",
  P: "######|#....#|#....#|######|#.....|#.....|#.....",
  Q: "######|#....#|#....#|#....#|#..#.#|#...##|######",
  R: "######|#....#|#....#|######|#...#.|#....#|#....#",
  S: "######|#.....|#.....|######|.....#|.....#|######",
  T: "#######|...#...|...#...|...#...|...#...|...#...|...#...",
  U: "#....#|#....#|#....#|#....#|#....#|#....#|######",
  V: "#....#|#....#|#....#|#....#|.#..#.|.#..#.|..##..",
  W: "#.....#|#.....#|#.....#|#..#..#|#..#..#|#..#..#|#######",
  X: "#....#|#....#|.#..#.|..##..|.#..#.|#....#|#....#",
  Y: "#.....#|#.....#|#.....#|#######|...#...|...#...|...#...",
  Z: "######|.....#|....#.|...#..|..#...|.#....|######",
  "0": "######|#....#|#...##|#..#.#|#.#..#|##...#|######",
  "1": "##|.#|.#|.#|.#|.#|.#",
  "2": "######|.....#|.....#|######|#.....|#.....|######",
  "3": "######|.....#|.....#|.#####|.....#|.....#|######",
  "4": "#....#|#....#|#....#|######|.....#|.....#|.....#",
  "5": "######|#.....|######|.....#|.....#|.....#|######",
  "6": "######|#.....|#.....|######|#....#|#....#|######",
  "7": "######|.....#|.....#|....#.|...#..|...#..|...#..",
  "8": "######|#....#|#....#|######|#....#|#....#|######",
  "9": "######|#....#|#....#|######|.....#|.....#|######",
  ".": ".|.|.|.|.|.|#",
  ",": "..|..|..|..|..|.#|#.",
  ":": ".|.|#|.|.|#|.",
  "-": "....|....|....|####|....|....|....",
  "/": "....#|....#|...#.|..#..|.#...|#....|#....",
  "'": "#|#|.|.|.|.|.",
  "°": "###|#.#|###|...|...|...|...",
  "%": "##...#|##..#.|...#..|..#...|.#....|#...##|....##",
  ">": "#...|.#..|..#.|...#|..#.|.#..|#...",
  "<": "...#|..#.|.#..|#...|.#..|..#.|...#",
  "+": ".....|..#..|..#..|#####|..#..|..#..|.....",
  "?": "######|.....#|.....#|..####|..#...|......|..#...",
  "(": "##|#.|#.|#.|#.|#.|##",
  ")": "##|.#|.#|.#|.#|.#|##",
  "#": ".#..#.|######|.#..#.|.#..#.|######|.#..#.|......",
};
const GLYPHS = new Map(Object.entries(FONT).map(([c, s]) => [c, s.split("|")]));

/** Width of `text` in label(); 2 px (x scale) between letters, 12 px gaps for spaces at scale 2. */
export function labelWidth(text: string, scale: 1 | 2 = 2): number {
  let x = 0;
  let right = 0;
  for (const ch of text.toUpperCase()) {
    if (ch === " ") {
      x += 4 * scale;
      continue;
    }
    const g = GLYPHS.get(ch);
    if (!g) continue;
    right = x + g[0].length * scale;
    x += (g[0].length + 2) * scale;
  }
  return right;
}

/**
 * Capitals at (x, y) = top left; scale 2 (12x14 letters, the normal size) or 1 (7 px, decoration and
 * AM/PM only). Lowercase is drawn as uppercase; characters the font lacks are skipped. Returns the width.
 */
export function label(r: Raster, x: number, y: number, text: string, o?: { level?: number; scale?: 1 | 2 }): number {
  const scale = o?.scale ?? 2;
  const level = o?.level ?? 9;
  let cx = Math.round(x);
  for (const ch of text.toUpperCase()) {
    if (ch === " ") {
      cx += 4 * scale;
      continue;
    }
    const g = GLYPHS.get(ch);
    if (!g) continue;
    for (let row = 0; row < g.length; row++)
      for (let col = 0; col < g[row].length; col++) if (g[row][col] === "#") r.fillRect(cx + col * scale, y + row * scale, scale, scale, level);
    cx += (g[0].length + 2) * scale;
  }
  return labelWidth(text, scale);
}

export const LABEL_H = { 1: 7, 2: 14 } as const;

/** Does the label font have this character? (Spaces count.) */
export const hasLabelGlyph = (ch: string) => ch === " " || GLYPHS.has(ch.toUpperCase());

// ---------------- marks ----------------

/**
 * A filled delta (the map's position chevron, list markers): w x h, centred on (cx, cy), pointing
 * `angle` degrees clockwise from up, with a notch cut into its tail. `knockout` paints a ring of
 * level 0 around it first so it reads on top of roads.
 */
export function chevron(r: Raster, cx: number, cy: number, w: number, h: number, o?: { angle?: number; level?: number; knockout?: number; notch?: number }): void {
  const a = ((o?.angle ?? 0) * Math.PI) / 180;
  const notch = o?.notch ?? h / 4;
  const shape: [number, number][] = [[0, -h / 2], [w / 2, h / 2], [0, h / 2 - notch], [-w / 2, h / 2]];
  const rot = (k: number): [number, number][] =>
    shape.map(([px, py]) => {
      const s = 1 + (k * 2) / Math.max(w, h);
      const qx = px * s, qy = py * s;
      return [cx + qx * Math.cos(a) - qy * Math.sin(a), cy + qx * Math.sin(a) + qy * Math.cos(a)];
    });
  if (o?.knockout) r.fillPoly(rot(o.knockout), 0);
  r.fillPoly(rot(0), o?.level ?? 15);
}

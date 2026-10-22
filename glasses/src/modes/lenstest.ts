import { imageResults, type Mode, type Screen } from "../core";
import { digits, frame, G, getGlyphMode, label, ladder, LV, setGlyphMode, tile, type Raster } from "../ui/kit";

// LENS TEST: what the glasses actually draw. Page 1 shows the kit's pixel art (digits, lettering,
// frames, a ladder); page 2 numbered glyph candidates for the firmware font (tell Jarvis which ones
// show, and the G table defaults get updated); page 3 a ruler for tuning the columns/lines estimates;
// page 4 one test-pattern tile per image payload format (the iPhone app's experimental BMP/LZ4
// variants, forced for that push), with the format's name drawn into the tile and the push result below.
// Swipe = page, tap (page 2) = flip the lens glyphs between ASCII and unicode, tap (page 4) = next
// format, double tap = back.

const PAGES = 4;
let page = 0;

let tiles: [Raster, Raster] | null = null;
function art(): [Raster, Raster] {
  if (tiles) return tiles;
  const a = tile();
  digits(a, 8, 2, "14", "XL", { level: LV.value, ghost: true });
  digits(a, 8 + 104, 2, ":32", "XL", { level: LV.value }); // ghost off, for comparison
  digits(a, 8, 82, "1.2", "L", { level: LV.value });
  label(a, 92, 112, "KM", { level: LV.label });
  digits(a, 130, 82, "89-AbC", "M", { level: LV.accent });
  digits(a, 130, 110, "01234567", "M", { level: LV.value });
  ladder(a, 8, 136, 10, 6);
  const b = tile();
  frame(b, 0, 0, 288, 144, { cut: 8, notch: "FRAME 8" });
  frame(b, 12, 22, 120, 52, { cut: 4, weight: 2, level: LV.accent, notch: "W2" });
  frame(b, 144, 22, 132, 52, { cut: 4, notch: "CUT 4" });
  label(b, 14, 84, "ABCDEFGHIJKLM");
  label(b, 14, 102, "NOPQRSTUVWXYZ");
  label(b, 14, 124, "0123456789 .,:-/'°%><+?()# AM PM", { scale: 1 });
  return (tiles = [a, b]);
}

/** G2Kit ImageFormat raw values, standard first as the baseline. */
const FORMATS = ["standard", "rle4", "rle8", "1bit", "lz4", "lz4-frag"];
let format = 0;

/** Grid, a 16-level ramp, lines, mostly-black space like a map, and the format name: if it reads right, it rendered. */
const patterns = new Map<string, Raster>();
export function formatPattern(name: string): Raster {
  const cached = patterns.get(name);
  if (cached) return cached;
  const r = tile();
  patterns.set(name, r);
  for (let x = 0; x < 288; x += 24) r.line(x, 0, x, 104, LV.minor);
  for (let y = 0; y < 104; y += 24) r.line(0, y, 287, y, LV.minor);
  r.rect(0, 0, 288, 144, LV.value);
  r.line(2, 102, 140, 2, LV.accent, 2);
  r.fillRect(150, 30, 120, 50, 0);
  label(r, 156, 40, name, { level: LV.value });
  label(r, 156, 62, "GRID RAMP", { level: LV.label, scale: 1 });
  for (let v = 0; v < 16; v++) r.fillRect(4 + v * 17, 110, 17, 30, v);
  return r;
}

const CANDIDATES = ["01 ●  02 »  03 ›  04 ▸", "05 ⇄  06 …  07 ←  08 ↱", "09 ↶  10 ▮  11 ▯  12 ─", "13 █  14 °  15 ·  16 ✓"].join("\n");

export const lenstest: Mode = {
  id: "lenstest",
  title: "Lens test",
  enter() {
    page = 0;
  },
  screen(): Screen {
    const head = `LENS TEST ${page + 1}/${PAGES}   SWIPE: PAGE`;
    if (page === 0) {
      const [a, b] = art();
      return {
        header: head,
        tiles: [
          { slot: 0, x: 0, y: 48, img: a },
          { slot: 1, x: 288, y: 48, img: b },
        ],
        main: { x: 12, y: 204, w: 552, h: 84, pad: 6 },
        body: "XL 14 GHOST ON :32 OFF  L 1.2 KM  M DIGITS\nLADDER 6/10  FRAMES CUT 8, 4, 2 PX  LABELS",
      };
    }
    if (page === 1) {
      const mode = getGlyphMode() || "defaults";
      return {
        header: `${head}   TAP: GLYPHS`,
        body: `WHICH OF THESE SHOW?\n${CANDIDATES}\nIN USE (${mode.toUpperCase()}): ${G.dot} ${G.toast} ${G.sel} ${G.ell} ${G.swap} ${G.deg} ${G.mid}`,
      };
    }
    if (page === 3) {
      const f = FORMATS[format];
      const last = imageResults.get("tile0");
      const res = last && last.format === f ? `${last.result.toUpperCase()} IN ${last.ms} MS` : "SENDING…";
      return {
        header: `${head}   TAP: NEXT FORMAT`,
        tiles: [{ slot: 0, x: 144, y: 44, img: formatPattern(f.toUpperCase()), format: f }],
        main: { x: 12, y: 196, w: 552, h: 92, pad: 6 },
        body: `FORMAT ${format + 1}/${FORMATS.length}: ${f.toUpperCase()}   ${res}\nDOES THE TILE SHOW ${f.toUpperCase()}, A GRID AND 16 STEPS?`,
      };
    }
    // 46 columns and 8 numbered lines, edge to edge: count what fits.
    const ruler = "1234567890".repeat(5).slice(0, 46);
    return { header: "", noHeader: true, main: { x: 0, y: 0, w: 576, h: 288, pad: 0 }, body: [ruler, ...[2, 3, 4, 5, 6, 7, 8].map((n) => `${n} ${"-".repeat(40)} ${n}`)].join("\n") };
  },
  gesture(g) {
    if (g === "up" || g === "down") page = (page + (g === "down" ? 1 : PAGES - 1)) % PAGES;
    else if (g === "tap" && page === 3) format = (format + 1) % FORMATS.length;
    else if (g === "tap" && page === 1) setGlyphMode(getGlyphMode() === "ascii" ? "unicode" : getGlyphMode() === "unicode" ? "" : "ascii");
    else return false;
    return true;
  },
};

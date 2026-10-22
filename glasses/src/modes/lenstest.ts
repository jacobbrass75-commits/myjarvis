import { type Mode, type Screen } from "../core";
import { digits, frame, G, getGlyphMode, label, ladder, LV, setGlyphMode, tile, type Raster } from "../ui/kit";

// LENS TEST: what the glasses actually draw. Page 1 shows the kit's pixel art (digits, lettering,
// frames, a ladder); page 2 numbered glyph candidates for the firmware font (tell Jarvis which ones
// show, and the G table defaults get updated); page 3 a ruler for tuning the columns/lines estimates.
// Swipe = page, tap (page 2) = flip the lens glyphs between ASCII and unicode, double tap = back.

const PAGES = 3;
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
    // 46 columns and 8 numbered lines, edge to edge: count what fits.
    const ruler = "1234567890".repeat(5).slice(0, 46);
    return { header: "", noHeader: true, main: { x: 0, y: 0, w: 576, h: 288, pad: 0 }, body: [ruler, ...[2, 3, 4, 5, 6, 7, 8].map((n) => `${n} ${"-".repeat(40)} ${n}`)].join("\n") };
  },
  gesture(g) {
    if (g === "up" || g === "down") page = (page + (g === "down" ? 1 : PAGES - 1)) % PAGES;
    else if (g === "tap" && page === 1) setGlyphMode(getGlyphMode() === "ascii" ? "unicode" : getGlyphMode() === "unicode" ? "" : "ascii");
    else return false;
    return true;
  },
};

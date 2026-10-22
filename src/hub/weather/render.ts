import { digits, digitsWidth, label, labelWidth } from "../../shared/glyphs.js";
import type { WxLayer } from "../../shared/protocol.js";
import { Raster } from "../../shared/raster.js";
import {
  at, CITIES, contour, extrema, hourIndex, lattice, levels, polyLength, project, sampleCubic, sampleLinear, unproject, windUV,
  DETAIL, FAST, type Extremum, type Lattice, type View, type WxGrid, type XY,
} from "./grid.js";
import { REGIONS } from "./outline.js";
import type { Radar } from "./radar.js";

// The weather map, "Weather Channel" style in Lagonda green, in two views: "detail", the whole 576x288
// lens (four 288x144 tiles), California a little right of centre, the ocean on the left holding the
// readouts drawn in; and "fast", just the state in 288x288 (two tiles), the readouts left to text.
// Six layers:
//   sky       clouds as dim texture (dots = low/mid deck, strokes = high cirrus) with rain on top:
//             the model's hourly precipitation, and RainViewer radar at "now"
//   pressure  isobars every 4 hPa (2 when the field is flat), labelled; H and L centres; streamlines
//             of the 10 m wind, with particle frames the glasses cycle to animate the airflow
//   temp      2 m temperature as dithered levels on a dot lattice, isotherms every 10 degrees
//   precip    radar (RainViewer, "now" only) or the model's hourly precipitation, dithered
//   clouds    the cloud textures brighter, total-cover contours at 50% (solid) and 90% (dashed)
//   wind      10 m wind speed as dithered levels, arrows on a grid
// Detail readouts set into the corners: WX CALIFORNIA + layer + valid time (top left), model run +
// forecast step ladder (top right), legend (bottom left), California's extreme for the layer (bottom right).
// Outlines, not fills; under 15% of each tile lit (the shading thins out until it fits).

/** Swipe order on the glasses; "sky" (clouds dim, rain bright on top) is the default. */
export const WX_LAYERS: WxLayer[] = ["sky", "pressure", "temp", "precip", "clouds", "wind"];
/** Forecast steps, hours ahead. */
export const WX_STEPS = [0, 6, 12, 24];

const LIT_BUDGET = 0.15;
const LV = { shadeLo: 2, shadeHi: 10, stream: 3, border: 5, iso: 7, ca: 13, text: 9, value: 15, frame: 6, city: 12 } as const;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Readout panels; nothing else is drawn under them. */
export const PANELS = {
  title: { x: 6, y: 4, w: 200, h: 74 },
  run: { x: 446, y: 4, w: 124, h: 74 },
  legend: { x: 6, y: 206, w: 170, h: 78 },
  stat: { x: 446, y: 206, w: 124, h: 78 },
} satisfies Record<string, Rect>;
/** The view being drawn (renderWx is synchronous) and its panels: none on the fast map, text boxes do that job. */
let V: View = DETAIL;
let PANEL_LIST: Rect[] = Object.values(PANELS);
const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inPanel = (x: number, y: number, pad = 0) => PANEL_LIST.some((p) => x >= p.x - pad && x < p.x + p.w + pad && y >= p.y - pad && y < p.y + p.h + pad);

export { CITIES };

export interface WxRenderOpts {
  layer: WxLayer;
  /** Hours ahead (one of WX_STEPS). */
  step: number;
  /** "Now" (ms): step 0 is the hour nearest it. */
  now: number;
  /** Model run (initialisation) time, ms. */
  run?: number;
  model?: string;
  pos?: { lat: number; lon: number } | null;
  /** Live radar for the precip layer at step 0. */
  radar?: Radar | null;
  hour12?: boolean;
  /** "detail" (default): the whole lens with readouts drawn in; "fast": a 288x288 map only (FAST), readouts go to text. */
  view?: "fast" | "detail";
}

/** California's extremes for the layer, and what the readouts need (the fast layout shows them as text). */
export interface WxInfo {
  lo: number;
  hi: number;
  source: "MODEL" | "RADAR";
  /** Isobar spacing (hPa) on the pressure layer. */
  interval?: number;
  tempUnit: "F" | "C";
  /** sky, clouds: California's average total cloud cover (%). */
  cloud?: number;
}

export interface WxRender {
  img: Raster;
  /** Animation frames: flat [x0, y0, x1, y1, ...] particle segments to draw over img (pressure layer). */
  frames: number[][];
  /** Valid time of the hour drawn (ms). */
  valid: number;
  /** "RADAR" when the precip layer shows RainViewer, else "MODEL". */
  source: "MODEL" | "RADAR";
  isobars: number[];
  extrema: Extremum[];
  info: WxInfo;
  /** Tile indices (row by row, 288x144 each) in the order to push them: California's first, then the fuller ones. */
  order: number[];
}

// ---------------- fields ----------------

interface Fields {
  p: Lattice;
  t: Lattice;
  ws: Lattice;
  /** Pixel-space wind (x east, y down), mph. */
  vx: Lattice;
  vy: Lattice;
  pr: Lattice;
  /** Cloud cover, %: total, low/mid deck (the larger), high. */
  c: Lattice;
  lm: Lattice;
  hc: Lattice;
}

function fields(g: WxGrid, h: number): Fields {
  const v = g.vars;
  // u/v from the grid's own components (interpolating directions would wrap at 360)
  const u = new Float32Array(g.nx * g.ny), n = new Float32Array(g.nx * g.ny);
  for (let k = 0; k < u.length; k++) [u[k], n[k]] = windUV(v.ws[h][k], v.wd[h][k]);
  return {
    p: lattice((la, lo) => sampleCubic(v.p[h], g, la, lo), 4, V),
    t: lattice((la, lo) => sampleCubic(v.t[h], g, la, lo), 4, V),
    ws: lattice((la, lo) => Math.max(0, sampleLinear(v.ws[h], g, la, lo)), 4, V),
    vx: lattice((la, lo) => sampleLinear(u, g, la, lo), 4, V),
    vy: lattice((la, lo) => -sampleLinear(n, g, la, lo), 4, V),
    c: lattice((la, lo) => sampleLinear(v.c[h], g, la, lo), 4, V),
    lm: lattice((la, lo) => Math.max(sampleLinear(v.cl[h], g, la, lo), sampleLinear(v.cm[h], g, la, lo)), 4, V),
    hc: lattice((la, lo) => sampleLinear(v.ch[h], g, la, lo), 4, V),
    pr: lattice((la, lo) => Math.max(0, sampleLinear(v.pr[h], g, la, lo)), 4, V),
  };
}

// ---------------- drawing helpers ----------------

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((x) => (x + 0.5) / 16);

/**
 * Dithered levels on a staggered dot lattice every `sp` px: ramp() gives 0..1 (or < 0 for nothing),
 * mapped onto LV.shadeLo..shadeHi with an ordered dither between neighbouring levels.
 */
function shade(r: Raster, ramp: (x: number, y: number) => number, sp: number, lo: number = LV.shadeLo, hi: number = LV.shadeHi) {
  for (let row = 0, y = 1; y < V.h; row++, y += sp)
    for (let col = 0, x = 1 + (row & 1 ? sp >> 1 : 0); x < V.w; col++, x += sp) {
      if (inPanel(x, y, 2)) continue;
      const f = ramp(x, y);
      if (!(f >= 0)) continue;
      const lv = lo + Math.min(1, f) * (hi - lo);
      const fl = Math.floor(lv);
      r.set(x, y, lv - fl > BAYER[(row & 3) * 4 + (col & 3)] ? fl + 1 : fl);
    }
}

/** A 1 px outline with 45-degree corners and, optionally, a CAPS label set into its top border. */
function panel(r: Raster, p: Rect, notch?: string, level: number = LV.frame) {
  r.fillRect(p.x, p.y, p.w, p.h, 0);
  const top = notch ? p.y + 7 : p.y, c = 6, x1 = p.x + p.w - 1, y1 = p.y + p.h - 1;
  r.polyline([[p.x + c, top], [x1 - c, top], [x1, top + c], [x1, y1 - c], [x1 - c, y1], [p.x + c, y1], [p.x, y1 - c], [p.x, top + c], [p.x + c, top]], level);
  if (notch) {
    const lx = p.x + c + 6;
    r.fillRect(lx - 3, top, labelWidth(notch) + 6, 1, 0);
    label(r, lx, p.y, notch, { level: LV.text });
  }
}

function lensFrame(r: Raster) {
  const c = 8, x1 = V.w - 1, y1 = V.h - 1;
  r.polyline([[c, 0], [x1 - c, 0], [x1, c], [x1, y1 - c], [x1 - c, y1], [c, y1], [0, y1 - c], [0, c], [c, 0]], LV.frame);
}

function outlines(r: Raster) {
  const ring = (flat: number[]) => {
    const pts: XY[] = [];
    for (let i = 0; i < flat.length; i += 2) pts.push(project(flat[i + 1], flat[i], V));
    return pts;
  };
  for (const reg of REGIONS) if (reg.id !== "CA") for (const rg of reg.rings) r.polyline(ring(rg), LV.border);
  for (const reg of REGIONS) if (reg.id === "CA") for (const rg of reg.rings) r.polyline(ring(rg), LV.ca);
}

/** Inside California (even-odd over its rings, so lakes and islands come out right). */
export function inCalifornia(lat: number, lon: number): boolean {
  let inside = false;
  for (const reg of REGIONS)
    if (reg.id === "CA")
      for (const rg of reg.rings)
        for (let i = 0, j = rg.length - 2; i < rg.length; j = i, i += 2) {
          const xi = rg[i], yi = rg[i + 1], xj = rg[j], yj = rg[j + 1];
          if (yi > lat !== yj > lat && lon < xi + ((lat - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
        }
  return inside;
}

/** Point at arc length s along a polyline. */
function along(p: XY[], s: number): XY {
  for (let i = 1; i < p.length; i++) {
    const d = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    if (s <= d) {
      const t = d ? s / d : 0;
      return [p[i - 1][0] + t * (p[i][0] - p[i - 1][0]), p[i - 1][1] + t * (p[i][1] - p[i - 1][1])];
    }
    s -= d;
  }
  return p[p.length - 1];
}

/** Contour labels: on the longer lines, knocked out of the line, never in a panel or on another label. */
function contourLabels(r: Raster, lines: { level: number; pts: XY[] }[], text: (lv: number) => string, taken: Rect[]) {
  const placed: { rect: Rect; s: string; level: number }[] = [];
  const sorted = lines.map((l) => ({ ...l, len: polyLength(l.pts) })).filter((l) => l.len > 50).sort((a, b) => b.len - a.len);
  for (const l of sorted) {
    const s = text(l.level);
    const w = labelWidth(s, 1) + 4, h = 11;
    const fracs = l.len > 360 ? [0.5, 0.2, 0.8] : [0.5, 0.35, 0.65];
    let n = 0;
    for (const f of fracs) {
      if (n >= (l.len > 360 ? 2 : 1)) break;
      const [cx, cy] = along(l.pts, l.len * f);
      const rect = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
      if (rect.x < 6 || rect.y < 6 || rect.x + w > V.w - 6 || rect.y + h > V.h - 6) continue;
      if (PANEL_LIST.some((p) => hits(p, rect)) || taken.some((t) => hits(t, rect))) continue;
      taken.push({ x: rect.x - 20, y: rect.y - 8, w: rect.w + 40, h: rect.h + 16 }); // keep labels apart
      placed.push({ rect, s, level: l.level });
      n++;
    }
  }
  for (const p of placed) {
    r.fillRect(p.rect.x, p.rect.y, p.rect.w, p.rect.h, 0);
    label(r, p.rect.x + 2, p.rect.y + 2, p.s, { scale: 1, level: LV.text });
  }
}

// ---------------- wind ----------------

/**
 * Evenly spaced streamlines (a light Jobard-Lefer): seeds every 22 px, traced both ways in 2 px steps
 * until the flow stalls, leaves the lens, runs into a panel or comes within 6 px of another line.
 */
export function streamlines(vx: Lattice, vy: Lattice, o?: { seed?: number; sep?: number; maxLen?: number }): XY[][] {
  const sep = o?.sep ?? 14, dtest = sep * 0.55, maxLen = o?.maxLen ?? 170, step = 2;
  const cell = sep;
  const cw = Math.ceil(V.w / cell), ch = Math.ceil(V.h / cell);
  const grid: XY[][] = Array.from({ length: cw * ch }, () => []);
  const near = (x: number, y: number, d: number, own?: Set<number>) => {
    const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
    for (let b = cj - 1; b <= cj + 1; b++)
      for (let a = ci - 1; a <= ci + 1; a++) {
        if (a < 0 || b < 0 || a >= cw || b >= ch) continue;
        if (own?.has(b * cw + a)) continue;
        for (const [px, py] of grid[b * cw + a]) if ((px - x) ** 2 + (py - y) ** 2 < d * d) return true;
      }
    return false;
  };
  const dir = (x: number, y: number): XY | null => {
    const u = at(vx, x, y), v = at(vy, x, y), s = Math.hypot(u, v);
    return s < 1 ? null : [u / s, v / s];
  };
  const trace = (x: number, y: number, sign: 1 | -1): XY[] => {
    const pts: XY[] = [];
    let len = 0;
    while (len < maxLen) {
      const d1 = dir(x, y);
      if (!d1) break;
      const mx = x + (sign * d1[0] * step) / 2, my = y + (sign * d1[1] * step) / 2;
      const d2 = dir(mx, my);
      if (!d2) break;
      const nx = x + sign * d2[0] * step, ny = y + sign * d2[1] * step;
      if (nx < 3 || ny < 3 || nx > V.w - 3 || ny > V.h - 3 || inPanel(nx, ny, 3) || near(nx, ny, dtest)) break;
      // no tight loops back onto itself
      if (pts.length > 8 && pts.slice(0, -6).some(([px, py]) => (px - nx) ** 2 + (py - ny) ** 2 < dtest * dtest)) break;
      pts.push([nx, ny]);
      x = nx;
      y = ny;
      len += step;
    }
    return pts;
  };
  let h = o?.seed ?? 1;
  const rnd = () => ((h = (h * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const lines: XY[][] = [];
  for (let sy = 12; sy < V.h; sy += 24)
    for (let sx = 12; sx < V.w; sx += 24) {
      const x = sx + (rnd() - 0.5) * 14, y = sy + (rnd() - 0.5) * 14;
      if (inPanel(x, y, 4) || near(x, y, sep) || !dir(x, y)) continue;
      const back = trace(x, y, -1).reverse();
      const fwd = trace(x, y, 1);
      const line: XY[] = [...back, [x, y], ...fwd];
      if (line.length * step < 26) continue;
      lines.push(line);
      for (const [px, py] of line) {
        const ci = Math.floor(px / cell), cj = Math.floor(py / cell);
        if (ci >= 0 && cj >= 0 && ci < cw && cj < ch) grid[cj * cw + ci].push([px, py]);
      }
    }
  return lines;
}

/** A small open arrowhead at the end of a line, pointing along its last step. */
function arrowHead(r: Raster, tip: XY, from: XY, size: number, level: number) {
  const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  for (const s of [-1, 1]) r.line(tip[0], tip[1], tip[0] - size * Math.cos(a + s * 0.55), tip[1] - size * Math.sin(a + s * 0.55), level);
}

/** Particle frames along the streamlines: dashes 6 px long every 30 px, moved a quarter step per frame. */
export function particleFrames(lines: XY[][], n = 4, spacing = 30, dash = 6): number[][] {
  const frames: number[][] = Array.from({ length: n }, () => []);
  lines.forEach((l, li) => {
    const len = polyLength(l);
    if (len < 30) return;
    const offset = (li * 7.3) % spacing;
    for (let f = 0; f < n; f++)
      for (let s = offset + (f * spacing) / n; s + dash <= len; s += spacing) {
        const a = along(l, s), b = along(l, s + dash);
        frames[f].push(Math.round(a[0]), Math.round(a[1]), Math.round(b[0]), Math.round(b[1]));
      }
  });
  return frames;
}

// ---------------- readouts ----------------

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const HOUR12 = (() => {
  try {
    return Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 ?? true;
  } catch {
    return true;
  }
})();

/** "4:00" + "PM" + "TUE" (or "16:00"). */
export function fmtValid(ms: number, hour12 = HOUR12): { hm: string; ampm?: string; day: string } {
  const d = new Date(ms);
  const h = d.getHours(), m = String(d.getMinutes()).padStart(2, "0");
  return hour12 ? { hm: `${h % 12 || 12}:${m}`, ampm: h < 12 ? "AM" : "PM", day: DAYS[d.getDay()] } : { hm: `${String(h).padStart(2, "0")}:${m}`, day: DAYS[d.getDay()] };
}

const LAYER_NAME: Record<WxLayer, string> = { sky: "SKY", pressure: "PRESSURE", temp: "TEMPERATURE", precip: "RAIN", clouds: "CLOUDS", wind: "WIND SPEED" };

function readouts(r: Raster, o: WxRenderOpts, valid: number, g: WxGrid, f: Fields, source: "MODEL" | "RADAR") {
  // title: WX CALIFORNIA, layer, valid time and step
  const T = PANELS.title;
  panel(r, T, "WX CALIFORNIA");
  label(r, T.x + 10, T.y + 22, LAYER_NAME[o.layer], { level: LV.value });
  const v = fmtValid(valid, o.hour12);
  const dw = digits(r, T.x + 10, T.y + 44, v.hm, "M", { level: LV.value });
  let x = T.x + 10 + dw + 6;
  if (v.ampm) label(r, x, T.y + 44, v.ampm, { scale: 1, level: LV.text });
  label(r, x, T.y + 56, v.day, { scale: 1, level: LV.text });
  x += labelWidth("WED", 1) + 8;
  const stepText = o.step ? `+${o.step}H` : "NOW";
  label(r, Math.max(x, T.x + T.w - 10 - labelWidth(stepText)), T.y + 50, stepText, { level: o.step ? LV.value : LV.text });

  // run: model and cycle, the forecast step ladder
  const R = PANELS.run;
  panel(r, R, "RUN");
  const cyc = o.run ? `${String(new Date(o.run).getUTCHours()).padStart(2, "0")}Z` : "--Z";
  label(r, R.x + 10, R.y + 22, `${o.model ?? "GFS"} ${cyc}`, { level: LV.value });
  const segW = 22, gap = 5;
  WX_STEPS.forEach((s, i) => {
    const sx = R.x + 10 + i * (segW + gap), sy = R.y + 44;
    if (s === o.step) r.fillRect(sx, sy, segW, 7, LV.value);
    else r.rect(sx, sy, segW, 7, LV.frame);
    const t = s ? String(s) : "NOW";
    label(r, sx + Math.round((segW - labelWidth(t, 1)) / 2), sy + 12, t, { scale: 1, level: s === o.step ? LV.value : LV.text });
  });

  // legend
  const L = PANELS.legend;
  panel(r, L, "LEGEND");
  const lx = L.x + 10, ly = L.y + 22;
  const tu = g.tempUnit;
  if (o.layer === "pressure") {
    r.line(lx, ly + 3, lx + 22, ly + 3, LV.iso);
    label(r, lx + 30, ly, "ISOBARS HPA", { scale: 1, level: LV.text });
    digits(r, lx, ly + 14, "H", "M", { level: LV.value });
    label(r, lx + 18, ly + 22, "HIGH", { scale: 1, level: LV.text });
    digits(r, lx + 56, ly + 14, "L", "M", { level: LV.value });
    label(r, lx + 74, ly + 22, "LOW", { scale: 1, level: LV.text });
    r.line(lx + 110, ly + 30, lx + 140, ly + 24, LV.stream + 2);
    arrowHead(r, [lx + 140, ly + 24], [lx + 130, ly + 26], 4, LV.stream + 4);
    label(r, lx + 110, ly + 36, "WIND", { scale: 1, level: LV.text });
  } else if (o.layer === "sky" || o.layer === "clouds") {
    // a dot patch, a cirrus stroke, then a rain patch (sky) or the 50% line (clouds)
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) r.set(lx + 1 + i * 3, ly + 1 + j * 3, o.layer === "sky" ? 4 : 8);
    label(r, lx + 16, ly, "LOW+MID", { scale: 1, level: LV.text });
    r.line(lx + 76, ly + 6, lx + 80, ly + 2, o.layer === "sky" ? 3 : 7);
    r.line(lx + 82, ly + 6, lx + 86, ly + 2, o.layer === "sky" ? 3 : 7);
    label(r, lx + 92, ly, "HIGH", { scale: 1, level: LV.text });
    if (o.layer === "sky") {
      for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) r.set(lx + 1 + i * 2, ly + 15 + j * 2, 13);
      label(r, lx + 16, ly + 16, source === "RADAR" ? "RAIN RADAR+GFS" : "RAIN GFS", { scale: 1, level: LV.text });
    } else {
      r.line(lx, ly + 19, lx + 12, ly + 19, LV.iso);
      label(r, lx + 16, ly + 16, "50% COVER", { scale: 1, level: LV.text });
    }
    if (source === "RADAR") label(r, lx, ly + 30, "RADAR RAINVIEWER", { scale: 1, level: LV.text });
  } else {
    const [lo, hi, unit] = o.layer === "temp" ? (tu === "C" ? ["0", "38", "C"] : ["30", "100", "F"]) : o.layer === "wind" ? ["0", "40", "MPH"] : ["", "", source === "RADAR" ? "RADAR" : "MM/H"];
    // ramp: eight boxes, darkest to brightest
    for (let i = 0; i < 8; i++) {
      const lv = Math.round(LV.shadeLo + (i / 7) * (LV.shadeHi + 4 - LV.shadeLo));
      r.fillRect(lx + i * 18, ly + 2, 14, 6, lv);
    }
    if (lo) label(r, lx, ly + 14, lo, { scale: 1, level: LV.text });
    if (hi) label(r, lx + 8 * 18 - 4 - labelWidth(hi, 1), ly + 14, hi, { scale: 1, level: LV.text });
    label(r, lx + (lo ? 40 : 0), ly + 14, o.layer === "precip" ? (source === "RADAR" ? "LIGHT - HEAVY" : "0.1 - 5 MM/H") : unit, { scale: 1, level: LV.text });
    if (o.layer === "temp") label(r, lx, ly + 30, `ISOTHERMS 10${tu === "C" ? "C" : "F"}`, { scale: 1, level: LV.text });
    if (o.layer === "wind") label(r, lx, ly + 30, "ARROWS: FLOW", { scale: 1, level: LV.text });
    if (o.layer === "precip") label(r, lx, ly + 30, source === "RADAR" ? "RADAR RAINVIEWER" : "MODEL GFS HOURLY", { scale: 1, level: LV.text });
  }
  label(r, lx, L.y + L.h - 13, "OPEN-METEO", { scale: 1, level: 4 });

  // stat: California's extreme for the layer
  const S = PANELS.stat;
  const { lo, hi } = caRange(o.layer, f);
  const statRows: [string, string][] =
    o.layer === "pressure" ? [["LO", String(Math.round(lo))], ["HI", String(Math.round(hi))]]
    : o.layer === "temp" ? [["HI", String(Math.round(hi))], ["LO", String(Math.round(lo))]]
    : o.layer === "wind" ? [["MAX", String(Math.round(hi))]]
    : o.layer === "clouds" ? [["AVG %", String(Math.round(caCloud(f)))], ["MIN %", String(Math.round(lo))]]
    : o.layer === "sky" ? [["CLD %", String(Math.round(caCloud(f)))], ["MM/H", hi.toFixed(1)]]
    : [["MAX", hi.toFixed(1)]];
  panel(r, S, o.layer === "pressure" ? "CA HPA" : o.layer === "temp" ? `CA ${tu}` : o.layer === "wind" ? "CA MPH" : o.layer === "clouds" ? "CLOUD" : o.layer === "sky" ? "CA SKY" : source === "RADAR" ? "GFS MM/H" : "CA MM/H");
  statRows.forEach(([k, val], i) => {
    const y = S.y + 22 + i * 28;
    label(r, S.x + 10, y + 6, k, { scale: 1, level: LV.text });
    const text = val.replace(/[^0-9.\-]/g, "");
    digits(r, S.x + S.w - 10 - digitsWidth(text, "M"), y, text, "M", { level: LV.value });
  });
}

/** Lowest and highest value of the layer's field over California. */
function caRange(layer: WxLayer, f: Fields): { lo: number; hi: number } {
  let lo = Infinity, hi = -Infinity;
  const lat: Lattice = layer === "pressure" ? f.p : layer === "temp" ? f.t : layer === "wind" ? f.ws : layer === "clouds" ? f.c : f.pr;
  for (let j = 0; j < lat.h; j++)
    for (let i = 0; i < lat.w; i++) {
      const { lat: la, lon } = unproject(i * lat.step, j * lat.step, V);
      if (!inCalifornia(la, lon)) continue;
      const x = lat.v[j * lat.w + i];
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  return Number.isFinite(lo) ? { lo, hi } : { lo: 0, hi: 0 };
}

/** California's average total cloud cover, %. */
function caCloud(f: Fields): number {
  let s = 0, n = 0;
  for (let j = 0; j < f.c.h; j++)
    for (let i = 0; i < f.c.w; i++) {
      const { lat, lon } = unproject(i * f.c.step, j * f.c.step, V);
      if (inCalifornia(lat, lon)) (s += f.c.v[j * f.c.w + i]), n++;
    }
  return n ? s / n : 0;
}

/**
 * Cloud textures: the low/mid deck as a dot lattice (brighter = thicker), high cloud as short
 * diagonal strokes on a 12 px grid (cirrus). `dim` keeps them under the rain on the sky layer.
 */
function cloudTexture(r: Raster, f: Fields, sp: number, dim: boolean) {
  shade(r, (x, y) => {
    const c = at(f.lm, x, y);
    return c < 15 ? -1 : (c - 15) / 85;
  }, sp, 2, dim ? 3 : 9);
  for (let row = 0, y = 6; y < V.h; row++, y += 12)
    for (let x = 6 + (row & 1 ? 6 : 0); x < V.w; x += 12) {
      const c = at(f.hc, x, y);
      if (c < 30 || inPanel(x, y, 4)) continue;
      r.line(x - 2, y + 2, x + 2, y - 2, dim ? 2 : 3 + Math.round((c / 100) * 4));
    }
}

/** Share of each tile (288x144, row by row) that is California, per view; fixed, so worked out once. */
const caShare = new Map<View, number[]>();
function caTiles(): number[] {
  let share = caShare.get(V);
  if (!share) {
    share = [];
    for (let ty = 0; ty < V.h; ty += 144)
      for (let tx = 0; tx < V.w; tx += 288) {
        let n = 0, k = 0;
        for (let y = ty + 2; y < ty + 144; y += 4)
          for (let x = tx + 2; x < tx + 288; x += 4, k++) {
            const { lat, lon } = unproject(x, y, V);
            if (inCalifornia(lat, lon)) n++;
          }
        share.push(n / k);
      }
    caShare.set(V, share);
  }
  return share;
}

/** Push order: the tiles with the most California first (what you look at), then by how much is lit. */
function tileOrder(img: Raster): number[] {
  const share = caTiles();
  const score = share.map((s, i) => {
    const tx = (i % (V.w / 288)) * 288, ty = Math.floor(i / (V.w / 288)) * 144;
    return Math.round(s * 20) * 10 + img.crop(tx, ty, 288, 144).lit();
  });
  return score.map((_, i) => i).sort((a, b) => score[b] - score[a]);
}

// ---------------- the map ----------------

/** City dots with tiny labels (plus the city's own reading on temp and wind), and your position. */
function cities(r: Raster, o: WxRenderOpts, g: WxGrid, h: number, f: Fields, taken: Rect[]) {
  let me: XY | null = null;
  if (o.pos) {
    const [x, y] = project(o.pos.lat, o.pos.lon, V).map(Math.round) as XY;
    if (x > 8 && y > 8 && x < V.w - 8 && y < V.h - 8 && !inPanel(x, y)) me = [x, y];
  }
  for (const c of CITIES) {
    const [x, y] = project(c.lat, c.lon, V).map(Math.round) as XY;
    const site = g.sites.find((s) => s.lat === c.lat && s.lon === c.lon);
    const reading = (v: "t" | "ws", l: Lattice) => {
      const own = site?.v[v][h];
      return Math.round(own !== undefined && Number.isFinite(own) ? own : at(l, x, y));
    };
    let text = c.name;
    if (o.layer === "temp") text += ` ${reading("t", f.t)}`;
    else if (o.layer === "wind") text += ` ${reading("ws", f.ws)}`;
    const w = labelWidth(text, 1);
    // you're in this city: the position mark stands for the dot, the label moves clear of it
    const here = me && Math.abs(me[0] - x) <= 8 && Math.abs(me[1] - y) <= 8;
    const gap = here ? 9 : 5;
    const tx = c.left ? x - gap - w : x + gap;
    if (!here) {
      r.fillRect(x - 2, y - 2, 5, 5, 0);
      r.fillRect(x - 1, y - 1, 3, 3, LV.city);
    }
    r.fillRect(tx - 1, y - 4, w + 2, 9, 0);
    label(r, tx, y - 3, text, { scale: 1, level: LV.city });
    taken.push({ x: Math.min(x - 3, tx - 2), y: y - 6, w: w + 4 + gap, h: 13 });
  }
  if (me) {
    const [x, y] = me;
    r.fillRect(x - 6, y - 6, 13, 13, 0);
    r.rect(x - 5, y - 5, 11, 11, LV.value);
    r.fillRect(x - 1, y - 1, 3, 3, LV.value);
    taken.push({ x: x - 8, y: y - 8, w: 17, h: 17 });
  }
}

function hilo(r: Raster, ex: Extremum[], taken: Rect[]) {
  for (const e of ex) {
    // the letter on the centre, nudged up or down a little if a readout panel or a city is in the way
    for (const dy of [0, -10, 10, -20, 20]) {
      const y = e.y + dy;
      const rect = { x: e.x - 12, y: y - 15, w: 26, h: 38 };
      if (rect.x < 4 || rect.x + rect.w > V.w - 4 || rect.y < 4 || rect.y + rect.h > V.h - 4 || PANEL_LIST.some((p) => hits(p, rect)) || taken.some((t) => hits(t, rect))) continue;
      r.fillRect(rect.x, rect.y, rect.w, rect.h, 0);
      digits(r, e.x - 7, y - 13, e.kind, "M", { level: LV.value });
      const s = String(Math.round(e.value));
      label(r, e.x - Math.round(labelWidth(s, 1) / 2), y + 14, s, { scale: 1, level: LV.text });
      taken.push(rect);
      break;
    }
  }
}

/** Isobar spacing: 4 hPa, or 2 when the whole map spans less than 10. */
export function isobarInterval(p: Lattice): number {
  let lo = Infinity, hi = -Infinity;
  for (const x of p.v) (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
  return hi - lo < 10 ? 2 : 4;
}

/** Draw one layer at one forecast step. */
export function renderWx(g: WxGrid, o: WxRenderOpts): WxRender {
  const fast = o.view === "fast";
  V = fast ? FAST : DETAIL;
  PANEL_LIST = fast ? [] : Object.values(PANELS);
  const h = hourIndex(g, o.now + o.step * 3_600_000);
  const valid = g.times[h];
  const f = fields(g, h);
  const radar = (o.layer === "precip" || o.layer === "sky") && o.step === 0 ? o.radar ?? null : null;
  const source = radar ? "RADAR" : "MODEL";
  const tempLo = g.tempUnit === "C" ? -1 : 30, tempSpan = g.tempUnit === "C" ? 39 : 70;

  const lines = o.layer === "pressure" ? streamlines(f.vx, f.vy) : [];
  let isobars: number[] = [], ex: Extremum[] = [];
  let img = new Raster(V.w, V.h);
  for (let dim = 0; dim <= 3; dim++) {
    img = new Raster(V.w, V.h);
    const sp = 3 + dim;
    const taken: Rect[] = [];
    if (o.layer === "temp") shade(img, (x, y) => (at(f.t, x, y) - tempLo) / tempSpan, sp);
    else if (o.layer === "wind") shade(img, (x, y) => { const s = at(f.ws, x, y); return s < 3 ? -1 : s / 40; }, sp);
    else if (o.layer === "precip")
      shade(img, (x, y) => {
        if (radar) {
          const { lat, lon } = unproject(x, y, V);
          const v = radar.sample(lat, lon);
          return v > 0 ? v : -1;
        }
        const p = at(f.pr, x, y);
        return p < 0.05 ? -1 : (Math.log10(p) + 1.3) / 2;
      }, Math.max(2, sp - 1), 3, 12);
    else if (o.layer === "clouds") cloudTexture(img, f, sp, false);
    else if (o.layer === "sky") {
      cloudTexture(img, f, sp + 1, true);
      // rain on top, bright: radar (now) or the model, whichever shows more
      shade(img, (x, y) => {
        const p = at(f.pr, x, y);
        let v = p < 0.05 ? -1 : (Math.log10(p) + 1.3) / 2;
        if (radar) {
          const { lat, lon } = unproject(x, y, V);
          const rv = radar.sample(lat, lon);
          if (rv > 0) v = Math.max(v, rv);
        }
        return v;
      }, Math.max(2, sp - 1), 8, 14);
    }

    if (o.layer === "pressure")
      for (const l of lines) {
        img.polyline(l, dim >= 2 ? 2 : LV.stream);
        if (l.length > 6) arrowHead(img, l[l.length - 1], l[l.length - 4], 4, LV.stream + 2);
      }
    if (o.layer === "wind")
      for (let y = 18; y < V.h; y += 30)
        for (let x = 18 + ((y / 30) & 1 ? 15 : 0); x < V.w; x += 30) {
          if (inPanel(x, y, 12)) continue;
          const u = at(f.vx, x, y), v = at(f.vy, x, y), s = Math.hypot(u, v);
          if (s < 2) continue;
          const len = Math.min(22, 5 + s * 0.6);
          const tip: XY = [x + (u / s) * len / 2, y + (v / s) * len / 2];
          img.line(x - (u / s) * len / 2, y - (v / s) * len / 2, tip[0], tip[1], 10);
          arrowHead(img, tip, [x, y], 4, 10);
        }

    outlines(img);

    if (o.layer === "pressure" || o.layer === "temp") {
      const field = o.layer === "pressure" ? f.p : f.t;
      const interval = o.layer === "pressure" ? isobarInterval(f.p) : g.tempUnit === "C" ? 5 : 10;
      const lvls = levels(field, interval);
      const cl = lvls.flatMap((lv) => contour(field, lv).map((pts) => ({ level: lv, pts })));
      for (const c of cl) img.polyline(c.pts, o.layer === "pressure" ? LV.iso : 6);
      if (o.layer === "pressure") {
        isobars = lvls;
        ex = extrema(f.p, { minProm: 1 });
      }
      cities(img, o, g, h, f, taken);
      if (o.layer === "pressure") hilo(img, ex, taken);
      contourLabels(img, cl, (lv) => String(Math.round(lv)), taken);
    } else if (o.layer === "clouds" || o.layer === "sky") {
      // cloud edges (clouds only; sky stays quiet under the rain): 50% total cover solid, 90% dashed, labelled
      const cl = o.layer === "clouds" ? [50, 90].flatMap((lv) => contour(f.c, lv).map((pts) => ({ level: lv, pts }))) : [];
      for (const c of cl) img.polyline(c.pts, LV.iso, 1, c.level === 90 ? [3, 3] : undefined);
      cities(img, o, g, h, f, taken);
      contourLabels(img, cl, (lv) => `${lv}%`, taken);
    } else cities(img, o, g, h, f, taken);

    if (!fast) readouts(img, o, valid, g, f, source);
    lensFrame(img);
    let lit = 0;
    for (let ty = 0; ty < V.h; ty += 144) for (let tx = 0; tx < V.w; tx += 288) lit = Math.max(lit, img.crop(tx, ty, 288, 144).lit());
    if (lit <= LIT_BUDGET - 0.01) break; // room for the particles
  }
  const info: WxInfo = {
    ...caRange(o.layer, f), source, tempUnit: g.tempUnit,
    ...(o.layer === "pressure" ? { interval: isobarInterval(f.p) } : {}),
    ...(o.layer === "sky" || o.layer === "clouds" ? { cloud: Math.round(caCloud(f)) } : {}),
  };
  return { img, frames: o.layer === "pressure" ? particleFrames(lines) : [], valid, source, isobars, extrema: ex, info, order: tileOrder(img) };
}

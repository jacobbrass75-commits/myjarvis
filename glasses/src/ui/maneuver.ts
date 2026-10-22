import type { Maneuver } from "../../../src/shared/protocol";
import type { Raster } from "../../../src/shared/raster";
import { LV } from "./kit";

// Turn arrows for the Navigate readout, in the Lagonda style: straight stems, 45/90-degree bends, a
// 90-degree arrow head and a square-cut tail; no curves. Drawn in a 96-unit box and scaled.
// Outlined (3 px) while the turn is far off, filled when it's close.

type Pt = [number, number];

/** Arrow polygon along a centreline (mitred joins), with a head of length hl and half-width hw at the end. */
function arrow(line: Pt[], half = 6, hl = 30, hw = 30): Pt[] {
  const n = line.length;
  const nrm = (a: Pt, b: Pt): Pt => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [dy / l, -dx / l]; // left of the direction of travel (y down)
  };
  const left: Pt[] = [], right: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const n1 = nrm(line[Math.max(0, i - 1)], line[Math.max(1, i)]);
    const n2 = nrm(line[Math.min(i, n - 2)], line[Math.min(i + 1, n - 1)]);
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const k = half / Math.max(0.3, mx * n1[0] + my * n1[1]);
    left.push([line[i][0] + mx * k, line[i][1] + my * k]);
    right.push([line[i][0] - mx * k, line[i][1] - my * k]);
  }
  const end = line[n - 1], prev = line[n - 2];
  const dl = Math.hypot(end[0] - prev[0], end[1] - prev[1]) || 1;
  const ux = (end[0] - prev[0]) / dl, uy = (end[1] - prev[1]) / dl;
  const [lx, ly] = nrm(prev, end);
  return [...left, [end[0] + lx * hw, end[1] + ly * hw], [end[0] + ux * hl, end[1] + uy * hl], [end[0] - lx * hw, end[1] - ly * hw], ...right.reverse()];
}

const mirror = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [96 - x, y]);

const SHAPES: Record<string, () => Pt[][]> = {
  straight: () => [arrow([[48, 92], [48, 38]])],
  left: () => [arrow([[62, 92], [62, 46], [36, 46]])],
  "slight left": () => [arrow([[58, 92], [58, 58], [38, 38]], 6, 24, 24)],
  "sharp left": () => [arrow([[72, 92], [72, 30], [46, 56]], 6, 20, 20)],
  uturn: () => [arrow([[66, 92], [66, 28], [30, 28], [30, 54]], 6, 22, 20)],
};

/** An octagon ring (cut corners) with the way in from below and the exit straight on. */
function roundabout(): Pt[][] {
  const oct = (r: number): Pt[] => {
    const c = r * 0.414; // 45-degree corner cut of a square of half-size r
    return [[48 - c, 46 - r], [48 + c, 46 - r], [48 + r, 46 - c], [48 + r, 46 + c], [48 + c, 46 + r], [48 - c, 46 + r], [48 - r, 46 + c], [48 - r, 46 - c]];
  };
  return [oct(24), oct(14), [[42, 70], [54, 70], [54, 92], [42, 92]], arrow([[48, 22], [48, 18]], 6, 14, 14)];
}

/**
 * The maneuver `kind` in a size x size box at (x, y): outlined 3 px when far, filled when close (<= 50 m).
 * "arrive" is the destination square; "depart" draws as straight.
 */
export function drawManeuver(r: Raster, x: number, y: number, size: number, kind: Maneuver | undefined, filled: boolean, level: number = LV.value): void {
  const k = size / 96;
  const to = (pts: Pt[]): Pt[] => pts.map(([px, py]) => [x + px * k, y + py * k]);
  const t = Math.max(1, Math.round(3 * (size / 96)));
  if (kind === "arrive") {
    const s = Math.round(56 * k), o = Math.round((size - s) / 2);
    r.rect(x + o, y + o, s, s, level, t);
    const inner = Math.round(20 * k), io = Math.round((size - inner) / 2);
    if (filled) r.fillRect(x + io, y + io, inner, inner, level);
    else r.rect(x + io, y + io, inner, inner, level, Math.max(1, t - 1));
    return;
  }
  let polys: Pt[][];
  if (kind === "roundabout") {
    const [outer, inner, entry, exit] = roundabout().map(to);
    // the ring is a band between two octagons: outline both, or fill the band
    if (filled) {
      r.fillPoly(outer, level);
      r.fillPoly(inner, 0);
      r.fillPoly(entry, level);
      r.fillPoly(exit, level);
    } else for (const p of [outer, inner, entry, exit]) r.polyline([...p, p[0]], level, t);
    return;
  }
  const name = kind === "depart" || !kind ? "straight" : kind;
  const right = name.endsWith("right");
  const base = SHAPES[right ? name.replace("right", "left") : name] ?? SHAPES.straight;
  polys = base().map((p) => to(right ? mirror(p) : p));
  for (const p of polys) {
    if (filled) r.fillPoly(p, level);
    else r.polyline([...p, p[0]], level, t);
  }
}

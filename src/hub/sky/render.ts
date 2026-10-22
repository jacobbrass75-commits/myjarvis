import { label, labelWidth, LABEL_H } from "../../shared/glyphs.js";
import { Raster } from "../../shared/raster.js";
import { FIGURE_SEGMENTS, STARS, type BodyId } from "./astro.js";

// The SKY NOW chart: a 288x288 all-sky disc, zenith in the middle, horizon on the rim, drawn the way
// you'd hold a star map over your head (north up, east LEFT, west right). Azimuthal equidistant: the
// radius is the zenith distance. Lagonda levels: horizon hairline 6, 30/60 degree rings dotted 2,
// constellation lines 4 (kept clear of their stars), stars by magnitude (15 / 12 / 8 / 6), planets
// as bright rings with 3-letter capitals, the Moon with its lit side toward the Sun, the ISS as an X.

export const SKY_W = 288;
export const SKY_H = 288;
const CX = 144, CY = 144, R = 138;

export interface ChartBody { id: BodyId | "iss"; alt: number; az: number; mag: number; label?: string }
export interface ChartInput {
  stars: { alt: Float32Array; az: Float32Array };
  limitMag: number;
  bodies: ChartBody[];
  /** Moon: phase angle (0 full .. 180 new); the Sun's alt/az orients its lit side. */
  moon?: { phaseAngle: number };
  sun?: { alt: number; az: number };
  /** Corner labels: top left (time step), bottom left (latitude). */
  corner?: { tl?: string; bl?: string; br?: string };
}

/** Lens pixel of an altitude/azimuth (null below the horizon). */
export function skyXY(alt: number, az: number, clipHorizon = true): [number, number] | null {
  if (clipHorizon && alt < 0) return null;
  const r = (R * (90 - alt)) / 90, a = (az * Math.PI) / 180;
  return [CX - r * Math.sin(a), CY - r * Math.cos(a)];
}

function ring(r: Raster, cx: number, cy: number, rad: number, v: number, dash?: [number, number]) {
  const n = Math.max(24, Math.round(rad * 6.3));
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) pts.push([cx + rad * Math.cos((i / n) * 2 * Math.PI), cy + rad * Math.sin((i / n) * 2 * Math.PI)]);
  if (!dash) return r.polyline(pts, v);
  pts.forEach(([x, y], i) => i % (dash[0] + dash[1]) < dash[0] && r.set(x, y, v));
}

function disc(r: Raster, cx: number, cy: number, rad: number, v: number) {
  for (let y = -rad; y <= rad; y++) for (let x = -rad; x <= rad; x++) if (x * x + y * y <= rad * rad + rad * 0.6) r.set(cx + x, cy + y, v);
}

function star(r: Raster, x: number, y: number, mag: number) {
  if (mag < 0.5) {
    r.fillRect(x - 1, y - 1, 3, 3, 15);
    r.set(x - 2, y, 12), r.set(x + 2, y, 12), r.set(x, y - 2, 12), r.set(x, y + 2, 12);
  } else if (mag < 1.5) {
    r.set(x, y, 15), r.set(x - 1, y, 12), r.set(x + 1, y, 12), r.set(x, y - 1, 12), r.set(x, y + 1, 12);
  } else if (mag < 2.5) {
    r.set(x, y, 15), r.set(x + 1, y, 9), r.set(x, y + 1, 9);
  } else if (mag < 3.5) r.set(x, y, 12);
  else r.set(x, y, mag < 4 ? 8 : 6);
}

type Box = [number, number, number, number];
const hits = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** The chart. Returns the raster (levels 0..15). */
export function renderSky(o: ChartInput): Raster {
  const r = new Raster(SKY_W, SKY_H);
  ring(r, CX, CY, R / 3, 2, [1, 3]); // 60 degree altitude ring
  ring(r, CX, CY, (R * 2) / 3, 2, [1, 3]); // 30 degree altitude ring
  r.set(CX, CY, 4), r.set(CX - 2, CY, 3), r.set(CX + 2, CY, 3), r.set(CX, CY - 2, 3), r.set(CX, CY + 2, 3);
  ring(r, CX, CY, R, 6);

  const { alt, az } = o.stars;
  const pts = STARS.map((_, i) => skyXY(alt[i], az[i]));
  // constellation lines once it's dark enough to see their stars, gapped 3 px at each end
  if (o.limitMag >= 3)
    for (const f of FIGURE_SEGMENTS)
      for (const [i, j] of f.segs) {
        const a = pts[i], b = pts[j];
        if (!a || !b) continue;
        const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (len < 9 || len > 120) continue;
        const ux = dx / len, uy = dy / len;
        r.line(a[0] + ux * 4, a[1] + uy * 4, b[0] - ux * 4, b[1] - uy * 4, 4);
      }
  for (let i = 0; i < STARS.length; i++) {
    const p = pts[i];
    if (p && STARS[i].mag <= o.limitMag) star(r, Math.round(p[0]), Math.round(p[1]), STARS[i].mag);
  }

  // labels: placed around their mark, avoiding each other, the rim letters and the corner labels
  const taken: Box[] = [];
  const place = (x: number, y: number, text: string, level: number, gap = 7) => {
    const w = labelWidth(text), h = LABEL_H[2];
    const tries: [number, number][] = [[x + gap, y - h / 2], [x - gap - w, y - h / 2], [x - w / 2, y - gap - h], [x - w / 2, y + gap]];
    for (const [lx, ly] of tries) {
      const b: Box = [lx - 2, ly - 2, lx + w + 2, ly + h + 2];
      const inside = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].every(([px, py]) => Math.hypot(px - CX, py - CY) < R - 2);
      if (!inside || taken.some((t) => hits(t, b))) continue;
      taken.push(b);
      r.fillRect(b[0] + 1, b[1] + 1, b[2] - b[0] - 2, b[3] - b[1] - 2, 0);
      label(r, Math.round(lx), Math.round(ly), text, { level });
      return;
    }
  };
  // the compass letters on the rim: N top, E left, S bottom, W right (looking up)
  const rim: [string, number, number][] = [["N", CX, CY - R + 12], ["S", CX, CY + R - 12], ["E", CX - R + 11, CY], ["W", CX + R - 11, CY]];
  for (const [t, x, y] of rim) {
    const w = labelWidth(t), h = LABEL_H[2];
    const b: Box = [x - w / 2 - 3, y - h / 2 - 3, x + w / 2 + 3, y + h / 2 + 3];
    r.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1], 0);
    label(r, Math.round(x - w / 2), Math.round(y - h / 2), t, { level: 9 });
    taken.push(b);
  }

  if (o.sun && o.sun.alt > -0.833) {
    const p = skyXY(Math.max(0, o.sun.alt), o.sun.az)!;
    disc(r, p[0], p[1], 9, 0);
    ring(r, p[0], p[1], 5, 15);
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      r.line(p[0] + 7 * Math.cos(a), p[1] + 7 * Math.sin(a), p[0] + 9 * Math.cos(a), p[1] + 9 * Math.sin(a), 12);
    }
    taken.push([p[0] - 10, p[1] - 10, p[0] + 10, p[1] + 10]);
  }

  // brightest last, so it wins the label places near it
  const bodies = [...o.bodies].filter((b) => b.alt >= 0).sort((a, b) => b.mag - a.mag);
  const marks: { b: ChartBody; p: [number, number] }[] = [];
  for (const b of bodies) {
    const p = skyXY(b.alt, b.az)!;
    marks.push({ b, p });
    if (b.id === "moon") {
      const rad = 7;
      disc(r, p[0], p[1], rad + 2, 0);
      // lit where the terminator ellipse allows, on the side facing the Sun
      const s = o.sun ? skyXY(o.sun.alt, o.sun.az, false)! : [p[0], p[1] - 1];
      let ux = s[0] - p[0], uy = s[1] - p[1];
      const n = Math.hypot(ux, uy) || 1;
      ux /= n;
      uy /= n;
      const k = Math.cos(((o.moon?.phaseAngle ?? 0) * Math.PI) / 180);
      for (let y = -rad; y <= rad; y++)
        for (let x = -rad; x <= rad; x++) {
          const d2 = (x * x + y * y) / (rad * rad);
          if (d2 > 1) continue;
          const along = (x * ux + y * uy) / rad, perp = (x * -uy + y * ux) / rad;
          if (along >= -k * Math.sqrt(Math.max(0, 1 - perp * perp))) r.set(p[0] + x, p[1] + y, 12);
        }
      ring(r, p[0], p[1], rad, 6);
      taken.push([p[0] - rad - 2, p[1] - rad - 2, p[0] + rad + 2, p[1] + rad + 2]);
    } else if (b.id === "iss") {
      disc(r, p[0], p[1], 5, 0);
      r.line(p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4, 15, 2);
      r.line(p[0] - 4, p[1] + 4, p[0] + 4, p[1] - 4, 15, 2);
      taken.push([p[0] - 6, p[1] - 6, p[0] + 6, p[1] + 6]);
    } else {
      disc(r, p[0], p[1], 5, 0);
      ring(r, p[0], p[1], 4, 15);
      r.set(p[0], p[1], 15);
      taken.push([p[0] - 5, p[1] - 5, p[0] + 5, p[1] + 5]);
    }
  }
  for (const { b, p } of marks) if (b.label) place(p[0], p[1], b.label, b.id === "iss" ? 15 : 12, b.id === "moon" ? 10 : 7);

  // corner readouts sit outside the disc
  if (o.corner?.tl) label(r, 2, 2, o.corner.tl, { level: 9 });
  if (o.corner?.bl) label(r, 2, SKY_H - LABEL_H[2] - 2, o.corner.bl, { level: 6 });
  if (o.corner?.br) label(r, SKY_W - labelWidth(o.corner.br) - 2, SKY_H - LABEL_H[2] - 2, o.corner.br, { level: 6 });
  return r;
}

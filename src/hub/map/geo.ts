// Small-area geometry for the Navigate map: distances, bearings, a local flat projection, snapping a
// position onto the route, and line simplification. Metres and degrees throughout.

export interface Pos {
  lat: number;
  lon: number;
}

const RAD = Math.PI / 180;
/** Metres per degree on the same sphere haversine() uses, so projected and great-circle distances agree. */
const M_LAT = (6371000 * Math.PI) / 180;
const M_LON = M_LAT;

export function haversine(a: Pos, b: Pos): number {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Initial bearing a → b, degrees clockwise from north (0..360). */
export function bearing(a: Pos, b: Pos): number {
  const p1 = a.lat * RAD, p2 = b.lat * RAD, dl = (b.lon - a.lon) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / RAD) % 360 + 360) % 360;
}

/** Smallest difference between two bearings (0..180). */
export const angleDiff = (a: number, b: number) => {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
};

/** Metres east (x) and north (y) of `o`. Good to well under 1% within a few km. */
export function local(o: Pos, p: Pos): [number, number] {
  return [(p.lon - o.lon) * Math.cos(o.lat * RAD) * M_LON, (p.lat - o.lat) * M_LAT];
}

export function unlocal(o: Pos, x: number, y: number): Pos {
  return { lat: o.lat + y / M_LAT, lon: o.lon + x / (Math.cos(o.lat * RAD) * M_LON) };
}

/**
 * Lens pixels for a map centred on `o`, `bearing` pointing up, `mpp` metres per pixel, with `o` drawn
 * at pixel (cx, cy) and y growing downwards.
 */
export function projector(o: Pos, bearingDeg: number, mpp: number, cx: number, cy: number): (p: Pos) => [number, number] {
  const c = Math.cos(bearingDeg * RAD), s = Math.sin(bearingDeg * RAD);
  return (p) => {
    const [x, y] = local(o, p);
    return [cx + (x * c - y * s) / mpp, cy - (x * s + y * c) / mpp];
  };
}

/** Cumulative distance along a polyline, metres (cum[0] = 0). */
export function cumulative(line: Pos[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + haversine(line[i - 1], line[i]));
  return out;
}

export interface Snap {
  /** Index of the segment start (the point lies between line[idx] and line[idx + 1]). */
  idx: number;
  /** The nearest point on the line. */
  pos: Pos;
  /** Metres from the given position to the line. */
  off: number;
  /** Metres along the line to the snapped point. */
  along: number;
}

/** The nearest point on `line` to `p`, looking only at segments from index `from` on that start within `toAlong` metres. */
export function snapToLine(line: Pos[], cum: number[], p: Pos, from = 0, toAlong = Infinity): Snap | null {
  if (line.length < 2) return null;
  let best: Snap | null = null;
  for (let i = Math.max(0, from); i < line.length - 1 && cum[i] <= toAlong; i++) {
    const [ax, ay] = local(p, line[i]);
    const [bx, by] = local(p, line[i + 1]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const qx = ax + t * dx, qy = ay + t * dy;
    const off = Math.hypot(qx, qy);
    if (!best || off < best.off) best = { idx: i, pos: unlocal(p, qx, qy), off, along: cum[i] + t * (cum[i + 1] - cum[i]) };
  }
  return best;
}

/** The point `d` metres along the line (clamped to its ends). */
export function pointAlong(line: Pos[], cum: number[], d: number): Pos {
  if (d <= 0) return line[0];
  for (let i = 1; i < line.length; i++)
    if (cum[i] >= d) {
      const seg = cum[i] - cum[i - 1];
      const t = seg ? (d - cum[i - 1]) / seg : 0;
      return { lat: line[i - 1].lat + t * (line[i].lat - line[i - 1].lat), lon: line[i - 1].lon + t * (line[i].lon - line[i - 1].lon) };
    }
  return line[line.length - 1];
}

/** Douglas-Peucker on pixel coordinates: drop points within `eps` px of the simplified line. */
export function simplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let far = -1, fd = eps;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = len ? Math.abs(dy * (px - ax) - dx * (py - ay)) / len : Math.hypot(px - ax, py - ay);
      if (d > fd) {
        fd = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Cut a polyline to the box [x0, x1] x [y0, y1] (Liang-Barsky per segment), so lines that run far
 * off the lens aren't walked pixel by pixel. Returns the visible runs.
 */
export function clipPolyline(pts: [number, number][], x0: number, y0: number, x1: number, y1: number): [number, number][][] {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]] as const) {
      if (p === 0) {
        if (q < 0) ok = false;
        continue;
      }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (!ok || t0 > t1) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    }
    const a: [number, number] = [ax + t0 * dx, ay + t0 * dy], b: [number, number] = [ax + t1 * dx, ay + t1 * dy];
    if (!run.length || t0 > 0) {
      if (run.length > 1) runs.push(run);
      run = [a];
    }
    run.push(b);
    if (t1 < 1) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

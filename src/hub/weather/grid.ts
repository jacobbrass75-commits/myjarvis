// The weather map's geometry and numbers: the lens projection, the Open-Meteo sample grid and its
// parsing, smooth sampling between grid points, marching-squares contours and pressure highs/lows.
// Pure (no I/O), so the tests can feed it canned Open-Meteo JSON.

// ---------------- projection ----------------

export const WX_W = 576;
export const WX_H = 288;
/** North and south edges of the lens, degrees. */
export const LAT_N = 42.6;
export const LAT_S = 32.0;
/** Longitude at the middle of the lens: California sits a little right of centre, the ocean on the left holds the readouts. */
export const LON_C = -121.0;
/** Pixels per degree of latitude. */
export const PPD = WX_H / (LAT_N - LAT_S);
/** Equirectangular, true to scale at 37.3 N (the middle of the state). */
const COS = Math.cos((37.3 * Math.PI) / 180);

export type XY = [number, number];

/** Lens pixel for a position (x right, y down). */
export function project(lat: number, lon: number): XY {
  return [WX_W / 2 + (lon - LON_C) * PPD * COS, (LAT_N - lat) * PPD];
}

export function unproject(x: number, y: number): { lat: number; lon: number } {
  return { lat: LAT_N - y / PPD, lon: LON_C + (x - WX_W / 2) / (PPD * COS) };
}

/** West and east edges of the lens. */
export const LON_W = unproject(0, 0).lon;
export const LON_E = unproject(WX_W, 0).lon;

// ---------------- the sample grid ----------------

/**
 * Where Open-Meteo is asked: 20 x 13 points, 1.5 degrees of longitude by 1 of latitude, a little
 * beyond the lens on every side. One request for all of them (each point counts as one API call).
 */
export const GRID = { lon0: -135, dlon: 1.5, nx: 20, lat0: 31.5, dlat: 1, ny: 13 } as const;

export interface GridSpec {
  lon0: number;
  dlon: number;
  nx: number;
  lat0: number;
  dlat: number;
  ny: number;
}

/** Grid points in request order: row by row from the south-west corner (index = j * nx + i). */
export function gridPoints(g: GridSpec = GRID): { lat: number; lon: number }[] {
  const out = [];
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) out.push({ lat: +(g.lat0 + j * g.dlat).toFixed(3), lon: +(g.lon0 + i * g.dlon).toFixed(3) });
  return out;
}

/** Labelled on the map; also asked for by name so their readings are their own, not the coarse grid's. */
export const CITIES: { name: string; lat: number; lon: number; left?: boolean }[] = [
  { name: "SAC", lat: 38.58, lon: -121.49 },
  { name: "SF", lat: 37.77, lon: -122.42, left: true },
  { name: "FRESNO", lat: 36.74, lon: -119.79 },
  { name: "LA", lat: 34.05, lon: -118.24 },
  { name: "SD", lat: 32.72, lon: -117.16 },
];

/** Everything one request asks for: the grid, then the cities. */
export function requestPoints(g: GridSpec = GRID, sites: { lat: number; lon: number }[] = CITIES): { lat: number; lon: number }[] {
  return [...gridPoints(g), ...sites.map((c) => ({ lat: c.lat, lon: c.lon }))];
}

export type WxVar = "p" | "t" | "ws" | "wd" | "pr";

/** Hourly fields on the grid: vars[v][hour][j * nx + i]. */
export interface WxGrid extends GridSpec {
  /** Valid time of each hour (ms). */
  times: number[];
  vars: Record<WxVar, Float32Array[]>;
  /** Point forecasts for the cities (same order as asked): sites[k][v][hour]. */
  sites: { lat: number; lon: number; v: Record<WxVar, number[]> }[];
  /** Units the request asked for. */
  tempUnit: "F" | "C";
}

const OM_VARS: Record<WxVar, string> = { p: "pressure_msl", t: "temperature_2m", ws: "wind_speed_10m", wd: "wind_direction_10m", pr: "precipitation" };
export const OM_HOURLY = Object.values(OM_VARS).join(",");

/** The forecast request for every grid point (GFS, so the run time can be shown; wind in mph). */
export function openMeteoUrl(g: GridSpec = GRID, tempUnit: "F" | "C" = "F", sites: { lat: number; lon: number }[] = CITIES): string {
  const pts = requestPoints(g, sites);
  return (
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${pts.map((p) => p.lat).join(",")}&longitude=${pts.map((p) => p.lon).join(",")}` +
    `&hourly=${OM_HOURLY}&models=gfs_global&forecast_hours=26&timeformat=unixtime&timezone=GMT` +
    `&wind_speed_unit=mph&temperature_unit=${tempUnit === "C" ? "celsius" : "fahrenheit"}&cell_selection=nearest`
  );
}

/** Open-Meteo's answer for requestPoints() (an array, one object per point, in order) → WxGrid. Throws on anything off. */
export function parseOpenMeteo(json: unknown, g: GridSpec = GRID, tempUnit: "F" | "C" = "F", sites: { lat: number; lon: number }[] = CITIES): WxGrid {
  const all = Array.isArray(json) ? json : [json];
  if (all.length !== g.nx * g.ny + sites.length) throw new Error(`open-meteo: ${all.length} locations, wanted ${g.nx * g.ny + sites.length}`);
  const arr = all.slice(0, g.nx * g.ny);
  const first = (arr[0] as any)?.hourly;
  if (!first || !Array.isArray(first.time) || !first.time.length) throw new Error("open-meteo: no hourly data");
  const times = (first.time as unknown[]).map((t) => (typeof t === "number" ? t * 1000 : Date.parse(String(t) + "Z")));
  const vars = {} as Record<WxVar, Float32Array[]>;
  for (const v of Object.keys(OM_VARS) as WxVar[]) vars[v] = times.map(() => new Float32Array(g.nx * g.ny));
  arr.forEach((loc: any, k: number) => {
    const h = loc?.hourly;
    if (!h) throw new Error(`open-meteo: location ${k} has no hourly data`);
    for (const v of Object.keys(OM_VARS) as WxVar[]) {
      const series = h[OM_VARS[v]];
      if (!Array.isArray(series)) throw new Error(`open-meteo: location ${k} lacks ${OM_VARS[v]}`);
      for (let t = 0; t < times.length; t++) {
        const x = series[t];
        vars[v][t][k] = typeof x === "number" && Number.isFinite(x) ? x : NaN;
      }
    }
  });
  // Gaps (null): the mean of the hour's other points, so contours stay closed.
  for (const v of Object.keys(OM_VARS) as WxVar[])
    for (const f of vars[v]) {
      let s = 0, n = 0;
      for (const x of f) if (!Number.isNaN(x)) (s += x), n++;
      if (n < f.length) for (let i = 0; i < f.length; i++) if (Number.isNaN(f[i])) f[i] = n ? s / n : 0;
    }
  const site = sites.map((c, k) => {
    const h = (all[g.nx * g.ny + k] as any)?.hourly ?? {};
    const v = {} as Record<WxVar, number[]>;
    for (const name of Object.keys(OM_VARS) as WxVar[]) v[name] = times.map((_, t) => (typeof h[OM_VARS[name]]?.[t] === "number" ? h[OM_VARS[name]][t] : NaN));
    return { lat: c.lat, lon: c.lon, v };
  });
  return { ...g, times, vars, sites: site, tempUnit };
}

/** Index of the hour nearest `at` (ms). */
export function hourIndex(g: WxGrid, at: number): number {
  let best = 0;
  for (let i = 1; i < g.times.length; i++) if (Math.abs(g.times[i] - at) < Math.abs(g.times[best] - at)) best = i;
  return best;
}

// ---------------- sampling ----------------

/** Catmull-Rom weights for fraction t. */
function cr(t: number): [number, number, number, number] {
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}

/** Smooth (bicubic) value of a grid field at a position; clamped at the grid's edges. */
export function sampleCubic(f: Float32Array, g: GridSpec, lat: number, lon: number): number {
  const gx = Math.max(0, Math.min(g.nx - 1, (lon - g.lon0) / g.dlon));
  const gy = Math.max(0, Math.min(g.ny - 1, (lat - g.lat0) / g.dlat));
  const i = Math.min(g.nx - 2, Math.floor(gx)), j = Math.min(g.ny - 2, Math.floor(gy));
  const wx = cr(gx - i), wy = cr(gy - j);
  const at = (a: number, b: number) => f[Math.max(0, Math.min(g.ny - 1, b)) * g.nx + Math.max(0, Math.min(g.nx - 1, a))];
  let s = 0;
  for (let m = 0; m < 4; m++) {
    let row = 0;
    for (let k = 0; k < 4; k++) row += wx[k] * at(i - 1 + k, j - 1 + m);
    s += wy[m] * row;
  }
  return s;
}

/** Plain bilinear value (for fields where overshoot looks wrong: rain, wind speed). */
export function sampleLinear(f: Float32Array, g: GridSpec, lat: number, lon: number): number {
  const gx = Math.max(0, Math.min(g.nx - 1, (lon - g.lon0) / g.dlon));
  const gy = Math.max(0, Math.min(g.ny - 1, (lat - g.lat0) / g.dlat));
  const i = Math.min(g.nx - 2, Math.floor(gx)), j = Math.min(g.ny - 2, Math.floor(gy));
  const fx = gx - i, fy = gy - j;
  const a = f[j * g.nx + i], b = f[j * g.nx + i + 1], c = f[(j + 1) * g.nx + i], d = f[(j + 1) * g.nx + i + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** A field resampled onto lens nodes every `step` px: v[j * w + i] is the value at pixel (i * step, j * step). */
export interface Lattice {
  w: number;
  h: number;
  step: number;
  v: Float32Array;
}

export function lattice(fn: (lat: number, lon: number) => number, step = 4): Lattice {
  const w = Math.floor(WX_W / step) + 1, h = Math.floor(WX_H / step) + 1;
  const v = new Float32Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const { lat, lon } = unproject(i * step, j * step);
      v[j * w + i] = fn(lat, lon);
    }
  return { w, h, step, v };
}

/** Bilinear lookup in a lattice at a lens pixel. */
export function at(l: Lattice, x: number, y: number): number {
  const gx = Math.max(0, Math.min(l.w - 1.001, x / l.step)), gy = Math.max(0, Math.min(l.h - 1.001, y / l.step));
  const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
  const k = j * l.w + i;
  return (l.v[k] * (1 - fx) + l.v[k + 1] * fx) * (1 - fy) + (l.v[k + l.w] * (1 - fx) + l.v[k + l.w + 1] * fx) * fy;
}

// ---------------- contours ----------------

/**
 * Marching squares on a lattice at one level, joined into polylines in lens pixels. Open lines run
 * edge to edge; closed ones end where they start. Saddles are split by the cell's centre value.
 */
export function contour(l: Lattice, level: number): XY[][] {
  const { w, h, v, step } = l;
  const above = (i: number, j: number) => v[j * w + i] >= level;
  // Edge keys: horizontal edge (i,j)-(i+1,j) = j*w+i; vertical edge (i,j)-(i,j+1) = w*h + j*w+i.
  const H = (i: number, j: number) => j * w + i;
  const V = (i: number, j: number) => w * h + j * w + i;
  const pointOf = (key: number): XY => {
    if (key < w * h) {
      const i = key % w, j = Math.floor(key / w);
      const a = v[j * w + i], b = v[j * w + i + 1];
      const t = a === b ? 0.5 : (level - a) / (b - a);
      return [(i + t) * step, j * step];
    }
    const k = key - w * h, i = k % w, j = Math.floor(k / w);
    const a = v[j * w + i], b = v[(j + 1) * w + i];
    const t = a === b ? 0.5 : (level - a) / (b - a);
    return [i * step, (j + t) * step];
  };
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let j = 0; j < h - 1; j++)
    for (let i = 0; i < w - 1; i++) {
      // corners: tl, tr, br, bl
      const c = (above(i, j) ? 8 : 0) | (above(i + 1, j) ? 4 : 0) | (above(i + 1, j + 1) ? 2 : 0) | (above(i, j + 1) ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const top = H(i, j), bottom = H(i, j + 1), left = V(i, j), right = V(i + 1, j);
      switch (c) {
        case 1: case 14: link(left, bottom); break;
        case 2: case 13: link(bottom, right); break;
        case 3: case 12: link(left, right); break;
        case 4: case 11: link(top, right); break;
        case 6: case 9: link(top, bottom); break;
        case 7: case 8: link(left, top); break;
        case 5: case 10: {
          const centre = (v[j * w + i] + v[j * w + i + 1] + v[(j + 1) * w + i] + v[(j + 1) * w + i + 1]) / 4 >= level;
          // 5 = tr+bl above, 10 = tl+br above; a centre on the same side as the diagonal joins it
          if ((c === 5) === centre) link(left, top), link(bottom, right);
          else link(left, bottom), link(top, right);
          break;
        }
      }
    }
  const used = new Set<number>();
  const walk = (start: number): XY[] => {
    const keys = [start];
    used.add(start);
    let prev = -1, cur = start;
    for (;;) {
      const next = (links.get(cur) ?? []).find((k) => k !== prev && !used.has(k)) ?? (links.get(cur) ?? []).find((k) => k === start && prev !== start && keys.length > 2);
      if (next === undefined) break;
      keys.push(next);
      if (next === start) break;
      used.add(next);
      prev = cur;
      cur = next;
    }
    return keys.map(pointOf);
  };
  const lines: XY[][] = [];
  // open lines first (from an end), then loops
  for (const [k, ns] of links) if (ns.length === 1 && !used.has(k)) lines.push(walk(k));
  for (const k of links.keys()) if (!used.has(k)) lines.push(walk(k));
  return lines.filter((l) => l.length > 1);
}

/** Contour levels every `interval` between a lattice's min and max (multiples of the interval). */
export function levels(l: Lattice, interval: number): number[] {
  let lo = Infinity, hi = -Infinity;
  for (const x of l.v) (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
  const out = [];
  for (let c = Math.ceil(lo / interval) * interval; c <= hi; c += interval) out.push(c);
  return out;
}

export function polyLength(p: XY[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return s;
}

// ---------------- highs and lows ----------------

export interface Extremum {
  kind: "H" | "L";
  x: number;
  y: number;
  value: number;
  /** How far it stands out from the lowest (H) / highest (L) value around it. */
  prominence: number;
}

/**
 * Pressure centres: lattice nodes that are the highest (H) or lowest (L) within `radius` px, away
 * from the lens edges (an edge maximum is just a gradient leaving the map), standing out by at
 * least `minProm` hPa. The `max` most prominent of each kind.
 */
export function extrema(l: Lattice, o?: { radius?: number; margin?: number; minProm?: number; max?: number }): Extremum[] {
  const R = Math.round((o?.radius ?? 56) / l.step), M = Math.round((o?.margin ?? 12) / l.step), minProm = o?.minProm ?? 1, max = o?.max ?? 3;
  const { w, h, v } = l;
  const out: Extremum[] = [];
  for (let j = M; j < h - M; j++)
    for (let i = M; i < w - M; i++) {
      const c = v[j * w + i];
      let isMax = true, isMin = true, lo = c, hi = c;
      for (let b = Math.max(0, j - R); b <= Math.min(h - 1, j + R) && (isMax || isMin); b++)
        for (let a = Math.max(0, i - R); a <= Math.min(w - 1, i + R); a++) {
          if ((a - i) ** 2 + (b - j) ** 2 > R * R || (a === i && b === j)) continue;
          const x = v[b * w + a];
          // ties: only the first node of a flat top (in scan order) counts
          const earlier = b < j || (b === j && a < i);
          if (x > c || (earlier && x === c)) isMax = false;
          if (x < c || (earlier && x === c)) isMin = false;
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      if (isMax && c - lo >= minProm) out.push({ kind: "H", x: i * l.step, y: j * l.step, value: c, prominence: c - lo });
      if (isMin && hi - c >= minProm) out.push({ kind: "L", x: i * l.step, y: j * l.step, value: c, prominence: hi - c });
    }
  const pick = (k: "H" | "L") => out.filter((e) => e.kind === k).sort((a, b) => b.prominence - a.prominence).slice(0, max);
  return [...pick("H"), ...pick("L")];
}

// ---------------- wind ----------------

/** Wind from speed and the direction it blows FROM (degrees) → east/north components. */
export function windUV(speed: number, fromDeg: number): [number, number] {
  const a = (fromDeg * Math.PI) / 180;
  return [-speed * Math.sin(a), -speed * Math.cos(a)];
}

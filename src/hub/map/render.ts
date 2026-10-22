import { chevron, label, labelWidth } from "../../shared/glyphs.js";
import { Raster } from "../../shared/raster.js";
import { clipPolyline, projector, simplify, type Pos } from "./geo.js";

// The Navigate map: 288x288 (or the whole lens, 576x288, for the full-map view), 4-bit, route-up, you
// fixed at pixel (w / 2, 220) so most of the lens shows what's ahead. A base map (Google roads or OpenStreetMap lines, or nothing) under the OSRM route, a
// range ring, the destination and a north tick, in the "Lagonda digital" levels: outlines, not fills.

export const MAP_W = 288;
export const MAP_H = 288;
/** Where "you" are on the map. */
export const ME_X = 144;
export const ME_Y = 220;
/** The full-map view's width (the whole lens). */
export const FULL_W = 576;

/** Size of the map a view is drawn into, and where you are on it. */
export function geom(v: { w?: number }): { w: number; h: number; meX: number; meY: number } {
  const w = v.w === FULL_W ? FULL_W : MAP_W;
  return { w, h: MAP_H, meX: w / 2, meY: ME_Y };
}

const LIT_BUDGET = 0.15;

export interface MapView {
  /** Your position (snapped onto the route when you're on it). */
  pos: Pos;
  /** Degrees clockwise from north that point up. */
  bearing: number;
  /** Metres per pixel wanted (a base map may snap it to its own zoom levels). */
  mpp: number;
  route: Pos[];
  /** Route segment you're on (route[snapIdx] .. route[snapIdx + 1]); -1 before the route starts. */
  snapIdx: number;
  /** pos is on the route (within 30 m), so the line ahead starts at pos. */
  onRoute?: boolean;
  dest: Pos;
  profile: string;
  /** Map width: 288 (default) or 576 (full-map view). */
  w?: number;
}

export interface BaseMap {
  readonly source: "google" | "osm";
  /** Fetch or refresh what this view needs (cached, rate-limited). Never throws. */
  prepare(v: MapView): Promise<void>;
  /** Anything to draw yet? */
  ready(): boolean;
  /** The metres per pixel this provider draws `v` at (Google: its zoom level's real scale). */
  scale?(v: MapView): number;
  /** dim 0 = normal; 1 and 2 = darker / sparser when the frame is over the lit budget. */
  draw(r: Raster, v: MapView, toPx: (p: Pos) => [number, number], dim: number): void;
}

export interface NavRender {
  img: Raster;
  /** The scale actually drawn. */
  mpp: number;
  source: "google" | "osm" | "route";
}

/** Draw the map for a view. The base map is fetched (or refreshed) first; any failure leaves it out. */
export async function renderNavMap(v: MapView, base: BaseMap | null): Promise<NavRender> {
  if (base) await base.prepare(v).catch(() => {});
  const useBase = base?.ready() ? base : null;
  const mpp = useBase?.scale?.(v) ?? v.mpp;
  const view = { ...v, mpp };
  const g = geom(v);
  const toPx = projector(v.pos, v.bearing, mpp, g.meX, g.meY);
  let img = new Raster(g.w, g.h);
  for (let dim = 0; dim <= 2; dim++) {
    img = new Raster(g.w, g.h);
    if (useBase) {
      try {
        useBase.draw(img, view, toPx, dim);
      } catch {}
    }
    overlays(img, view, toPx, useBase?.source ?? "route");
    // the lens budget is per 288x144 tile
    if (!useBase || tileLit(img) <= LIT_BUDGET) break;
  }
  return { img, mpp, source: useBase?.source ?? "route" };
}

/** The most lit of the map's 288x144 tiles (0..1). */
export function tileLit(img: Raster): number {
  let m = 0;
  for (let y = 0; y < img.h; y += 144) for (let x = 0; x < img.w; x += 288) m = Math.max(m, img.crop(x, y, Math.min(288, img.w - x), Math.min(144, img.h - y)).lit());
  return m;
}

function overlays(r: Raster, v: MapView, toPx: (p: Pos) => [number, number], source: string) {
  const { meX, meY } = geom(v);
  rangeRing(r, v.mpp, meX, meY);
  // Walked part dim, the rest bright on a black casing so it reads over any road.
  const idx = Math.max(-1, Math.min(v.snapIdx, v.route.length - 1));
  const walked = idx >= 0 ? v.route.slice(0, idx + 1) : [];
  const ahead = v.route.slice(idx + 1);
  if (v.onRoute) {
    walked.push(v.pos);
    ahead.unshift(v.pos);
  } else if (idx >= 0) ahead.unshift(v.route[idx]);
  if (walked.length > 1) stroke(r, walked.map(toPx), 4, 1);
  if (ahead.length > 1) {
    const px = simplify(ahead.map(toPx), 1.5);
    stroke(r, px, 0, 8);
    stroke(r, px, 15, 4);
  }
  // Destination: a square with a cross.
  const [dx, dy] = toPx(v.dest).map(Math.round);
  if (dx >= -4 && dy >= -4 && dx < r.w + 4 && dy < r.h + 4) {
    r.fillRect(dx - 6, dy - 6, 12, 12, 0);
    r.rect(dx - 4, dy - 4, 8, 8, 15);
    r.line(dx, dy - 2, dx, dy + 1, 15);
    r.line(dx - 2, dy, dx + 1, dy, 15);
  }
  chevron(r, meX, meY, 14, 16, { level: 15, knockout: 2 });
  mapFrame(r);
  northTick(r, v);
  label(r, 10, r.h - 12, source === "google" ? "GOOGLE" : source === "osm" ? "OSM" : "ROUTE", { scale: 1, level: 4 });
}

/** A polyline clipped to just outside the map, so far-off points cost nothing. */
function stroke(r: Raster, pts: [number, number][], level: number, t: number) {
  for (const run of clipPolyline(pts, -8, -8, r.w + 8, r.h + 8)) r.polyline(run, level, t);
}

/** Dashed ring 100 m around you (50 m when zoomed far in), labelled. */
/** Dashed ring around you: 100 m (50 m zoomed far in; 500 m / 1 km / 2 km zoomed far out), labelled. */
function rangeRing(r: Raster, mpp: number, meX: number, meY: number) {
  const m = mpp <= 2 ? (100 / mpp > 200 ? 50 : 100) : [200, 500, 1000, 2000].find((d) => d / mpp >= 40) ?? 2000;
  const rad = m / mpp;
  const n = Math.max(24, Math.ceil((2 * Math.PI * rad) / 2));
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) pts.push([meX + rad * Math.cos((i / n) * 2 * Math.PI), meY + rad * Math.sin((i / n) * 2 * Math.PI)]);
  r.polyline(pts, 3, 1, [2, 4]);
  const text = m >= 1000 ? `${m / 1000}KM` : `${m}M`;
  const lx = Math.round(meX + rad * 0.707 + 3), ly = Math.round(meY - rad * 0.707 - 9);
  if (lx + labelWidth(text, 1) < r.w - 4 && ly > 4) label(r, lx, ly, text, { scale: 1, level: 6 });
  else if (meY - rad - 9 > 4) label(r, meX + 4, Math.round(meY - rad - 9), text, { scale: 1, level: 6 });
}

/** The map's outline: 1 px at level 6 with 8 px 45-degree corners (split across the two tiles). */
function mapFrame(r: Raster) {
  const c = 8, x1 = r.w - 1, y1 = r.h - 1;
  r.polyline([[c, 0], [x1 - c, 0], [x1, c], [x1, y1 - c], [x1 - c, y1], [c, y1], [0, y1 - c], [0, c], [c, 0]], 6);
}

/** A short tick on the frame where north is, with a small N inside it. */
function northTick(r: Raster, v: MapView) {
  const a = (-v.bearing * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  // ray from the middle of the map to its edge
  const cx = r.w / 2, cy = r.h / 2;
  const t = Math.min(dx ? (dx > 0 ? r.w - 2 - cx : cx - 1) / Math.abs(dx) : Infinity, dy ? (dy > 0 ? r.h - 2 - cy : cy - 1) / Math.abs(dy) : Infinity);
  const ex = cx + dx * t, ey = cy + dy * t;
  r.line(ex, ey, ex - dx * 6, ey - dy * 6, 9, 2);
  const nx = ex - dx * 16 - 3, ny = ey - dy * 16 - 3;
  r.fillRect(nx - 2, ny - 2, 10, 11, 0);
  label(r, nx, ny, "N", { scale: 1, level: 9 });
}

/** How far from `pos` (metres) the map can show anything: the farthest corner from where you are. */
export function viewRadius(mpp: number, w: number = MAP_W): number {
  const g = geom({ w });
  return Math.hypot(Math.max(g.meX, g.w - g.meX), Math.max(g.meY, g.h - g.meY)) * mpp;
}

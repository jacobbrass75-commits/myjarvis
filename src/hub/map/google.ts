import type { Raster } from "../../shared/raster.js";
import { haversine, unlocal, type Pos } from "./geo.js";
import { decodePng, type Gray } from "./png-decode.js";
import { geom, MAP_H, type BaseMap, type MapView } from "./render.js";

// Google roads as the base map, when GOOGLE_MAPS_API_KEY is set (Maps Static API). The image is styled
// black with roads in three greys and no labels, then rotated route-up and snapped to green levels
// here. One image is kept in memory (never on disk) and reused until you move 50 px from its centre
// or the zoom changes; at most one request per 10 s (2 s after a zoom change, so a swipe shows soon).
// The full-map view (576 wide) centres the image on the middle of the view rather than on you, so
// 640 px still reaches its corners. The key is secret: the URL is never logged.

const SIZE = 640;
const MIN_GAP_MS = 10_000;
const ZOOM_GAP_MS = 2_000;
/** Google's logo and copyright line along the bottom of the image: not roads. */
const FOOTER = 26;

const STYLES = [
  "element:geometry|color:0x000000",
  "element:labels|visibility:off",
  "feature:administrative|visibility:off",
  "feature:poi|visibility:off",
  "feature:transit|visibility:off",
  "feature:water|element:geometry|color:0x000000",
  "feature:landscape|element:geometry|color:0x000000",
  "feature:road|element:geometry.stroke|visibility:off",
  "feature:road.highway|element:geometry.fill|color:0xffffff",
  "feature:road.arterial|element:geometry.fill|color:0xb4b4b4",
  "feature:road.local|element:geometry.fill|color:0x787878",
];

/** Metres per pixel of a Web Mercator zoom level (256 px tiles, scale=1). */
export const mppAt = (z: number, lat: number) => (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
export const zoomFor = (lat: number, mpp: number) => Math.max(13, Math.min(19, Math.round(Math.log2((156543.03 * Math.cos((lat * Math.PI) / 180)) / mpp))));

/** Web Mercator world pixel of a position at zoom z. */
function world(p: Pos, z: number): [number, number] {
  const n = 256 * 2 ** z;
  const s = Math.sin((p.lat * Math.PI) / 180);
  return [((p.lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

/** Luminance → level; thresholds rather than a ramp keep the road edges crisp. [highway, arterial, local] per dim step. */
const LEVELS = [[9, 7, 5], [6, 5, 4], [6, 4, 0]];
function level(l: number, dim: number): number {
  const lv = LEVELS[Math.min(dim, 2)];
  return l >= 0xd8 ? lv[0] : l >= 0x96 ? lv[1] : l >= 0x50 ? lv[2] : 0;
}

export function staticMapUrl(center: Pos, z: number, key: string): string {
  const q = [
    `center=${center.lat.toFixed(6)},${center.lon.toFixed(6)}`, `zoom=${z}`, `size=${SIZE}x${SIZE}`, "scale=1", "format=png", "maptype=roadmap",
    ...STYLES.map((s) => `style=${encodeURIComponent(s)}`),
    `key=${encodeURIComponent(key)}`,
  ];
  return `https://maps.googleapis.com/maps/api/staticmap?${q.join("&")}`;
}

export class GoogleBase implements BaseMap {
  readonly source = "google" as const;
  /** Set after Google refused the key (400/403): the rest of this session uses OpenStreetMap. */
  disabled = false;
  private img: { center: Pos; z: number; gray: Gray } | null = null;
  private lastTry = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  /** Called when a fetch had to wait for the rate limit and may now go (redraw to get it). */
  onData?: () => void;

  constructor(
    private key = process.env.GOOGLE_MAPS_API_KEY?.trim() ?? "",
    private fetcher: typeof fetch = fetch,
    private log: (s: string) => void = console.log,
  ) {}

  /** Has a key and Google hasn't refused it. */
  get usable() {
    return !!this.key && !this.disabled;
  }

  ready() {
    return !!this.img;
  }

  /** Draw at the wanted zoom level's own scale (rotation only, no resampling blur once its image is in). */
  scale(v: MapView): number {
    return mppAt(zoomFor(v.pos.lat, v.mpp), v.pos.lat);
  }

  /** Where the image should be centred: on you, or for the full map on the middle of the view. */
  private centerFor(v: MapView, z: number): Pos {
    const g = geom(v);
    if (g.w <= MAP_H) return v.pos;
    const ahead = (g.meY - g.h / 2) * mppAt(z, v.pos.lat);
    const a = (v.bearing * Math.PI) / 180;
    return unlocal(v.pos, Math.sin(a) * ahead, Math.cos(a) * ahead);
  }

  async prepare(v: MapView): Promise<void> {
    if (!this.usable) return;
    const z = zoomFor(v.pos.lat, v.mpp);
    const want = this.centerFor(v, z);
    const im = this.img;
    if (im && im.z === z && haversine(im.center, want) / mppAt(z, v.pos.lat) <= 50) return;
    const gap = im && im.z !== z ? ZOOM_GAP_MS : MIN_GAP_MS;
    const wait = this.lastTry + gap - Date.now();
    if (wait > 0) {
      // a zoom change waits a moment, then asks for a redraw so the right image comes in
      if (im && im.z !== z && !this.retry) {
        this.retry = setTimeout(() => ((this.retry = undefined), this.onData?.()), wait + 20);
        this.retry.unref?.();
      }
      return;
    }
    this.lastTry = Date.now();
    const center = { lat: +want.lat.toFixed(6), lon: +want.lon.toFixed(6) };
    try {
      const res = await this.fetcher(staticMapUrl(center, z, this.key), { signal: AbortSignal.timeout(8000) });
      this.log(`[map] google z=${z} ${res.status}`);
      if (res.status === 400 || res.status === 403) {
        this.disabled = true;
        this.log("[map] google refused the key: OpenStreetMap for the rest of this session");
        return;
      }
      if (!res.ok) return;
      const gray = decodePng(new Uint8Array(await res.arrayBuffer()));
      this.img = { center, z, gray };
    } catch (e: any) {
      // e.message from fetch never carries the URL, but stay safe: name only.
      this.log(`[map] google failed: ${e?.name ?? "error"}`);
    }
  }

  draw(r: Raster, v: MapView, _toPx: (p: Pos) => [number, number], dim: number): void {
    const im = this.img;
    if (!im) return;
    const { gray, z } = im;
    const [px, py] = world(v.pos, z);
    const [cx, cy] = world(im.center, z);
    // offset of pos in the image, plus image pixels per lens pixel (1 when scale() was used)
    const ox = gray.w / 2 + (px - cx), oy = gray.h / 2 + (py - cy);
    const k = v.mpp / mppAt(z, v.pos.lat);
    const a = (v.bearing * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const { meX, meY } = geom(v);
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        // lens pixel → metres right/up of you → east/north (inverse of the route-up rotation)
        const sx = x + 0.5 - meX, su = meY - (y + 0.5);
        const ix = Math.floor(ox + (c * sx + s * su) * k);
        const iy = Math.floor(oy - (-s * sx + c * su) * k);
        if (ix < 0 || iy < 0 || ix >= gray.w || iy >= gray.h - FOOTER) continue;
        const lv = level(gray.px[iy * gray.w + ix], dim);
        if (lv) r.px[y * r.w + x] = lv;
      }
  }
}

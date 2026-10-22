import { decodePng, type Gray } from "../map/png-decode.js";
import { LAT_N, LAT_S, LON_E, LON_W } from "./grid.js";

// Live precipitation radar from RainViewer (https://www.rainviewer.com/api.html): free for personal
// use with attribution ("RAINVIEWER" is drawn on the map whenever this layer shows). Since 2026 the
// public API serves past radar only (no nowcast), zoom 7 at most, one colour scheme, 100 requests a
// minute per IP. We take the newest frame at zoom 5: 3 x 3 tiles of 256 px cover the lens, fetched
// at most every 10 minutes and only while the precipitation layer is open at "now".

const ZOOM = 5;
const TTL = 10 * 60_000;
const INDEX = "https://api.rainviewer.com/public/weather-maps.json";

/** Fractional Web Mercator pixel at zoom z (256 px tiles). */
export function mercator(lat: number, lon: number, z = ZOOM): [number, number] {
  const n = 256 * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

/** The tiles [x, y] at zoom z covering the lens. */
export function radarTiles(z = ZOOM): [number, number][] {
  const [x0, y0] = mercator(LAT_N, LON_W, z), [x1, y1] = mercator(LAT_S, LON_E, z);
  const out: [number, number][] = [];
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor(y1 / 256); ty++) for (let tx = Math.floor(x0 / 256); tx <= Math.floor(x1 / 256); tx++) out.push([tx, ty]);
  return out;
}

export interface Radar {
  /** Time of the radar frame (ms). */
  at: number;
  /** Rain intensity 0..1 at a position (0 = none or not covered). */
  sample(lat: number, lon: number): number;
}

export class RainViewer {
  /** The last answer, also when RainViewer had no frame (radar null), so that isn't asked again for 10 minutes. */
  private cache: { at: number; radar: Radar | null } | null = null;
  private inflight: Promise<Radar | null> | null = null;

  constructor(private fetcher: typeof fetch = (...a) => fetch(...a), private headers: Record<string, string> = {}, private now = () => Date.now()) {}

  /**
   * The newest radar frame, cached for 10 minutes; null when RainViewer can't be reached. Never throws.
   * Past 10 minutes the cached frame comes back at once and a fresh one loads behind it (the map never
   * waits on RainViewer once it has a frame).
   */
  async get(): Promise<Radar | null> {
    if (this.cache && this.now() - this.cache.at < TTL) return this.cache.radar;
    const first = !this.cache;
    this.inflight ??= this.load()
      .catch((e) => {
        console.log(`[weather] radar: ${e?.message ?? e}`);
        return this.cache?.radar ?? null;
      })
      .finally(() => (this.inflight = null));
    return first ? this.inflight : this.cache!.radar;
  }

  private async load(): Promise<Radar | null> {
    const idx: any = await (await this.fetcher(INDEX, { headers: this.headers, signal: AbortSignal.timeout(8000) })).json();
    const frame = idx?.radar?.past?.at?.(-1);
    if (!frame?.path || typeof idx.host !== "string") {
      this.cache = { at: this.now(), radar: null };
      return null;
    }
    const tiles = new Map<string, Gray>();
    await Promise.all(
      radarTiles().map(async ([x, y]) => {
        const r = await this.fetcher(`${idx.host}${frame.path}/256/${ZOOM}/${x}/${y}/2/1_0.png`, { headers: this.headers, signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        tiles.set(`${x},${y}`, decodePng(new Uint8Array(await r.arrayBuffer())));
      }),
    );
    const radar = radarFrom(tiles, frame.time * 1000);
    this.cache = { at: this.now(), radar };
    return radar;
  }
}

/** A Radar over decoded tiles keyed "x,y" (luminance with alpha already composited onto black). */
export function radarFrom(tiles: Map<string, Gray>, at: number): Radar {
  return {
    at,
    sample(lat, lon) {
      const [px, py] = mercator(lat, lon);
      const t = tiles.get(`${Math.floor(px / 256)},${Math.floor(py / 256)}`);
      if (!t) return 0;
      const v = t.px[Math.floor(py % 256) * t.w + Math.floor(px % 256)] ?? 0;
      return v < 16 ? 0 : Math.min(1, v / 220);
    },
  };
}

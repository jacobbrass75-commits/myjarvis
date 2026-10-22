import type { HubMsg, WxLayer, WxMap } from "../../shared/protocol.js";
import { where } from "../dashboard.js";
import { pack4, toB64 } from "../../shared/raster.js";
import { GRID, openMeteoUrl, parseOpenMeteo, type WxGrid } from "./grid.js";
import { RainViewer } from "./radar.js";
import { renderWx, WX_LAYERS, WX_STEPS } from "./render.js";

// The WEATHER mode's data: one Open-Meteo forecast request for the whole grid (GFS, 260 points, 25
// hours), kept 20 minutes, plus the GFS run time from Open-Meteo's model metadata. Open-Meteo's free
// API is for non-commercial use under CC BY 4.0 (credited on the map), < 10,000 calls a day with each
// location counting as a call, so refreshes are also capped at 24 a day (~6,200 calls); past that the
// last data is reused. Nothing is fetched until the glasses open the map.

const UA = { "User-Agent": "g2-orchestrator/0.1 (personal smart-glasses weather map)" };
const TTL = 20 * 60_000;
const MAX_PER_DAY = 24;
const META = "https://api.open-meteo.com/data/ncep_gfs013/static/meta.json";

export interface WeatherOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  tempUnit?: "F" | "C";
}

export class WeatherService {
  private data: { at: number; grid: WxGrid; run?: number } | null = null;
  private inflight: Promise<void> | null = null;
  private fetches: number[] = [];
  private seq = 0;
  private renders = new Map<string, WxMap>();
  private fetcher: typeof fetch;
  private now: () => number;
  readonly tempUnit: "F" | "C";
  readonly radar: RainViewer;

  constructor(o: WeatherOptions = {}) {
    this.fetcher = o.fetcher ?? ((...a) => fetch(...a));
    this.now = o.now ?? (() => Date.now());
    this.tempUnit = o.tempUnit ?? (process.env.G2_TEMP_UNIT === "celsius" ? "C" : "F");
    this.radar = new RainViewer(this.fetcher, UA, this.now);
  }

  /** Forecast data, refreshed when older than 20 minutes (and the daily cap allows). Throws only with nothing cached. */
  async forecast(): Promise<{ grid: WxGrid; run?: number }> {
    const now = this.now();
    this.fetches = this.fetches.filter((t) => now - t < 86_400_000);
    const stale = !this.data || now - this.data.at > TTL;
    if (stale && (this.fetches.length < MAX_PER_DAY || !this.data)) {
      this.inflight ??= this.load().finally(() => (this.inflight = null));
      try {
        await this.inflight;
      } catch (e: any) {
        if (!this.data) throw e;
        console.log(`[weather] refresh failed, keeping data from ${new Date(this.data.at).toLocaleTimeString()}: ${e?.message ?? e}`);
      }
    }
    return this.data!;
  }

  private async load() {
    this.fetches.push(this.now());
    const [r, meta] = await Promise.all([
      this.fetcher(openMeteoUrl(GRID, this.tempUnit), { headers: UA, signal: AbortSignal.timeout(15000) }),
      this.fetcher(META, { headers: UA, signal: AbortSignal.timeout(8000) }).then((m) => m.json()).catch(() => null),
    ]);
    if (!r.ok) throw new Error(`open-meteo ${r.status}: ${(await r.text().catch(() => "")).slice(0, 120)}`);
    const grid = parseOpenMeteo(await r.json(), GRID, this.tempUnit);
    const init = Number((meta as any)?.last_run_initialisation_time);
    this.data = { at: this.now(), grid, run: Number.isFinite(init) && init > 0 ? init * 1000 : undefined };
    this.renders.clear();
    console.log(`[weather] forecast: ${grid.nx * grid.ny} points, ${grid.times.length} h${this.data.run ? `, GFS ${new Date(this.data.run).toISOString().slice(11, 13)}Z` : ""}`);
  }

  /** The map for a layer and step (cached until the data, the hour or your position changes). */
  async map(layer: WxLayer, step: number, pos?: { lat: number; lon: number } | null): Promise<WxMap> {
    if (!WX_LAYERS.includes(layer)) layer = "pressure";
    if (!WX_STEPS.includes(step)) step = 0;
    const { grid, run } = await this.forecast();
    const radar = layer === "precip" && step === 0 ? await this.radar.get() : null;
    const now = this.now();
    const key = [layer, step, Math.floor(now / 3_600_000), radar?.at ?? 0, pos ? `${pos.lat.toFixed(2)},${pos.lon.toFixed(2)}` : ""].join("|");
    const hit = this.renders.get(key);
    if (hit) return hit;
    const r = renderWx(grid, { layer, step, now, run, model: "GFS", pos, radar });
    const map: WxMap = { w: 576, h: 288, px: toB64(pack4(r.img)), layer, step, valid: r.valid, run, frames: r.frames.length ? r.frames : undefined, seq: ++this.seq };
    if (this.renders.size > 24) this.renders.clear();
    this.renders.set(key, map);
    return map;
  }

  /** wx_get from the glasses: answer with wx_map (or an error the screen can show). */
  async handle(send: (m: HubMsg) => void, layer: WxLayer, step: number, pos?: { lat: number; lon: number } | null) {
    try {
      // no phone GPS yet: the hub's own (G2_LAT/G2_LON or IP, city-level) location
      pos ??= await where().then((w) => (Number.isFinite(w?.lat) && Number.isFinite(w?.lon) ? { lat: w.lat, lon: w.lon } : null)).catch(() => null);
      send({ t: "wx_map", map: await this.map(layer, step, pos) });
    } catch (e: any) {
      console.log(`[weather] ${e?.message ?? e}`);
      send({ t: "wx_map", map: null, error: String(e?.message ?? e).slice(0, 80) });
    }
  }
}

export const weather = new WeatherService();

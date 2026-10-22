import type { HubMsg, WxLayer, WxMap, WxView } from "../../shared/protocol.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { where } from "../dashboard.js";
import { DATA_DIR } from "../store.js";
import { pack4, toB64 } from "../../shared/raster.js";
import { GRID, openMeteoUrl, parseOpenMeteo, type WxGrid } from "./grid.js";
import { RainViewer } from "./radar.js";
import { renderWx, WX_LAYERS, WX_STEPS } from "./render.js";

// The WEATHER mode's data: one Open-Meteo forecast request for the whole grid (GFS, 265 points, 26
// hours), kept 20 minutes, plus the GFS run time from Open-Meteo's model metadata. Open-Meteo's free
// API is for non-commercial use under CC BY 4.0 (credited on the map), < 10,000 calls a day with each
// location counting as a call, so refreshes are also capped at 24 a day (~6,400 calls); past that the
// last data is reused. The per-minute limit (600) allows only two of our requests a minute, so a failed
// attempt waits 2 minutes before the next (10 after a 429), and the last answer is kept on disk
// (DATA_DIR/weather-forecast.json) so a hub restart reuses it instead of fetching again.
//
// Opening the map never waits on the network or on drawing: start() fetches once when the hub starts
// and then keeps the forecast fresh in the background, and the default view (sky, now, in the layout
// the glasses used last: full lens unless they asked for compact) drawn, for as long as the map was opened in the last 3 hours. After each answer the neighbours (the
// layers either side, the next step) are drawn in the background too, so a swipe or tap is answered
// from the cache. A request with stale data gets the stale map at once and, when the refresh lands,
// the fresh one.

const UA = { "User-Agent": "g2-orchestrator/0.1 (personal smart-glasses weather map)" };
const TTL = 20 * 60_000;
const MAX_PER_DAY = 24;
const KEEP_WARM = 3 * 3_600_000;
const TICK = 5 * 60_000;
const META = "https://api.open-meteo.com/data/ncep_gfs013/static/meta.json";

type Pos = { lat: number; lon: number };

export interface WeatherOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  tempUnit?: "F" | "C";
  /** Where you are when no phone GPS is given (default: the hub's G2_LAT/G2_LON or IP location). */
  fallbackPos?: () => Promise<Pos | null>;
  /** The last forecast on disk, reused across restarts (null: none; default DATA_DIR/weather-forecast.json). */
  cacheFile?: string | null;
}

/** A saved forecast older than this isn't drawn after a restart. */
const DISK_MAX_AGE = 6 * 3_600_000;

const hubPos = () => where().then((w) => (Number.isFinite(w?.lat) && Number.isFinite(w?.lon) ? { lat: w.lat, lon: w.lon } : null)).catch(() => null);

export class WeatherService {
  private data: { at: number; grid: WxGrid; run?: number } | null = null;
  private inflight: Promise<void> | null = null;
  private fetches: number[] = [];
  private seq = 0;
  private renders = new Map<string, WxMap>();
  private fetcher: typeof fetch;
  private now: () => number;
  private fallbackPos: () => Promise<Pos | null>;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** No new attempt before this after a failed one (each attempt costs 265 calls of a 600-a-minute budget). */
  private retryAt = -Infinity;
  /** The layout the glasses asked for last (full-lens "detail" until they ask for the compact one). */
  private lastView: WxView = "detail";
  /** When a client last asked for a map (background refreshes stop 3 hours after). */
  private usedAt = -Infinity;
  private cacheFile: string | null;
  private diskRead = false;
  readonly tempUnit: "F" | "C";
  readonly radar: RainViewer;

  constructor(o: WeatherOptions = {}) {
    this.fetcher = o.fetcher ?? ((...a) => fetch(...a));
    this.now = o.now ?? (() => Date.now());
    this.tempUnit = o.tempUnit ?? (process.env.G2_TEMP_UNIT === "celsius" ? "C" : "F");
    this.fallbackPos = o.fallbackPos ?? hubPos;
    this.cacheFile = o.cacheFile === undefined ? join(DATA_DIR, "weather-forecast.json") : o.cacheFile;
    this.radar = new RainViewer(this.fetcher, UA, this.now);
  }

  /** Background upkeep: once now, then every 5 minutes while the map was used in the last 3 hours. */
  start(pos: () => Pos | null = () => null) {
    clearInterval(this.timer);
    const tick = () => {
      if (this.data && this.now() - this.usedAt > KEEP_WARM) return;
      void this.warm(pos());
    };
    tick();
    this.timer = setInterval(tick, TICK);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Refresh the forecast if it's stale, then draw the default view so the next open is instant. Never throws. */
  async warm(pos?: Pos | null) {
    try {
      await this.fromDisk();
      pos ??= await this.fallbackPos();
      this.refresh();
      await this.inflight?.catch(() => {});
      if (this.data) {
        await this.map("sky", 0, pos, this.lastView);
        await this.neighbours("sky", 0, pos, this.lastView);
      }
    } catch (e: any) {
      console.log(`[weather] warm-up: ${e?.message ?? e}`);
    }
  }

  /** The forecast saved by an earlier run, if it is the same units and under 6 hours old (once). */
  private async fromDisk() {
    if (this.diskRead || this.data || !this.cacheFile) return;
    this.diskRead = true;
    try {
      const saved = JSON.parse(await readFile(this.cacheFile, "utf8"));
      if (saved?.tempUnit !== this.tempUnit || !(this.now() - saved.at < DISK_MAX_AGE)) return;
      this.data = { at: saved.at, grid: parseOpenMeteo(saved.json, GRID, this.tempUnit), run: saved.run };
      console.log(`[weather] forecast from ${new Date(saved.at).toLocaleTimeString()} (saved)`);
    } catch {}
  }

  /** Start a refresh when the data is older than 20 minutes and the daily cap allows (no-op while one runs). */
  private refresh() {
    const now = this.now();
    this.fetches = this.fetches.filter((t) => now - t < 86_400_000);
    const stale = !this.data || now - this.data.at > TTL;
    if (!stale || this.inflight || now < this.retryAt || (this.data && this.fetches.length >= MAX_PER_DAY)) return;
    this.inflight = this.load()
      .catch((e) => {
        // 429 = over the per-minute or daily limit: wait longer
        this.retryAt = this.now() + (/\b429\b/.test(String(e?.message)) ? 10 : 2) * 60_000;
        console.log(`[weather] refresh failed${this.data ? `, keeping data from ${new Date(this.data.at).toLocaleTimeString()}` : ""}: ${e?.message ?? e}${e?.cause ? ` (${e.cause.code ?? e.cause.message ?? e.cause})` : ""}`);
        throw e;
      })
      .finally(() => (this.inflight = null));
    this.inflight.catch(() => {}); // handled by whoever awaits it
  }

  /** Forecast data: what's cached right away (a refresh starts behind it when stale); waits only when there is none. */
  async forecast(): Promise<{ grid: WxGrid; run?: number }> {
    this.refresh();
    if (!this.data && this.inflight) await this.inflight;
    if (!this.data) throw new Error(this.now() < this.retryAt ? "weather data unavailable, retrying soon" : "no forecast yet");
    return this.data;
  }

  /** Draw the maps one swipe or tap away (layers either side, the next step), one per tick so requests aren't held up. */
  async neighbours(layer: WxLayer, step: number, pos: Pos | null | undefined, view: WxView) {
    const i = WX_LAYERS.indexOf(layer), n = WX_LAYERS.length, k = WX_STEPS.indexOf(step);
    const next: [WxLayer, number][] = [[WX_LAYERS[(i + 1) % n], step], [WX_LAYERS[(i + n - 1) % n], step], [layer, WX_STEPS[(k + 1) % WX_STEPS.length]]];
    for (const [l, s] of next) {
      await new Promise((r) => setImmediate(r));
      await this.map(l, s, pos, view).catch(() => {});
    }
  }

  /** Resolves when a running refresh is done (tests, warm-up). */
  async idle() {
    await this.inflight?.catch(() => {});
  }

  private async load() {
    this.fetches.push(this.now());
    const [r, meta] = await Promise.all([
      this.fetcher(openMeteoUrl(GRID, this.tempUnit), { headers: UA, signal: AbortSignal.timeout(25000) }),
      this.fetcher(META, { headers: UA, signal: AbortSignal.timeout(8000) }).then((m) => m.json()).catch(() => null),
    ]);
    if (!r.ok) throw new Error(`open-meteo ${r.status}: ${(await r.text().catch(() => "")).slice(0, 120)}`);
    const json = await r.json();
    const grid = parseOpenMeteo(json, GRID, this.tempUnit);
    const init = Number((meta as any)?.last_run_initialisation_time);
    this.data = { at: this.now(), grid, run: Number.isFinite(init) && init > 0 ? init * 1000 : undefined };
    this.renders.clear();
    if (this.cacheFile) {
      const file = this.cacheFile, saved = { at: this.data.at, run: this.data.run, tempUnit: this.tempUnit, json };
      void mkdir(dirname(file), { recursive: true }).then(() => writeFile(file, JSON.stringify(saved))).catch(() => {});
    }
    console.log(`[weather] forecast: ${grid.nx * grid.ny + grid.sites.length} points, ${grid.times.length} h${this.data.run ? `, GFS ${new Date(this.data.run).toISOString().slice(11, 13)}Z` : ""}`);
  }

  /** The map for a layer, step and view (cached until the data, the hour or your position changes). */
  async map(layer: WxLayer, step: number, pos?: Pos | null, view: WxView = "detail"): Promise<WxMap> {
    if (!WX_LAYERS.includes(layer)) layer = "sky";
    if (!WX_STEPS.includes(step)) step = 0;
    if (view !== "fast") view = "detail";
    const { grid, run } = await this.forecast();
    const radar = (layer === "precip" || layer === "sky") && step === 0 ? await this.radar.get() : null;
    const now = this.now();
    const key = [layer, step, view, Math.floor(now / 3_600_000), radar?.at ?? 0, pos ? `${pos.lat.toFixed(2)},${pos.lon.toFixed(2)}` : ""].join("|");
    const hit = this.renders.get(key);
    if (hit) return hit;
    const r = renderWx(grid, { layer, step, now, run, model: "GFS", pos, radar, view });
    const map: WxMap = {
      w: view === "fast" ? 288 : 576, h: 288, view, px: toB64(pack4(r.img)), layer, step, valid: r.valid, run,
      frames: r.frames.length ? r.frames : undefined, info: r.info, order: r.order, seq: ++this.seq,
    };
    if (this.renders.size > 64) this.renders.clear();
    this.renders.set(key, map);
    return map;
  }

  /** wx_get from the glasses: answer with wx_map at once (or an error the screen can show); again when a refresh lands. */
  async handle(send: (m: HubMsg) => void, layer: WxLayer, step: number, pos?: Pos | null, view: WxView = "detail") {
    this.usedAt = this.now();
    if (view === "fast" || view === "detail") this.lastView = view;
    try {
      // no phone GPS yet: the hub's own (G2_LAT/G2_LON or IP, city-level) location
      pos ??= await this.fallbackPos();
      const first = await this.map(layer, step, pos, view);
      send({ t: "wx_map", map: first });
      void this.neighbours(layer, step, pos, view);
      if (this.inflight) {
        await this.idle();
        const fresh = await this.map(layer, step, pos, view);
        if (fresh.seq !== first.seq) send({ t: "wx_map", map: fresh });
      }
    } catch (e: any) {
      console.log(`[weather] ${e?.message ?? e}`);
      send({ t: "wx_map", map: null, error: String(e?.message ?? e).slice(0, 80) });
    }
  }
}

export const weather = new WeatherService();

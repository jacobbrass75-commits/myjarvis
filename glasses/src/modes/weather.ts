import type { HubMsg, WxLayer, WxMap, WxView } from "../../../src/shared/protocol";
import { current, render, send, type Box, type Mode, type Screen, type Tile } from "../core";
import { clip, colsFor, fmtClock, fromB64, G, label, labelWidth, LV, Raster, unpack4 } from "../ui/kit";

// WEATHER: a "Weather Channel" map of California drawn by the hub (src/hub/weather) from Open-Meteo's
// GFS forecast. Layers, in swipe order: SKY (clouds dim, rain bright on top; the default), PRESSURE
// (isobars, H/L, streamlines), TEMP, RAIN (radar now), CLOUDS (low/mid dots, high strokes, 50/90%
// edges), WIND speed. Each 288x144 image tile costs ~1.5 s over BLE while text is near-instant.
//
//   FULL (default, "detail")  the whole lens in four tiles, the map with its four framed Lagonda
//                   readouts drawn in. Opening costs four pushes (~6 s), California's tiles first.
//   COMPACT ("fast")  voice "compact weather map" (remembered): the state as a 288x288 map in the
//                   middle (two tiles, ~3 s), the readouts as firmware text boxes either side.
//
// The hub keeps the forecast fetched and the default map (and the maps one swipe or tap away) drawn,
// so a request is answered at once; a map from the last visit (< 20 min, same layout) goes up while it
// does. Only tiles whose pixels changed are pushed, and an all-black tile never is: until the first map
// arrives the tiles stay black instead of carrying a placeholder that would hold the real map up.
// The valid time drawn in changes once an hour at most (with the data), never per minute.
// Ring: swipe down/up = next/previous layer, tap = forecast step (now, +6, +12, +24 h), double tap =
// back, hold = talk. The pressure layer's airflow animation runs in the emulator only.

export const WX_LAYERS: WxLayer[] = ["sky", "pressure", "temp", "precip", "clouds", "wind"];
export const WX_STEPS = [0, 6, 12, 24];
const FRAME_MS = 2000;
const ANIMATE_FOR = 90_000;
const REFRESH_MS = 15 * 60_000;
/** A map kept from the last visit shows straight away on reopening if it is this fresh and the same view. */
const REUSE_MS = 20 * 60_000;

let layer = 0;
let step = 0;
let view: WxView = readView();
let map: WxMap | null = null;
let mapAt = 0;
let base: Raster | null = null;
let frame = 0;
let error = "";
let waiting = false;
let askedAt = 0;
let activeAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let cache: { key: string; tiles: Tile[] } | null = null;

function readView(): WxView {
  try {
    return (globalThis as any).localStorage?.getItem("wxView") === "fast" ? "fast" : "detail";
  } catch {
    return "detail";
  }
}

const wanted = (m: WxMap | null) => !!m && m.layer === WX_LAYERS[layer] && m.step === WX_STEPS[step] && (m.view ?? "detail") === view;

function request() {
  waiting = true;
  askedAt = Date.now();
  send({ t: "wx_get", layer: WX_LAYERS[layer], step: WX_STEPS[step], view });
}

/** Voice: "show me the temperature map for tomorrow", "compact weather map" (applied now, or when the mode opens). */
export function weatherTo(o: { layer?: WxLayer; step?: number; view?: WxView }) {
  if (o.layer && WX_LAYERS.includes(o.layer)) layer = WX_LAYERS.indexOf(o.layer);
  if (o.step !== undefined) step = Math.max(0, WX_STEPS.findIndex((s) => s >= o.step!));
  if (o.view === "fast" || o.view === "detail") {
    view = o.view;
    try {
      (globalThis as any).localStorage?.setItem("wxView", view);
    } catch {}
  }
  if (current()?.id === "weather") request();
}

// ---------------- tiles ----------------

/** Lit pixels: without the hub's order, the tile with the most on it goes out first. */
const ink = (r: Raster) => r.px.reduce((n, v) => n + (v >= 2 ? 1 : 0), 0);

function tiles(): Tile[] {
  const showing = base && map && (map.view ?? "detail") === view ? map : null;
  const key = [showing?.seq ?? -1, frame, view].join("|");
  if (cache?.key === key) return cache.tiles;
  const W = view === "fast" ? 288 : 576;
  // nothing yet: black tiles, which core doesn't push (a fresh image container is black already)
  const r = showing && base ? new Raster(W, 288, base.px.slice()) : new Raster(W, 288);
  const segs = showing?.frames?.[frame % (showing.frames.length || 1)];
  if (segs) for (let i = 0; i + 3 < segs.length; i += 4) r.line(segs[i], segs[i + 1], segs[i + 2], segs[i + 3], 13);
  const x0 = view === "fast" ? 144 : 0;
  const parts = view === "fast"
    ? [r.crop(0, 0, 288, 144), r.crop(0, 144, 288, 144)]
    : [r.crop(0, 0, 288, 144), r.crop(288, 0, 288, 144), r.crop(0, 144, 288, 144), r.crop(288, 144, 288, 144)];
  const pos = view === "fast" ? [[x0, 0], [x0, 144]] : [[0, 0], [288, 0], [0, 144], [288, 144]];
  // push order: the hub's (California's tiles first), else the fullest first
  const order = showing?.order?.length === parts.length ? showing.order : parts.map((p, i) => [ink(p), i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  const out = parts.map((img, i) => ({ slot: i as Tile["slot"], x: pos[i][0], y: pos[i][1], img, prio: order.indexOf(i) }));
  cache = { key, tiles: out };
  return out;
}

// ---------------- text readouts (FAST) ----------------

const BOX_W = 140;
const COLS = colsFor(BOX_W, 4, 1);
const NAME: Record<WxLayer, string> = { sky: "SKY", pressure: "PRESSURE", temp: "TEMP", precip: "RAIN", clouds: "CLOUDS", wind: "WIND MPH" };

function validText(ms: number): string {
  const d = new Date(ms);
  const c = fmtClock(d);
  // valid times are on the hour: "5PM WED" (or "17:00 WED")
  return `${c.ampm ? c.hm.replace(/:00$/, "") : c.hm}${c.ampm ?? ""} ${["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][d.getDay()]}`;
}

function readouts(): { title: string[]; legend: string[]; run: string[]; stat: string[] } {
  const L = WX_LAYERS[layer];
  const m = map && map.layer === L ? map : null;
  const info = m?.info;
  const tu = info?.tempUnit ?? "F";
  const title = [waiting && !wanted(map) ? `WX ${G.ell}` : "WX CALIF", NAME[L] + (L === "temp" ? ` ${tu}` : ""), map && wanted(map) ? validText(map.valid) : error ? "NO DATA" : "LOADING"];
  const legend =
    L === "pressure" ? [`ISO ${info?.interval ?? 4} HPA`, "ARROW=WIND", "OPEN-METEO"]
    : L === "temp" ? [tu === "C" ? "DOT 0-38C" : "DOT 30-100", `LINES 10${tu}`, "OPEN-METEO"]
    : L === "wind" ? ["DOT 0-40", "ARROW=FLOW", "OPEN-METEO"]
    : L === "sky" ? ["DIM=CLOUD", info?.source === "RADAR" ? "LIT=RADAR" : "LIT=RAIN", info?.source === "RADAR" ? "RAINVIEWER" : "OPEN-METEO"]
    : L === "clouds" ? ["DOT=LOW", "/ =HIGH", "LINE 50%"]
    : info?.source === "RADAR" ? ["DOT=RADAR", "RAINVIEWER", "OPEN-METEO"]
    : ["DOT=RAIN", "0.1-5 MM/H", "OPEN-METEO"];
  const cyc = map?.run ? `${String(new Date(map.run).getUTCHours()).padStart(2, "0")}Z` : "--Z";
  const s = WX_STEPS[step];
  const run = [`GFS ${cyc}`, s ? `STEP +${s}H` : "STEP NOW", WX_STEPS.map((_, i) => (i === step ? G.dot : G.mid)).join(" ")];
  const r = (x: number) => String(Math.round(x));
  const stat = !info ? ["CA", " ", " "]
    : L === "pressure" ? [`LO ${r(info.lo)}`, `HI ${r(info.hi)}`, "CA HPA"]
    : L === "temp" ? [`HI ${r(info.hi)}${tu}`, `LO ${r(info.lo)}${tu}`, "CA"]
    : L === "wind" ? [`MAX ${r(info.hi)}`, "CA MPH", " "]
    : L === "sky" ? [`CLOUD ${info.cloud ?? 0}%`, `RAIN ${info.hi.toFixed(1)}`, "CA MM/H"]
    : L === "clouds" ? [`AVG ${info.cloud ?? 0}%`, `MIN ${r(info.lo)}%`, `MAX ${r(info.hi)}%`]
    : [`MAX ${info.hi.toFixed(1)}`, info.source === "RADAR" ? "GFS MM/H" : "CA MM/H", " "];
  return { title, legend, run, stat };
}

function boxes(): Box[] {
  const t = readouts();
  const box = (slot: Box["slot"], x: number, y: number, lines: string[], capture = false): Box => ({
    slot, x, y, w: BOX_W, h: 142, border: 1, borderLevel: LV.frame, pad: 4, capture, text: lines.map((l) => clip(l, COLS)).join("\n"),
  });
  return [box(0, 0, 0, t.title, true), box(1, 0, 146, t.legend), box(2, 436, 0, t.run), box(3, 436, 146, t.stat)];
}

// ---------------- detail placeholder ----------------

let note: { text: string; r: Raster } | null = null;
/** FULL layout and the hub can't get a map: the lens frame and a note (COMPACT says so in text instead). */
function detailNote(text: string): Raster {
  if (note?.text === text) return note.r;
  const r = new Raster(576, 288);
  const c = 8, x1 = 575, y1 = 287;
  r.polyline([[c, 0], [x1 - c, 0], [x1, c], [x1, y1 - c], [x1 - c, y1], [c, y1], [0, y1 - c], [0, c], [c, 0]], LV.frame);
  label(r, Math.round((576 - labelWidth(text)) / 2), 137, text, { level: LV.frame });
  return (note = { text, r }).r;
}

function tick() {
  if (current()?.id !== "weather") return;
  if (Date.now() - askedAt > REFRESH_MS) return request();
  const n = map?.frames?.length ?? 0;
  // On real glasses every frame would re-push the map tiles (~1.5 s each), so the airflow only moves
  // in the browser emulator; the lens gets the still map (streamlines + arrowheads).
  if (n < 2 || (globalThis as any).flutter_inappwebview) return;
  const still = Date.now() - activeAt > ANIMATE_FOR;
  const next = still ? 0 : (frame + 1) % n;
  if (next === frame) return;
  frame = next;
  render();
}

export const weather: Mode = {
  id: "weather",
  title: "Weather",
  enter() {
    frame = 0;
    activeAt = Date.now();
    error = "";
    // A recent map of the same view shows at once (it's on the way to the lens while the hub answers);
    // otherwise the tiles start black and only the hub's map is pushed.
    if (!(map && wanted(map) && Date.now() - mapAt < REUSE_MS)) base = map = null;
    cache = null;
    request();
    clearInterval(timer);
    timer = setInterval(tick, FRAME_MS);
  },
  exit() {
    clearInterval(timer);
    timer = undefined;
  },
  onHub(m: HubMsg) {
    if (m.t === "wx_map") {
      if (!m.map) {
        waiting = false;
        error = m.error || "NO DATA";
        return;
      }
      // an answer to an earlier swipe: wait for the one asked for last
      if (!wanted(m.map)) return;
      waiting = false;
      error = "";
      if (map?.seq === m.map.seq) return;
      map = m.map;
      mapAt = Date.now();
      base = unpack4(fromB64(m.map.px), m.map.w, m.map.h);
      frame = 0;
    } else if (m.t === "welcome" && current()?.id === "weather") request(); // hub came back
  },
  screen(): Screen {
    if (view === "detail") {
      const t = tiles();
      // no map yet: black tiles (not pushed) unless the hub said it has none to give
      if (error && (!base || (map?.view ?? "detail") !== "detail")) {
        const r = detailNote("NO WEATHER DATA");
        return { header: "", noHeader: true, tiles: t.map((x) => ({ ...x, img: r.crop(x.x, x.y, 288, 144) })), captionSlot: "takeover" };
      }
      return { header: "", noHeader: true, tiles: t, captionSlot: "takeover" };
    }
    return { header: "", noHeader: true, tiles: tiles(), boxes: boxes(), captionSlot: 1, toastSlot: 3 };
  },
  gesture(g) {
    activeAt = Date.now();
    if (g === "down" || g === "up") {
      layer = (layer + (g === "down" ? 1 : WX_LAYERS.length - 1)) % WX_LAYERS.length;
      request();
      return true;
    }
    if (g === "tap") {
      step = (step + 1) % WX_STEPS.length;
      request();
      return true;
    }
    return false; // double tap: back
  },
};

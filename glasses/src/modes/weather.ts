import type { HubMsg, WxLayer, WxMap } from "../../../src/shared/protocol";
import { current, render, send, type Mode, type Screen, type Tile } from "../core";
import { fromB64, label, labelWidth, LV, Raster, unpack4 } from "../ui/kit";

// WEATHER: a "Weather Channel" map of California over the whole lens, drawn by the hub
// (src/hub/weather) from Open-Meteo's GFS forecast: isobars with H/L centres and streamlines,
// temperature, precipitation (radar now) or wind speed. Four 288x144 tiles; only changed ones are pushed.
// Ring: swipe down/up = next/previous layer, tap = forecast step (now, +6, +12, +24 h), double tap =
// back, hold = talk. On the pressure layer the airflow moves: four particle frames cycle every 2 s
// (all four tiles change, ~0.8 s of BLE), and go still after 90 s without a gesture.

export const WX_LAYERS: WxLayer[] = ["pressure", "temp", "precip", "wind"];
export const WX_STEPS = [0, 6, 12, 24];
const FRAME_MS = 2000;
const ANIMATE_FOR = 90_000;
const REFRESH_MS = 15 * 60_000;

let layer = 0;
let step = 0;
let map: WxMap | null = null;
let base: Raster | null = null;
let frame = 0;
let error = "";
let waiting = false;
let askedAt = 0;
let activeAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let cache: { key: string; tiles: Raster[] } | null = null;

function request() {
  waiting = true;
  askedAt = Date.now();
  send({ t: "wx_get", layer: WX_LAYERS[layer], step: WX_STEPS[step] });
}

/** Voice: "show me the temperature map for tomorrow" (applied now, or when the mode opens). */
export function weatherTo(o: { layer?: WxLayer; step?: number }) {
  if (o.layer && WX_LAYERS.includes(o.layer)) layer = WX_LAYERS.indexOf(o.layer);
  if (o.step !== undefined) step = Math.max(0, WX_STEPS.findIndex((s) => s >= o.step!));
  if (current()?.id === "weather") request();
}

let placeholder: { text: string; r: Raster } | null = null;
/** Before the first map (or when the hub can't get one): the lens frame and a note. */
function waitingRaster(text: string): Raster {
  if (placeholder?.text === text) return placeholder.r;
  const r = new Raster(576, 288);
  const c = 8, x1 = 575, y1 = 287;
  r.polyline([[c, 0], [x1 - c, 0], [x1, c], [x1, y1 - c], [x1 - c, y1], [c, y1], [0, y1 - c], [0, c], [c, 0]], LV.frame);
  label(r, Math.round((576 - labelWidth("WX CALIFORNIA")) / 2), 116, "WX CALIFORNIA", { level: LV.label });
  label(r, Math.round((576 - labelWidth(text)) / 2), 146, text, { level: LV.frame });
  placeholder = { text, r };
  return r;
}

/** The lens as it should look now: the map, this frame's particles, a LOADING tag while a change is on its way. */
function lens(): Raster {
  if (!base) return waitingRaster(error ? error.toUpperCase().replace(/[^A-Z0-9 .:-]/g, "").slice(0, 36) || "NO DATA" : "LOADING");
  const r = new Raster(576, 288, base.px.slice());
  const segs = map?.frames?.[frame % (map.frames.length || 1)];
  if (segs) for (let i = 0; i + 3 < segs.length; i += 4) r.line(segs[i], segs[i + 1], segs[i + 2], segs[i + 3], 13);
  if (waiting && (map?.layer !== WX_LAYERS[layer] || map?.step !== WX_STEPS[step])) {
    // bottom centre, inside the lower right tile only
    r.fillRect(300, 268, 86, 14, 0);
    label(r, 304, 270, "LOADING", { scale: 1, level: LV.value });
  }
  return r;
}

function tiles(): Tile[] {
  const key = [map?.seq ?? -1, frame, waiting, error, layer, step].join("|");
  if (cache?.key !== key) {
    const r = lens();
    cache = { key, tiles: [r.crop(0, 0, 288, 144), r.crop(288, 0, 288, 144), r.crop(0, 144, 288, 144), r.crop(288, 144, 288, 144)] };
  }
  const t = cache.tiles;
  return [
    { slot: 0, x: 0, y: 0, img: t[0] },
    { slot: 1, x: 288, y: 0, img: t[1] },
    { slot: 2, x: 0, y: 144, img: t[2] },
    { slot: 3, x: 288, y: 144, img: t[3] },
  ];
}

function tick() {
  if (current()?.id !== "weather") return;
  if (Date.now() - askedAt > REFRESH_MS) return request();
  const n = map?.frames?.length ?? 0;
  // On real glasses a full-screen frame is four ~1.7 s tile pushes, so the airflow can't move there:
  // animate only in the browser emulator; the lens gets the still map (streamlines + arrows).
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
      if (m.map.layer !== WX_LAYERS[layer] || m.map.step !== WX_STEPS[step]) return;
      waiting = false;
      error = "";
      map = m.map;
      base = unpack4(fromB64(m.map.px), m.map.w, m.map.h);
      frame = 0;
    } else if (m.t === "welcome" && current()?.id === "weather") request(); // hub came back
  },
  screen(): Screen {
    return { header: "", noHeader: true, tiles: tiles(), captionSlot: "takeover" };
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

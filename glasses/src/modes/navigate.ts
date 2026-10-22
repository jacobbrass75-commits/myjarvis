import type { HubMsg, Maneuver, NavMap, NavState, NavTransit, NavView } from "../../../src/shared/protocol";
import { back, core, render, send, type Box, type Mode, type Screen, type Tile } from "../core";
import { drawManeuver } from "../ui/maneuver";
import { caps, clip, colsFor, digits, digitsWidth, fmtClock, frame, fromB64, label, labelWidth, ladder, LV, Raster, tile, unpack4 } from "../ui/kit";

// Turn-by-turn directions. Start by voice ("walk me to the nearest pharmacy", "take me there by train");
// this screen opens by itself. Stop by voice ("stop navigation") or double tap on the map view.
//
// Views (TAP cycles them):
//   MAP   the hub's 288x288 route-up map on the left (two image tiles), the turn readout top right (turn
//         arrow, distance in big digits, a countdown ladder for the last 100 m) and the street, next turn,
//         ETA and clock in firmware text bottom right, where live words and toasts also go.
//   FULL  the hub's 576x288 map over the whole lens (four tiles) with a slim readout (arrow + distance)
//         drawn into the top-left corner tile; only that tile changes as the distance counts down.
//   ESO   the pared-down readout: the turn and the ETA.
// SWIPE up / down zooms in / out (held ~20 s after the last swipe, then automatic; the level shows
// briefly in the top-left corner). HOLD is push-to-talk. DOUBLE TAP goes back to MAP; on MAP it asks
// "END ROUTE?" (tap yes, double no).

let nav: NavState | null = null;
export type Layout = "map" | "full" | "eso";
let layout: Layout = "map";
/** The latest map from the hub (288 or 576 wide), and its cuts for each view. */
let map: { w: number; seq: number; img: Raster; cuts: Map<number, Raster[]>; zoom?: NavMap["zoom"]; mpp: number } | null = null;
/** The END ROUTE? question is up until then. */
let confirmUntil = 0;
let confirmTimer: ReturnType<typeof setTimeout> | undefined;
/** Zoom level shown in the corner until then (set when a map arrives after a swipe). */
let zoomUntil = 0;
let zoomTimer: ReturnType<typeof setTimeout> | undefined;
let swipedAt = 0;
/** The map seq we last asked the hub to redraw for (so a mismatched map asks once). */
let askedFor = -1;

const CONFIRM_MS = 8000;
const ZOOM_SHOW_MS = 2500;
const VIEWS: Layout[] = ["map", "full", "eso"];

/** Tell the hub which map to draw. */
function tellView(v: NavView = layout) {
  send({ t: "nav_view", view: v });
}

// ---------------- distance shown ----------------

/** Rounded the way the readout shows it: km with one decimal over 1 km, 10 m steps over 100 m, else 5 m. */
export function roundDist(m: number): number {
  if (m >= 995) return m >= 9950 ? Math.round(m / 1000) * 1000 : Math.round(m / 100) * 100;
  if (m >= 100) return Math.round(m / 10) * 10;
  return Math.round(m / 5) * 5;
}

export function fmtDistance(m: number): { text: string; unit: "M" | "KM" } {
  const r = roundDist(m);
  if (r >= 1000) return { text: r >= 10000 ? String(Math.round(r / 1000)) : (r / 1000).toFixed(1), unit: "KM" };
  return { text: String(r), unit: "M" };
}

// GPS jitter makes the distance creep up and down: a bigger number only shows once two readings agree.
// Fed once per nav message (not per draw: every hub message redraws, which would count as a second reading).
let shown = { key: "", m: -1 };
let risingTo = -1;
function stableDistance(n: NavState): number {
  const key = `${n.dest}|${n.maneuver}|${n.street}|${n.instruction}`;
  const m = roundDist(n.distance);
  if (key !== shown.key || shown.m < 0 || m <= shown.m || m === risingTo) {
    shown = { key, m };
    risingTo = -1;
  } else risingTo = m;
  return shown.m;
}

// ---------------- text ----------------

const ABBR: [RegExp, string][] = [
  [/\bStreet\b/gi, "St"], [/\bAvenue\b/gi, "Ave"], [/\bBoulevard\b/gi, "Blvd"], [/\bRoad\b/gi, "Rd"], [/\bDrive\b/gi, "Dr"],
  [/\bLane\b/gi, "Ln"], [/\bPlace\b/gi, "Pl"], [/\bCourt\b/gi, "Ct"], [/\bHighway\b/gi, "Hwy"], [/\bParkway\b/gi, "Pkwy"],
  [/\bExpressway\b/gi, "Expy"], [/\bFreeway\b/gi, "Fwy"], [/\bTerrace\b/gi, "Ter"], [/\bSquare\b/gi, "Sq"],
  [/^North\b/i, "N"], [/^South\b/i, "S"], [/^East\b/i, "E"], [/^West\b/i, "W"],
];
/** CAPS, ASCII only (the lens font is unverified beyond that): "Peñuelas" → "PENUELAS". */
const ascii = (s: string | undefined) => caps((s ?? "").normalize("NFD").replace(/[^\x20-\x7e]/g, "")).replace(/\s+/g, " ").trim();

/** "West 7th Street" → "W 7TH ST". */
export function street(s: string | undefined): string {
  let out = s ?? "";
  for (const [re, to] of ABBR) out = out.replace(re, to);
  return ascii(out);
}

/** "9:05 PM" → "9:05PM". */
const time = (s: string | undefined) => ascii(s).replace(/\s+(AM|PM)$/, "$1");

const WORD: Record<Maneuver, string> = {
  depart: "HEAD OUT", straight: "STRAIGHT", "slight left": "BEAR LEFT", left: "LEFT", "sharp left": "SHARP LEFT",
  "slight right": "BEAR RIGHT", right: "RIGHT", "sharp right": "SHARP RIGHT", uturn: "U-TURN", roundabout: "ROUNDABOUT", arrive: "ARRIVE",
};

/** The first line when the street has no name (footpaths): what to do. */
const DO: Partial<Record<Maneuver, string>> = { straight: "GO STRAIGHT", left: "TURN LEFT", right: "TURN RIGHT" };

function clock(d: Date): string {
  const c = fmtClock(d);
  return c.hm + (c.ampm ?? "");
}

const COLS = colsFor(288, 6, 1);

/** Heading for the stop itself (the step you're on ends where you board). */
const atBoarding = (n: NavState) => n.transit?.phase === "board" && !!n.street && ascii(n.street) === ascii(n.transit.stop);

/** The ride as text: "BUS 38", "METRO RED LINE". */
const ride = (t: NavTransit) => `${t.vehicle} ${ascii(t.line)}`.trim();

export function lines(n: NavState, cols: number): string[] {
  const dest = ascii(n.dest);
  const now = new Date();
  const eta = `ETA ${clock(new Date(now.getTime() + n.etaMin * 60_000))}  ${n.etaMin} MIN`;
  if (n.arrived) return ["ARRIVED", clip(dest, cols), clock(now)];
  const t = n.transit;
  if (t?.phase === "ride") {
    return [`RIDE ${ride(t)}`, t.headsign ? `TO ${ascii(t.headsign)}` : t.stops ? `${t.stops} STOPS` : `TO ${dest}`, `OFF AT ${ascii(t.stop)}`, eta].map((s) => clip(s, cols));
  }
  const m = n.maneuver ?? "straight";
  const onto = atBoarding(n) ? "WALK TO THE STOP" : m === "arrive" ? `ARRIVE ${dest}` : n.street ? `ONTO ${street(n.street)}` : DO[m] ?? WORD[m];
  if (t?.phase === "board") return [onto, `${ride(t)} ${time(t.time)}`.trim(), `AT ${ascii(t.stop)}`, eta].map((s) => clip(s, cols));
  const then = n.thenManeuver
    ? `THEN: ${n.thenManeuver === "arrive" ? "ARRIVE" : `${WORD[n.thenManeuver]} ${street(n.thenStreet)}`.trim()}`
    : `TO ${dest}`;
  const go = fmtDistance(n.remaining);
  const last = n.gps === false ? "NO GPS - CITY FIX" : `TO GO ${go.text} ${go.unit}  ${n.trafficMin ? `+${n.trafficMin} TRAF` : clock(now)}`;
  return [onto, then, eta, last].map((s) => clip(s, cols));
}

// ---------------- tiles ----------------

let readoutCache: { key: string; at: number; r: Raster } | null = null;
let readoutTimer: ReturnType<typeof setTimeout> | undefined;

/** A ride in place of a turn arrow: the vehicle over the line, in a frame. */
function drawRide(r: Raster, x: number, y: number, size: number, t: NavTransit) {
  frame(r, x, y, size, size, { cut: 4, level: LV.accent });
  const small = size < 80;
  const v = clip(t.vehicle, small ? 5 : 6), l = clip(ascii(t.line), small ? 4 : 6);
  const sv: 1 | 2 = small || labelWidth(v) > size - 8 ? 1 : 2;
  const sl: 1 | 2 = labelWidth(l) > size - 8 ? 1 : 2;
  label(r, x + Math.round((size - labelWidth(v, sv)) / 2), y + Math.round(size * 0.22), v, { scale: sv, level: LV.label });
  label(r, x + Math.round((size - labelWidth(l, sl)) / 2), y + Math.round(size * 0.55), l, { scale: sl, level: LV.value });
}

const notchOf = (n: NavState) => (n.transit?.phase === "ride" ? "GET OFF IN" : atBoarding(n) ? "BOARD IN" : "TURN IN");

/** The 288x144 turn readout; redrawn at most once a second (each change is an image push). */
function readout(n: NavState): Raster {
  const dist = shown.m >= 0 ? shown.m : roundDist(n.distance);
  const key = [n.arrived, n.maneuver, n.thenManeuver, n.dest, dist, notchOf(n), n.transit?.line].join("|");
  const now = Date.now();
  if (readoutCache && readoutCache.key !== key && now - readoutCache.at < 1000) {
    if (!readoutTimer) readoutTimer = setTimeout(() => ((readoutTimer = undefined), render()), 1000 - (now - readoutCache.at));
    return readoutCache.r;
  }
  if (readoutCache?.key === key) return readoutCache.r;
  const r = tile();
  if (n.arrived) {
    frame(r, 0, 0, 288, 144, { cut: 8, notch: "ARRIVED" });
    drawManeuver(r, 12, 32, 96, "arrive", true);
    const name = ascii(n.dest);
    // the destination's name in up to two lines of the label font
    const words = name.split(" ");
    const rows: string[] = [""];
    for (const w of words) {
      const next = rows[rows.length - 1] ? `${rows[rows.length - 1]} ${w}` : w;
      if (labelWidth(next) <= 156) rows[rows.length - 1] = next;
      else if (rows.length < 2) rows.push(w);
      else break;
    }
    rows.forEach((t, i) => label(r, 120, 52 + i * 24, t, { level: LV.value }));
  } else {
    frame(r, 0, 0, 288, 144, { cut: 8, notch: notchOf(n) });
    if (n.transit && (n.transit.phase === "ride" || atBoarding(n))) drawRide(r, 12, 32, 96, n.transit);
    else drawManeuver(r, 12, 32, 96, n.maneuver, dist <= 50);
    const { text, unit } = fmtDistance(dist);
    const dw = digitsWidth(text, "XL"), uw = labelWidth(unit);
    const x = Math.max(112, Math.min(120, 280 - dw - 4 - uw));
    digits(r, x, 40, text, "XL", { level: LV.value });
    label(r, x + dw + 4, 40 + 72 - 14, unit, { level: LV.label });
    // last 100 m: one segment goes out every 10 m
    if (dist < 100) ladder(r, 120, 124, 10, Math.max(0, Math.min(10, Math.ceil(dist / 10))), { segW: 10, segH: 6, gap: 3 });
    if (n.thenManeuver && !n.transit) drawManeuver(r, 258, 116, 22, n.thenManeuver, false, 7);
  }
  readoutCache = { key, at: now, r };
  return r;
}

const placeholders = new Map<number, Raster[]>();
/** Before the first map of this size arrives: the map's frame and a note. */
function waitingMap(w: number): Raster[] {
  const hit = placeholders.get(w);
  if (hit) return hit;
  const r = new Raster(w, 288);
  frame(r, 0, 0, w, 288, { cut: 8 });
  const t = "MAP LOADING";
  label(r, Math.round((w - labelWidth(t)) / 2), 137, t, { level: LV.frame });
  const out = quarters(r);
  placeholders.set(w, out);
  return out;
}

/** A map cut into 288x144 tiles, row by row: [top, bottom] or [top-left, top-right, bottom-left, bottom-right]. */
function quarters(r: Raster): Raster[] {
  const out: Raster[] = [];
  for (let y = 0; y < r.h; y += 144) for (let x = 0; x < r.w; x += 288) out.push(r.crop(x, y, 288, 144));
  return out;
}

const fmtMpp = (m: number) => (m < 1 ? m.toFixed(1) : String(Math.round(m)));

/** "ZOOM" with an LED ladder (more lit = closer) and the scale, at (x, y) on a black plate: ~132x30. */
function drawZoom(r: Raster, x: number, y: number) {
  const z = map?.zoom;
  if (!z || !map) return;
  r.fillRect(x, y, 134, 30, 0);
  frame(r, x, y, 134, 30, { cut: 4 });
  label(r, x + 8, y + 6, "ZOOM", { scale: 1, level: LV.label });
  label(r, x + 8, y + 17, z.manual ? "HOLD" : "AUTO", { scale: 1, level: z.manual ? LV.accent : LV.frame });
  ladder(r, x + 42, y + 8, z.of, z.of - z.step, { segW: 6, segH: 6, gap: 2 });
  label(r, x + 42, y + 18, `${fmtMpp(map.mpp)}M/PX`, { scale: 1, level: LV.value });
}

/** The slim readout for the full map: arrow (or ride) + distance on a black plate, top left, ~170x64. */
function drawSlim(r: Raster, n: NavState) {
  r.fillRect(0, 0, 172, 66, 0);
  frame(r, 0, 0, 172, 66, { cut: 4 });
  const dist = shown.m >= 0 ? shown.m : roundDist(n.distance);
  if (n.arrived) {
    drawManeuver(r, 8, 9, 48, "arrive", true);
    label(r, 64, 26, "ARRIVED", { level: LV.value });
    return;
  }
  if (n.transit && (n.transit.phase === "ride" || atBoarding(n))) drawRide(r, 8, 9, 48, n.transit);
  else drawManeuver(r, 8, 9, 48, n.maneuver, dist <= 50);
  const { text, unit } = fmtDistance(dist);
  const dw = digitsWidth(text, "L");
  digits(r, 64, 11, text, "L", { level: LV.value });
  label(r, Math.min(64 + dw + 4, 172 - 4 - labelWidth(unit, 1)), 11 + 44 - 7, unit, { scale: 1, level: LV.label });
}

let cornerCache: { key: string; at: number; r: Raster } | null = null;
let cornerTimer: ReturnType<typeof setTimeout> | undefined;

/** The top-left map tile with what's drawn over it (full: slim readout; both: zoom level for a moment). */
function corner(base: Raster, seq: number, n: NavState): Raster {
  const slim = layout === "full";
  const zoom = Date.now() < zoomUntil && !!map?.zoom;
  if (!slim && !zoom) return base;
  const dist = shown.m >= 0 ? shown.m : roundDist(n.distance);
  const key = [layout, seq, zoom, slim ? [n.arrived, n.maneuver, dist, n.transit?.phase, n.transit?.line] : ""].join("|");
  const now = Date.now();
  if (cornerCache?.key === key) return cornerCache.r;
  // Distance changes go out at most once a second; a new map, view or zoom at once.
  const sameMap = cornerCache?.key.split("|").slice(0, 3).join("|") === key.split("|").slice(0, 3).join("|");
  if (cornerCache && sameMap && now - cornerCache.at < 1000) {
    if (!cornerTimer) cornerTimer = setTimeout(() => ((cornerTimer = undefined), render()), 1000 - (now - cornerCache.at));
    return cornerCache.r;
  }
  const r = new Raster(base.w, base.h, base.px.slice());
  if (slim) drawSlim(r, n);
  if (zoom) drawZoom(r, slim ? 4 : 8, slim ? 72 : 8);
  cornerCache = { key, at: now, r };
  return r;
}

/**
 * The latest map as `w`-wide tiles. A map drawn for the other view stands in until the right one comes:
 * the middle of a full map is exactly the 288 map (you at 144, 220); a 288 map sits in the middle of the
 * full view.
 */
function cuts(w: number): Raster[] {
  if (!map) return waitingMap(w);
  let c = map.cuts.get(w);
  if (!c) {
    if (map.w === w) c = quarters(map.img);
    else if (w === 288) c = quarters(map.img.crop(144, 0, 288, 288));
    else {
      const r = new Raster(576, 288);
      r.blit(map.img, 144, 0);
      c = quarters(r);
    }
    map.cuts.set(w, c);
  }
  return c;
}

function mapTiles(n: NavState): Tile[] {
  const w = layout === "full" ? 576 : 288;
  const parts = cuts(w).slice();
  const seq = map ? map.seq * 2 + (map.w === w ? 1 : 0) : -1;
  parts[0] = corner(parts[0], seq, n);
  if (w === 288)
    // the half with you in it goes first
    return [
      { slot: 0, x: 0, y: 0, img: parts[0], prio: 2 },
      { slot: 1, x: 0, y: 144, img: parts[1], prio: 1 },
    ];
  // the corner with the readout first, then the bottom row (you), then the top right
  return [
    { slot: 0, x: 0, y: 0, img: parts[0], prio: 0 },
    { slot: 1, x: 288, y: 0, img: parts[1], prio: 3 },
    { slot: 2, x: 0, y: 144, img: parts[2], prio: 1 },
    { slot: 3, x: 288, y: 144, img: parts[3], prio: 2 },
  ];
}

// ---------------- gestures ----------------

function setLayout(l: Layout) {
  if (l === layout) return;
  layout = l;
  tellView();
}

function confirming() {
  return Date.now() < confirmUntil;
}

function askEnd() {
  confirmUntil = Date.now() + CONFIRM_MS;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(render, CONFIRM_MS + 20);
}

function cancelEnd() {
  confirmUntil = 0;
  clearTimeout(confirmTimer);
}

function clearMap() {
  map = null;
  cornerCache = null;
  zoomUntil = 0;
}

/** Testing hook: which view is up. */
export const navLayout = () => layout;

// ---------------- mode ----------------

export const navigate: Mode = {
  id: "navigate",
  title: "Navigate",
  enter() {
    if (nav) tellView();
  },
  exit() {
    cancelEnd();
    tellView("off");
  },
  onHub(m: HubMsg) {
    if (m.t === "nav") {
      const was = nav;
      nav = m.nav;
      if (nav) {
        stableDistance(nav);
        // a new route: start on the map view, and tell the hub (it may still think "off")
        if (!was) tellView();
      } else {
        clearMap();
        cancelEnd();
      }
    } else if (m.t === "nav_map") {
      if (!m.map) return clearMap();
      const want = layout === "full" ? 576 : 288;
      // The hub drew for another view (it restarted, or this page did): ask for ours, once per map.
      if ((layout === "eso" || m.map.w !== want) && askedFor !== m.map.seq) {
        askedFor = m.map.seq;
        tellView();
      }
      map = { w: m.map.w, seq: m.map.seq, img: unpack4(fromB64(m.map.px), m.map.w, m.map.h), cuts: new Map(), zoom: m.map.zoom, mpp: m.map.mpp };
      // the first map after a swipe shows its zoom level for a moment
      if (Date.now() - swipedAt < 4000) {
        zoomUntil = Date.now() + ZOOM_SHOW_MS;
        clearTimeout(zoomTimer);
        zoomTimer = setTimeout(render, ZOOM_SHOW_MS + 20);
      }
    }
  },
  screen(): Screen {
    if (!nav) return { header: "NAVIGATE", body: "\nHold and say where to go, like:\n\n“walk me to the nearest coffee shop”\n“take me to LAX by train”" };
    // Full map has no text box: a toast (a voice reply) shows on the MAP view until it goes.
    const view: Layout = layout === "full" && core.toast ? "map" : layout;
    if (view === "eso") {
      const head = readout(nav);
      const [onto, second, eta] = lines(nav, COLS);
      const first = nav.transit?.phase === "ride" ? `OFF AT ${ascii(nav.transit.stop)}` : nav.transit?.phase === "board" ? second : onto;
      const box: Box = { slot: 0, x: 144, y: 204, w: 288, h: 80, border: 1, pad: 6, capture: true, text: nav.arrived ? `ARRIVED\n${clip(ascii(nav.dest), COLS)}` : `${clip(first, COLS)}\n${nav.transit?.phase === "ride" ? lines(nav, COLS)[3] : eta}` };
      return {
        header: clip(`NAV  ${ascii(nav.dest)}`, 36) + `  ${clock(new Date())}`,
        tiles: [{ slot: 0, x: 144, y: 48, img: head, prio: 0 }],
        boxes: [box],
        captionSlot: 0,
      };
    }
    if (view === "full" && layout === "full") {
      return { header: "", noHeader: true, tiles: mapTiles(nav), captionSlot: "takeover" };
    }
    const saved = layout;
    layout = "map"; // mapTiles() draws for the view on the lens
    const tiles = mapTiles(nav);
    layout = saved;
    const text = confirming() ? ["END ROUTE?", "", "TAP: YES, END IT", "DOUBLE: NO"].join("\n") : lines(nav, COLS).join("\n");
    return {
      header: "",
      noHeader: true,
      tiles: [...tiles, { slot: 2, x: 288, y: 0, img: readout(nav), prio: 0 }],
      boxes: [{ slot: 0, x: 288, y: 148, w: 288, h: 140, border: 1, pad: 6, capture: true, text }],
      captionSlot: 0,
      toastSlot: 0,
    };
  },
  gesture(g) {
    if (!nav) return false;
    if (confirming()) {
      cancelEnd();
      if (g === "tap") {
        send({ t: "nav_stop" });
        nav = null;
        clearMap();
        back();
      }
      // double (or a swipe): keep going
      return true;
    }
    if (g === "tap") {
      setLayout(VIEWS[(VIEWS.indexOf(layout) + 1) % VIEWS.length]);
      return true;
    }
    if (g === "double") {
      if (layout !== "map") setLayout("map");
      else askEnd();
      return true;
    }
    if (g === "up" || g === "down") {
      if (layout === "eso") return true; // no map to zoom
      swipedAt = Date.now();
      send({ t: "nav_zoom", dir: g === "up" ? "in" : "out" });
      return true;
    }
    return false;
  },
};

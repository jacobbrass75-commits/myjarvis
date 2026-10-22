// Offline previews of Navigate's FULL map view (and the MAP view's END ROUTE? card): the real hub
// Navigator on canned roads/routes (a street grid, OSRM walking, Google transit), wired to the real
// glasses Navigate screen on a fake bridge, as the glasses would send nav_view / nav_zoom.
//   node --import tsx scripts/navmap-full-preview.mjs <out dir>   (npm run nav:full:preview -- <out dir>)
// Writes fullmap-walk.png, fullmap-zoom.png, fullmap-drive.png, fullmap-transit.png, fullmap-confirm.png (576x288 at 2x).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { core, render } from "../glasses/src/core.ts";
import { navigate } from "../glasses/src/modes/navigate.ts";
import { unlocal } from "../src/hub/map/geo.ts";
import { GoogleBase } from "../src/hub/map/google.ts";
import { OsmBase } from "../src/hub/map/osm.ts";
import { Navigator } from "../src/hub/nav.ts";
import { fakeBridge, greenPng, lensRaster, settle } from "./lens-preview.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: navmap-full-preview.mjs <out dir>");
mkdirSync(out, { recursive: true });

const O = { lat: 37.788, lon: -122.4075 };
const at = (x, y) => unlocal(O, x, y);
const json = (j) => new Response(JSON.stringify(j), { headers: { "Content-Type": "application/json" } });

// a street grid: 80 m blocks, every third street a main road, a diagonal avenue and a park path
function grid() {
  const el = [];
  let id = 1;
  const way = (hw, pts) => el.push({ type: "way", id: id++, tags: { highway: hw }, geometry: pts.map((p) => ({ lat: p.lat, lon: p.lon })) });
  for (let x = -2400; x <= 2400; x += 80) way(x % 240 ? "residential" : "primary", [at(x, -2400), at(x, 3200)]);
  for (let y = -2400; y <= 3200; y += 80) way(y % 240 ? "residential" : "secondary", [at(-2400, y), at(2400, y)]);
  way("trunk", [at(-2400, -1600), at(2400, 2400)]);
  way("footway", [at(-200, 40), at(-60, 120), at(-140, 200)]);
  return { elements: el };
}
const osm = new OsmBase(undefined, {}, (async () => new Response("offline", { status: 503 })));
osm.load(O, 4000, grid());

// walk: 320 m north, right 240 m east, left 160 m north
const WALK = [at(0, 0), at(0, 160), at(0, 320), at(120, 320), at(240, 320), at(240, 480)];
const osrm = (line) => ({
  routes: [{
    distance: 720, duration: 540, geometry: { type: "LineString", coordinates: line.map((p) => [p.lon, p.lat]) },
    legs: [{ steps: [
      { distance: 320, name: "Powell Street", maneuver: { type: "depart", bearing_after: 0, location: [line[0].lon, line[0].lat] } },
      { distance: 240, name: "Sutter Street", maneuver: { type: "turn", modifier: "right", location: [line[2].lon, line[2].lat] } },
      { distance: 160, name: "Stockton Street", maneuver: { type: "turn", modifier: "left", location: [line[4].lon, line[4].lat] } },
      { distance: 0, name: "", maneuver: { type: "arrive", location: [line[5].lon, line[5].lat] } },
    ] }],
  }],
});
// transit: walk 80 m to the stop, bus 1.6 km north-east, walk 80 m
const T = [at(0, 0), at(0, 80), at(400, 480), at(800, 880), at(1100, 1300), at(1180, 1300)];
const enc = (pts) => {
  let s = "", pl = 0, pn = 0;
  const e = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1, o = "";
    while (n >= 0x20) (o += String.fromCharCode((0x20 | (n & 0x1f)) + 63)), (n >>= 5);
    return o + String.fromCharCode(n + 63);
  };
  for (const p of pts) {
    const a = Math.round(p.lat * 1e5), b = Math.round(p.lon * 1e5);
    s += e(a - pl) + e(b - pn);
    pl = a;
    pn = b;
  }
  return s;
};
const ll = (p) => ({ latLng: { latitude: p.lat, longitude: p.lon } });
const TRANSIT = {
  routes: [{
    distanceMeters: 1800, duration: "1080s", polyline: { encodedPolyline: enc(T) },
    legs: [{ steps: [
      { distanceMeters: 80, staticDuration: "60s", startLocation: ll(T[0]), endLocation: ll(T[1]), travelMode: "WALK", navigationInstruction: { maneuver: "DEPART", instructions: "Head north on Powell St" } },
      {
        distanceMeters: 1640, startLocation: ll(T[1]), endLocation: ll(T[4]), travelMode: "TRANSIT",
        transitDetails: {
          stopDetails: { departureStop: { name: "Powell St & Geary" }, arrivalStop: { name: "Van Ness Ave" } },
          localizedValues: { departureTime: { time: { text: "9:05 PM" } }, arrivalTime: { time: { text: "9:17 PM" } } },
          headsign: "Ocean Beach", stopCount: 7, transitLine: { nameShort: "38R", name: "Geary Rapid", vehicle: { type: "BUS" } },
        },
      },
      { distanceMeters: 80, staticDuration: "60s", startLocation: ll(T[4]), endLocation: ll(T[5]), travelMode: "WALK", navigationInstruction: { maneuver: "TURN_RIGHT", instructions: "Turn right onto Larkin St" } },
    ] }],
  }],
};
const fetcher = (async (input, init = {}) => {
  const url = String(input);
  if (url.includes("places.googleapis.com")) return json({ places: [{ displayName: { text: "Tataki Ramen" }, location: { latitude: T[5].lat, longitude: T[5].lon }, rating: 4.6, userRatingCount: 1200, currentOpeningHours: { openNow: true } }] });
  if (url.includes("routes.googleapis.com")) return json(TRANSIT);
  if (url.includes("nominatim")) return json([{ lat: String(WALK[5].lat), lon: String(WALK[5].lon), name: "Blue Bottle", display_name: "Blue Bottle" }]);
  if (url.includes("route/v1")) return json(osrm(WALK));
  void init;
  return new Response("offline", { status: 503 });
});

let lastMap = null;
let key = "";
const n = new Navigator(
  (s) => navigate.onHub({ t: "nav", nav: s }),
  (m) => {
    lastMap = m;
    navigate.onHub({ t: "nav_map", map: m });
    render();
  },
  { fetcher, google: new GoogleBase(""), osm, key: () => key, log: () => {} },
);
const b = fakeBridge();
core.bridge = b;
// what server.ts does with the glasses' messages
core.ws = {
  readyState: 1,
  send(s) {
    const m = JSON.parse(s);
    if (m.t === "nav_view") n.setView(m.view);
    if (m.t === "nav_zoom") n.zoomBy(m.dir);
    if (m.t === "nav_stop") n.stop();
  },
};
core.stack = [navigate];

const waitMap = async (w, f = () => true) => {
  const seq = lastMap?.seq ?? 0;
  for (let i = 0; i < 400; i++) {
    if (lastMap && lastMap.seq > seq && lastMap.w === w && f(lastMap)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no map");
};
const snap = async (name) => {
  render();
  await settle();
  writeFileSync(join(out, `${name}.png`), greenPng(lensRaster(b)));
  console.log(`wrote ${join(out, `${name}.png`)}`);
};

// walk, FULL view (tap from MAP), 100 m along
n.moved({ ...O, accuracy: 5 });
console.log(await n.start("coffee", "walk"));
navigate.gesture("tap", 0);
n.moved({ ...at(0, 100), accuracy: 5 });
await waitMap(576);
await snap("fullmap-walk");
// swipe down = zoom out: the zoom plate shows under the readout
navigate.gesture("down", 0);
await waitMap(576, (m) => !!m.zoom?.manual);
await snap("fullmap-zoom");
// zoom further out, as driving at speed would
navigate.gesture("down", 0);
navigate.gesture("down", 0);
await waitMap(576, (m) => m.mpp >= 8);
await snap("fullmap-drive");
n.stop();
await settle();

// transit with a (canned) Google key: on the bus
key = "preview-key";
n.moved({ ...O, accuracy: 5 });
console.log(await n.start("ramen", "transit"));
n.moved({ ...at(0, 75), accuracy: 5 });
await new Promise((r) => setTimeout(r, 1100)); // corner readout redraws at most once a second
n.moved({ ...at(300, 380), accuracy: 5 });
await waitMap(576);
await new Promise((r) => setTimeout(r, 1100));
await snap("fullmap-transit");
// double tap: back to MAP; again: END ROUTE?
navigate.gesture("double", 0);
await waitMap(288);
navigate.gesture("double", 0);
await snap("fullmap-confirm");
n.stop();
process.exit(0);

// Navigate map, offline: geometry, the renderer on canned Overpass + an L-shaped route, the PNG decoder,
// the Google provider (fake fetch, key never logged), the redraw policy, and the Navigator end to end on
// canned Nominatim/OSRM/Overpass answers. Also the glasses' Navigate screen against the page rules.
//   node --import tsx --test scripts/navmap-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import type { HubMsg, NavMap, NavState } from "../src/shared/protocol.js";
import { unpack4 } from "../src/shared/raster.js";
import { bearing, clipPolyline, cumulative, haversine, projector, simplify, snapToLine, unlocal, type Pos } from "../src/hub/map/geo.js";
import { GoogleBase, mppAt, staticMapUrl, zoomFor } from "../src/hub/map/google.js";
import { OsmBase, overpassQuery, parseOverpass } from "../src/hub/map/osm.js";
import { decodePng } from "../src/hub/map/png-decode.js";
import { ME_X, ME_Y, renderNavMap, type MapView } from "../src/hub/map/render.js";
import { MapPolicy, maneuverOf, Navigator, zoomStep } from "../src/hub/nav.js";

// ---------------- fixtures ----------------

const O: Pos = { lat: 30.2672, lon: -97.7431 };
/** metres east/north of O */
const at = (x: number, y: number) => unlocal(O, x, y);
/** 300 m north, then 300 m east. */
const ROUTE: Pos[] = [at(0, 0), at(0, 100), at(0, 200), at(0, 300), at(150, 300), at(300, 300)];
const DEST = at(300, 300);

const way = (id: number, highway: string, pts: Pos[]) => ({ type: "way", id, tags: { highway, name: `W${id}` }, geometry: pts.map((p) => ({ lat: p.lat, lon: p.lon })) });
const OVERPASS = {
  elements: [
    way(1, "primary", [at(0, -400), at(0, 600)]),
    way(2, "residential", [at(60, -400), at(60, 600)]),
    way(3, "footway", [at(-60, -400), at(-60, 600)]),
    way(4, "residential", [at(-400, 300), at(600, 300)]),
    way(5, "construction", [at(-30, -400), at(-30, 600)]),
    { type: "node", id: 9, lat: O.lat, lon: O.lon },
  ],
};

const OSRM = {
  routes: [{
    distance: 600, duration: 450,
    geometry: { type: "LineString", coordinates: ROUTE.map((p) => [p.lon, p.lat]) },
    legs: [{
      steps: [
        { distance: 300, name: "Congress Avenue", maneuver: { type: "depart", bearing_after: 0, location: [ROUTE[0].lon, ROUTE[0].lat] } },
        { distance: 300, name: "West 7th Street", maneuver: { type: "turn", modifier: "right", location: [ROUTE[3].lon, ROUTE[3].lat] } },
        { distance: 0, name: "", maneuver: { type: "arrive", location: [DEST.lon, DEST.lat] } },
      ],
    }],
  }],
};
const NOMINATIM = [{ lat: String(DEST.lat), lon: String(DEST.lon), name: "Test Cafe", display_name: "Test Cafe, Austin" }];

const json = (j: unknown) => new Response(JSON.stringify(j), { headers: { "Content-Type": "application/json" } });

/** A fetch that answers from the fixtures and records what was asked. */
function fakeFetch(calls: string[]): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("nominatim")) return json(NOMINATIM);
    if (url.includes("route/v1")) return json(OSRM);
    if (url.includes("interpreter")) return json(OVERPASS);
    return new Response("no", { status: 404 });
  }) as typeof fetch;
}

const view = (o: Partial<MapView> = {}): MapView => ({ pos: at(0, 100), bearing: 0, mpp: 1, route: ROUTE, snapIdx: 1, onRoute: true, dest: DEST, profile: "walk", ...o });

const loadedOsm = () => {
  const osm = new OsmBase(undefined, {}, (async () => new Response("offline", { status: 503 })) as typeof fetch);
  osm.load(O, 700, OVERPASS);
  return osm;
};

// ---------------- geometry ----------------

test("geo: distances, bearings, projection, snapping, simplify, clipping", () => {
  assert.ok(Math.abs(haversine(at(0, 0), at(0, 300)) - 300) < 1.5);
  assert.ok(Math.abs(bearing(at(0, 0), at(0, 300)) - 0) < 0.5);
  assert.ok(Math.abs(bearing(at(0, 0), at(300, 0)) - 90) < 0.5);
  // route-up: heading east, a point east of you is straight up, north is to the left
  const toPx = projector(O, 90, 1, ME_X, ME_Y);
  const [ex, ey] = toPx(at(50, 0));
  assert.ok(Math.abs(ex - ME_X) < 0.5 && Math.abs(ey - (ME_Y - 50)) < 0.5);
  const [nx] = toPx(at(0, 50));
  assert.ok(nx < ME_X - 49);
  const cum = cumulative(ROUTE);
  const s = snapToLine(ROUTE, cum, at(10, 150))!;
  assert.equal(s.idx, 1);
  assert.ok(Math.abs(s.off - 10) < 0.5 && Math.abs(s.along - 150) < 1);
  assert.deepEqual(simplify([[0, 0], [10, 0.5], [20, 0], [20, 20]], 1.5), [[0, 0], [20, 0], [20, 20]]);
  const runs = clipPolyline([[-100, 50], [100, 50], [100, 400]], 0, 0, 288, 288);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].map(([x, y]) => [Math.round(x), Math.round(y)]), [[0, 50], [100, 50], [100, 288]]);
});

// ---------------- renderer ----------------

test("render: OSM roads + L route: chevron, route ahead bright, walked dim, roads by class", async () => {
  const out = await renderNavMap(view(), loadedOsm());
  const px = (x: number, y: number) => out.img.get(x, y);
  assert.equal(out.source, "osm");
  assert.equal(out.img.w, 288);
  assert.equal(out.img.h, 288);
  assert.equal(px(ME_X, ME_Y), 15, "chevron at (144, 220)");
  assert.equal(px(ME_X, ME_Y - 60), 15, "route ahead, 60 m north");
  assert.equal(px(ME_X + 60, ME_Y - 200), 15, "route ahead after the right turn");
  assert.equal(px(ME_X, ME_Y + 50), 4, "walked part");
  assert.equal(px(ME_X + 60, ME_Y - 40), 6, "residential street, 1 px at 6");
  assert.equal(px(ME_X - 60, ME_Y - 41) || px(ME_X - 60, ME_Y - 42), 5, "footway dotted at 5");
  assert.equal(px(ME_X - 30, ME_Y - 41), 0, "highway=construction isn't drawn");
  assert.equal(px(ME_X, ME_Y - 104), 15, "primary road under the route stays route-bright");
  assert.ok(out.img.crop(0, 0, 288, 144).lit() <= 0.15 && out.img.crop(0, 144, 288, 144).lit() <= 0.15, "lit budget");
});

test("render: route-up rotation and route-only fallback", async () => {
  // At the corner, heading east: the east leg points up the lens.
  const out = await renderNavMap(view({ pos: at(0, 300), bearing: 90, snapIdx: 3 }), null);
  assert.equal(out.source, "route");
  assert.equal(out.img.get(ME_X, ME_Y - 80), 15);
  assert.equal(out.img.get(ME_X + 80, ME_Y), 4, "heading east, the walked leg (from the south) is to the right");
});

// ---------------- PNG decoding ----------------

/** A tiny PNG encoder that uses every filter type in turn, so the decoder's unfiltering is exercised. */
function png(w: number, h: number, type: number, depth: number, rows: Uint8Array[], extra: [string, Uint8Array][] = []): Buffer {
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]!;
  const bpp = Math.max(1, (ch * depth) >> 3);
  const stride = Math.ceil((w * ch * depth) / 8);
  const raw: number[] = [];
  let prev: Uint8Array = new Uint8Array(stride);
  rows.forEach((row, y) => {
    const f = y % 5;
    raw.push(f);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const pa = Math.abs(a + b - c - a), pb = Math.abs(a + b - c - b), pc = Math.abs(a + b - c - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw.push((row[i] - pred) & 255);
    }
    prev = row;
  });
  const chunk = (t: string, d: Uint8Array) => {
    const b = Buffer.alloc(12 + d.length);
    b.writeUInt32BE(d.length, 0);
    b.write(t, 4, "latin1");
    Buffer.from(d).copy(b, 8);
    return b; // the decoder doesn't check CRCs
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0);
  ih.writeUInt32BE(h, 4);
  ih[8] = depth;
  ih[9] = type;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), ...extra.map(([t, d]) => chunk(t, d)), chunk("IDAT", deflateSync(Buffer.from(raw))), chunk("IEND", new Uint8Array(0))]);
}

test("png: grey, RGB, palette (8 and 4 bit), grey+alpha, RGBA, 1-bit grey", () => {
  const W = 7, H = 6;
  const want = Array.from({ length: W * H }, (_, i) => (i * 37) % 256);
  const rowsOf = (f: (v: number, x: number, y: number) => number[]) =>
    Array.from({ length: H }, (_, y) => Uint8Array.from(Array.from({ length: W }, (_, x) => f(want[y * W + x], x, y)).flat()));
  const close = (g: { px: Uint8Array }, exp: number[], tol = 1) => exp.forEach((v, i) => assert.ok(Math.abs(g.px[i] - v) <= tol, `px ${i}: ${g.px[i]} vs ${v}`));

  close(decodePng(png(W, H, 0, 8, rowsOf((v) => [v]))), want);
  close(decodePng(png(W, H, 2, 8, rowsOf((v) => [v, v, v]))), want);
  close(decodePng(png(W, H, 4, 8, rowsOf((v) => [v, 255]))), want);
  close(decodePng(png(W, H, 6, 8, rowsOf((v) => [v, v, v, 128]))), want.map((v) => Math.round((v * 128) / 255)));
  // palette: index = pixel % 16, palette entry k = grey k*17
  const pal = Uint8Array.from(Array.from({ length: 16 }, (_, k) => [k * 17, k * 17, k * 17]).flat());
  const idx = want.map((v) => v % 16);
  close(decodePng(png(W, H, 3, 8, rowsOf((v) => [v % 16]), [["PLTE", pal]])), idx.map((k) => k * 17));
  const packed4 = Array.from({ length: H }, (_, y) => {
    const b = new Uint8Array(Math.ceil(W / 2));
    for (let x = 0; x < W; x++) b[x >> 1] |= idx[y * W + x] << (x & 1 ? 0 : 4);
    return b;
  });
  close(decodePng(png(W, H, 3, 4, packed4, [["PLTE", pal]])), idx.map((k) => k * 17));
  const bits = want.map((v) => (v >= 128 ? 1 : 0));
  const packed1 = Array.from({ length: H }, (_, y) => {
    const b = new Uint8Array(Math.ceil(W / 8));
    for (let x = 0; x < W; x++) b[x >> 3] |= bits[y * W + x] << (7 - (x & 7));
    return b;
  });
  close(decodePng(png(W, H, 0, 1, packed1)), bits.map((b) => b * 255));
  assert.throws(() => decodePng(new Uint8Array(40)), /not a PNG/);
});

// ---------------- Google ----------------

/** A 640x640 styled map as Google would send it: black, with a white road across the middle row band and a grey one down the middle. */
function fakeGoogleMap(): Buffer {
  const rows = Array.from({ length: 640 }, (_, y) => Uint8Array.from(Array.from({ length: 640 }, (_, x) => (Math.abs(y - 320) <= 3 ? 255 : Math.abs(x - 400) <= 2 ? 0x78 : 0))));
  return png(640, 640, 0, 8, rows);
}

test("google: styled request, quantised roads, key never logged, refusal falls back", async () => {
  const KEY = "TEST-KEY-do-not-log-123";
  const logs: string[] = [];
  const urls: string[] = [];
  let status = 200;
  const g = new GoogleBase(KEY, (async (u: any) => {
    urls.push(String(u));
    return status === 200 ? new Response(new Uint8Array(fakeGoogleMap()), { headers: { "Content-Type": "image/png" } }) : new Response("denied", { status });
  }) as typeof fetch, (s) => logs.push(s));
  const v = view({ pos: O, route: [], snapIdx: -1, onRoute: false, mpp: 1 });
  const out = await renderNavMap(v, g);
  assert.equal(out.source, "google");
  const z = zoomFor(O.lat, 1);
  assert.equal(z, 17);
  assert.equal(out.mpp, mppAt(z, O.lat), "drawn at the zoom level's own scale");
  assert.equal(out.img.get(40, ME_Y), 9, "white road → level 9");
  // the grey road is 80 image px east of the centre (1 image px per lens px)
  assert.equal(out.img.get(ME_X + 80, 60), 5, "grey road → level 5");
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes("style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff"));
  assert.ok(urls[0].includes("size=640x640") && urls[0].includes(`key=${KEY}`));
  // cached: a small move doesn't fetch again
  await renderNavMap({ ...v, pos: unlocal(O, 10, 0) }, g);
  assert.equal(urls.length, 1);
  // route-up: heading east, the east-west road runs up the lens
  const east = await renderNavMap({ ...v, bearing: 90 }, g);
  assert.equal(east.img.get(ME_X, 40), 9);
  // refusal
  const g2 = new GoogleBase(KEY, (async () => new Response("denied", { status: 403 })) as typeof fetch, (s) => logs.push(s));
  const refused = await renderNavMap(v, g2);
  assert.equal(refused.source, "route");
  assert.equal(g2.usable, false);
  for (const l of logs) assert.ok(!l.includes(KEY) && !l.includes("key="), `log line leaks: ${l}`);
  assert.ok(logs.some((l) => l === `[map] google z=17 200`));
  assert.ok(staticMapUrl(O, 17, "k").startsWith("https://maps.googleapis.com/maps/api/staticmap?center=30.267200,-97.743100&zoom=17"));
  status = 0;
});

// ---------------- OSM provider ----------------

test("osm: query, classes, one fetch per area", async () => {
  assert.match(overpassQuery(O, 700, false), /^\[out:json\]\[timeout:25\];way\["highway"\]\(around:700,30\.267200,-97\.743100\);out geom;$/);
  assert.match(overpassQuery(O, 2500, true), /highway"~"\^\(\(motorway\|trunk/);
  const ways = parseOverpass(OVERPASS);
  assert.deepEqual(ways.map((w) => w.kind), ["path", "minor", "minor", "major"]);
  const calls: string[] = [];
  const osm = new OsmBase(undefined, { "User-Agent": "test" }, fakeFetch(calls));
  await osm.prepare(view({ pos: O }));
  await osm.prepare(view({ pos: at(100, 100) }));
  assert.equal(calls.filter((c) => c.includes("interpreter")).length, 1);
  assert.ok(osm.ready());
});

// ---------------- policy ----------------

test("policy: redraw on real change only, at most every 2 s", () => {
  const p = new MapPolicy(2000);
  const k = { pos: O, bearing: 0, idx: 1, mpp: 1, arrived: false };
  assert.equal(p.due(k, 0), 0);
  p.drawn(k, 0);
  assert.equal(p.due({ ...k, pos: at(0, 5) }, 3000), null, "5 m: no redraw");
  assert.equal(p.due({ ...k, bearing: 10 }, 3000), null, "10 degrees: no redraw");
  assert.equal(p.due({ ...k, pos: at(0, 20) }, 500), 1500, "moved, but only 0.5 s after the last");
  assert.equal(p.due({ ...k, pos: at(0, 20) }, 2500), 0);
  assert.equal(p.due({ ...k, bearing: 20 }, 2500), 0);
  assert.equal(p.due({ ...k, idx: 2 }, 2500), 0);
  assert.equal(p.due({ ...k, mpp: 2 }, 2500), 0);
  assert.equal(p.due({ ...k, arrived: true }, 2500), 0);
  p.force();
  assert.equal(p.due(k, 2500), 0);
  // zoom hysteresis: 60 m threshold, moves off a step only 20% past it
  assert.equal(zoomStep(-1, 100, [60, 180]), 1);
  assert.equal(zoomStep(1, 55, [60, 180]), 1);
  assert.equal(zoomStep(1, 47, [60, 180]), 0);
  assert.equal(zoomStep(0, 65, [60, 180]), 0);
  assert.equal(zoomStep(0, 75, [60, 180]), 1);
  assert.equal(zoomStep(0, 500, [60, 180]), 2);
});

// ---------------- navigator ----------------

test("navigator: canned OSRM route → maneuvers, streets, map frames (OSM), throttled", async () => {
  assert.equal(maneuverOf({ type: "turn", modifier: "slight right" }), "slight right");
  assert.equal(maneuverOf({ type: "rotary", modifier: "left" }), "roundabout");
  assert.equal(maneuverOf({ type: "new name", modifier: "weird" }), "straight");
  const calls: string[] = [];
  const navs: (NavState | null)[] = [];
  const maps: (NavMap | null)[] = [];
  const n = new Navigator((s) => navs.push(s), (m) => maps.push(m), { fetcher: fakeFetch(calls), google: new GoogleBase("") });
  n.moved({ lat: O.lat, lon: O.lon, accuracy: 5 });
  const said = await n.start("coffee", "walk");
  assert.match(said, /Navigating to Test Cafe: 600 m/);
  const osrm = calls.find((c) => c.includes("route/v1"))!;
  assert.match(osrm, /steps=true&overview=full&geometries=geojson/);
  const s = navs.at(-1)!;
  assert.equal(s.maneuver, "right");
  assert.equal(s.street, "West 7th Street");
  assert.equal(s.thenManeuver, "arrive");
  assert.equal(s.thenStreet, "Test Cafe");
  assert.equal(s.gps, true);
  assert.ok(Math.abs(s.distance - 300) <= 1);
  assert.ok(Math.abs(s.remaining - 600) <= 2);
  // the first map waits for Overpass
  for (let i = 0; i < 50 && !maps.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(maps.length, 1);
  const m = maps[0]!;
  assert.equal(m.source, "osm");
  assert.equal(m.seq, 1);
  assert.equal(m.bearing, 0);
  assert.equal(m.mpp, 2, "walk, 300 m to the turn → 2 m/px");
  const img = unpack4(Buffer.from(m.px, "base64"), 288, 288);
  assert.equal(img.get(ME_X, ME_Y), 15);
  assert.equal(img.get(ME_X, ME_Y - 60), 15, "route ahead");
  // 4 m: no new map; 60 m further, too soon: deferred, then sent
  n.moved({ ...at(2, 4), accuracy: 5 });
  n.moved({ ...at(1, 60), accuracy: 5 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(maps.length, 1, "throttled");
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(maps.length, 2);
  assert.equal(maps[1]!.seq, 2);
  assert.equal(navs.at(-1)!.distance, 240);
  // past the corner: next step is arrival, heading east, route-up turns
  n.moved({ ...at(80, 300), accuracy: 5 });
  assert.equal(navs.at(-1)!.maneuver, "arrive");
  assert.ok(Math.abs(navs.at(-1)!.distance - 220) <= 1);
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(maps.at(-1)!.bearing, 90);
  // arrival
  n.moved({ ...at(295, 300), accuracy: 5 });
  assert.equal(navs.at(-1)!.arrived, true);
  assert.equal(calls.filter((c) => c.includes("interpreter")).length, 1, "one Overpass query for the whole walk");
  n.stop();
  assert.equal(navs.at(-1), null);
  assert.equal(maps.at(-1), null);
});

// ---------------- glasses screen ----------------

test("glasses: Navigate MAP and ESO screens fit the page rules and show the map halves", async () => {
  const modPath = "../glasses/src/modes/navigate.ts";
  const corePath = "../glasses/src/core.ts";
  const layoutPath = "../glasses/src/ui/layout.ts";
  const { navigate, fmtDistance, street } = await import(modPath);
  const { containers } = await import(corePath);
  const { checkLayout } = await import(layoutPath);
  assert.deepEqual(fmtDistance(1234), { text: "1.2", unit: "KM" });
  assert.deepEqual(fmtDistance(996), { text: "1.0", unit: "KM" });
  assert.deepEqual(fmtDistance(347), { text: "350", unit: "M" });
  assert.deepEqual(fmtDistance(42), { text: "40", unit: "M" });
  assert.deepEqual(fmtDistance(12600), { text: "13", unit: "KM" });
  assert.equal(street("West 7th Street"), "W 7TH ST");
  assert.equal(street("Avenida Peñuelas"), "AVENIDA PENUELAS");

  const nav: NavState = {
    dest: "Test Cafe", profile: "walk", arrow: "→", instruction: "Turn right onto West 7th Street", distance: 42, then: "Arrive", remaining: 1400, etaMin: 12, arrived: false,
    maneuver: "right", street: "West 7th Street", thenManeuver: "arrive", thenStreet: "Test Cafe", gps: true,
  };
  const sendHub = (m: HubMsg) => navigate.onHub(m);
  sendHub({ t: "nav", nav });
  let s = navigate.screen();
  assert.equal(s.noHeader, true);
  assert.deepEqual(s.tiles.map((t: any) => [t.slot, t.x, t.y, t.img.w, t.img.h]), [[0, 0, 0, 288, 144], [1, 0, 144, 288, 144], [2, 288, 0, 288, 144]]);
  checkLayout(containers(s));
  const text: string[] = s.boxes[0].text.split("\n");
  assert.equal(text[0], "ONTO W 7TH ST");
  assert.equal(text[1], "THEN: ARRIVE");
  assert.match(text[2], /^ETA \d+:\d\d(AM|PM)?  12 MIN$/);
  assert.match(text[3], /^TO GO 1\.4 KM  /);
  assert.ok(text.every((l) => l.length <= 21 && /^[\x20-\x7e]*$/.test(l)));
  // readout: filled arrow (<= 50 m), ladder lit for 4 of 10 (40 m)
  const ro = s.tiles[2].img;
  assert.ok(ro.lit() > 0.02 && ro.lit() < 0.15, `readout lit ${ro.lit()}`);
  // a map arrives: the halves are what the hub drew
  const out = await renderNavMap(view(), loadedOsm());
  const { pack4, toB64 } = await import("../src/shared/raster.js");
  sendHub({ t: "nav_map", map: { w: 288, h: 288, px: toB64(pack4(out.img)), seq: 1, mpp: 1, bearing: 0, source: "osm" } });
  s = navigate.screen();
  assert.equal(s.tiles[1].img.get(ME_X, ME_Y - 144), 15, "chevron in the bottom half");
  assert.deepEqual(Array.from(s.tiles[0].img.px), Array.from(out.img.crop(0, 0, 288, 144).px));
  // tap: FULL (four tiles), tap: ESO, tap: back to MAP
  assert.equal(navigate.gesture("tap", 0), true);
  s = navigate.screen();
  assert.deepEqual(s.tiles.map((t: any) => [t.slot, t.x, t.y]), [[0, 0, 0], [1, 288, 0], [2, 0, 144], [3, 288, 144]]);
  checkLayout(containers(s));
  assert.equal(navigate.gesture("tap", 0), true);
  s = navigate.screen();
  assert.deepEqual(s.tiles.map((t: any) => [t.x, t.y]), [[144, 48]]);
  checkLayout(containers(s));
  assert.match(s.header, /^NAV  TEST CAFE  /);
  navigate.gesture("tap", 0);
  assert.equal(navigate.screen().tiles.length, 3);
  sendHub({ t: "nav", nav: null });
  assert.equal(navigate.screen().header, "NAVIGATE");
});

// ---------------- review fixes ----------------

test("robustness: a NaN coordinate draws nothing instead of hanging; bad fixes are ignored", async () => {
  const { Raster } = await import("../src/shared/raster.js");
  const r = new Raster(288, 288);
  r.line(NaN, 0, 10, 10, 15);
  r.polyline([[0, 0], [Infinity, 5], [10, 10]], 15, 3);
  assert.equal(r.lit(), 0);
  const n = new Navigator(() => {}, () => {}, { fetcher: fakeFetch([]), google: new GoogleBase("") });
  n.moved({ lat: NaN, lon: O.lon });
  n.moved({ lat: undefined as any, lon: undefined as any });
  assert.equal(n.pos, null);
  n.moved({ lat: O.lat, lon: O.lon, accuracy: 5 });
  assert.deepEqual(n.pos, { lat: O.lat, lon: O.lon });
});

test("policy: a fix that wobbles within its accuracy doesn't redraw; one past it does", () => {
  const p = new MapPolicy(2000);
  const k = { pos: O, acc: 20, bearing: 0, idx: 1, mpp: 1, arrived: false };
  p.drawn(k, 0);
  assert.equal(p.due({ ...k, pos: at(0, 15) }, 3000), null);
  assert.equal(p.due({ ...k, pos: at(0, 22) }, 3000), 0);
  assert.equal(p.due({ ...k, acc: 200, pos: at(0, 30) }, 3000), 0, "capped at 25 m");
});

test("navigator: an out-and-back route doesn't jump to the way back (turns aren't skipped)", async () => {
  // 150 m north, 20 m east, 150 m back south: the two legs run 20 m apart.
  const U = [at(0, 0), at(0, 75), at(0, 150), at(20, 150), at(20, 75), at(20, 0)];
  const osrm = {
    routes: [{
      distance: 320, duration: 240,
      geometry: { type: "LineString", coordinates: U.map((p) => [p.lon, p.lat]) },
      legs: [{ steps: [
        { distance: 150, name: "Up St", maneuver: { type: "depart", location: [U[0].lon, U[0].lat] } },
        { distance: 20, name: "Across St", maneuver: { type: "turn", modifier: "right", location: [U[2].lon, U[2].lat] } },
        { distance: 150, name: "Down St", maneuver: { type: "turn", modifier: "right", location: [U[3].lon, U[3].lat] } },
        { distance: 0, name: "", maneuver: { type: "arrive", location: [U[5].lon, U[5].lat] } },
      ] }],
    }],
  };
  const f = (async (input: any) => {
    const url = String(input);
    if (url.includes("nominatim")) return json([{ lat: String(U[5].lat), lon: String(U[5].lon), name: "Back", display_name: "Back" }]);
    if (url.includes("route/v1")) return json(osrm);
    return new Response("offline", { status: 503 });
  }) as typeof fetch;
  const navs: (NavState | null)[] = [];
  const n = new Navigator((s) => navs.push(s), undefined, { fetcher: f, google: new GoogleBase("") });
  n.moved({ ...at(0, 0), accuracy: 5 });
  await n.start("back", "walk");
  n.moved({ ...at(0, 40), accuracy: 5 });
  // GPS drifts 12 m east, nearer the way back (8 m) than the way up (12 m)
  n.moved({ ...at(12, 100), accuracy: 15 });
  const s = navs.at(-1)!;
  assert.equal(s.street, "Across St", `still heading for the first turn, got ${s.street}`);
  assert.ok(Math.abs(s.distance - 50) <= 2, `distance ${s.distance}`);
  n.stop();
});

test("navigator: a page that connects mid-route gets the directions and (glasses) the last map", async () => {
  const maps: (NavMap | null)[] = [];
  const n = new Navigator(() => {}, (m) => maps.push(m), { fetcher: fakeFetch([]), google: new GoogleBase("") });
  const replayed: string[] = [];
  n.replay((m) => replayed.push(m.t), true);
  assert.equal(replayed.join(), "", "nothing before a route");
  n.moved({ lat: O.lat, lon: O.lon, accuracy: 5 });
  await n.start("coffee", "walk");
  for (let i = 0; i < 50 && !maps.length; i++) await new Promise((r) => setTimeout(r, 10));
  n.replay((m) => replayed.push(m.t), true);
  n.replay((m) => replayed.push(m.t), false);
  assert.equal(replayed.join(), "nav,nav_map,nav");
  n.stop();
  replayed.length = 0;
  n.replay((m) => replayed.push(m.t), true);
  assert.equal(replayed.join(), "", "nothing after stop");
});

test("osm: the area is refetched before the top of a 2 m/px view runs out of roads", async () => {
  const calls: string[] = [];
  const osm = new OsmBase(undefined, {}, fakeFetch(calls));
  await osm.prepare(view({ pos: O, mpp: 2 }));
  await osm.prepare(view({ pos: at(0, 150), mpp: 2 }));
  assert.equal(calls.length, 1, "150 m on: the view (526 m) still fits in 700 m");
  (osm as any).lastTry = 0;
  await osm.prepare(view({ pos: at(0, 200), mpp: 2 }));
  assert.equal(calls.length, 2, "200 m on: it wouldn't");
  (osm as any).lastTry = 0;
  await osm.prepare(view({ pos: at(0, 300), mpp: 0.5 }));
  assert.equal(calls.length, 2, "zoomed in, 100 m from the new centre: reuse");
});

test("glasses: a rising distance needs two nav messages, not two redraws", async () => {
  const modPath = "../glasses/src/modes/navigate.ts";
  const { navigate } = await import(modPath);
  const nav: NavState = {
    dest: "Jitter Cafe", profile: "walk", arrow: "→", instruction: "Turn left", distance: 300, then: undefined, remaining: 900, etaMin: 10, arrived: false,
    maneuver: "left", street: "Elm Street", gps: true,
  };
  /** A short fingerprint of the readout's pixels. */
  const digitsOf = () => (navigate.screen() as any).tiles[2].img.px.reduce((h: number, v: number, i: number) => (h * 31 + v * (i + 1)) >>> 0, 7);
  navigate.onHub!({ t: "nav", nav });
  await new Promise((r) => setTimeout(r, 1100)); // past the previous test's readout
  const at300 = digitsOf();
  await new Promise((r) => setTimeout(r, 1100)); // the readout redraws at most once a second
  navigate.onHub!({ t: "nav", nav: { ...nav, distance: 340 } });
  navigate.screen();
  navigate.screen();
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(digitsOf(), at300, "one 340 reading, many redraws: still 300");
  navigate.onHub!({ t: "nav", nav: { ...nav, distance: 340 } });
  await new Promise((r) => setTimeout(r, 1100));
  assert.notEqual(digitsOf(), at300, "two readings agree: 340");
  navigate.onHub!({ t: "nav", nav: null });
});

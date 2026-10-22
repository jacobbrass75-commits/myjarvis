// Navigate with Google Maps Platform, offline: Places (New) and Routes (computeRoutes) parsing on canned
// answers, the key only ever in a header (never a URL or the log), fallbacks to Nominatim / OSRM, transit
// directions end to end, swipe zoom with its 20 s hold, the hub drawing the map the glasses' view needs,
// and the glasses' Navigate view cycle (tap), zoom (swipe), END ROUTE? card (double tap) and tile pushes.
//   node --import tsx --test scripts/nav-google-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubMsg, NavMap, NavState } from "../src/shared/protocol.js";
import { unpack4 } from "../src/shared/raster.js";
import { unlocal, type Pos } from "../src/hub/map/geo.js";
import { GoogleBase } from "../src/hub/map/google.js";
import { OsmBase } from "../src/hub/map/osm.js";
import { describePlaces, parsePlaceQuery, parsePlaces, Places, placeType } from "../src/hub/map/places.js";
import { decodePolyline, GoogleRoutes, parseGoogleRoute, ROUTE_FIELDS, routesBody, streetOf } from "../src/hub/map/routes.js";
import { MANUAL_ZOOM_MS, Navigator, ZoomState, zoomFrom } from "../src/hub/nav.js";

// ---------------- fixtures ----------------

const KEY = "AIzaTESTKEY-0123456789";
const O: Pos = { lat: 30.2672, lon: -97.7431 };
const at = (x: number, y: number) => unlocal(O, x, y);

/** Google's polyline encoding (the inverse of decodePolyline), for building canned routes. */
function encodePolyline(pts: Pos[]): string {
  let out = "", plat = 0, plon = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const p of pts) {
    const lat = Math.round(p.lat * 1e5), lon = Math.round(p.lon * 1e5);
    out += enc(lat - plat) + enc(lon - plon);
    plat = lat;
    plon = lon;
  }
  return out;
}
const ll = (p: Pos) => ({ latLng: { latitude: p.lat, longitude: p.lon } });

const PLACES_TEXT = {
  places: [
    { displayName: { text: "Far Ramen" }, shortFormattedAddress: "9 Far St", location: { latitude: at(0, 2000).lat, longitude: at(0, 2000).lon }, rating: 4.9, userRatingCount: 3200, currentOpeningHours: { openNow: true }, primaryTypeDisplayName: { text: "Ramen restaurant" } },
    { displayName: { text: "Near Ramen" }, shortFormattedAddress: "1 Near St", location: { latitude: at(100, 1100).lat, longitude: at(100, 1100).lon }, rating: 4.2, userRatingCount: 150, currentOpeningHours: { openNow: true }, primaryTypeDisplayName: { text: "Ramen restaurant" } },
    { displayName: { text: "Closed Ramen" }, location: { latitude: at(0, 300).lat, longitude: at(0, 300).lon }, rating: 4.8, userRatingCount: 12, currentOpeningHours: { openNow: false } },
    { displayName: { text: "" }, location: { latitude: 1, longitude: 2 } },
    { displayName: { text: "No Location" } },
  ],
};
const PLACES_NEARBY = {
  places: [
    { displayName: { text: "Cafe Two" }, location: { latitude: at(0, 400).lat, longitude: at(0, 400).lon }, rating: 4.5, userRatingCount: 80 },
    { displayName: { text: "Cafe One" }, location: { latitude: at(0, 150).lat, longitude: at(0, 150).lon }, rating: 3.9, userRatingCount: 900 },
  ],
};

/** 300 m north on Congress Ave, right onto W 7th St for 300 m (DRIVE, with traffic). */
const DRIVE_LINE = [at(0, 0), at(0, 150), at(0, 300), at(150, 300), at(300, 300)];
const ROUTES_DRIVE = {
  routes: [{
    distanceMeters: 600, duration: "420s", staticDuration: "240s",
    polyline: { encodedPolyline: encodePolyline(DRIVE_LINE) },
    legs: [{ steps: [
      { distanceMeters: 300, staticDuration: "60s", startLocation: ll(at(0, 0)), endLocation: ll(at(0, 300)), travelMode: "DRIVE", navigationInstruction: { maneuver: "DEPART", instructions: "Head north on Congress Ave toward E 6th St" } },
      { distanceMeters: 300, staticDuration: "60s", startLocation: ll(at(0, 300)), endLocation: ll(at(300, 300)), travelMode: "DRIVE", navigationInstruction: { maneuver: "TURN_RIGHT", instructions: "Turn right onto W 7th St\nDestination will be on the left" } },
    ] }],
  }],
};

/** Walk 100 m north to a stop, bus 1 km north, walk 100 m east. */
const STOP_A = at(0, 100), STOP_B = at(0, 1100), DEST = at(100, 1100);
const TRANSIT_LINE = [at(0, 0), STOP_A, at(0, 600), STOP_B, DEST];
const ROUTES_TRANSIT = {
  routes: [{
    distanceMeters: 1200, duration: "1260s",
    polyline: { encodedPolyline: encodePolyline(TRANSIT_LINE) },
    legs: [{ steps: [
      { distanceMeters: 100, staticDuration: "80s", startLocation: ll(at(0, 0)), endLocation: ll(STOP_A), travelMode: "WALK", navigationInstruction: { maneuver: "DEPART", instructions: "Head north on Main St" } },
      {
        distanceMeters: 1000, staticDuration: "300s", startLocation: ll(STOP_A), endLocation: ll(STOP_B), travelMode: "TRANSIT", navigationInstruction: { instructions: "Bus towards Ocean Beach" },
        transitDetails: {
          stopDetails: { departureStop: { name: "Main St & 1st" }, arrivalStop: { name: "Main St & 11th" }, departureTime: "2026-10-22T02:05:00Z", arrivalTime: "2026-10-22T02:10:00Z" },
          localizedValues: { departureTime: { time: { text: "9:05 PM" } }, arrivalTime: { time: { text: "9:10 PM" } } },
          headsign: "Ocean Beach", stopCount: 6,
          transitLine: { name: "Geary Rapid", nameShort: "38R", vehicle: { type: "BUS", name: { text: "Bus" } } },
        },
      },
      { distanceMeters: 100, staticDuration: "90s", startLocation: ll(STOP_B), endLocation: ll(DEST), travelMode: "WALK", navigationInstruction: { maneuver: "TURN_RIGHT", instructions: "Turn right onto Elm St" } },
    ] }],
  }],
};

const OSRM_WALK = {
  routes: [{
    distance: 600, duration: 450,
    geometry: { type: "LineString", coordinates: DRIVE_LINE.map((p) => [p.lon, p.lat]) },
    legs: [{ steps: [
      { distance: 300, name: "Congress Avenue", maneuver: { type: "depart", bearing_after: 0, location: [DRIVE_LINE[0].lon, DRIVE_LINE[0].lat] } },
      { distance: 300, name: "West 7th Street", maneuver: { type: "turn", modifier: "right", location: [DRIVE_LINE[2].lon, DRIVE_LINE[2].lat] } },
      { distance: 0, name: "", maneuver: { type: "arrive", location: [DRIVE_LINE[4].lon, DRIVE_LINE[4].lat] } },
    ] }],
  }],
};
const NOMINATIM = [{ lat: String(DRIVE_LINE[4].lat), lon: String(DRIVE_LINE[4].lon), name: "Test Cafe", display_name: "Test Cafe, Austin" }];

const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "Content-Type": "application/json" } });

interface Call { url: string; headers: Record<string, string>; body: any }

/** A fetch that answers Google, Nominatim and OSRM from the fixtures and records every request. */
function fake(calls: Call[], o: { places?: (c: Call) => Response; routes?: (c: Call) => Response } = {}): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const c: Call = { url: String(input), headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: init.body ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : undefined };
    calls.push(c);
    if (c.url.startsWith("https://places.googleapis.com/")) return o.places?.(c) ?? json(c.url.endsWith(":searchNearby") ? PLACES_NEARBY : PLACES_TEXT);
    if (c.url.startsWith("https://routes.googleapis.com/")) return o.routes?.(c) ?? json(c.body?.travelMode === "TRANSIT" ? ROUTES_TRANSIT : ROUTES_DRIVE);
    if (c.url.includes("nominatim")) return json(NOMINATIM);
    if (c.url.includes("route/v1")) return json(OSRM_WALK);
    return new Response("offline", { status: 503 });
  }) as typeof fetch;
}

/** Nothing about the key anywhere but the X-Goog-Api-Key header. */
function keySafe(calls: Call[], logs: string[]) {
  for (const c of calls) {
    assert.ok(!c.url.includes(KEY) && !c.url.toLowerCase().includes("key="), `key in URL ${c.url}`);
    if (c.url.includes("googleapis.com")) assert.equal(c.headers["x-goog-api-key"], KEY);
    else assert.equal(c.headers["x-goog-api-key"], undefined, "key sent to a non-Google host");
  }
  assert.ok(logs.every((l) => !l.includes(KEY)), "key in the log");
}

const roadGrid = () => {
  const el: any[] = [];
  let id = 1;
  for (let x = -600; x <= 600; x += 100) el.push({ type: "way", id: id++, tags: { highway: x % 300 ? "residential" : "primary" }, geometry: [at(x, -600), at(x, 1600)].map((p) => ({ lat: p.lat, lon: p.lon })) });
  for (let y = -600; y <= 1600; y += 100) el.push({ type: "way", id: id++, tags: { highway: y % 300 ? "residential" : "secondary" }, geometry: [at(-600, y), at(600, y)].map((p) => ({ lat: p.lat, lon: p.lon })) });
  return { elements: el };
};
const loadedOsm = () => {
  const osm = new OsmBase(undefined, {}, (async () => new Response("offline", { status: 503 })) as typeof fetch);
  osm.load(O, 4000, roadGrid());
  return osm;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 1500) {
  for (let i = 0; i < ms / 10 && !f(); i++) await sleep(10);
  assert.ok(f(), "timed out");
}

// ---------------- places ----------------

test("places: query words → search, open now, best vs nearest", () => {
  assert.deepEqual(parsePlaceQuery("the best ramen open now"), { query: "ramen", openNow: true, sort: "best" });
  assert.deepEqual(parsePlaceQuery("nearest pharmacy"), { query: "pharmacy", openNow: false, sort: "distance" });
  assert.deepEqual(parsePlaceQuery("coffee near me"), { query: "coffee", openNow: false, sort: "distance" });
  assert.deepEqual(parsePlaceQuery("a taco place that's open"), { query: "taco place", openNow: true, sort: "distance" });
  assert.equal(placeType("coffee shop"), "cafe");
  assert.equal(placeType("gas station"), "gas_station");
  assert.equal(placeType("ramen"), undefined);
});

test("places: Text Search parsing, field mask, key in the header only, open-now filter, best-rated order", async () => {
  const calls: Call[] = [], logs: string[] = [];
  const p = new Places(() => KEY, fake(calls), (s) => logs.push(s));
  const parsed = parsePlaces(PLACES_TEXT, O);
  assert.equal(parsed.length, 3, "nameless and location-less places dropped");
  assert.ok(Math.abs(parsed[1].distance - Math.hypot(100, 1100)) <= 2, `distance ${parsed[1].distance}`);
  assert.deepEqual({ ...parsed[1], distance: 0 }, {
    name: "Near Ramen", address: "1 Near St", lat: parsed[1].lat, lon: parsed[1].lon, rating: 4.2, ratings: 150, openNow: true, kind: "Ramen restaurant", distance: 0, source: "google",
  });
  // best ramen open now: Text Search, RELEVANCE, openNow; Closed Ramen filtered out; 4.9 x 3200 beats 4.2 x 150
  const r = await p.search({ query: "ramen", near: O, openNow: true, sort: "best" });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, "https://places.googleapis.com/v1/places:searchText");
  assert.equal(c.body.textQuery, "ramen");
  assert.equal(c.body.openNow, true);
  assert.equal(c.body.rankPreference, "RELEVANCE");
  assert.deepEqual(c.body.locationBias.circle.center, { latitude: O.lat, longitude: O.lon });
  assert.match(c.headers["x-goog-fieldmask"], /places\.displayName/);
  assert.match(c.headers["x-goog-fieldmask"], /places\.currentOpeningHours\.openNow/);
  assert.ok(!c.headers["x-goog-fieldmask"].includes("*"), "a field mask, not *");
  assert.deepEqual(r.places.map((x) => x.name), ["Far Ramen", "Near Ramen"]);
  assert.equal(r.source, "google");
  assert.match(describePlaces(r), /^1\. Far Ramen: 4\.9 stars \(3200\), open now, 2\.0 km, Ramen restaurant, 9 Far St/);
  // nearest: DISTANCE, nearest first
  const near = await p.search({ query: "ramen", near: O });
  assert.equal(calls[1].body.rankPreference, "DISTANCE");
  assert.deepEqual(near.places.map((x) => x.name), ["Closed Ramen", "Near Ramen", "Far Ramen"]);
  // a kind of place: Nearby Search with its type
  const cafes = await p.search({ query: "coffee", near: O });
  assert.equal(calls[2].url, "https://places.googleapis.com/v1/places:searchNearby");
  assert.deepEqual(calls[2].body.includedTypes, ["cafe"]);
  assert.equal(calls[2].body.rankPreference, "DISTANCE");
  assert.equal(calls[2].body.locationRestriction.circle.radius, 5000);
  assert.deepEqual(cafes.places.map((x) => x.name), ["Cafe One", "Cafe Two"]);
  keySafe(calls, logs);
});

test("places: no key or a refused key → Nominatim, with a note; the log never has the key", async () => {
  const calls: Call[] = [], logs: string[] = [];
  const none = new Places(() => "", fake(calls), (s) => logs.push(s));
  const r = await none.search({ query: "coffee", near: O, openNow: true });
  assert.equal(r.source, "osm");
  assert.equal(r.places[0].name, "Test Cafe");
  assert.match(r.note!, /can't tell what's open/);
  assert.ok(calls.every((c) => !c.url.includes("googleapis")), "no Google call without a key");
  const refused = new Places(() => KEY, fake(calls, { places: () => json({ error: { code: 403, status: "PERMISSION_DENIED", message: `Places API (New) has not been used in project 123 before or it is disabled. key=${KEY}` } }, 403) }), (s) => logs.push(s));
  const r2 = await refused.search({ query: "ramen", near: O });
  assert.equal(r2.source, "osm");
  assert.match(r2.note!, /Google Places failed/);
  assert.ok(logs.some((l) => /\[places\] google text 403 PERMISSION_DENIED \(API not enabled/.test(l)), logs.join("\n"));
  keySafe(calls, logs);
});

// ---------------- routes ----------------

test("routes: polyline decoding, drive parsing (maneuvers, streets, traffic), request bodies", () => {
  // Google's documented example
  assert.deepEqual(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@"), [{ lat: 38.5, lon: -120.2 }, { lat: 40.7, lon: -120.95 }, { lat: 43.252, lon: -126.453 }]);
  assert.deepEqual(decodePolyline("_p~iF~ps|U_ul"), [{ lat: 38.5, lon: -120.2 }], "a truncated string stops cleanly");
  assert.equal(streetOf("Head north on Congress Ave toward E 6th St"), "Congress Ave");
  assert.equal(streetOf("Turn right onto W 7th St\nDestination will be on the left"), "W 7th St");
  assert.equal(streetOf("Keep left"), "");
  const p = parseGoogleRoute(ROUTES_DRIVE)!;
  assert.equal(p.source, "google");
  assert.equal(p.duration, 420);
  assert.equal(p.staticDuration, 240);
  assert.equal(p.line.length, 5);
  assert.deepEqual(p.steps.map((s) => [s.maneuver, s.name]), [["depart", "Congress Ave"], ["right", "W 7th St"], ["arrive", ""]]);
  assert.equal(p.steps[1].instruction, "Turn right onto W 7th St. Destination will be on the left");
  assert.equal(p.legs, undefined, "no legs list without transit");
  assert.equal(parseGoogleRoute({ routes: [] }), null);
  assert.equal(parseGoogleRoute({}), null);
  const drive = routesBody("drive", O, DEST);
  assert.equal(drive.travelMode, "DRIVE");
  assert.equal(drive.routingPreference, "TRAFFIC_AWARE");
  const transit = routesBody("transit", O, DEST, { prefer: "bus" });
  assert.equal(transit.travelMode, "TRANSIT");
  assert.equal(transit.routingPreference, undefined, "Google refuses a routing preference on transit");
  assert.deepEqual(transit.transitPreferences, { allowedTravelModes: ["BUS"] });
  assert.deepEqual((routesBody("transit", O, DEST, { prefer: "train" }).transitPreferences as any).allowedTravelModes, ["TRAIN", "SUBWAY", "LIGHT_RAIL", "RAIL"]);
  assert.ok(ROUTE_FIELDS.includes("routes.legs.steps.transitDetails") && !ROUTE_FIELDS.includes("*"));
});

test("routes: transit parsing → walk / ride / walk legs with line, stop, departure", () => {
  const p = parseGoogleRoute(ROUTES_TRANSIT)!;
  assert.deepEqual(p.legs, ["WALK 1 MIN", "BUS 38R 9:05 PM Main St & 1st", "WALK 2 MIN"]);
  assert.deepEqual(p.steps.map((s) => s.maneuver), ["depart", "straight", "right", "arrive"]);
  const ride = p.steps[1];
  assert.deepEqual(ride.transit, { line: "38R", vehicle: "BUS", from: "Main St & 1st", to: "Main St & 11th", dep: "9:05 PM", arr: "9:10 PM", headsign: "Ocean Beach", stops: 6 });
  assert.equal(ride.name, "Main St & 1st");
  assert.equal(ride.instruction, "Take bus 38R toward Ocean Beach from Main St & 1st at 9:05 PM");
  // no localized text: the ISO time in local time; unknown vehicle → TRANSIT
  const bare = structuredClone(ROUTES_TRANSIT) as any;
  delete bare.routes[0].legs[0].steps[1].transitDetails.localizedValues;
  bare.routes[0].legs[0].steps[1].transitDetails.transitLine = { name: "Blue", vehicle: { type: "OTHER" } };
  const q = parseGoogleRoute(bare)!;
  assert.equal(q.steps[1].transit!.vehicle, "TRANSIT");
  assert.equal(q.steps[1].transit!.line, "Blue");
  assert.match(q.steps[1].transit!.dep!, /^\d{1,2}:05 (AM|PM)$/);
});

test("routes: Google refusal is a reason string, logged without the key", async () => {
  const calls: Call[] = [], logs: string[] = [];
  const g = new GoogleRoutes(() => KEY, fake(calls, { routes: () => json({ error: { status: "PERMISSION_DENIED", message: "Routes API has not been used in project 1 before or it is disabled" } }, 403) }), (s) => logs.push(s));
  const r = await g.route("drive", O, DEST);
  assert.equal(typeof r, "string");
  assert.match(r as string, /403 PERMISSION_DENIED/);
  assert.equal(calls[0].url, "https://routes.googleapis.com/directions/v2:computeRoutes");
  assert.equal(calls[0].headers["x-goog-fieldmask"], ROUTE_FIELDS);
  keySafe(calls, logs);
});

// ---------------- navigator ----------------

test("navigator: transit end to end: walk to the stop, board, ride, get off, walk", async () => {
  const calls: Call[] = [], logs: string[] = [];
  const navs: (NavState | null)[] = [];
  const n = new Navigator((s) => navs.push(s), undefined, { fetcher: fake(calls), google: new GoogleBase(""), key: () => KEY, log: (s) => logs.push(s) });
  n.moved({ lat: O.lat, lon: O.lon, accuracy: 5 });
  // find first, then go to "the second one" by bus
  const list = await n.find("best ramen open now");
  assert.match(list, /^1\. Far Ramen/);
  const said = await n.start("the second one", "transit", { prefer: "bus" });
  assert.match(said, /^Navigating to Near Ramen \(4\.2 stars, open now\): 1\.2 km, about 21 min by transit: walk 1 min, then bus 38R at 9:05 PM from Main St & 1st to Main St & 11th, then walk 2 min\.$/);
  const rc = calls.find((c) => c.url.includes("computeRoutes"))!;
  assert.equal(rc.body.travelMode, "TRANSIT");
  assert.deepEqual(rc.body.transitPreferences, { allowedTravelModes: ["BUS"] });
  assert.equal(calls.filter((c) => c.url.includes("places.googleapis")).length, 1, "the second one came from the last search");
  let s = navs.at(-1)!;
  assert.equal(s.profile, "transit");
  assert.deepEqual(s.transit, { phase: "board", line: "38R", vehicle: "BUS", stop: "Main St & 1st", time: "9:05 PM", headsign: "Ocean Beach", stops: 6 });
  assert.equal(s.street, "Main St & 1st");
  assert.ok(Math.abs(s.distance - 100) <= 2);
  assert.equal(s.etaMin, 21, "timetable ETA");
  assert.deepEqual(s.legs, ["WALK 1 MIN", "BUS 38R 9:05 PM Main St & 1st", "WALK 2 MIN"]);
  // at the stop: riding, distance to where you get off
  n.moved({ ...at(0, 92), accuracy: 5 });
  s = navs.at(-1)!;
  assert.equal(s.transit?.phase, "ride");
  assert.equal(s.transit?.stop, "Main St & 11th");
  assert.equal(s.transit?.time, "9:10 PM");
  assert.match(s.instruction, /^Ride 38R to Main St & 11th/);
  assert.ok(Math.abs(s.distance - 1008) <= 3, `distance ${s.distance}`);
  n.moved({ ...at(0, 700), accuracy: 5 });
  assert.ok(Math.abs(navs.at(-1)!.distance - 400) <= 3);
  // off the bus: walking the last turn, no ride left
  n.moved({ ...at(0, 1095), accuracy: 5 });
  s = navs.at(-1)!;
  assert.equal(s.transit, undefined);
  assert.equal(s.maneuver, "arrive");
  n.moved({ ...at(95, 1100), accuracy: 5 });
  assert.equal(navs.at(-1)!.arrived, true);
  keySafe(calls, logs);
  n.stop();
});

test("navigator: no key → transit says so and walks (OSRM); drive uses Google traffic, else OSRM", async () => {
  const calls: Call[] = [];
  const quiet = () => {};
  const a = new Navigator(() => {}, undefined, { fetcher: fake(calls), google: new GoogleBase(""), key: () => "", log: quiet });
  a.moved({ lat: O.lat, lon: O.lon, accuracy: 5 });
  const said = await a.start("coffee", "transit");
  assert.match(said, /^Transit directions need a Google Maps key, so walking: Navigating to Test Cafe: 600 m, about 8 min walking\.$/);
  assert.ok(calls.some((c) => c.url.includes("routed-foot")));
  assert.ok(!calls.some((c) => c.url.includes("googleapis")));
  a.stop();
  // drive with a key: Google route, traffic in the reply and the state
  calls.length = 0;
  const navs: (NavState | null)[] = [];
  const b = new Navigator((s) => navs.push(s), undefined, { fetcher: fake(calls), google: new GoogleBase(""), key: () => KEY, log: quiet });
  b.moved({ lat: O.lat, lon: O.lon, accuracy: 5 });
  assert.match(await b.start("coffee", "drive"), /about 7 min driving \(3 min of it traffic\)\.$/);
  assert.equal(navs.at(-1)!.trafficMin, 3);
  assert.equal(navs.at(-1)!.street, "W 7th St");
  assert.ok(!calls.some((c) => c.url.includes("route/v1")), "no OSRM");
  b.stop();
  // Google Routes down: OSRM driving
  calls.length = 0;
  const c = new Navigator(() => {}, undefined, { fetcher: fake(calls, { routes: () => json({}, 500) }), google: new GoogleBase(""), key: () => KEY, log: quiet });
  c.moved({ lat: O.lat, lon: O.lon, accuracy: 5 });
  assert.match(await c.start("coffee", "drive"), /about 8 min driving\.$/);
  assert.ok(calls.some((x) => x.url.includes("router.project-osrm.org/route/v1/driving")));
  c.stop();
});

test("zoom: a swipe steps one level, holds 20 s after the last swipe, then auto again", () => {
  assert.equal(zoomFrom(2, "in"), 1);
  assert.equal(zoomFrom(2, "out"), 4);
  assert.equal(zoomFrom(0.5, "in"), 0.5, "closest clamps");
  assert.equal(zoomFrom(16, "out"), 16, "farthest clamps");
  assert.equal(zoomFrom(1.89, "out"), 4, "Google's snapped scale counts as its nearest level");
  const z = new ZoomState();
  assert.equal(z.mpp(2, 0), 2);
  assert.equal(z.swipe("in", 2, 0), 1);
  assert.equal(z.swipe("in", 2, 5000), 0.5, "from the manual level, not auto");
  assert.equal(z.mpp(2, 5000 + MANUAL_ZOOM_MS - 1), 0.5, "held 20 s after the last swipe");
  assert.equal(z.isManual(5000 + MANUAL_ZOOM_MS - 1), true);
  assert.equal(z.mpp(2, 5000 + MANUAL_ZOOM_MS), 2, "then auto");
  assert.equal(z.isManual(5000 + MANUAL_ZOOM_MS), false);
});

test("navigator: swipe zoom and view changes redraw at once; ESO/off draws nothing; full map is 576 wide", async () => {
  const maps: (NavMap | null)[] = [];
  const n = new Navigator(() => {}, (m) => maps.push(m), { fetcher: fake([]), google: new GoogleBase(""), osm: loadedOsm(), key: () => "", log: () => {} });
  n.moved({ lat: O.lat, lon: O.lon, accuracy: 5 });
  await n.start("coffee", "walk");
  await until(() => maps.length === 1);
  assert.equal(maps[0]!.w, 288);
  assert.equal(maps[0]!.mpp, 2);
  assert.deepEqual(maps[0]!.zoom, { step: 2, of: 6, manual: false });
  // swipe in twice: each drawn straight away (no 2 s gap)
  assert.equal(n.zoomBy("in"), 1);
  await until(() => maps.length === 2);
  assert.equal(maps[1]!.mpp, 1);
  assert.deepEqual(maps[1]!.zoom, { step: 1, of: 6, manual: true });
  n.zoomBy("in");
  await until(() => maps.at(-1)!.mpp === 0.5);
  // the full map
  n.setView("full");
  await until(() => maps.at(-1)!.w === 576);
  const m = maps.at(-1)!;
  const img = unpack4(Buffer.from(m.px, "base64"), 576, 288);
  assert.equal(img.get(288, 220), 15, "you at (288, 220)");
  assert.equal(img.get(288, 160), 15, "route ahead");
  assert.equal(m.mpp, 0.5, "the zoom holds across views");
  // ESO: nothing drawn, even moving
  n.setView("eso");
  const count = maps.length;
  n.moved({ ...at(0, 60), accuracy: 5 });
  await sleep(3200);
  assert.equal(maps.length, count, "no maps while ESO");
  n.setView("map");
  await until(() => maps.length === count + 1);
  assert.equal(maps.at(-1)!.w, 288);
  n.stop();
});

// ---------------- glasses ----------------

test("glasses: tap cycles MAP → FULL → ESO; swipes zoom; double tap: back to MAP, then END ROUTE?", async () => {
  // through variables, so the hub's typecheck doesn't pull in the glasses sources (they build with vite)
  const modPath = "../glasses/src/modes/navigate.ts", corePath = "../glasses/src/core.ts", layoutPath = "../glasses/src/ui/layout.ts";
  const { navigate, navLayout, lines } = await import(modPath);
  const { core, containers } = await import(corePath);
  const { checkLayout } = await import(layoutPath);
  const { pack4, toB64 } = await import("../src/shared/raster.js");
  const { renderNavMap } = await import("../src/hub/map/render.js");
  const sent: any[] = [];
  core.ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) } as any;
  const hub = (m: HubMsg) => navigate.onHub!(m);
  const nav: NavState = {
    dest: "Near Ramen", profile: "walk", arrow: "→", instruction: "Turn right", distance: 240, remaining: 600, etaMin: 8, arrived: false,
    maneuver: "right", street: "West 7th Street", thenManeuver: "arrive", thenStreet: "Near Ramen", gps: true,
  };
  hub({ t: "nav", nav });
  assert.deepEqual(sent.splice(0), [{ t: "nav_view", view: "map" }], "a new route tells the hub the view");
  assert.equal(navLayout(), "map");
  // FULL: four quarter tiles, the hub's 576 map, slim readout in the top-left one only
  navigate.gesture("tap", 0);
  assert.deepEqual(sent.splice(0), [{ t: "nav_view", view: "full" }]);
  const view = { pos: at(0, 60), bearing: 0, mpp: 1, route: DRIVE_LINE, snapIdx: 0, onRoute: true, dest: DRIVE_LINE[4], profile: "walk", w: 576 };
  const full = (await renderNavMap(view, loadedOsm())).img;
  hub({ t: "nav_map", map: { w: 576, h: 288, px: toB64(pack4(full)), seq: 7, mpp: 1, bearing: 0, source: "osm", zoom: { step: 1, of: 6, manual: false } } });
  let s = navigate.screen();
  checkLayout(containers(s));
  assert.equal(s.boxes, undefined);
  assert.deepEqual(s.tiles!.map((t: any) => [t.slot, t.x, t.y, t.img.w, t.img.h]), [[0, 0, 0, 288, 144], [1, 288, 0, 288, 144], [2, 0, 144, 288, 144], [3, 288, 144, 288, 144]]);
  const tiles = (sc: any) => Object.fromEntries(sc.tiles.map((t: any) => [t.slot, Array.from(t.img.px) as number[]]));
  const t1 = tiles(s);
  assert.deepEqual(t1[1], Array.from(full.crop(288, 0, 288, 144).px));
  assert.deepEqual(t1[3], Array.from(full.crop(288, 144, 288, 144).px));
  assert.notDeepEqual(t1[0], Array.from(full.crop(0, 0, 288, 144).px), "slim readout drawn in");
  assert.equal(s.tiles![0].img.get(1, 30), 0, "readout plate is black over the map");
  // the distance counts down: only the corner tile changes (only it is pushed again)
  await sleep(1050);
  hub({ t: "nav", nav: { ...nav, distance: 120 } });
  const t2 = tiles(navigate.screen());
  assert.notDeepEqual(t2[0], t1[0]);
  for (const k of [1, 2, 3]) assert.deepEqual(t2[k], t1[k], `tile ${k} unchanged`);
  // swipe up = zoom in: asks the hub; the next map shows the level for a moment (corner tile only)
  assert.equal(navigate.gesture("up", 0), true);
  assert.equal(navigate.gesture("down", 0), true);
  assert.deepEqual(sent.splice(0), [{ t: "nav_zoom", dir: "in" }, { t: "nav_zoom", dir: "out" }]);
  hub({ t: "nav_map", map: { w: 576, h: 288, px: toB64(pack4(full)), seq: 8, mpp: 1, bearing: 0, source: "osm", zoom: { step: 1, of: 6, manual: true } } });
  const t3 = tiles(navigate.screen());
  assert.notDeepEqual(t3[0], t2[0], "zoom plate in the corner");
  for (const k of [1, 2, 3]) assert.deepEqual(t3[k], t1[k]);
  // a voice reply (toast) while FULL: the MAP view (it has the text box) until it goes
  core.toast = "Three stops to go";
  s = navigate.screen();
  assert.equal(s.boxes?.[0].slot, 0);
  assert.equal(s.tiles!.length, 3);
  assert.deepEqual(Array.from(s.tiles![1].img.px), Array.from(full.crop(144, 144, 288, 144).px), "the middle of the full map stands in");
  core.toast = "";
  // double tap off FULL: back to MAP (no question)
  navigate.gesture("double", 0);
  assert.equal(navLayout(), "map");
  assert.deepEqual(sent.splice(0), [{ t: "nav_view", view: "map" }]);
  // tap tap: ESO, swipes do nothing there; tap: MAP
  navigate.gesture("tap", 0);
  navigate.gesture("tap", 0);
  assert.equal(navLayout(), "eso");
  assert.equal(navigate.gesture("up", 0), true);
  assert.deepEqual(sent.splice(0), [{ t: "nav_view", view: "full" }, { t: "nav_view", view: "eso" }]);
  // a map drawn for another view (the hub restarted) asks for ours once
  hub({ t: "nav_map", map: { w: 576, h: 288, px: toB64(pack4(full)), seq: 9, mpp: 1, bearing: 0, source: "osm" } });
  hub({ t: "nav_map", map: { w: 576, h: 288, px: toB64(pack4(full)), seq: 9, mpp: 1, bearing: 0, source: "osm" } });
  assert.deepEqual(sent.splice(0), [{ t: "nav_view", view: "eso" }]);
  navigate.gesture("tap", 0);
  assert.equal(navLayout(), "map");
  sent.length = 0;
  // double on MAP: END ROUTE?; double: no; double, tap: yes → nav_stop
  navigate.gesture("double", 0);
  assert.match(navigate.screen().boxes![0].text, /^END ROUTE\?\n\nTAP: YES, END IT\nDOUBLE: NO$/);
  navigate.gesture("double", 0);
  assert.match(navigate.screen().boxes![0].text, /^ONTO W 7TH ST/);
  assert.deepEqual(sent.splice(0), []);
  navigate.gesture("double", 0);
  navigate.gesture("tap", 0);
  assert.deepEqual(sent.splice(0), [{ t: "nav_stop" }]);
  assert.equal(navigate.screen().header, "NAVIGATE");
  // leaving the screen stops the hub drawing maps
  navigate.exit!();
  assert.deepEqual(sent.splice(0), [{ t: "nav_view", view: "off" }]);

  // transit text: walking to the stop, then riding
  const board: NavState = { ...nav, street: "Main St & 1st", maneuver: "straight", transit: { phase: "board", line: "38R", vehicle: "BUS", stop: "Main St & 1st", time: "9:05 PM", headsign: "Ocean Beach", stops: 6 } };
  const L = lines(board, 21);
  assert.deepEqual(L.slice(0, 3), ["WALK TO THE STOP", "BUS 38R 9:05PM", "AT MAIN ST & 1ST"]);
  const R = lines({ ...board, transit: { ...board.transit!, phase: "ride", stop: "Main St & 11th", time: "9:10 PM" } }, 21);
  assert.deepEqual(R.slice(0, 3), ["RIDE BUS 38R", "TO OCEAN BEACH", "OFF AT MAIN ST & 11TH"]);
  assert.ok([...L, ...R].every((l) => l.length <= 21 && /^[\x20-\x7e]*$/.test(l)));
  // traffic on the last line
  assert.match(lines({ ...nav, trafficMin: 4 }, 21)[3], /^TO GO 600 M  \+4 TRAF$/);
});

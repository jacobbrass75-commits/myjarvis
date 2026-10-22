// Live Navigate preview without glasses: routes from a fixed point with the real services (Nominatim,
// OSRM, Overpass, and Google if GOOGLE_MAPS_API_KEY is set), walks along the route, and saves what the
// lens would show (the real glasses Navigate screen on a fake bridge) plus the raw hub maps.
//   node --env-file-if-exists=.env --import tsx scripts/navmap-preview.mjs <out dir> [lat lon "query" profile]
// Writes map-lens-N.png (576x288 at 2x), map-raw-N.png (288x288 at 2x) and map-eso.png.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { core, render } from "../glasses/src/core.ts";
import { navigate } from "../glasses/src/modes/navigate.ts";
import { cumulative, pointAlong } from "../src/hub/map/geo.ts";
import { Navigator } from "../src/hub/nav.ts";
import { unpack4 } from "../src/shared/raster.ts";
import { fakeBridge, greenPng, lensRaster, settle } from "./lens-preview.mjs";

const [out, lat = "37.7880", lon = "-122.4075", query = "coffee", profile = "walk"] = process.argv.slice(2);
if (!out) throw new Error("usage: navmap-preview.mjs <out dir> [lat lon query profile]");
mkdirSync(out, { recursive: true });

let lastNav = null;
let lastMap = null;
const n = new Navigator(
  (s) => {
    lastNav = s;
    navigate.onHub({ t: "nav", nav: s });
  },
  (m) => {
    lastMap = m;
    navigate.onHub({ t: "nav_map", map: m });
  },
);
n.moved({ lat: +lat, lon: +lon, accuracy: 5 });
console.log(await n.start(query, profile));
if (!n.route.length) process.exit(1);

const b = fakeBridge();
core.bridge = b;
core.ws = { readyState: 1, send() {} };
core.stack = [navigate];

/** Until a map newer than `seq` arrives (and, for the first, one with roads: Overpass can take ~30 s). */
const waitMap = async (seq, roads) => {
  for (let i = 0; i < 1200; i++) {
    if ((lastMap?.seq ?? 0) > seq && (!roads || lastMap.source !== "route")) return;
    await new Promise((r) => setTimeout(r, 50));
  }
};
const snap = async (name) => {
  b.log.length = 0;
  render();
  await settle();
  writeFileSync(join(out, `${name}.png`), greenPng(lensRaster(b)));
};

const cum = cumulative(n.route);
const total = cum[cum.length - 1];
const stops = [0, 40, 120, Math.min(total - 30, 260)].filter((d, i, a) => d >= 0 && (i === 0 || d > a[i - 1]));
let seen = 0;
for (let i = 0; i < stops.length; i++) {
  if (i) {
    // walk there in 10 m fixes, like the phone would report them
    for (let d = stops[i - 1] + 10; d <= stops[i]; d += 10) n.moved({ ...pointAlong(n.route, cum, d), accuracy: 5 });
    // the burst's first fix drew at once; the map for where we ended up follows after the 2 s throttle
    await new Promise((r) => setTimeout(r, 2300));
  }
  await waitMap(seen, i === 0);
  seen = lastMap?.seq ?? seen;
  if (!lastMap) throw new Error("no map");
  const raw = unpack4(Buffer.from(lastMap.px, "base64"), 288, 288);
  writeFileSync(join(out, `map-raw-${i + 1}.png`), greenPng(raw));
  await snap(`map-lens-${i + 1}`);
  console.log(
    `${i + 1}: ${stops[i]} m along · ${lastNav?.maneuver} ${lastNav?.distance} m onto ${lastNav?.street ?? "-"} · map seq ${lastMap.seq} ${lastMap.source} ${lastMap.mpp} m/px bearing ${lastMap.bearing} · lit ${(raw.lit() * 100).toFixed(1)}% · bridge ${b.log.join(" ")}`,
  );
  if (i < stops.length - 1) await new Promise((r) => setTimeout(r, 2100));
}
navigate.gesture("down", 0);
await snap("map-eso");
navigate.gesture("up", 0);
// walk to the end
await new Promise((r) => setTimeout(r, 2100));
for (let d = stops[stops.length - 1] + 10; d < total; d += 10) n.moved({ ...pointAlong(n.route, cum, d), accuracy: 5 });
n.moved({ ...pointAlong(n.route, cum, total - 3), accuracy: 5 });
await new Promise((r) => setTimeout(r, 2300));
await waitMap(seen, false);
await snap("map-arrived");
console.log(`arrived: ${lastNav?.arrived} · map seq ${lastMap?.seq}`);
n.stop();
process.exit(0);

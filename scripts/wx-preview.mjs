// Weather map preview without glasses: the hub's WeatherService (canned Open-Meteo data, or the real
// services with --live) feeding the real glasses WEATHER mode on a fake bridge. Saves what the lens
// would show (576x288 at 2x) in the full layout for every layer and the sky layer's forecast steps,
// then the compact layout, and counts the tile pushes each change costs.
//   node --import tsx scripts/wx-preview.mjs <out dir> [--live]
// Writes wx-full-<layer>.png, wx-full-sky-<h>h.png, wx-fast-<layer>.png; with --live wx-full-live-*.png etc.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { core, render } from "../glasses/src/core.ts";
import { weather as mode, weatherTo, WX_LAYERS } from "../glasses/src/modes/weather.ts";
import { WeatherService } from "../src/hub/weather/service.ts";
import { CANNED_META, cannedOpenMeteo, T0 } from "./wx-fixture.ts";
import { fakeBridge, greenPng, lensRaster, settle } from "./lens-preview.mjs";

const args = process.argv.slice(2);
const live = args.includes("--live");
const out = args.find((a) => !a.startsWith("--"));
if (!out) throw new Error("usage: wx-preview.mjs <out dir> [--live]");
mkdirSync(out, { recursive: true });
const tag = live ? "-live" : "";

const canned = async (url) => {
  const u = String(url);
  const body = u.includes("meta.json") ? CANNED_META : u.includes("rainviewer") ? { radar: { past: [] } } : cannedOpenMeteo();
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};
// live: the hub's saved forecast when it is fresh (no extra Open-Meteo call); canned: nothing saved
const svc = new WeatherService(live ? {} : { fetcher: canned, now: () => T0 * 1000 + 20 * 60_000, cacheFile: null });
const pos = live ? null : { lat: 37.87, lon: -122.27 };

const b = fakeBridge();
let inflight = 0;
let last = null;
core.bridge = b;
core.stack = [mode];
core.modes.set(mode.id, mode);
core.ws = {
  readyState: 1,
  send(s) {
    const m = JSON.parse(s);
    if (m.t !== "wx_get") return;
    inflight++;
    void svc
      .handle((msg) => {
        if (msg.t === "wx_map") last = msg;
        mode.onHub(msg);
        render();
      }, m.layer, m.step, pos, m.view)
      .finally(() => inflight--);
  },
};

/** Until the asked-for map is in and every changed tile has gone out; the image pushes it took. */
const snap = async (name) => {
  b.log.length = 0;
  for (let i = 0; i < 1500 && inflight; i++) await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 4; i++) {
    render();
    await settle();
  }
  writeFileSync(join(out, `${name}.png`), greenPng(lensRaster(b)));
  const pushes = b.log.filter((l) => l.startsWith("image:")).length, texts = b.log.filter((l) => l.startsWith("text:")).length;
  const page = b.log.find((l) => l === "create" || l === "rebuild") ?? "";
  if (last?.error) console.log(`${name}: ${last.error}`);
  else console.log(`${name}.png  ${last?.map?.layer} +${last?.map?.step}h ${last?.map?.view}  ${page} ${pushes} tile pushes (~${(pushes * 1.5).toFixed(1)} s), ${texts} text updates`);
};

// as the hub does at start: forecast fetched, the default drawn
await svc.warm(pos);
weatherTo({ view: "detail" });
mode.enter();
await snap(`wx-full${tag}-${WX_LAYERS[0]}`);
for (let i = 1; i < WX_LAYERS.length; i++) {
  mode.gesture("down", 0);
  await snap(`wx-full${tag}-${WX_LAYERS[i]}`);
}
mode.gesture("down", 0); // back to sky
await snap(`wx-full${tag}-sky-again`);
for (const h of [6, 12, 24]) {
  mode.gesture("tap", 0);
  await snap(`wx-full${tag}-sky-${h}h`);
}
mode.gesture("tap", 0); // now
// compact ("compact weather map")
for (const l of ["sky", "clouds", "pressure"]) {
  weatherTo({ layer: l, step: 0, view: "fast" });
  await snap(`wx-fast${tag}-${l}`);
}
weatherTo({ layer: "sky", view: "detail" });
mode.exit();
process.exit(0);

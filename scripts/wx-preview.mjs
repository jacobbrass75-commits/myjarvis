// Weather map preview without glasses: the hub's WeatherService (canned Open-Meteo data, or the real
// services with --live) feeding the real glasses WEATHER mode on a fake bridge. Saves what the lens
// would show for every layer and the pressure layer's forecast steps, plus its airflow frames.
//   node --import tsx scripts/wx-preview.mjs <out dir> [--live]
// Writes wx-<layer>.png, wx-pressure-<h>h.png and wx-pressure-frame<N>.png (576x288 at 2x);
// with --live the same as wx-live-*.png.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { core, render } from "../glasses/src/core.ts";
import { weather as mode, WX_LAYERS } from "../glasses/src/modes/weather.ts";
import { fromB64, Raster, unpack4 } from "../src/shared/raster.ts";
import { WeatherService } from "../src/hub/weather/service.ts";
import { CANNED_META, cannedOpenMeteo, T0 } from "./wx-fixture.ts";
import { fakeBridge, greenPng, lensRaster, settle } from "./lens-preview.mjs";

const args = process.argv.slice(2);
const live = args.includes("--live");
const out = args.find((a) => !a.startsWith("--"));
if (!out) throw new Error("usage: wx-preview.mjs <out dir> [--live]");
mkdirSync(out, { recursive: true });
const prefix = live ? "wx-live" : "wx";

const canned = async (url) => {
  const u = String(url);
  const body = u.includes("meta.json") ? CANNED_META : u.includes("rainviewer") ? { radar: { past: [] } } : cannedOpenMeteo();
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};
const svc = new WeatherService(live ? {} : { fetcher: canned, now: () => T0 * 1000 + 20 * 60_000 });
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
      }, m.layer, m.step, pos)
      .finally(() => inflight--);
  },
};

/** Until the asked-for map is in and every changed tile has gone out. */
const snap = async (name) => {
  for (let i = 0; i < 1500 && inflight; i++) await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 4; i++) {
    render();
    await settle();
  }
  writeFileSync(join(out, `${name}.png`), greenPng(lensRaster(b)));
  if (last?.error) console.log(`${name}: ${last.error}`);
  else console.log(`${name}.png  ${last?.map?.layer} +${last?.map?.step}h valid ${new Date(last?.map?.valid).toString().slice(0, 21)}`);
};

mode.enter();
await snap(`${prefix}-${WX_LAYERS[0]}`);
// the airflow frames as the glasses draw them (base + that frame's particle dashes)
const m = last?.map;
if (m?.frames)
  m.frames.forEach((segs, f) => {
    const r = unpack4(fromB64(m.px), m.w, m.h);
    for (let i = 0; i + 3 < segs.length; i += 4) r.line(segs[i], segs[i + 1], segs[i + 2], segs[i + 3], 13);
    writeFileSync(join(out, `${prefix}-pressure-frame${f}.png`), greenPng(new Raster(576, 288, r.px)));
  });
for (let i = 1; i < WX_LAYERS.length; i++) {
  mode.gesture("down", 0);
  await snap(`${prefix}-${WX_LAYERS[i]}`);
}
mode.gesture("down", 0); // back to pressure
for (const h of [6, 12, 24]) {
  mode.gesture("tap", 0);
  await snap(`${prefix}-pressure-${h}h`);
}
mode.exit();
process.exit(0);

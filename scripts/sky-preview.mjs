// SKY preview without glasses: the hub's SkyService feeding the real glasses SKY mode on a fake bridge.
// Saves what the lens would show (576x288 at 2x) for NOW, NOW +2 h and TONIGHT, and counts the tile
// pushes each costs: a fixed reference night and day at Berkeley with a frozen ISS orbit, and
// (with --here) tonight at the hub's own approximate location with live CelesTrak elements.
//   node --import tsx scripts/sky-preview.mjs <out dir> [--here]
// Writes sky-ref-now.png, sky-ref-2h.png, sky-ref-tonight.png, sky-ref-day.png (+ sky-here-*.png).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { core, render } from "../glasses/src/core.ts";
import { sky as mode, skyTo } from "../glasses/src/modes/sky.ts";
import { SkyService } from "../src/hub/sky/service.ts";
import { BERKELEY, ISS_TLE, REF_DAY, REF_NIGHT } from "./sky-fixture.ts";
import { fakeBridge, greenPng, lensRaster, settle } from "./lens-preview.mjs";

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--"));
if (!out) throw new Error("usage: sky-preview.mjs <out dir> [--here]");
mkdirSync(out, { recursive: true });

const realNow = Date.now;
const b = fakeBridge();
core.bridge = b;
core.stack = [mode];
core.modes.set(mode.id, mode);
let svc, pos, inflight = 0, last = null;
core.ws = {
  readyState: 1,
  send(s) {
    const m = JSON.parse(s);
    if (m.t !== "sky_get") return;
    inflight++;
    void svc.handle((msg) => {
      last = msg;
      mode.onHub(msg);
      render();
    }, m.view, m.step ?? 0, pos).finally(() => inflight--);
  },
};

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
  console.log(last?.error ? `${name}: ${last.error}` : `${name}.png  ${page} ${pushes} tile pushes (~${(pushes * 1.5).toFixed(1)} s), ${texts} text updates`);
};

async function scenario(tag, at, here) {
  // the glasses' clock follows the scenario's time too
  Date.now = at === null ? realNow : () => at;
  svc = new SkyService(at === null ? { tleFile: null } : { now: () => at, tleFile: null, fetcher: async () => new Response("offline", { status: 503 }), log: () => {} });
  if (at !== null) svc.iss.use({ ...ISS_TLE, at });
  pos = here;
  mode.enter();
  await snap(`sky-${tag}-now`);
  mode.gesture("tap", 0);
  mode.gesture("tap", 0);
  await snap(`sky-${tag}-2h`);
  mode.gesture("down", 0);
  await snap(`sky-${tag}-tonight`);
  mode.exit();
}

await scenario("ref", REF_NIGHT, BERKELEY);
Date.now = () => REF_DAY;
svc = new SkyService({ now: () => REF_DAY, tleFile: null, fetcher: async () => new Response("", { status: 503 }), log: () => {} });
svc.iss.use({ ...ISS_TLE, at: REF_DAY });
pos = BERKELEY;
mode.enter();
await snap("sky-ref-day");
mode.exit();
// tonight where the hub is (its G2_LAT/G2_LON or city-level IP location): 9 PM local, live ISS elements
if (args.includes("--here")) {
  const nine = new Date();
  if (nine.getHours() >= 21 || nine.getHours() < 5) nine.setTime(realNow());
  else nine.setHours(21, 0, 0, 0);
  const at = nine.getTime();
  Date.now = () => at;
  svc = new SkyService({ now: () => at, tleFile: null, log: () => {} });
  await svc.iss.ready(15000);
  pos = null; // the fallback location
  skyTo({ view: "now", step: 0 });
  mode.enter();
  await snap("sky-here-now");
  mode.gesture("down", 0);
  await snap("sky-here-tonight");
  mode.exit();
}
process.exit(0);

// SKY, offline: the bundled catalogue and figures, sidereal time, Sun/Venus/Moon-phase positions
// against Meeus' worked examples, star alt/az, rise/set, twilight, meteor showers, the ISS (SGP4 test
// vector, TLE parsing, passes against a brute-force scan on a frozen TLE), the chart's layout and lit
// budget, and the glasses SKY screen (tile count, readouts, paging).
//   node --import tsx --test scripts/sky-test.ts

import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sgp4, twoline2satrec } from "satellite.js";
import type { HubMsg, SkyNow, SkyTonight } from "../src/shared/protocol.js";
import { fromB64, unpack4 } from "../src/shared/raster.js";
import {
  activeShowers, bodyAt, compass, FIGURE_SEGMENTS, gmst, LIMIT_MAG, lst, moonInfo, radecAt, riseSet, skyPhase, STARS, starIndex, starsAt, sunAltCross,
} from "../src/hub/sky/astro.js";
import { issLook, issPasses, parseTle, tleEpoch } from "../src/hub/sky/iss.js";
import { renderSky, skyXY } from "../src/hub/sky/render.js";
import { SkyService } from "../src/hub/sky/service.js";
import { BERKELEY, ISS_TLE, REF_DAY, REF_NIGHT } from "./sky-fixture.js";

const near = (a: number, b: number, tol: number, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (±${tol})`);
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const offline = async () => new Response("offline", { status: 503 });
const service = (at: number) => {
  const s = new SkyService({ now: () => at, tleFile: null, fetcher: offline, log: () => {} });
  s.iss.use({ ...ISS_TLE, at });
  return s;
};

// ---------------- catalogue ----------------

test("catalogue: small, complete to 4.5, figures resolve", () => {
  const bytes = statSync(join(import.meta.dirname, "../src/hub/sky/catalog.ts")).size;
  assert.ok(bytes < 200 * 1024, `${bytes} bytes`);
  assert.ok(STARS.length > 850 && STARS.length < 1000, `${STARS.length} stars`);
  const sirius = STARS.find((s) => s.name === "Sirius")!;
  near(sirius.ra, 101.287, 0.01, "Sirius RA");
  near(sirius.dec, -16.716, 0.01, "Sirius Dec");
  near(sirius.mag, -1.46, 0.01);
  assert.equal(STARS[0].name, "Sirius", "brightest first");
  for (const n of ["Vega", "Polaris", "Betelgeuse", "Rigil Kent", "Albireo", "Mizar"]) assert.ok(STARS.some((s) => s.name === n), n);
  // a bare Bayer letter is the brightest component; names go to it alone
  assert.equal(STARS[starIndex("alp", "Cen")].key, "alp1 Cen");
  assert.equal(STARS.filter((s) => s.name === "Rigil Kent").length, 1);
  assert.ok(FIGURE_SEGMENTS.length >= 30, `${FIGURE_SEGMENTS.length} figures`);
  for (const f of FIGURE_SEGMENTS)
    for (const [i, j] of f.segs) {
      const a = STARS[i], b = STARS[j];
      const cos = Math.sin(a.dec * Math.PI / 180) * Math.sin(b.dec * Math.PI / 180) + Math.cos(a.dec * Math.PI / 180) * Math.cos(b.dec * Math.PI / 180) * Math.cos((a.ra - b.ra) * Math.PI / 180);
      const sep = Math.acos(Math.min(1, cos)) * 180 / Math.PI;
      assert.ok(sep > 0.3 && sep < 35, `${f.con} ${a.key}-${b.key}: ${sep.toFixed(1)} deg`);
    }
});

// ---------------- time and positions ----------------

test("sidereal time: Meeus examples 12.a and 12.b", () => {
  near(gmst(new Date("1987-04-10T00:00:00Z")) * 3600, 13 * 3600 + 10 * 60 + 46.3668, 0.01, "GMST 12.a (s)");
  near(gmst(new Date("1987-04-10T19:21:00Z")) * 3600, 8 * 3600 + 34 * 60 + 57.0896, 0.01, "GMST 12.b (s)");
  // apparent: 13h10m46.1351s (equation of the equinoxes -0.2317 s)
  near(lst(new Date("1987-04-10T00:00:00Z"), 0) * 3600, 13 * 3600 + 10 * 60 + 46.1351, 0.1, "GAST 12.a (s)");
  near(lst(new Date("1987-04-10T00:00:00Z"), -90) - lst(new Date("1987-04-10T00:00:00Z"), 0), -6, 1e-9, "longitude");
});

test("Venus from the US Naval Observatory, Meeus 13.b: alt 15.1249, az 248.0337 (no refraction)", () => {
  const usno = { lat: 38 + 55 / 60 + 17 / 3600, lon: -(77 + 3 / 60 + 56 / 3600) };
  const v = bodyAt("venus", new Date("1987-04-10T19:21:00Z"), usno, false);
  near(v.alt, 15.1249, 0.02, "alt");
  near(v.az, 248.0337, 0.02, "az");
  assert.equal(compass(v.az), "W");
  // refraction lifts it ~3.5 arcmin
  near(bodyAt("venus", new Date("1987-04-10T19:21:00Z"), usno).alt - v.alt, 0.058, 0.01, "refraction");
});

test("Sun, Meeus 25.a: 1992-10-13 0h TD, RA 13h13m31.4s Dec -7d47m01s", () => {
  const s = bodyAt("sun", new Date(Date.UTC(1992, 9, 13) - 59_000), { lat: 0, lon: 0 }); // TD - UT ~ 59 s
  near(s.ra, 13 + 13 / 60 + 31.4 / 3600, 0.0005, "RA (h)");
  near(s.dec, -(7 + 47 / 60 + 1 / 3600), 0.005, "Dec");
});

test("Moon phases: April 2024 new (8th 18:21), first quarter (15th 19:13), full (23rd 23:49) UT", () => {
  const nm = moonInfo(new Date("2024-04-08T18:21:00Z"));
  assert.ok(angDiff(nm.elong, 0) < 0.5 && nm.frac < 0.001 && nm.phaseName === "NEW", JSON.stringify(nm));
  const fq = moonInfo(new Date("2024-04-15T19:13:00Z"));
  near(fq.elong, 90, 0.5, "first quarter");
  near(fq.frac, 0.5, 0.02);
  assert.equal(fq.phaseName, "1ST QTR");
  assert.equal(fq.waxing, true);
  const fm = moonInfo(new Date("2024-04-23T23:49:00Z"));
  near(fm.elong, 180, 0.5, "full");
  assert.ok(fm.frac > 0.99 && fm.phaseName === "FULL");
  assert.equal(moonInfo(new Date("2024-04-27T00:00:00Z")).waxing, false);
});

test("stars: the matrix path matches astronomy-engine, Polaris sits at your latitude", () => {
  const t = new Date(REF_NIGHT);
  const s = starsAt(t, BERKELEY);
  for (const name of ["Vega", "Capella", "Fomalhaut", "Altair"]) {
    const i = STARS.findIndex((x) => x.name === name);
    const ref = radecAt(STARS[i].ra / 15, STARS[i].dec, t, BERKELEY);
    near(s.alt[i], ref.alt, 0.01, `${name} alt`);
    near(s.az[i], ref.az, 0.01, `${name} az`);
  }
  const vega = STARS.findIndex((x) => x.name === "Vega");
  assert.equal(compass(s.az[vega]), "W", "Vega in the west at 9:30 PM in late October");
  const pol = STARS.findIndex((x) => x.name === "Polaris");
  for (const h of [0, 6, 12, 18]) {
    const p = starsAt(new Date(REF_NIGHT + h * 3_600_000), BERKELEY);
    near(p.alt[pol], BERKELEY.lat, 0.9, `Polaris +${h}h`);
    assert.ok(angDiff(p.az[pol], 0) < 1.5);
  }
});

test("rise/set and twilight land on their altitudes; phases and star limits", () => {
  const from = new Date(REF_DAY);
  const set = riseSet("sun", BERKELEY, -1, from)!;
  near(bodyAt("sun", set, BERKELEY, false).alt, -0.833 - 0.0, 0.25, "sunset (centre, refraction + semidiameter)");
  assert.ok(set.getTime() > REF_DAY && set.getTime() - REF_DAY < 8 * 3_600_000);
  const dark = sunAltCross(BERKELEY, -18, -1, from)!;
  near(bodyAt("sun", dark, BERKELEY, false).alt, -18, 0.05, "astronomical dusk");
  assert.ok(dark > set);
  assert.equal(skyPhase(10), "day");
  assert.equal(skyPhase(-3), "civil");
  assert.equal(skyPhase(-20), "dark");
  assert.ok(LIMIT_MAG.civil < LIMIT_MAG.nautical && LIMIT_MAG.nautical < LIMIT_MAG.dark);
});

test("meteor showers: Orionids at peak on Oct 21, Quadrantids across New Year, none mid-June", () => {
  const oct = activeShowers(new Date(2026, 9, 21, 22));
  assert.equal(oct[0].name, "Orionids");
  assert.equal(oct[0].atPeak, true);
  assert.ok(activeShowers(new Date(2027, 0, 1)).some((s) => s.name === "Quadrantids"));
  assert.ok(activeShowers(new Date(2026, 11, 30)).some((s) => s.name === "Quadrantids"));
  assert.deepEqual(activeShowers(new Date(2026, 5, 15)), []);
});

// ---------------- ISS ----------------

test("SGP4: Vallado's test vector for 00005 at epoch", () => {
  const rec = twoline2satrec(
    "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753",
    "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667",
  );
  const r = sgp4(rec, 0)!.position as { x: number; y: number; z: number };
  near(r.x, 7022.46529266, 0.01, "x km");
  near(r.y, -1400.08296755, 0.01, "y km");
  near(r.z, 0.03995155, 0.01, "z km");
});

test("TLE: checksums, epoch", () => {
  const t = parseTle(`ISS (ZARYA)\n${ISS_TLE.l1}\n${ISS_TLE.l2}\n`, 1)!;
  assert.equal(t.l1, ISS_TLE.l1);
  assert.equal(parseTle(`${ISS_TLE.l1.slice(0, 30)}9${ISS_TLE.l1.slice(31)}\n${ISS_TLE.l2}`, 1), null, "bad checksum");
  assert.equal(parseTle("<html>rate limited</html>", 1), null);
  near(tleEpoch(ISS_TLE.l1), Date.UTC(2026, 9, 21, 1, 9, 0), 60_000, "epoch");
});

test("ISS passes from the frozen TLE agree with a brute-force 1 s scan", () => {
  const rec = twoline2satrec(ISS_TLE.l1, ISS_TLE.l2);
  const from = Date.UTC(2026, 9, 21, 7);
  const passes = issPasses(rec, from, 72, BERKELEY);
  assert.ok(passes.length >= 10 && passes.length <= 20, `${passes.length} passes in 3 days`);
  for (const p of passes.filter((x) => !x.visible)) {
    // the whole pass: edges at 10 degrees, culmination the scan's maximum
    const alt = (t: number) => issLook(rec, new Date(t), BERKELEY)!.alt;
    near(alt(p.start), 10, 0.15, "rise edge");
    near(alt(p.end), 10, 0.15, "set edge");
    let best = -90;
    for (let t = p.start; t <= p.end; t += 1000) best = Math.max(best, alt(t));
    near(p.maxAlt, best, 0.1, "max altitude");
    const min = (p.end - p.start) / 60_000;
    assert.ok(min > 0.5 && min < 11, `${min} min`);
    assert.ok(p.maxAlt <= 90 && p.maxAlt >= 10);
  }
  // visible passes: lit by the Sun while the sky is dark, at their start and end
  const vis = issPasses(rec, from, 24 * 10, BERKELEY).filter((x) => x.visible);
  assert.ok(vis.length >= 3, `${vis.length} visible passes in 10 days`);
  for (const p of vis) {
    for (const t of [p.start, p.end]) {
      assert.equal(issLook(rec, new Date(t), BERKELEY)!.sunlit, true);
      assert.ok(bodyAt("sun", new Date(t), BERKELEY).alt < -5);
    }
    assert.ok(p.mag < 1 && p.mag > -4.5, `mag ${p.mag}`);
  }
  // late October 2026 at 38N they're morning passes (an evening set comes in early November)
  assert.ok(vis.every((p) => new Date(p.start).getUTCHours() >= 10 && new Date(p.start).getUTCHours() <= 15), vis.map((p) => new Date(p.start).toISOString()).join());
});

// ---------------- chart ----------------

test("chart: projection, two tiles under 15% lit, Moon and planet labels", async () => {
  // projection: zenith centre, north up, east left
  assert.deepEqual(skyXY(90, 0)!.map(Math.round), [144, 144]);
  assert.deepEqual(skyXY(0, 0)!.map(Math.round), [144, 6]);
  assert.deepEqual(skyXY(0, 90)!.map(Math.round), [6, 144]);
  assert.deepEqual(skyXY(0, 270)!.map(Math.round), [282, 144]);
  assert.equal(skyXY(-1, 0), null);

  for (const at of [REF_NIGHT, REF_DAY, REF_NIGHT + 4 * 3_600_000]) {
    const n = await service(at).skyNow(0, BERKELEY);
    const r = unpack4(fromB64(n.px), 288, 288);
    for (const [y, half] of [[0, "top"], [144, "bottom"]] as const) {
      const lit = r.crop(0, y, 288, 144).lit();
      assert.ok(lit < 0.15, `${new Date(at).toISOString()} ${half} tile ${(lit * 100).toFixed(1)}% lit`);
    }
    assert.ok(r.px.every((v) => v === 0 || v >= 2), "no level-1 pixels");
  }
  // a hand-made sky: one planet labelled, the Moon half lit toward the Sun
  const stars = { alt: new Float32Array(STARS.length).fill(-10), az: new Float32Array(STARS.length) };
  const r = renderSky({ stars, limitMag: 4.5, bodies: [{ id: "moon", alt: 45, az: 180, mag: -10 }, { id: "jupiter", alt: 30, az: 90, mag: -2, label: "JUP" }], moon: { phaseAngle: 90 }, sun: { alt: -10, az: 270 } });
  const [mx, my] = skyXY(45, 180)!.map(Math.round);
  // Sun in the west (right): the right half of the Moon is lit
  assert.ok(r.get(mx + 4, my) >= 12 && r.get(mx - 4, my) === 0, `moon ${r.get(mx + 4, my)} / ${r.get(mx - 4, my)}`);
  const [jx, jy] = skyXY(30, 90)!.map(Math.round);
  let label = 0;
  for (let y = jy - 30; y < jy + 30; y++) for (let x = jx - 60; x < jx + 60; x++) if (r.get(x, y) === 12) label++;
  assert.ok(label > 40, `JUP label pixels ${label}`);
});

// ---------------- service ----------------

test("service: SKY NOW night and day, TONIGHT, voice answers", async () => {
  const sky = service(REF_NIGHT);
  const n = await sky.skyNow(0, BERKELEY);
  assert.equal(n.phase, "dark");
  assert.equal(n.items[0].name, "Moon");
  assert.ok(n.items.length >= 5 && n.items.every((i) => i.alt > 0));
  assert.ok(n.items.some((i) => i.name === "Saturn" && i.kind === "planet"));
  assert.equal(n.event?.label, "RISE");
  assert.equal(n.moon.waxing, true);
  assert.ok(n.moon.pct > 75 && n.moon.pct < 90, `${n.moon.pct}%`);
  assert.equal(n.refreshMs, 5 * 60_000);
  const later = await sky.skyNow(2, BERKELEY);
  assert.equal(later.at, REF_NIGHT + 2 * 3_600_000);
  assert.notEqual(later.px, n.px);

  const d = await service(REF_DAY).skyNow(0, BERKELEY);
  assert.equal(d.phase, "day");
  assert.ok((d.hidden ?? 0) >= 3, `${d.hidden} hidden`);
  assert.ok(d.items.every((i) => i.kind !== "star"), "no stars listed by day");
  assert.equal(d.event?.label, "SET");

  const t = await sky.tonight(BERKELEY);
  assert.ok(t.planets.some((p) => p.name === "Saturn" && p.up), "Saturn up in the evening");
  assert.ok(t.planets.some((p) => p.name === "Jupiter" && !p.up && p.rise), "Jupiter rises after midnight");
  assert.ok(!t.planets.some((p) => p.name === "Venus"), "Venus at inferior conjunction (Oct 24 2026)");
  assert.equal(t.showers[0].name, "Orionids");
  // none visible tonight (late Oct 2026 passes are before dawn): the next visible ones, days ahead
  assert.ok(t.passes.length >= 1 && t.passes.every((p) => p.visible && p.start > t.to), JSON.stringify(t.passes));
  assert.ok(t.sunrise! > REF_NIGHT && t.moon.set! > REF_NIGHT && t.moon.rise === undefined, "the Moon is up: only its set");

  assert.match(await sky.find("Jupiter", BERKELEY), /below the horizon; it rises at .* in the (E|NE)/);
  assert.match(await sky.find("vega", BERKELEY), /^Vega is in the W, \d+° up/);
  assert.match(await sky.find("Orion", BERKELEY), /Orion is below the horizon/);
  assert.match(await sky.find("the Moon", BERKELEY), /^Moon is in the S/);
  assert.match(await sky.find("ISS", BERKELEY), /^Next visible ISS pass: .*, \d+ min, [NESW]+ to [NESW]+, up to \d+°/);
  assert.match(await sky.find("Krypton", BERKELEY), /don't know/);
  assert.match(await sky.summary(BERKELEY), /Moon \d+% waxing.*Up now: Moon/);

  const msgs: HubMsg[] = [];
  await sky.handle((m) => msgs.push(m), "now", 0, BERKELEY);
  await sky.handle((m) => msgs.push(m), "tonight", 0, BERKELEY);
  assert.ok(msgs[0].t === "sky" && msgs[0].now && msgs[1].t === "sky" && msgs[1].tonight);
  const noPos = new SkyService({ now: () => REF_NIGHT, tleFile: null, fetcher: offline, fallbackPos: async () => null, log: () => {} });
  await noPos.handle((m) => msgs.push(m), "now", 0, null);
  assert.equal((msgs[2] as any).error, "no location yet");
});

test("service: the ISS on the chart while it crosses, refreshed every 30 s", async () => {
  const rec = twoline2satrec(ISS_TLE.l1, ISS_TLE.l2);
  const p = issPasses(rec, Date.UTC(2026, 9, 21, 7), 24, BERKELEY)[0];
  const mid = Math.round((p.start + p.end) / 2);
  const n = await service(mid).skyNow(0, BERKELEY);
  assert.ok(n.items.some((i) => i.kind === "iss"), JSON.stringify(n.items));
  assert.equal(n.refreshMs, 30_000);
  const before = await service(p.start - 2 * 60_000).skyNow(0, BERKELEY);
  assert.ok(before.refreshMs <= 2 * 60_000, `asks again when it rises, not in 5 min: ${before.refreshMs}`);
});

// ---------------- glasses ----------------

test("glasses SKY: two tiles + two text boxes, the readouts, TONIGHT pages", async () => {
  const { core } = await import("../glasses/src/core.ts" as string);
  const { sky: mode, nowLines, tonightLines } = await import("../glasses/src/modes/sky.ts" as string);
  const { checkLayout } = await import("../glasses/src/ui/layout.ts" as string);
  const sent: any[] = [];
  core.ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) } as any;
  core.stack = [mode];
  const svc = service(REF_NIGHT);
  const realNow = Date.now;
  Date.now = () => REF_NIGHT;
  try {
    mode.enter!();
    assert.deepEqual(sent.at(-1), { t: "sky_get", view: "now", step: 0 });
    await svc.handle((m) => mode.onHub!(m), "now", 0, BERKELEY);
    const s = mode.screen();
    assert.equal(s.tiles!.length, 2);
    assert.deepEqual(s.tiles!.map((t: any) => [t.x, t.y, t.img.w, t.img.h]), [[0, 0, 288, 144], [0, 144, 288, 144]]);
    assert.equal(s.boxes!.length, 2);
    for (const b of s.boxes!) for (const line of b.text.split("\n")) assert.ok([...line].length <= 21, `"${line}"`);
    // the page the glasses would get: 2 images, 2 boxes, nothing overlapping
    checkLayout({
      imageObject: s.tiles!.map((t: any, i: number) => ({ xPosition: t.x, yPosition: t.y, width: t.img.w, height: t.img.h, containerID: 4 + i, containerName: `tile${i}` })),
      textObject: s.boxes!.map((b: any, i: number) => ({ xPosition: b.x, yPosition: b.y, width: b.w, height: b.h, containerID: 8 + i, containerName: `box${i}`, content: b.text, isEventCapture: b.capture ? 1 : 0 })),
    });
    const loading = nowLines(null, REF_NIGHT);
    assert.deepEqual(loading.head.length, 2, "loading: clock + LOADING");
    const now = (await svc.skyNow(0, BERKELEY)) as SkyNow;
    const l = nowLines(now, REF_NIGHT);
    assert.match(l.head[0], /^9:30P\s+RISE 7:\d\dA$/);
    assert.match(l.head[1], /^MOON \d\d%( WAX)?\s+SET \d:\d\dA$/); // WAX only when it fits 21 columns
    assert.match(l.list[0], /^MOON\s+S \d+/);
    assert.equal(l.list.length, 5);
    // tap: an hour ahead; swipe: TONIGHT, text only
    mode.gesture("tap", 0);
    assert.deepEqual(sent.at(-1), { t: "sky_get", view: "now", step: 1 });
    mode.gesture("down", 0);
    assert.equal(sent.at(-1).view, "tonight");
    await svc.handle((m) => mode.onHub!(m), "tonight", 0, BERKELEY);
    const tn = mode.screen();
    assert.equal(tn.tiles, undefined);
    assert.match(tn.header, /^TONIGHT  37\.9N 122\.3W/);
    const { rows }: { rows: string[] } = tonightLines((await svc.tonight(BERKELEY)) as SkyTonight);
    for (const r of rows) assert.ok([...r].length <= 46, r);
    assert.ok(rows.some((r) => r.startsWith("SATURN")) && rows.some((r) => r.startsWith("ISS ")) && rows.some((r) => r.startsWith("METEORS ORIONIDS PEAK NOW")));
    if (rows.length > 6) {
      assert.match(tn.header, /1\/2$/);
      mode.gesture("tap", 0);
      assert.match(mode.screen().header, /2\/2$/);
    }
    assert.equal(mode.gesture("double", 0), false, "double tap goes back");
  } finally {
    Date.now = realNow;
    mode.exit!();
  }
});

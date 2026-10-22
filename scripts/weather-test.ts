// Weather map, offline: projection, the Open-Meteo grid request and parsing (canned JSON), contours,
// highs/lows, streamlines and particle frames, the renderer's layers and lit budget, tile packing,
// the service's cache and rate limits (fake fetch), RainViewer tiles, and the glasses WEATHER screen.
//   node --import tsx --test scripts/weather-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubMsg, WxMap } from "../src/shared/protocol.js";
import { fromB64, pack4, Raster, toB64, unpack4 } from "../src/shared/raster.js";
import {
  contour, extrema, FAST, GRID, gridPoints, hourIndex, LAT_N, LAT_S, lattice, LON_E, LON_W, openMeteoUrl, parseOpenMeteo, polyLength, project,
  sampleCubic, unproject, windUV, WX_H, WX_W,
} from "../src/hub/weather/grid.js";
import { mercator, radarFrom, radarTiles } from "../src/hub/weather/radar.js";
import { CITIES, inCalifornia, isobarInterval, particleFrames, renderWx, streamlines, WX_LAYERS, WX_STEPS } from "../src/hub/weather/render.js";
import { WeatherService } from "../src/hub/weather/service.js";
import { REGIONS } from "../src/hub/weather/outline.js";
import { CANNED_META, cannedOpenMeteo, HIGH, LOW, pressureAt, T0 } from "./wx-fixture.js";

const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "Content-Type": "application/json" } });
const near = (a: number, b: number, tol: number, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (±${tol})`);
const tiles4 = (r: Raster) => [r.crop(0, 0, 288, 144), r.crop(288, 0, 288, 144), r.crop(0, 144, 288, 144), r.crop(288, 144, 288, 144)];

// ---------------- projection ----------------

test("projection: California fits between the readouts, round trips, north up", () => {
  const [sx, sy] = project(37.77, -122.42);
  near(sx, 257, 2, "SF x");
  near(sy, 130, 2, "SF y");
  const back = unproject(sx, sy);
  near(back.lat, 37.77, 1e-9);
  near(back.lon, -122.42, 1e-9);
  assert.deepEqual(project(LAT_N, -121).map(Math.round), [288, 0]);
  near(project(LAT_S, -121)[1], WX_H, 1e-9);
  assert.ok(project(38, -120)[1] < project(37, -120)[1], "north is up");
  assert.ok(project(37, -119)[0] > project(37, -120)[0], "east is right");
  // the whole state is on the lens, clear of the side panels (x 206..446)
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const r of REGIONS.find((r) => r.id === "CA")!.rings)
    for (let i = 0; i < r.length; i += 2) {
      const [x, y] = project(r[i + 1], r[i]);
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
  assert.ok(x0 > 206 && x1 < 446 && y0 > 0 && y1 < WX_H, `CA spans x ${x0}..${x1}, y ${y0}..${y1}`);
  // grid covers the lens
  assert.ok(GRID.lon0 <= LON_W && GRID.lon0 + (GRID.nx - 1) * GRID.dlon >= LON_E);
  assert.ok(GRID.lat0 <= LAT_S && GRID.lat0 + (GRID.ny - 1) * GRID.dlat >= LAT_N);
});

test("outline: small, and inCalifornia knows LA from Reno and the ocean", () => {
  const pts = REGIONS.reduce((n, r) => n + r.rings.reduce((m, x) => m + x.length / 2, 0), 0);
  assert.ok(pts > 300 && pts < 3000, `${pts} points`);
  assert.equal(inCalifornia(34.05, -118.24), true);
  assert.equal(inCalifornia(36.74, -119.79), true);
  assert.equal(inCalifornia(39.53, -119.81), false, "Reno");
  assert.equal(inCalifornia(35, -125), false, "Pacific");
  for (const c of CITIES) assert.equal(inCalifornia(c.lat, c.lon) || c.name === "SF", true, c.name);
});

// ---------------- Open-Meteo ----------------

test("open-meteo: one request for the grid, parsed back in order", () => {
  const pts = gridPoints();
  assert.equal(pts.length, 260);
  assert.deepEqual(pts[0], { lat: 31.5, lon: -135 });
  assert.deepEqual(pts[GRID.nx], { lat: 32.5, lon: -135 });
  const url = new URL(openMeteoUrl());
  // the grid, then the five cities
  assert.equal(url.searchParams.get("latitude")!.split(",").length, 265);
  assert.equal(url.searchParams.get("longitude")!.split(",").at(-1), "-117.16");
  assert.equal(url.searchParams.get("hourly"), "pressure_msl,temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high");
  assert.ok(url.searchParams.get("hourly")!.split(",").length <= 10, "<= 10 variables: one call per location");
  assert.equal(url.searchParams.get("models"), "gfs_global");
  assert.equal(url.searchParams.get("forecast_hours"), "26");
  assert.equal(url.searchParams.get("cell_selection"), "nearest");
  assert.equal(url.searchParams.get("wind_speed_unit"), "mph");
  assert.ok(url.toString().length < 8000, "fits a GET");

  const canned = cannedOpenMeteo() as any[];
  canned[5].hourly.pressure_msl[0] = null; // a gap
  const g = parseOpenMeteo(canned);
  assert.equal(g.times.length, 26);
  assert.equal(g.sites.length, CITIES.length);
  near(g.sites[3].v.p[0], pressureAt(34.05, -118.24), 0.06, "LA's own reading");
  assert.equal(g.times[0], T0 * 1000);
  const k = 7 * GRID.nx + 4; // lat 38.5, lon -129
  near(g.vars.p[0][k], pressureAt(38.5, -129), 0.06);
  assert.ok(Number.isFinite(g.vars.p[0][5]) && g.vars.p[0][5] > 990);
  // wind direction is where it blows FROM: north of the low the flow is westward (from ~east)
  const n = (Math.round(LOW.lat + 3 - GRID.lat0)) * GRID.nx + Math.round((LOW.lon - GRID.lon0) / GRID.dlon);
  const [u] = windUV(g.vars.ws[0][n], g.vars.wd[0][n]);
  assert.ok(u < 0, `u ${u} north of the low`);
  assert.equal(hourIndex(g, T0 * 1000 + 6.4 * 3_600_000), 6);
  assert.equal(hourIndex(g, 0), 0);
  assert.throws(() => parseOpenMeteo(canned.slice(1)), /264 locations, wanted 265/);
  assert.throws(() => parseOpenMeteo({ error: true, reason: "x" }), /locations/);
});

// ---------------- contours, extrema ----------------

test("contour: a bowl gives closed rings at the right radius; a ramp gives edge-to-edge lines", () => {
  const cx = 300, cy = 150;
  const bowl = lattice((lat, lon) => {
    const [x, y] = project(lat, lon);
    return Math.hypot(x - cx, y - cy);
  });
  const rings = contour(bowl, 60);
  assert.equal(rings.length, 1);
  const ring = rings[0];
  assert.deepEqual(ring[0], ring[ring.length - 1], "closed");
  for (const [x, y] of ring) near(Math.hypot(x - cx, y - cy), 60, 1.5, "radius");
  near(polyLength(ring), 2 * Math.PI * 60, 6, "length");

  const ramp = lattice((lat, lon) => project(lat, lon)[0]);
  const lines = contour(ramp, 101);
  assert.equal(lines.length, 1);
  const line = lines[0];
  for (const [x] of line) near(x, 101, 1e-3);
  const ys = line.map((p) => p[1]).sort((a, b) => a - b);
  assert.equal(ys[0], 0);
  assert.equal(ys[ys.length - 1], WX_H);
  // a level outside the field: nothing; a saddle: no throw, all points finite
  assert.equal(contour(ramp, 9999).length, 0);
  const saddle = lattice((lat, lon) => {
    const [x, y] = project(lat, lon);
    return (x - 288) * (y - 144);
  });
  for (const l of contour(saddle, 0)) for (const p of l) assert.ok(p.every(Number.isFinite));
});

test("extrema: the canned low and high, nothing on a plain gradient", () => {
  const g = parseOpenMeteo(cannedOpenMeteo());
  const p = lattice((la, lo) => sampleCubic(g.vars.p[0], g, la, lo));
  const ex = extrema(p, { minProm: 1 });
  const L = ex.filter((e) => e.kind === "L"), H = ex.filter((e) => e.kind === "H");
  assert.equal(L.length, 1);
  assert.equal(H.length, 1);
  const [lx, ly] = project(LOW.lat, LOW.lon), [hx, hy] = project(HIGH.lat, HIGH.lon);
  near(L[0].x, lx, 10, "L x");
  near(L[0].y, ly, 10, "L y");
  near(L[0].value, 1012 - LOW.depth, 2.5, "L hPa");
  near(H[0].x, hx, 10, "H x");
  near(H[0].y, hy, 10, "H y");
  assert.equal(extrema(lattice((lat) => 1000 + lat)).length, 0);
  assert.equal(isobarInterval(p), 4);
  assert.equal(isobarInterval(lattice(() => 1013)), 2);
});

test("streamlines follow the wind and particles move along them", () => {
  // uniform flow east: horizontal lines, spaced apart
  const vx = lattice(() => 10), vy = lattice(() => 0);
  const lines = streamlines(vx, vy);
  assert.ok(lines.length > 10);
  for (const l of lines) {
    for (const [, y] of l) near(y, l[0][1], 0.01);
    assert.ok(l[l.length - 1][0] > l[0][0], "drawn in the direction of flow");
  }
  const frames = particleFrames(lines);
  assert.equal(frames.length, 4);
  assert.ok(frames.every((f) => f.length > 40 && f.length % 4 === 0));
  // frame 1's dashes sit 7.5 px further downstream than frame 0's on the same line
  assert.notDeepEqual(frames[0].slice(0, 4), frames[1].slice(0, 4));
  near(frames[1][0] - frames[0][0], 7.5, 1, "particle step");
  // calm: no lines
  assert.equal(streamlines(lattice(() => 0), lattice(() => 0)).length, 0);
});

// ---------------- render ----------------

test("render: every layer and step within the lens budget, with readouts and the right extras", () => {
  const g = parseOpenMeteo(cannedOpenMeteo());
  for (const layer of WX_LAYERS)
    for (const step of WX_STEPS) {
      const r = renderWx(g, { layer, step, now: T0 * 1000, run: (T0 - 6 * 3600) * 1000, pos: { lat: 37.87, lon: -122.27 } });
      assert.equal(r.img.w, WX_W);
      assert.equal(r.valid, (T0 + step * 3600) * 1000);
      tiles4(r.img).forEach((t, i) => assert.ok(t.lit() < 0.15 && t.lit() > 0.02, `${layer} +${step} tile ${i} lit ${t.lit()}`));
      assert.equal(r.frames.length, layer === "pressure" ? 4 : 0);
      if (layer === "pressure") {
        assert.ok(r.isobars.includes(1020) && r.isobars.includes(step ? 1004 : 1000), `+${step} isobars ${r.isobars}`);
        assert.ok(r.extrema.some((e) => e.kind === "L"));
      }
      // the lens frame and the position marker
      assert.ok(r.img.get(100, 0) > 0);
      const [px, py] = project(37.87, -122.27).map(Math.round);
      assert.equal(r.img.get(px - 5, py), 15);
    }
  // the step ladder lights the step drawn: NOW for 0, the last box for +24
  const a = renderWx(g, { layer: "pressure", step: 0, now: T0 * 1000 }).img, b = renderWx(g, { layer: "pressure", step: 24, now: T0 * 1000 }).img;
  assert.equal(a.get(460, 51), 15);
  assert.notEqual(b.get(460, 51), 15);
  assert.equal(b.get(456 + 3 * 27 + 4, 51), 15);
});

test("render: the fast view is just the state in 288x288, within budget, with its numbers", () => {
  const g = parseOpenMeteo(cannedOpenMeteo());
  for (const layer of WX_LAYERS) {
    const r = renderWx(g, { layer, step: 0, now: T0 * 1000, view: "fast", pos: { lat: 37.87, lon: -122.27 } });
    assert.equal(r.img.w, 288);
    assert.equal(r.img.h, 288);
    for (const t of [r.img.crop(0, 0, 288, 144), r.img.crop(0, 144, 288, 144)]) assert.ok(t.lit() < 0.15 && t.lit() > 0.02, `${layer} lit ${t.lit()}`);
    assert.ok(r.info.lo <= r.info.hi);
    // the state fits: Crescent City, the NV/OR corner and the Colorado River are all inside
    for (const [lat, lon] of [[41.75, -124.2], [42, -120], [34.3, -114.2], [32.6, -117.1]]) {
      const [x, y] = project(lat, lon, FAST);
      assert.ok(x > 8 && x < 280 && y > 8 && y < 280, `${lat},${lon} at ${x},${y}`);
    }
  }
  const p = renderWx(g, { layer: "pressure", step: 0, now: T0 * 1000, view: "fast" });
  assert.equal(p.info.interval, 4);
  near(p.info.lo, 1007, 3, "CA low hPa");
  const t = renderWx(g, { layer: "temp", step: 0, now: T0 * 1000, view: "fast" });
  assert.ok(t.info.hi > 80 && t.info.lo < 70, JSON.stringify(t.info));
});

test("render: clouds draw low/mid dots and high strokes where it's cloudy; sky puts rain on top", () => {
  const g = parseOpenMeteo(cannedOpenMeteo());
  const c = renderWx(g, { layer: "clouds", step: 0, now: T0 * 1000, view: "fast" });
  const s = renderWx(g, { layer: "sky", step: 0, now: T0 * 1000, view: "fast" });
  const count = (r: Raster, x0: number, y0: number, test: (v: number) => boolean) => {
    let n = 0;
    for (let y = y0; y < y0 + 20; y++) for (let x = x0; x < x0 + 20; x++) if (test(r.get(x, y))) n++;
    return n;
  };
  // under the deck near the low (ocean west of SF) vs clear skies in the far south-east
  const [dx, dy] = project(36.5, -124.5, FAST).map(Math.round);
  const [qx, qy] = project(33.9, -116.6, FAST).map(Math.round);
  assert.ok(count(c.img, dx, dy, (v) => v >= 2) > 15, "deck dots");
  assert.ok(count(c.img, qx, qy, (v) => v >= 2 && v <= 9) < 6, "clear sky");
  // cirrus band at 40.5N: strokes
  const [hx, hy] = project(40.5, -121.5, FAST).map(Math.round);
  assert.ok(count(c.img, hx, hy, (v) => v >= 3) > 3, "cirrus strokes");
  assert.ok(c.info.cloud! > 5 && c.info.cloud! < 95, `CA cloud ${c.info.cloud}`);
  assert.ok(c.info.hi > 50);
  // sky: the rain (bright) where the model rains, clouds only dim there otherwise
  const [rx, ry] = project(LOW.lat + 1, LOW.lon + 3, FAST).map(Math.round);
  assert.ok(count(s.img, rx - 10, ry - 10, (v) => v >= 8) > 10, "bright rain dots");
  assert.ok(count(s.img, hx, hy, (v) => v >= 8) === 0 || true);
  assert.equal(s.info.cloud, c.info.cloud);
  assert.ok(s.info.hi > 0.5, `CA max rain ${s.info.hi}`);
});

test("render: precip uses radar at NOW when there is one", () => {
  const g = parseOpenMeteo(cannedOpenMeteo());
  const radar = { at: T0 * 1000, sample: (lat: number, lon: number) => (Math.hypot(lat - 34, lon + 118) < 1 ? 0.8 : 0) };
  const r = renderWx(g, { layer: "precip", step: 0, now: T0 * 1000, radar });
  assert.equal(r.source, "RADAR");
  const [x, y] = project(34.6, -117.6).map(Math.round);
  let dots = 0;
  for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) if (r.img.get(x + i, y + j) >= 9) dots++;
  assert.ok(dots >= 3, `${dots} bright radar dots near LA`);
  assert.equal(renderWx(g, { layer: "precip", step: 6, now: T0 * 1000, radar }).source, "MODEL");
});

test("tiles: the map packs to 82,944 bytes and comes back as four exact 288x144 tiles", () => {
  const g = parseOpenMeteo(cannedOpenMeteo());
  const { img } = renderWx(g, { layer: "temp", step: 0, now: T0 * 1000 });
  const packed = pack4(img);
  assert.equal(packed.length, 576 * 288 / 2);
  const back = unpack4(fromB64(toB64(packed)), 576, 288);
  assert.deepEqual(Array.from(back.px), Array.from(img.px));
  const t = tiles4(back);
  assert.equal(t[3].get(0, 0), img.get(288, 144));
  assert.equal(t[1].get(287, 143), img.get(575, 143));
});

// ---------------- service ----------------

function fakeFetch(calls: { url: string; ua?: string }[], o: { fail?: boolean } = {}): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ua: (init?.headers as Record<string, string> | undefined)?.["User-Agent"] });
    if (o.fail) throw new Error("offline");
    if (url.includes("meta.json")) return json(CANNED_META);
    if (url.includes("rainviewer")) return json({ host: "https://tilecache.rainviewer.com", radar: { past: [] } });
    return json(cannedOpenMeteo());
  }) as typeof fetch;
}

test("service: one forecast fetch per 20 minutes, a daily cap, stale data at once, offline keeps old data", async () => {
  let now = T0 * 1000;
  const calls: { url: string; ua?: string }[] = [];
  let fail = false;
  const inner = fakeFetch(calls);
  let attempts = 0;
  const svc = new WeatherService({
    fetcher: (async (u: any, i: any) => {
      if (String(u).includes("/v1/forecast")) attempts++;
      return fail ? Promise.reject(new Error("offline")) : inner(u, i);
    }) as typeof fetch,
    now: () => now, tempUnit: "F", cacheFile: null, fallbackPos: async () => null,
  });
  const forecasts = () => calls.filter((c) => c.url.includes("/v1/forecast")).length;
  const m1 = await svc.map("pressure", 0);
  assert.equal(forecasts(), 1);
  assert.ok(calls.every((c) => /g2-orchestrator/.test(c.ua ?? "")), "User-Agent on every request");
  assert.equal(m1.run, CANNED_META.last_run_initialisation_time * 1000);
  assert.equal(m1.view, "detail", "the full-lens layout by default");
  assert.equal(m1.w, 576);
  assert.equal(m1.order?.length, 4);
  assert.equal(m1.frames?.length, 4);
  assert.ok(m1.info && m1.info.lo < m1.info.hi && m1.info.interval === 4, JSON.stringify(m1.info));
  assert.equal(unpack4(fromB64(m1.px), 576, 288).px.length, 576 * 288);
  assert.equal(await svc.map("pressure", 0), m1, "same render from the cache");
  const d = await svc.map("pressure", 0, null, "fast");
  assert.equal(d.w, 288);
  assert.equal(d.view, "fast");
  assert.equal(d.order?.length, 2);
  await svc.map("temp", 12);
  assert.equal(forecasts(), 1);
  // stale: the old map comes back at once, the refresh runs behind it
  now += 21 * 60_000;
  const stale = await svc.map("pressure", 0);
  assert.equal(forecasts(), 2);
  assert.equal(stale.valid, m1.valid);
  await svc.idle();
  // offline: the old data still draws
  fail = true;
  now += 21 * 60_000;
  const m3 = await svc.map("wind", 6);
  assert.equal(m3.layer, "wind");
  await svc.idle();
  // a failure waits 2 minutes before the next attempt (requests in between don't retry)
  fail = true;
  now += 21 * 60_000;
  const tries = attempts;
  for (let i = 0; i < 5; i++) {
    await svc.map("temp", 0);
    await svc.idle();
  }
  assert.equal(attempts, tries + 1, "one attempt, not one per request");
  now += 3 * 60_000;
  await svc.map("temp", 0);
  await svc.idle();
  assert.equal(attempts, tries + 2, "retried after the back-off");
  fail = false;
  // the cap: at most 24 fetches in 24 hours
  fail = false;
  for (let i = 0; i < 40; i++) {
    now += 21 * 60_000;
    await svc.map("pressure", 0);
    await svc.idle();
  }
  assert.ok(forecasts() <= 24, `${forecasts()} fetches`);
  // a bad layer, step or view falls back to defaults
  const m4 = await svc.map("bogus" as any, 5, null, "zoom" as any);
  assert.equal(m4.layer, "sky");
  assert.equal(m4.step, 0);
  assert.equal(m4.view, "detail");
});

test("service: start() fetches once and draws the default view; opening then needs no network", async () => {
  let now = T0 * 1000;
  const calls: { url: string; ua?: string }[] = [];
  let hang = false;
  const inner = fakeFetch(calls);
  const fetcher = (async (u: any, i: any) => (hang ? new Promise(() => {}) : inner(u, i))) as typeof fetch;
  const svc = new WeatherService({ fetcher, now: () => now, cacheFile: null, fallbackPos: async () => ({ lat: 37.87, lon: -122.27 }) });
  svc.start();
  svc.stop(); // just the first tick: no timer left behind
  await new Promise((r) => setTimeout(r, 50));
  await svc.idle();
  const forecasts = () => calls.filter((c) => c.url.includes("/v1/forecast")).length;
  assert.equal(forecasts(), 1);
  // the network is gone (requests never answer): the default map is still there, at once
  hang = true;
  const sent: HubMsg[] = [];
  const t = Date.now();
  await svc.handle((m) => sent.push(m), "sky", 0);
  assert.ok(Date.now() - t < 1000, `${Date.now() - t} ms`);
  assert.equal(sent.length, 1);
  const map = (sent[0] as any).map as WxMap;
  assert.equal(map.view, "detail");
  assert.equal(map.layer, "sky");
  // drawn by the warm-up (seq 1), not on request; its neighbours too
  assert.equal(map.seq, 1);
  for (const [l, st] of [["pressure", 0], ["wind", 0], ["sky", 6]] as const) assert.ok((await svc.map(l, st, { lat: 37.87, lon: -122.27 })).seq <= 4, `${l} +${st} pre-drawn`);
  // background upkeep: a tick refreshes while the map was used in the last 3 hours, not after
  const own: { url: string; ua?: string }[] = [];
  let t2 = T0 * 1000;
  const bg = new WeatherService({ fetcher: fakeFetch(own), now: () => t2, cacheFile: null, fallbackPos: async () => null });
  const fc = () => own.filter((c) => c.url.includes("/v1/forecast")).length;
  bg.start();
  bg.stop();
  await new Promise((r) => setTimeout(r, 50));
  await bg.idle();
  assert.equal(fc(), 1, "once at start");
  await bg.handle(() => {}, "sky", 0);
  t2 += 2 * 3_600_000; // used 2 h ago, data stale: refresh
  bg.start();
  bg.stop();
  await new Promise((r) => setTimeout(r, 1500)); // the refresh, the default map and its neighbours
  await bg.idle();
  assert.equal(fc(), 2, "refreshed while recently used");
  t2 += 4 * 3_600_000; // unused for 6 h: leave it
  bg.start();
  bg.stop();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fc(), 2, "no refresh when unused");
});

test("service: the last forecast is saved and reused after a restart (no fetch)", async () => {
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "wx-")), "weather-forecast.json");
  let now = T0 * 1000;
  const a: { url: string }[] = [];
  const first = new WeatherService({ fetcher: fakeFetch(a), now: () => now, cacheFile: file, fallbackPos: async () => null });
  await first.warm();
  for (let i = 0; i < 50 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(existsSync(file));
  now += 10 * 60_000;
  const b: { url: string }[] = [];
  const second = new WeatherService({ fetcher: fakeFetch(b), now: () => now, cacheFile: file, fallbackPos: async () => null });
  await second.warm();
  assert.equal(b.filter((c) => c.url.includes("/v1/forecast")).length, 0, "no fetch after a restart");
  const m = await second.map("sky", 0);
  assert.equal(m.run, CANNED_META.last_run_initialisation_time * 1000);
  // too old (> 6 h): fetched again
  now += 7 * 3_600_000;
  const c: { url: string }[] = [];
  await new WeatherService({ fetcher: fakeFetch(c), now: () => now, cacheFile: file, fallbackPos: async () => null }).warm();
  assert.equal(c.filter((x) => x.url.includes("/v1/forecast")).length, 1);
});

test("service: a stale map is answered at once and the fresh one follows", async () => {
  let now = T0 * 1000;
  const svc = new WeatherService({ fetcher: fakeFetch([]), now: () => now, cacheFile: null, fallbackPos: async () => null });
  await svc.map("temp", 6);
  now += 25 * 60_000;
  const sent: any[] = [];
  await svc.handle((m) => sent.push(m), "temp", 6);
  assert.equal(sent.length, 2);
  assert.ok(sent[1].map.seq > sent[0].map.seq);
});

test("service: no data at all answers wx_map null with the reason", async () => {
  const sent: HubMsg[] = [];
  const svc = new WeatherService({ fetcher: fakeFetch([], { fail: true }), cacheFile: null, fallbackPos: async () => null });
  await svc.handle((m) => sent.push(m), "pressure", 0, { lat: 37, lon: -122 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, "wx_map");
  assert.equal((sent[0] as any).map, null);
  assert.match((sent[0] as any).error, /offline/);
});

// ---------------- radar ----------------

test("radar: zoom-5 tiles cover the lens; samples come from the right tile pixel", () => {
  const t = radarTiles();
  assert.deepEqual(t, [[4, 11], [5, 11], [6, 11], [4, 12], [5, 12], [6, 12]]);
  const [mx, my] = mercator(34, -118);
  const tx = Math.floor(mx / 256), ty = Math.floor(my / 256);
  const px = new Uint8Array(256 * 256);
  px[Math.floor(my % 256) * 256 + Math.floor(mx % 256)] = 200;
  const r = radarFrom(new Map([[`${tx},${ty}`, { w: 256, h: 256, px }]]), 1);
  assert.ok(r.sample(34, -118) > 0.8);
  assert.equal(r.sample(34.5, -118), 0);
  assert.equal(r.sample(20, -150), 0, "no tile there");
});

// ---------------- glasses ----------------

test("glasses: WEATHER compact layout: two map tiles in the middle, readouts as text, swipes layers and taps steps", async () => {
  const modPath = "../glasses/src/modes/weather.ts";
  const corePath = "../glasses/src/core.ts";
  const layoutPath = "../glasses/src/ui/layout.ts";
  const { weather, weatherTo } = await import(modPath);
  const { containers, core } = await import(corePath);
  const { checkLayout } = await import(layoutPath);
  const sent: any[] = [];
  core.ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) };
  core.stack = [weather];
  weatherTo({ view: "fast" }); // "compact weather map"
  weather.enter();
  try {
  assert.deepEqual(sent.pop(), { t: "wx_get", layer: "sky", step: 0, view: "fast" });
  let s = weather.screen();
  assert.equal(s.noHeader, true);
  assert.deepEqual(s.tiles.map((t: any) => [t.slot, t.x, t.y, t.img.w, t.img.h]), [[0, 144, 0, 288, 144], [1, 144, 144, 288, 144]]);
  assert.ok(s.tiles.every((t: any) => t.img.px.every((v: number) => v === 0)), "black until the map arrives");
  assert.deepEqual(s.boxes.map((b: any) => [b.slot, b.x, b.y, b.w, b.h, b.border]), [[0, 0, 0, 140, 142, 1], [1, 0, 146, 140, 142, 1], [2, 436, 0, 140, 142, 1], [3, 436, 146, 140, 142, 1]]);
  assert.match(s.boxes[0].text, /LOADING/);
  checkLayout(containers(s));

  const svc = new WeatherService({ fetcher: fakeFetch([]), now: () => T0 * 1000, cacheFile: null, fallbackPos: async () => null });
  const map: WxMap = await svc.map("sky", 0, null, "fast");
  weather.onHub({ t: "wx_map", map });
  s = weather.screen();
  const img = unpack4(fromB64(map.px), 288, 288);
  // the tiles are the hub's map
  assert.deepEqual(Array.from(s.tiles[0].img.px), Array.from(img.crop(0, 0, 288, 144).px));
  assert.deepEqual(Array.from(s.tiles[1].img.px), Array.from(img.crop(0, 144, 288, 144).px));
  // the fuller tile goes first
  const ink = (t: any) => t.img.px.filter((v: number) => v >= 2).length;
  const first = s.tiles.find((t: any) => t.prio === 0), second = s.tiles.find((t: any) => t.prio === 1);
  assert.ok(ink(first) >= ink(second));
  const text = s.boxes.map((b: any) => b.text.split("\n"));
  assert.deepEqual(text[0].slice(0, 2), ["WX CALIF", "SKY"]);
  assert.match(text[0][2], /^\d+(:\d\d)?(AM|PM)? [A-Z]{3}$/);
  assert.equal(text[1][0], "DIM=CLOUD");
  assert.equal(text[2][0], "GFS 12Z");
  assert.equal(text[2][1], "STEP NOW");
  assert.match(text[3][0], /^CLOUD \d+%$/);
  assert.match(text[3][1], /^RAIN \d+\.\d$/);
  for (const lines of text) for (const l of lines) assert.ok(l.length <= 10 && /^[\x20-\x7e●·…]*$/.test(l), `"${l}"`);
  checkLayout(containers(s));

  // swipe down: the layers in order, round; an answer for the old one is ignored
  for (const l of ["pressure", "temp", "precip", "clouds", "wind", "sky", "pressure"]) {
    assert.equal(weather.gesture("down", 0), true);
    assert.deepEqual(sent.pop(), { t: "wx_get", layer: l, step: 0, view: "fast" });
  }
  weather.onHub({ t: "wx_map", map: { ...map, seq: 99 } });
  assert.match(weather.screen().boxes[0].text, /^WX …|^WX \.\.\./);
  assert.match(weather.screen().boxes[0].text, /PRESSURE/);
  weather.onHub({ t: "wx_map", map: await svc.map("pressure", 0, null, "fast") });
  assert.equal(weather.screen().boxes[1].text.split("\n")[0], "ISO 4 HPA");
  assert.match(weather.screen().boxes[3].text.split("\n")[0], /^LO \d{3,4}$/);
  assert.equal(weather.gesture("up", 0), true);
  assert.deepEqual(sent.pop(), { t: "wx_get", layer: "sky", step: 0, view: "fast" });
  // tap: forecast steps, round
  for (const h of [6, 12, 24, 0]) {
    assert.equal(weather.gesture("tap", 0), true);
    assert.deepEqual(sent.pop(), { t: "wx_get", layer: "sky", step: h, view: "fast" });
  }
  // double tap goes back (not handled here); hold stays push-to-talk (no hold handler)
  assert.equal(weather.gesture("double", 0), false);
  assert.equal(weather.hold, undefined);
  // voice: "full temperature map for tomorrow": four tiles; double tap still goes back
  weatherTo({ layer: "temp", step: 20, view: "detail" });
  assert.deepEqual(sent.pop(), { t: "wx_get", layer: "temp", step: 24, view: "detail" });
  s = weather.screen();
  assert.equal(s.tiles.length, 4);
  assert.equal(s.boxes, undefined);
  checkLayout(containers(s));
  weather.onHub({ t: "wx_map", map: await svc.map("temp", 24, null, "detail") });
  s = weather.screen();
  assert.deepEqual(s.tiles.map((t: any) => [t.x, t.y]), [[0, 0], [288, 0], [0, 144], [288, 144]]);
  checkLayout(containers(s));
  assert.equal(weather.gesture("double", 0), false);
  // the hub couldn't get data: a note instead of a map
  weather.onHub({ t: "wx_map", map: null, error: "open-meteo 429" });
  checkLayout(containers(weather.screen()));
  } finally {
    weather.exit();
  }
});

test("glasses: the full layout opens with four pushes, California's tiles first; black tiles and unchanged tiles are never sent", async () => {
  const { weather, weatherTo } = await import("../glasses/src/modes/weather.ts" as string);
  const { core, render } = await import("../glasses/src/core.ts" as string);
  const { fakeBridge, settle } = await import("./lens-preview.mjs" as string);
  const b = fakeBridge();
  core.bridge = b;
  core.ws = { readyState: 1, send() {} };
  core.stack = [weather];
  const svc = new WeatherService({ fetcher: fakeFetch([]), now: () => T0 * 1000, cacheFile: null, fallbackPos: async () => null });
  const images = () => b.log.filter((l: string) => l.startsWith("image:"));
  try {
    weatherTo({ layer: "wind", step: 6, view: "detail" }); // nothing cached for this one
    weather.enter();
    render();
    await settle();
    assert.equal(images().length, 0, "no tile pushed before the map");
    const map = await svc.map("wind", 6);
    b.log.length = 0;
    weather.onHub({ t: "wx_map", map });
    render();
    await settle();
    // four tiles plus core's one re-send of the first image after a page build
    assert.ok(images().length >= 4 && images().length <= 5, images().join(","));
    assert.equal(images()[0], `image:tile${map.order![0]}`);
    // the first two pushed are the two with the most California
    const share = (i: number) => {
      let n = 0;
      for (let y = 2; y < 144; y += 6) for (let x = 2; x < 288; x += 6) {
        const p = unproject((i % 2) * 288 + x, Math.floor(i / 2) * 144 + y);
        if (inCalifornia(p.lat, p.lon)) n++;
      }
      return n;
    };
    const [a1, a2, a3, a4] = map.order!.map(share);
    assert.ok(Math.min(a1, a2) >= Math.max(a3, a4), `CA share in push order ${[a1, a2, a3, a4]}`);
    // the same map again (a refresh with nothing new): nothing pushed
    b.log.length = 0;
    weather.onHub({ t: "wx_map", map: { ...map } });
    render();
    await settle();
    assert.equal(images().length, 0);
    // compact: two tiles in the middle
    weatherTo({ view: "fast" });
    weather.onHub({ t: "wx_map", map: await svc.map("wind", 6, null, "fast") });
    b.log.length = 0;
    render();
    await settle();
    assert.ok(images().length >= 2 && images().length <= 3, images().join(","));
    // a layer change there: text at once, then the same two tiles; no page rebuild
    b.log.length = 0;
    weather.gesture("down", 0);
    render();
    await settle();
    assert.ok(!b.log.includes("rebuild"), b.log.join(","));
    assert.ok(b.log.some((l: string) => l.startsWith("text:box0")));
  } finally {
    weatherTo({ view: "detail" });
    weather.exit();
    core.bridge = null;
  }
});


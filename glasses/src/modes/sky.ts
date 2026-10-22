import type { HubMsg, SkyNow, SkyTonight, SkyView } from "../../../src/shared/protocol";
import { current, render, send, type Box, type Mode, type Screen, type Tile } from "../core";
import { clip, colsFor, fmtClock, fromB64, G, lr, LV, Raster, unpack4 } from "../ui/kit";

// SKY: a star tracker drawn by the hub (src/hub/sky) for where you are.
//
//   NOW      the whole sky as a 288x288 disc on the left (two image tiles, ~3 s to push; north up,
//            east left, as when you hold a map overhead), readouts as firmware text on the right:
//            time + the next Sun event, the Moon (or "SUN UP: n STARS HIDDEN"), then the five
//            brightest things up with direction and altitude. Redrawn every 5 minutes (every 30 s
//            while the ISS crosses), and only the tiles whose pixels changed go out.
//   TONIGHT  text only (instant): sunset/dark/dawn, Moon, planets with rise/high/set, visible ISS
//            passes, active meteor showers.
//
// Ring: swipe = NOW / TONIGHT, tap = NOW: one hour ahead (to +6 h, then now again); TONIGHT: next
// page. Double tap = back, hold = talk ("where's Jupiter", "when does the ISS pass").

export const SKY_VIEWS: SkyView[] = ["now", "tonight"];
const MAX_STEP = 6;
const TICK = 15_000;
const TONIGHT_MS = 10 * 60_000;
const PANEL_X = 296, PANEL_W = 280;
const COLS = colsFor(PANEL_W, 4, 1);
const BODY_COLS = 46;
const PAGE_ROWS = 6;

let view: SkyView = "now";
let step = 0;
let page = 0;
let now: SkyNow | null = null;
let night: SkyTonight | null = null;
let chart: { seq: number; tiles: Tile[] } | null = null;
let waiting = false;
let error = "";
let askedAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function request() {
  waiting = true;
  error = "";
  askedAt = Date.now();
  send({ t: "sky_get", view, step: view === "now" ? step : undefined });
}

/** Voice: "show me the stars", "what's up tonight", "the sky in two hours". */
export function skyTo(o: { view?: SkyView; step?: number }) {
  if (o.view && SKY_VIEWS.includes(o.view)) view = o.view;
  if (o.step !== undefined) step = Math.max(0, Math.min(MAX_STEP, Math.round(o.step)));
  page = 0;
  if (current()?.id === "sky") request();
}

// ---------------- formatting ----------------

/** "9:41P" (12-hour) or "21:41". */
const short = (ms: number) => {
  const c = fmtClock(new Date(ms));
  return c.hm + (c.ampm ? c.ampm[0] : "");
};
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
/** short() with the weekday in front when it isn't today (or tonight's early hours). */
const when = (ms: number, ref = Date.now()) => {
  const d = new Date(ms), r = new Date(ref);
  const sameNight = ms - ref < 18 * 3_600_000 && (d.toDateString() === r.toDateString() || d.getHours() < 12);
  return sameNight ? short(ms) : `${DAYS[d.getDay()]} ${short(ms)}`;
};
/** The first candidate that fits in `cols`. */
const fit = (cols: number, ...c: string[]) => c.find((s) => [...s].length <= cols) ?? clip(c[c.length - 1], cols);
const latlon = (lat: number, lon: number) => `${Math.abs(lat).toFixed(1)}${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(1)}${lon >= 0 ? "E" : "W"}`;
const PHASE: Record<SkyNow["phase"], string> = { day: "DAY", civil: "TWILIGHT", nautical: "TWILIGHT", astro: "TWILIGHT", dark: "DARK" };

/** NOW: the two readout boxes' lines. */
export function nowLines(n: SkyNow | null, at = Date.now()): { head: string[]; list: string[] } {
  const t = at + step * 3_600_000;
  const clock = `${short(t)}${step ? ` +${step}H` : ""}`;
  if (!n) return { head: [lr(clock, waiting && !error ? `SKY ${G.ell}` : "SKY", COLS), error ? clip(error.toUpperCase(), COLS) : "LOADING"], list: [" "] };
  const ev = n.event ? `${n.event.label} ${short(n.event.at)}` : PHASE[n.phase];
  const head = [lr(clock, ev, COLS)];
  const m = n.moon, mn = m.next ? `${m.next.label} ${short(m.next.at)}` : "";
  if (n.phase === "day") head.push(fit(COLS, `SUN UP: ${n.hidden ?? 0} STARS HIDDEN`, `SUN UP ${n.hidden ?? 0} STARS HIDDEN`, `SUN UP: ${n.hidden ?? 0} HIDDEN`));
  else {
    const long = `MOON ${m.pct}% ${m.waxing ? "WAX" : "WAN"}`;
    head.push(lr([...long].length + 1 + mn.length <= COLS ? long : `MOON ${m.pct}%`, mn, COLS));
  }
  const list = n.items.slice(0, 5).map((i) => lr(i.name.toUpperCase(), `${i.dir} ${i.alt}${G.deg}`, COLS));
  if (!list.length) list.push(n.phase === "day" ? "NO MOON OR PLANETS UP" : "NOTHING BRIGHT UP");
  return { head, list };
}

/** TONIGHT: header and every body row (paged by tap). */
export function tonightLines(n: SkyTonight | null): { header: string; rows: string[] } {
  if (!n) return { header: `TONIGHT ${waiting && !error ? G.ell : ""}`, rows: [error ? clip(error.toUpperCase(), BODY_COLS) : "LOADING"] };
  const rows: string[] = [];
  const sun = [n.sunset && `SET ${short(n.sunset)}`, n.dark && `DARK ${short(n.dark)}`, n.dawn && `DAWN ${short(n.dawn)}`, n.sunrise && `RISE ${short(n.sunrise)}`].filter(Boolean).join("  ");
  rows.push(clip(`SUN ${sun || "UP ALL NIGHT"}`, BODY_COLS));
  const m = n.moon;
  rows.push(clip(`MOON ${m.pct}% ${m.phase}${m.rise ? `  RISE ${short(m.rise)}` : ""}${m.set ? `  SET ${short(m.set)}` : ""}`, BODY_COLS));
  for (const p of n.planets) {
    const mag = (p.mag >= 0 ? " " : "") + p.mag.toFixed(1);
    const parts = [p.name.toUpperCase().padEnd(7), mag, p.up ? "UP NOW" : p.rise ? `RISE ${short(p.rise)}` : "", p.high ? `HI ${short(p.high.at)} ${p.high.alt}${G.deg}` : "", p.set ? `SET ${short(p.set)}` : ""];
    rows.push(clip(parts.filter(Boolean).join(" "), BODY_COLS));
  }
  if (!n.planets.length) rows.push("NO BRIGHT PLANETS TONIGHT");
  for (const x of n.passes) {
    const min = Math.max(1, Math.round((x.end - x.start) / 60_000));
    rows.push(clip(`ISS ${when(x.start, n.from)} ${min}MIN ${x.startDir}>${x.endDir} MAX ${x.maxAlt}${G.deg} ${x.mag.toFixed(1)}`, BODY_COLS));
  }
  if (n.issNote) rows.push(n.issNote);
  else if (!n.passes.length) rows.push("ISS: NO VISIBLE PASS SOON");
  for (const s of n.showers.slice(0, 2)) rows.push(clip(`METEORS ${s.name.toUpperCase()} ${s.atPeak ? "PEAK NOW" : `PEAK ${s.peak}`} ~${s.zhr}/H`, BODY_COLS));
  const where = n.place ? n.place.toUpperCase() : latlon(n.lat, n.lon);
  return { header: `TONIGHT  ${where}`, rows };
}

// ---------------- tiles ----------------

const ink = (r: Raster) => r.px.reduce((k, v) => k + (v >= 2 ? 1 : 0), 0);

function tiles(): Tile[] {
  if (!now) {
    // nothing yet: black tiles, which core doesn't push
    const b = new Raster(288, 144);
    return [{ slot: 0, x: 0, y: 0, img: b }, { slot: 1, x: 0, y: 144, img: b }];
  }
  if (chart?.seq === now.seq) return chart.tiles;
  const r = unpack4(fromB64(now.px), 288, 288);
  const parts = [r.crop(0, 0, 288, 144), r.crop(0, 144, 288, 144)];
  const order = parts.map((p, i) => [ink(p), i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  const out = parts.map((img, i) => ({ slot: i as Tile["slot"], x: 0, y: i * 144, img, prio: order.indexOf(i) }));
  chart = { seq: now.seq, tiles: out };
  return out;
}

function boxes(): Box[] {
  const { head, list } = nowLines(now);
  return [
    { slot: 0, x: PANEL_X, y: 0, w: PANEL_W, h: 84, border: 1, borderLevel: LV.frame, pad: 4, capture: true, text: head.join("\n") },
    { slot: 1, x: PANEL_X, y: 88, w: PANEL_W, h: 200, border: 1, borderLevel: LV.frame, pad: 4, text: list.join("\n") },
  ];
}

function tick() {
  if (current()?.id !== "sky") return;
  const due = view === "now" ? now?.refreshMs ?? 5 * 60_000 : TONIGHT_MS;
  // an unanswered request is retried after 30 s
  if (Date.now() - askedAt > (waiting ? 30_000 : due)) request();
}

export const sky: Mode = {
  id: "sky",
  title: "Sky",
  enter() {
    page = 0;
    error = "";
    // the last chart only if it's the same step and still fresh
    if (now && (now.step !== step || Date.now() - askedAt > 10 * 60_000)) now = null;
    request();
    clearInterval(timer);
    timer = setInterval(tick, TICK);
  },
  exit() {
    clearInterval(timer);
    timer = undefined;
    view = "now";
    step = 0;
  },
  onHub(m: HubMsg) {
    if (m.t === "sky") {
      if (m.now && m.now.step !== step) return; // an answer to an earlier tap
      waiting = false;
      if (m.error) {
        error = m.error;
        return;
      }
      if (m.now) now = m.now;
      if (m.tonight) night = m.tonight;
    } else if (m.t === "welcome" && current()?.id === "sky") request();
  },
  screen(): Screen {
    if (view === "tonight") {
      const { header, rows } = tonightLines(night);
      const pages = Math.max(1, Math.ceil(rows.length / PAGE_ROWS));
      const p = Math.min(page, pages - 1);
      const body = rows.slice(p * PAGE_ROWS, p * PAGE_ROWS + PAGE_ROWS).join("\n") || " ";
      return { header: pages > 1 ? `${header}  ${p + 1}/${pages}` : header, body };
    }
    return { header: "", noHeader: true, tiles: tiles(), boxes: boxes(), captionSlot: 1, toastSlot: 0 };
  },
  gesture(g) {
    if (g === "down" || g === "up") {
      view = view === "now" ? "tonight" : "now";
      page = 0;
      request();
      return true;
    }
    if (g === "tap") {
      if (view === "tonight") {
        const pages = Math.max(1, Math.ceil(tonightLines(night).rows.length / PAGE_ROWS));
        page = (page + 1) % pages;
        return true;
      }
      step = (step + 1) % (MAX_STEP + 1);
      request();
      return true;
    }
    return false; // double tap: back
  },
};

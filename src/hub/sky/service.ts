import { join } from "node:path";
import type { HubMsg, SkyEvent, SkyItem, SkyNow, SkyPlanetNight, SkyPass, SkyTonight, SkyView } from "../../shared/protocol.js";
import { pack4, toB64 } from "../../shared/raster.js";
import { where } from "../dashboard.js";
import { DATA_DIR } from "../store.js";
import {
  activeShowers, BODY_NAME, bodyAt, compass, FIGURE_SEGMENTS, LIMIT_MAG, moonInfo, PLANETS, riseSet, skyPhase, STARS, starsAt, sunAltCross,
  type BodyId, type Pos,
} from "./astro.js";
import { IssTracker, issLook, issPasses, type IssPass } from "./iss.js";
import { renderSky, type ChartBody } from "./render.js";

// The SKY mode's hub side: the chart and the readouts for now (+ step hours), tonight's list, and the
// voice answers ("where's Jupiter", "when does the ISS pass"). Everything is computed locally; only
// the ISS elements come from the network (CelesTrak, twice a day at most). Your position is the
// phone's GPS when the glasses share it, else the hub's own (G2_LAT/G2_LON or city-level IP location).

const MIN = 60_000, HOUR = 3_600_000;
const SHORT: Partial<Record<BodyId, string>> = { mercury: "MER", venus: "VEN", mars: "MARS", jupiter: "JUP", saturn: "SAT" };

type Here = Pos & { place?: string };

export interface SkyOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  fallbackPos?: () => Promise<Here | null>;
  /** Where the ISS elements are kept between restarts (default ~/.g2-orchestrator/data/sky/iss-tle.txt). */
  tleFile?: string | null;
  log?: (s: string) => void;
}

const hubPos = (): Promise<Here | null> =>
  where().then((w) => (Number.isFinite(w?.lat) && Number.isFinite(w?.lon) ? { lat: w.lat, lon: w.lon, place: w.city || undefined } : null)).catch(() => null);

/** "9:41 PM", or "THU 9:41 PM" when not today. */
export function fmtTime(ms: number, now: number): string {
  const d = new Date(ms), n = new Date(now);
  const hm = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === n.toDateString() ? hm : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
}

export class SkyService {
  readonly iss: IssTracker;
  private now: () => number;
  private fallbackPos: () => Promise<Here | null>;
  private seq = 0;
  private charts = new Map<string, string>();
  private nights = new Map<string, SkyTonight>();
  private passCache: { key: string; passes: IssPass[] } | null = null;

  constructor(o: SkyOptions = {}) {
    this.now = o.now ?? (() => Date.now());
    this.fallbackPos = o.fallbackPos ?? hubPos;
    this.iss = new IssTracker({
      fetcher: o.fetcher, now: this.now, log: o.log,
      file: o.tleFile === null ? undefined : o.tleFile ?? join(DATA_DIR, "sky", "iss-tle.txt"),
    });
  }

  /** Fetch the ISS elements in the background if they're missing or 12 h old. */
  start() {
    this.iss.current();
  }

  private async here(pos?: Pos | null): Promise<Here> {
    if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) return { lat: pos.lat, lon: pos.lon };
    const f = await this.fallbackPos();
    if (!f) throw new Error("no location yet");
    return f;
  }

  // ---------------- SKY NOW ----------------

  async skyNow(step = 0, pos?: Pos | null): Promise<SkyNow> {
    const p = await this.here(pos);
    step = Math.max(0, Math.min(24, Math.round(step)));
    const now = this.now(), t = now + step * HOUR, date = new Date(t);
    const sun = bodyAt("sun", date, p);
    const phase = skyPhase(sun.alt);
    const limit = LIMIT_MAG[phase];
    const moonPos = bodyAt("moon", date, p);
    const mi = moonInfo(date);
    const planets = PLANETS.map((id) => bodyAt(id, date, p));
    const rec = this.iss.current();
    const iss = rec ? issLook(rec, date, p) : null;
    const issUp = !!iss && iss.alt > 0;

    const stars = starsAt(date, p);
    const items: (SkyItem & { score: number })[] = [];
    if (moonPos.alt > 0) items.push({ name: "Moon", dir: compass(moonPos.az), alt: moonPos.alt, mag: moonPos.mag, kind: "moon", score: -20 });
    if (issUp) items.push({ name: "ISS", dir: compass(iss!.az), alt: iss!.alt, mag: -2, kind: "iss", score: -19 });
    for (const b of planets) if (b.alt > 2) items.push({ name: b.name, dir: compass(b.az), alt: b.alt, mag: b.mag, kind: "planet", score: b.mag });
    let hidden = 0;
    STARS.forEach((s, i) => {
      if (stars.alt[i] <= 0) return;
      if (phase === "day") {
        if (s.mag <= 1.5) hidden++;
        return;
      }
      if (s.name && s.mag <= limit && stars.alt[i] > 5) items.push({ name: s.name, dir: compass(stars.az[i]), alt: stars.alt[i], mag: s.mag, kind: "star", score: s.mag });
    });
    items.sort((a, b) => a.score - b.score);

    // the next Sun event that matters for stargazing
    const rising = bodyAt("sun", new Date(t + 10 * MIN), p).alt > sun.alt;
    let event: SkyEvent | undefined;
    const ev = (label: string, d: Date | null) => (d ? { label, at: d.getTime() } : undefined);
    if (phase === "day") event = ev("SET", riseSet("sun", p, -1, date));
    else if (!rising && phase !== "dark") event = ev("DARK", sunAltCross(p, -18, -1, date));
    else event = ev("RISE", riseSet("sun", p, 1, date));

    const moonUp = moonPos.alt > 0;
    const moonNext = ev(moonUp ? "SET" : "RISE", riseSet("moon", p, moonUp ? -1 : 1, date));

    // the image: redrawn every 5 minutes of sky time, every 30 s while the ISS is up
    const quant = issUp ? 30_000 : 5 * MIN;
    const key = [Math.floor(t / quant), p.lat.toFixed(2), p.lon.toFixed(2), step, issUp ? "iss" : ""].join("|");
    let px = this.charts.get(key);
    if (!px) {
      const bodies: ChartBody[] = [
        ...planets.map((b) => ({ id: b.id, alt: b.alt, az: b.az, mag: b.mag, label: SHORT[b.id] })),
        { id: "moon", alt: moonPos.alt, az: moonPos.az, mag: moonPos.mag },
        ...(issUp ? [{ id: "iss" as const, alt: iss!.alt, az: iss!.az, mag: -2, label: "ISS" }] : []),
      ];
      const r = renderSky({
        stars, limitMag: limit, bodies, moon: { phaseAngle: mi.phaseAngle }, sun: { alt: sun.alt, az: sun.az },
        corner: { tl: step ? `+${step}H` : "NOW", bl: `${Math.abs(Math.round(p.lat))}${p.lat >= 0 ? "N" : "S"}` },
      });
      px = toB64(pack4(r));
      if (this.charts.size > 48) this.charts.clear();
      this.charts.set(key, px);
    }

    // ask again sooner while the station crosses, or just before it rises
    let refreshMs = 5 * MIN;
    if (issUp) refreshMs = 30_000;
    else if (rec && step === 0) {
      const soon = this.passes(p).find((x) => x.start > now && x.start - now < 5 * MIN);
      if (soon) refreshMs = Math.max(10_000, soon.start - now);
    }
    return {
      at: t, step, px, phase, hidden: phase === "day" ? hidden : undefined, event,
      moon: { pct: Math.round(mi.frac * 100), waxing: mi.waxing, up: moonUp, next: moonNext },
      items: items.slice(0, 6).map(({ score, ...it }) => ({ ...it, alt: Math.round(it.alt), mag: Math.round(it.mag * 10) / 10 })),
      lat: p.lat, lon: p.lon, place: p.place, refreshMs, seq: ++this.seq,
    };
  }

  // ---------------- ISS ----------------

  /** All ISS passes above 10 degrees in the next 7 days (cached per hour and element set). */
  private passes(p: Pos): IssPass[] {
    const rec = this.iss.current();
    if (!rec) return [];
    const now = this.now();
    const key = [Math.floor(now / HOUR), p.lat.toFixed(2), p.lon.toFixed(2), this.iss.age() !== null ? Math.floor((now - this.iss.age()!) / 1000) : 0].join("|");
    if (this.passCache?.key !== key) this.passCache = { key, passes: issPasses(rec, Math.floor(now / HOUR) * HOUR, 7 * 24 + 1, p) };
    return this.passCache.passes.filter((x) => x.end > now);
  }

  private toPass = (x: IssPass): SkyPass => ({ start: x.start, end: x.end, startDir: x.startDir, endDir: x.endDir, maxAlt: Math.round(x.maxAlt), mag: x.mag, visible: x.visible });

  // ---------------- TONIGHT ----------------

  async tonight(pos?: Pos | null): Promise<SkyTonight> {
    const p = await this.here(pos);
    await this.iss.ready();
    const now = this.now(), date = new Date(now);
    const key = [Math.floor(now / (10 * MIN)), p.lat.toFixed(2), p.lon.toFixed(2), this.iss.age() === null ? "-" : "tle"].join("|");
    const hit = this.nights.get(key);
    if (hit) return hit;

    const sunNow = bodyAt("sun", date, p).alt;
    const night = sunNow < -0.833;
    const sunset = night ? undefined : riseSet("sun", p, -1, date)?.getTime();
    const from = night ? now : sunset ?? now;
    const sunrise = riseSet("sun", p, 1, new Date(from))?.getTime();
    const to = sunrise ?? from + 12 * HOUR;
    const dark = sunAltCross(p, -18, -1, date)?.getTime();
    const dawn = sunAltCross(p, -18, 1, new Date(from))?.getTime();

    const mi = moonInfo(new Date(from));
    const moon = {
      pct: Math.round(mi.frac * 100), waxing: mi.waxing, phase: mi.phaseName,
      // up at the start of the night: only when it sets; else when it rises, then sets
      rise: bodyAt("moon", new Date(from), p).alt > 0 ? undefined : riseSet("moon", p, 1, new Date(from))?.getTime(),
      set: riseSet("moon", p, -1, new Date(from))?.getTime(),
    };

    const planets: SkyPlanetNight[] = [];
    const days = (to - from) / 86_400_000 + 0.05;
    for (const id of PLANETS) {
      let best: { at: number; alt: number } | null = null;
      for (let t = from; t <= to; t += 10 * MIN) {
        const d = new Date(t);
        if (bodyAt("sun", d, p, false).alt > -6) continue; // too bright to see it then
        const a = bodyAt(id, d, p).alt;
        if (a > 5 && (!best || a > best.alt)) best = { at: t, alt: a };
      }
      if (!best) continue;
      const up = bodyAt(id, new Date(from), p).alt > 0;
      const rise = up ? undefined : riseSet(id, p, 1, new Date(from), days)?.getTime();
      const set = riseSet(id, p, -1, new Date(from), 1.2)?.getTime();
      planets.push({ name: BODY_NAME[id], mag: Math.round(bodyAt(id, new Date(best.at), p).mag * 10) / 10, up, rise, set, high: { at: best.at, alt: Math.round(best.alt) } });
    }
    planets.sort((a, b) => a.mag - b.mag);

    const all = this.passes(p).filter((x) => x.visible);
    let passes = all.filter((x) => x.start < to);
    if (!passes.length) passes = all.slice(0, 2);
    const age = this.iss.age();
    const issNote = age === null ? "ISS: NO ORBIT DATA YET" : !this.iss.current() ? "ISS: ORBIT DATA TOO OLD" : !all.length ? "ISS: NO VISIBLE PASS IN 7 DAYS" : undefined;

    const out: SkyTonight = {
      from, to, sunset, dark: dark && dark < to ? dark : undefined, dawn: dawn && dawn < to ? dawn : undefined, sunrise,
      moon, planets, passes: passes.slice(0, 4).map(this.toPass), issNote, showers: activeShowers(new Date(from)),
      lat: p.lat, lon: p.lon, place: p.place, seq: ++this.seq,
    };
    if (this.nights.size > 16) this.nights.clear();
    this.nights.set(key, out);
    return out;
  }

  /** sky_get from the glasses: answer with `sky` (or an error the screen can show). */
  async handle(send: (m: HubMsg) => void, view: SkyView, step = 0, pos?: Pos | null) {
    try {
      if (view === "tonight") send({ t: "sky", tonight: await this.tonight(pos) });
      else send({ t: "sky", now: await this.skyNow(step, pos) });
    } catch (e: any) {
      console.log(`[sky] ${e?.message ?? e}`);
      send({ t: "sky", error: String(e?.message ?? e).slice(0, 60) });
    }
  }

  // ---------------- voice ----------------

  /** What's up now, in a couple of sentences. */
  async summary(pos?: Pos | null): Promise<string> {
    const n = await this.skyNow(0, pos);
    const now = this.now();
    const parts: string[] = [];
    if (n.phase === "day") parts.push(`The Sun is up, so ${n.hidden ?? 0} bright stars are hidden${n.event ? `; sunset ${fmtTime(n.event.at, now)}` : ""}.`);
    else if (n.event?.label === "DARK") parts.push(`Twilight; fully dark at ${fmtTime(n.event.at, now)}.`);
    parts.push(`Moon ${n.moon.pct}% ${n.moon.waxing ? "waxing" : "waning"}${n.moon.next ? `, ${n.moon.next.label === "SET" ? "sets" : "rises"} ${fmtTime(n.moon.next.at, now)}` : ""}.`);
    const up = n.items.slice(0, 5).map((i) => `${i.name} ${i.dir} ${i.alt}°`);
    if (up.length) parts.push(`Up now: ${up.join(", ")}.`);
    const next = this.passes(n).find((x) => x.visible);
    if (next) parts.push(`Next visible ISS pass ${fmtTime(next.start, now)} from the ${next.startDir}.`);
    return parts.join(" ");
  }

  /** "where's Jupiter / Vega / Orion / the Moon / the ISS" */
  async find(query: string, pos?: Pos | null): Promise<string> {
    const p = await this.here(pos);
    const ALIAS: Record<string, string> = {
      "big dipper": "ursa major", plough: "ursa major", "great bear": "ursa major", "little dipper": "ursa minor",
      "north star": "polaris", "pole star": "polaris", "dog star": "sirius", "orions belt": "orion", "space station": "iss",
    };
    let q = query.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
    q = ALIAS[q] ?? q;
    const now = this.now(), date = new Date(now);
    const sunUp = bodyAt("sun", date, p).alt > -0.833;
    const daytime = sunUp ? " The Sun is up, so it may be hard to see." : "";
    if (/^(iss|space station|international space station)$/.test(q)) return this.issText(p);
    const ids = Object.entries(BODY_NAME) as [BodyId, string][];
    const body = ids.find(([, n]) => n.toLowerCase() === q)?.[0];
    if (body) {
      const b = bodyAt(body, date, p);
      if (b.alt > 0) {
        const set = riseSet(body, p, -1, date);
        return `${b.name} is in the ${compass(b.az)}, ${Math.round(b.alt)}° up${body !== "sun" && body !== "moon" ? ` (magnitude ${b.mag.toFixed(1)})` : ""}${set ? `; it sets at ${fmtTime(set.getTime(), now)}` : ""}.${body === "sun" ? "" : daytime}`;
      }
      const rise = riseSet(body, p, 1, date);
      if (!rise) return `${b.name} doesn't rise in the next day here.`;
      const ra = bodyAt(body, rise, p);
      return `${b.name} is below the horizon; it rises at ${fmtTime(rise.getTime(), now)} in the ${compass(ra.az)}.`;
    }
    const stars = starsAt(date, p);
    const si = STARS.findIndex((s) => s.name?.toLowerCase() === q);
    if (si >= 0) {
      const s = STARS[si], alt = stars.alt[si], az = stars.az[si];
      return alt > 0 ? `${s.name} is in the ${compass(az)}, ${Math.round(alt)}° up (magnitude ${s.mag.toFixed(1)}).${daytime}` : `${s.name} is below the horizon right now.`;
    }
    const fig = FIGURE_SEGMENTS.find((f) => f.name.toLowerCase() === q || f.con.toLowerCase() === q);
    if (fig) {
      const idx = [...new Set(fig.segs.flat())];
      let x = 0, y = 0, z = 0;
      for (const i of idx) {
        const a = (stars.alt[i] * Math.PI) / 180, b = (stars.az[i] * Math.PI) / 180;
        x += Math.cos(a) * Math.cos(b);
        y += Math.cos(a) * Math.sin(b);
        z += Math.sin(a);
      }
      const alt = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI, az = (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
      return alt > 0 ? `${fig.name} is in the ${compass(az)}, about ${Math.round(alt)}° up.${daytime}` : `${fig.name} is below the horizon right now.`;
    }
    return `I don't know "${query}". Try a planet, the Moon, a bright star, a constellation or the ISS.`;
  }

  /** The next visible ISS passes, in words. */
  async issText(pos?: Pos | null): Promise<string> {
    const p = await this.here(pos);
    const rec = await this.iss.ready();
    if (!rec) return "I don't have the ISS orbit yet (CelesTrak didn't answer).";
    const now = this.now();
    const l = issLook(rec, new Date(now), p);
    const lead = l && l.alt > 0 ? `The ISS is up now in the ${compass(l.az)}, ${Math.round(l.alt)}° high${l.sunlit && bodyAt("sun", new Date(now), p).alt < -6 ? " and lit" : ""}. ` : "";
    const vis = this.passes(p).filter((x) => x.visible).slice(0, 3);
    if (!vis.length) return `${lead}No visible ISS passes in the next 7 days here.`;
    const say = (x: IssPass) => `${fmtTime(x.start, now)}, ${Math.max(1, Math.round((x.end - x.start) / MIN))} min, ${x.startDir} to ${x.endDir}, up to ${Math.round(x.maxAlt)}°${x.mag <= -2.5 ? ", very bright" : ""}`;
    return `${lead}Next visible ISS pass: ${say(vis[0])}.${vis.length > 1 ? ` Then ${vis.slice(1).map(say).join("; ")}.` : ""}`;
  }
}

export const sky = new SkyService();

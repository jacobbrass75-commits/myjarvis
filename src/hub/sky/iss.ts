import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as A from "astronomy-engine";
import { eciToEcf, ecfToLookAngles, gstime, propagate, twoline2satrec, type SatRec } from "satellite.js";
import { compass, type Pos } from "./astro.js";

// The International Space Station: its two-line elements from CelesTrak (free, no key; their guidance
// is to fetch a given set at most every couple of hours, we keep it 12 h and on disk across restarts),
// propagated with SGP4 (satellite.js, MIT). A pass counts from when it clears 10 degrees; it is
// visible when the station is in sunlight while the observer's sky is dark (Sun below -6 degrees).

export const TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE";
const TTL = 12 * 3_600_000;
const RETRY = 30 * 60_000;
/** Older than this the elements are too far off (minutes of timing error) to show at all. */
const TOO_OLD = 14 * 86_400_000;
const MIN_ALT = 10;
const RE = 6378.137;
const DEG = Math.PI / 180;

export interface Tle { l1: string; l2: string; at: number }

export interface IssLook { alt: number; az: number; range: number; sunlit: boolean }

export interface IssPass {
  start: number; end: number; maxAt: number; maxAlt: number;
  startAz: number; endAz: number; startDir: string; endDir: string;
  /** Estimated magnitude at its brightest visible moment. */
  mag: number;
  /** Seen against a dark sky in sunlight for part of it; start/end are then that part. */
  visible: boolean;
}

/** TLE text (an optional name line, then lines 1 and 2) for the ISS, checked; null if it isn't one. */
export function parseTle(text: string, at: number): Tle | null {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const l1 = lines.find((l) => l.startsWith("1 25544")), l2 = lines.find((l) => l.startsWith("2 25544"));
  if (!l1 || !l2 || l1.length < 69 || l2.length < 69) return null;
  const sum = (l: string) => [...l.slice(0, 68)].reduce((n, c) => n + (c === "-" ? 1 : /\d/.test(c) ? Number(c) : 0), 0) % 10;
  if (sum(l1) !== Number(l1[68]) || sum(l2) !== Number(l2[68])) return null;
  return { l1, l2, at };
}

/** The TLE's epoch (ms). */
export function tleEpoch(l1: string): number {
  const yy = Number(l1.slice(18, 20)), day = Number(l1.slice(20, 32));
  return Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) + (day - 1) * 86_400_000;
}

/** Sun direction (unit vector, equatorial J2000 ~ TEME to a fraction of a degree) at `date`. */
function sunDir(date: Date): [number, number, number] {
  const v = A.GeoVector(A.Body.Sun, date, false);
  const n = Math.hypot(v.x, v.y, v.z);
  return [v.x / n, v.y / n, v.z / n];
}

/** Where the station is in your sky, and whether the Sun lights it (cylindrical Earth shadow). */
export function issLook(rec: SatRec, date: Date, p: Pos): IssLook | null {
  const pv = propagate(rec, date);
  const r = pv?.position;
  if (!r || typeof r === "boolean") return null;
  const gm = gstime(date);
  const look = ecfToLookAngles({ latitude: p.lat * DEG, longitude: p.lon * DEG, height: 0 } as any, eciToEcf(r, gm));
  const u = sunDir(date);
  const along = r.x * u[0] + r.y * u[1] + r.z * u[2];
  const perp = Math.hypot(r.x - along * u[0], r.y - along * u[1], r.z - along * u[2]);
  return { alt: look.elevation / DEG, az: (((look.azimuth / DEG) % 360) + 360) % 360, range: look.rangeSat, sunlit: along > 0 || perp > RE };
}

/** Rough visual magnitude: intrinsic -1.3 at 1000 km and 90 degrees phase, diffuse-sphere phase law. */
export function issMag(rec: SatRec, date: Date, p: Pos): number {
  const pv = propagate(rec, date);
  const r = pv?.position;
  if (!r || typeof r === "boolean") return 0;
  const look = issLook(rec, date, p)!;
  // observer position in the same frame: rotate its Earth-fixed position by GMST
  const gm = gstime(date), lat = p.lat * DEG, lon = p.lon * DEG + gm;
  const o = [RE * Math.cos(lat) * Math.cos(lon), RE * Math.cos(lat) * Math.sin(lon), RE * Math.sin(lat)];
  const toObs = [o[0] - r.x, o[1] - r.y, o[2] - r.z], n = Math.hypot(...toObs);
  const u = sunDir(date);
  const phase = Math.acos(Math.max(-1, Math.min(1, (toObs[0] * u[0] + toObs[1] * u[1] + toObs[2] * u[2]) / n)));
  const f = (Math.sin(phase) + (Math.PI - phase) * Math.cos(phase)) / Math.PI;
  return Math.max(-4, -1.3 + 5 * Math.log10(look.range / 1000) - 2.5 * Math.log10(Math.max(1e-3, f * Math.PI)));
}

const sunAlt = (date: Date, p: Pos) => {
  const o = new A.Observer(p.lat, p.lon, 0);
  const eq = A.Equator(A.Body.Sun, date, o, true, true);
  return A.Horizon(date, o, eq.ra, eq.dec).altitude;
};

/** Passes above 10 degrees from `from` for `hours` (30 s scan, edges refined to a second). */
export function issPasses(rec: SatRec, from: number, hours: number, p: Pos): IssPass[] {
  const alt = (t: number) => issLook(rec, new Date(t), p)?.alt ?? -90;
  const edge = (a: number, b: number) => {
    // a below MIN_ALT, b above (or the reverse): bisect to 1 s
    const up = alt(a) < MIN_ALT;
    while (b - a > 1000) {
      const m = (a + b) / 2;
      if (alt(m) < MIN_ALT === up) a = m;
      else b = m;
    }
    return Math.round((a + b) / 2);
  };
  const out: IssPass[] = [];
  const STEP = 30_000, end = from + hours * 3_600_000;
  let prev = alt(from), riseAt = prev >= MIN_ALT ? from : 0;
  for (let t = from + STEP; t <= end + 15 * 60_000; t += STEP) {
    const a = alt(t);
    if (prev < MIN_ALT && a >= MIN_ALT && t <= end) riseAt = edge(t - STEP, t);
    if (prev >= MIN_ALT && a < MIN_ALT && riseAt) {
      const setAt = edge(t - STEP, t);
      out.push(describe(rec, riseAt, setAt, p));
      riseAt = 0;
    }
    prev = a;
  }
  return out;
}

function describe(rec: SatRec, rise: number, set: number, p: Pos): IssPass {
  let maxAt = rise, maxAlt = -90, visAt = 0, visAlt = -90;
  let vis0 = 0, vis1 = 0, bestMag = 9;
  // the Sun moves little in a pass: its altitude at the middle decides how dark the sky is
  const dark = sunAlt(new Date((rise + set) / 2), p) < -6;
  for (let t = rise; t <= set; t += 5000) {
    const l = issLook(rec, new Date(t), p);
    if (!l) continue;
    if (l.alt > maxAlt) [maxAlt, maxAt] = [l.alt, t];
    if (dark && l.sunlit) {
      if (!vis0) vis0 = t;
      vis1 = t;
      if (l.alt > visAlt) [visAlt, visAt] = [l.alt, t];
      bestMag = Math.min(bestMag, issMag(rec, new Date(t), p));
    }
  }
  const visible = vis0 > 0 && vis1 > vis0;
  // a visible pass is described by its visible part (it may come out of the shadow after culminating)
  if (visible) [maxAlt, maxAt] = [visAlt, visAt];
  const start = visible ? vis0 : rise, end = visible ? vis1 : set;
  const startAz = issLook(rec, new Date(start), p)?.az ?? 0, endAz = issLook(rec, new Date(end), p)?.az ?? 0;
  return {
    start, end, maxAt, maxAlt, startAz, endAz, startDir: compass(startAz), endDir: compass(endAz),
    mag: visible ? Math.round(bestMag * 10) / 10 : issMag(rec, new Date(maxAt), p), visible,
  };
}

export interface IssOptions { fetcher?: typeof fetch; now?: () => number; file?: string; log?: (s: string) => void }

/** Keeps the ISS elements fresh (memory + disk) and answers looks and passes. */
export class IssTracker {
  private tle: Tle | null = null;
  private rec: SatRec | null = null;
  private inflight: Promise<void> | null = null;
  private retryAt = 0;
  private fetcher: typeof fetch;
  private now: () => number;
  private file?: string;
  private log: (s: string) => void;

  constructor(o: IssOptions = {}) {
    this.fetcher = o.fetcher ?? ((...a) => fetch(...a));
    this.now = o.now ?? (() => Date.now());
    this.file = o.file;
    this.log = o.log ?? ((s) => console.log(`[sky] ${s}`));
    if (this.file) {
      try {
        const [at, ...rest] = readFileSync(this.file, "utf8").split("\n");
        const t = parseTle(rest.join("\n"), Number(at));
        if (t) this.use(t);
      } catch {}
    }
  }

  /** Use these elements (tests, or a fresh download). */
  use(t: Tle) {
    this.tle = t;
    this.rec = twoline2satrec(t.l1, t.l2);
  }

  /** The SGP4 record if the elements are usable; starts a download when they are 12 h old (never waits). */
  current(): SatRec | null {
    this.refresh();
    if (!this.tle || this.now() - tleEpoch(this.tle.l1) > TOO_OLD) return null;
    return this.rec;
  }

  /** Waits up to `ms` for a download when there are no elements yet. */
  async ready(ms = 8000): Promise<SatRec | null> {
    this.refresh();
    if (!this.current() && this.inflight) await Promise.race([this.inflight, new Promise((r) => setTimeout(r, ms))]);
    return this.current();
  }

  /** How old the elements are (ms since their epoch), or null. */
  age(): number | null {
    return this.tle ? this.now() - tleEpoch(this.tle.l1) : null;
  }

  private refresh() {
    const now = this.now();
    if (this.inflight || now < this.retryAt || (this.tle && now - this.tle.at < TTL)) return;
    this.inflight = this.download()
      .catch((e) => {
        this.retryAt = this.now() + RETRY;
        this.log(`ISS elements: ${e?.message ?? e}${this.tle ? " (keeping the last ones)" : ""}`);
      })
      .finally(() => (this.inflight = null));
  }

  private async download() {
    const r = await this.fetcher(TLE_URL, { headers: { "User-Agent": "g2-orchestrator/0.1 (personal smart-glasses sky chart)" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`celestrak ${r.status}`);
    const t = parseTle(await r.text(), this.now());
    if (!t) throw new Error("celestrak: not an ISS TLE");
    this.use(t);
    this.log(`ISS elements from CelesTrak, epoch ${new Date(tleEpoch(t.l1)).toISOString().slice(0, 16)}Z`);
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, `${t.at}\n${t.l1}\n${t.l2}\n`);
      } catch {}
    }
  }
}

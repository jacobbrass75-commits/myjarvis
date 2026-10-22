import * as A from "astronomy-engine";
import { CATALOG } from "./catalog.js";
import { FIGURES, STAR_NAMES } from "./figures.js";

// The sky for one place and time, offline: Sun, Moon and the naked-eye planets from astronomy-engine
// (MIT, Don Cross: VSOP87/ELP-based, about an arcminute), the bundled bright stars (Yale BSC5) turned
// into altitude/azimuth with one precession+nutation+Earth-rotation matrix per instant, twilight,
// rise/set, the Moon's phase, sidereal time and the annual meteor showers.

export type Pos = { lat: number; lon: number };
export type BodyId = "sun" | "moon" | "mercury" | "venus" | "mars" | "jupiter" | "saturn";

export interface Star { ra: number; dec: number; mag: number; key: string; name?: string }

const BAYER_NAME = (key: string) => key.replace(/\d(?= )/, "");

const named = new Set<string>();
export const STARS: Star[] = CATALOG.trim().split("\n").map((line) => {
  const [ra, dec, mag, key = ""] = line.split(" ");
  const k = key.replace("_", " ");
  const s: Star = { ra: Number(ra), dec: Number(dec), mag: Number(mag), key: k };
  const name = k ? STAR_NAMES[k] ?? STAR_NAMES[BAYER_NAME(k)] : undefined;
  // a name given without the component digit goes to the brightest component only (sorted brightest first)
  if (name && !named.has(name)) {
    s.name = name;
    named.add(name);
  }
  return s;
});

/** Index into STARS of a Bayer star ("alp", "Cen"); a bare letter means the brightest component. */
export function starIndex(bayer: string, con: string): number {
  const exact = STARS.findIndex((s) => s.key === `${bayer} ${con}`);
  if (exact >= 0) return exact;
  return STARS.findIndex((s) => s.key && BAYER_NAME(s.key) === `${bayer} ${con}`); // brightest first
}

/** Constellation figure segments as star index pairs, per constellation. */
export const FIGURE_SEGMENTS: { con: string; name: string; segs: [number, number][] }[] = Object.entries(FIGURES).map(([con, f]) => {
  const segs: [number, number][] = [];
  for (const chain of f.lines.split(" ")) {
    const idx = chain.split("-").map((tok) => {
      const [b, c] = tok.split(".");
      const i = starIndex(b, c ?? con);
      if (i < 0) throw new Error(`sky: figure star ${tok} (${con}) is not in the catalogue`);
      return i;
    });
    for (let k = 1; k < idx.length; k++) segs.push([idx[k - 1], idx[k]]);
  }
  return { con, name: f.name, segs };
});

// ---------------- time ----------------

const DEG = Math.PI / 180;
const norm360 = (x: number) => ((x % 360) + 360) % 360;

/** Greenwich mean sidereal time in hours (IAU 1982, Meeus 12.4), UT1 taken as UTC. */
export function gmst(date: Date): number {
  const jd = date.getTime() / 86_400_000 + 2440587.5;
  const t = (jd - 2451545.0) / 36525;
  const deg = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - (t * t * t) / 38710000;
  return norm360(deg) / 15;
}

/** Local apparent sidereal time in hours (GAST from astronomy-engine plus the longitude). */
export const lst = (date: Date, lon: number) => (((A.SiderealTime(date) + lon / 15) % 24) + 24) % 24;

// ---------------- directions ----------------

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** 8-point compass direction of an azimuth (degrees from north, east = 90). */
export const compass = (az: number) => POINTS[Math.round(norm360(az) / 45) % 8];

// ---------------- bodies ----------------

const BODY: Record<BodyId, A.Body> = {
  sun: A.Body.Sun, moon: A.Body.Moon, mercury: A.Body.Mercury, venus: A.Body.Venus, mars: A.Body.Mars, jupiter: A.Body.Jupiter, saturn: A.Body.Saturn,
};
export const PLANETS: BodyId[] = ["mercury", "venus", "mars", "jupiter", "saturn"];
export const BODY_NAME: Record<BodyId, string> = { sun: "Sun", moon: "Moon", mercury: "Mercury", venus: "Venus", mars: "Mars", jupiter: "Jupiter", saturn: "Saturn" };

export interface BodyPos { id: BodyId; name: string; alt: number; az: number; mag: number; ra: number; dec: number }

const observer = (p: Pos) => new A.Observer(p.lat, p.lon, 0);

/** Apparent altitude (with refraction unless refraction=false) and azimuth of a body. */
export function bodyAt(id: BodyId, date: Date, p: Pos, refraction = true): BodyPos {
  const o = observer(p);
  const eq = A.Equator(BODY[id], date, o, true, true);
  const h = A.Horizon(date, o, eq.ra, eq.dec, refraction ? "normal" : undefined);
  const mag = id === "sun" ? -26.7 : A.Illumination(BODY[id], date).mag;
  return { id, name: BODY_NAME[id], alt: h.altitude, az: h.azimuth, mag, ra: eq.ra, dec: eq.dec };
}

/** Altitude/azimuth of a J2000 RA (hours) / Dec, as horizon() does it for the catalogue. */
export function radecAt(raH: number, dec: number, date: Date, p: Pos, refraction = true): { alt: number; az: number } {
  const t = A.MakeTime(date);
  const v = A.RotateVector(A.Rotation_EQJ_HOR(t, observer(p)), A.VectorFromSphere(new A.Spherical(dec, raH * 15, 1), t));
  const h = A.HorizonFromVector(v, refraction ? "normal" : (undefined as any));
  return { alt: h.lat, az: h.lon };
}

/** Every catalogue star's altitude and azimuth (degrees), in STARS order. */
export function starsAt(date: Date, p: Pos): { alt: Float32Array; az: Float32Array } {
  const t = A.MakeTime(date);
  const m = A.Rotation_EQJ_HOR(t, observer(p)).rot;
  const alt = new Float32Array(STARS.length), az = new Float32Array(STARS.length);
  for (let i = 0; i < STARS.length; i++) {
    const s = STARS[i];
    const cd = Math.cos(s.dec * DEG), x = cd * Math.cos(s.ra * DEG), y = cd * Math.sin(s.ra * DEG), z = Math.sin(s.dec * DEG);
    // astronomy-engine's matrices are column-major: v'[i] = sum_j rot[j][i] v[j]; HOR x = north, y = west, z = up
    const hx = m[0][0] * x + m[1][0] * y + m[2][0] * z;
    const hy = m[0][1] * x + m[1][1] * y + m[2][1] * z;
    const hz = m[0][2] * x + m[1][2] * y + m[2][2] * z;
    const a = Math.asin(Math.max(-1, Math.min(1, hz))) / DEG;
    alt[i] = a + (a > -1 ? A.Refraction("normal", a) : 0);
    az[i] = norm360(-Math.atan2(hy, hx) / DEG);
  }
  return { alt, az };
}

// ---------------- Moon ----------------

export interface MoonInfo {
  /** Illuminated fraction 0..1. */
  frac: number;
  /** Phase angle Sun-Moon-Earth (degrees; 0 = full, 180 = new). */
  phaseAngle: number;
  /** Ecliptic elongation from the Sun, 0..360 (0 new, 90 first quarter, 180 full, 270 last quarter). */
  elong: number;
  waxing: boolean;
  phaseName: string;
}

export function moonInfo(date: Date): MoonInfo {
  const elong = A.MoonPhase(date);
  const ill = A.Illumination(A.Body.Moon, date);
  const waxing = elong < 180;
  const names: [number, string][] = [[11.25, "NEW"], [78.75, "WAX CRES"], [101.25, "1ST QTR"], [168.75, "WAX GIBB"], [191.25, "FULL"], [258.75, "WAN GIBB"], [281.25, "3RD QTR"], [348.75, "WAN CRES"], [360, "NEW"]];
  const phaseName = names.find(([lim]) => elong < lim)![1];
  return { frac: ill.phase_fraction, phaseAngle: ill.phase_angle, elong, waxing, phaseName };
}

// ---------------- events ----------------

/** Next rise (dir +1) or set (-1) of a body after `from`, within `days`; null if none. */
export function riseSet(id: BodyId, p: Pos, dir: 1 | -1, from: Date, days = 1.2): Date | null {
  return A.SearchRiseSet(BODY[id], observer(p), dir, from, days)?.date ?? null;
}

/** Next time the Sun's centre crosses `alt` going down (dir -1) or up (+1). */
export function sunAltCross(p: Pos, alt: number, dir: 1 | -1, from: Date, days = 1.2): Date | null {
  return A.SearchAltitude(A.Body.Sun, observer(p), dir, from, days, alt)?.date ?? null;
}

export type SkyPhase = "day" | "civil" | "nautical" | "astro" | "dark";

/** How dark it is from the Sun's altitude. */
export function skyPhase(sunAlt: number): SkyPhase {
  return sunAlt > -0.833 ? "day" : sunAlt > -6 ? "civil" : sunAlt > -12 ? "nautical" : sunAlt > -18 ? "astro" : "dark";
}

/** Faintest star drawn for that much darkness (the catalogue stops at 4.5). */
export const LIMIT_MAG: Record<SkyPhase, number> = { day: -9, civil: 1.0, nautical: 3.0, astro: 4.0, dark: 4.5 };

// ---------------- meteor showers ----------------

/** Annual showers (IMO working list: activity window, peak, zenithal hourly rate). Month 1..12. */
export const SHOWERS: { name: string; from: [number, number]; to: [number, number]; peak: [number, number]; zhr: number }[] = [
  { name: "Quadrantids", from: [12, 28], to: [1, 12], peak: [1, 3], zhr: 110 },
  { name: "Lyrids", from: [4, 14], to: [4, 30], peak: [4, 22], zhr: 18 },
  { name: "Eta Aquariids", from: [4, 19], to: [5, 28], peak: [5, 6], zhr: 50 },
  { name: "S Delta Aquariids", from: [7, 12], to: [8, 23], peak: [7, 30], zhr: 25 },
  { name: "Alpha Capricornids", from: [7, 3], to: [8, 15], peak: [7, 30], zhr: 5 },
  { name: "Perseids", from: [7, 17], to: [8, 24], peak: [8, 12], zhr: 100 },
  { name: "Draconids", from: [10, 6], to: [10, 10], peak: [10, 8], zhr: 10 },
  { name: "Orionids", from: [10, 2], to: [11, 7], peak: [10, 21], zhr: 20 },
  { name: "S Taurids", from: [9, 10], to: [11, 20], peak: [10, 10], zhr: 5 },
  { name: "N Taurids", from: [10, 20], to: [12, 10], peak: [11, 12], zhr: 5 },
  { name: "Leonids", from: [11, 6], to: [11, 30], peak: [11, 17], zhr: 15 },
  { name: "Geminids", from: [12, 4], to: [12, 20], peak: [12, 14], zhr: 150 },
  { name: "Ursids", from: [12, 17], to: [12, 26], peak: [12, 22], zhr: 10 },
];

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Showers active on the local date of `d`, strongest first; atPeak within a day of the peak. */
export function activeShowers(d: Date): { name: string; peak: string; zhr: number; atPeak: boolean }[] {
  const doy = (m: number, day: number) => (m - 1) * 31 + day; // monotonic stand-in for day of year
  const today = doy(d.getMonth() + 1, d.getDate());
  const inRange = (a: number, b: number) => (a <= b ? today >= a && today <= b : today >= a || today <= b);
  return SHOWERS.filter((s) => inRange(doy(...s.from), doy(...s.to)))
    .map((s) => {
      const p = doy(...s.peak);
      const dist = Math.min(Math.abs(today - p), 372 - Math.abs(today - p));
      return { name: s.name, peak: `${MONTHS[s.peak[0] - 1]} ${s.peak[1]}`, zhr: s.zhr, atPeak: dist <= 1 };
    })
    .sort((a, b) => Number(b.atPeak) - Number(a.atPeak) || b.zhr - a.zhr);
}

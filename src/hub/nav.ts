import type { Maneuver, NavMap, NavState, NavTransit, NavView } from "../shared/protocol.js";
import { pack4, toB64 } from "../shared/raster.js";
import { where } from "./dashboard.js";
import { angleDiff, bearing, cumulative, haversine, pointAlong, snapToLine, type Pos } from "./map/geo.js";
import { GoogleBase } from "./map/google.js";
import { OsmBase } from "./map/osm.js";
import { describePlaces, googleKey, parsePlaceQuery, Places, type Place, type PlaceResult } from "./map/places.js";
import { renderNavMap, FULL_W, MAP_W, type MapView } from "./map/render.js";
import { GoogleRoutes, osrmRoute, type Planned, type PlannedStep, type Profile } from "./map/routes.js";

// Turn-by-turn navigation. Places: Google Places (New) when GOOGLE_MAPS_API_KEY is set, else Nominatim
// (OpenStreetMap). Routes: OSRM for walking and cycling; Google Routes for driving (live traffic) and
// public transit when there's a key, OSRM driving otherwise. Location comes from the phone (glasses app
// or phone page) as it moves. The hub also draws the Navigate map (map/render.ts) for the view the
// glasses show (288x288 beside the readout, or the whole lens) and sends it only when it changed enough.

export type { Pos };
export { maneuverOf } from "./map/routes.js";

const UA = { "User-Agent": "g2-orchestrator/0.1 (personal smart-glasses navigation)" };

/** Within this many metres of the route line you're on it (snapped); further out you're off route. */
const SNAP_M = 30;
/** Once on the route, look this far ahead of where you were first, so a later leg passing close by
 *  (out-and-back, a loop round a block) can't swallow the turns in between. */
const SNAP_AHEAD_M = 120;

interface Step extends PlannedStep {
  /** Metres along the route line to this maneuver. */
  along: number;
}

export const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

// ---------------- map zoom and redraw policy ----------------

/** Metres per pixel by profile: walk/bike by distance to the next turn, drive (and riding transit) by speed (km/h). */
const ZOOM: Record<string, { by: "turn" | "speed"; thr: number[]; mpp: number[] }> = {
  walk: { by: "turn", thr: [60, 180], mpp: [0.5, 1, 2] },
  bike: { by: "turn", thr: [120, 360], mpp: [1, 2, 4] },
  drive: { by: "speed", thr: [30, 70], mpp: [2, 4, 8] },
};

/** The zoom steps a swipe moves through (metres per pixel, closest first). */
export const ZOOM_LEVELS = [0.5, 1, 2, 4, 8, 16];
/** A swipe's zoom holds this long after the last swipe, then automatic zoom takes over again. */
export const MANUAL_ZOOM_MS = 20_000;

/** Zoom step for value x, moving off the current step only 20% past a threshold. */
export function zoomStep(cur: number, x: number, thr: number[]): number {
  const plain = thr.filter((t) => x >= t).length;
  if (cur < 0 || plain === cur) return plain;
  let n = cur;
  if (plain > cur) while (n < thr.length && x >= thr[n] * 1.2) n++;
  else while (n > 0 && x < thr[n - 1] * 0.8) n--;
  return n;
}

/** Manual zoom: one swipe in (smaller m/px) or out from `mpp`, within ZOOM_LEVELS. */
export function zoomFrom(mpp: number, dir: "in" | "out"): number {
  let i = 0;
  for (let j = 1; j < ZOOM_LEVELS.length; j++) if (Math.abs(Math.log(ZOOM_LEVELS[j] / mpp)) < Math.abs(Math.log(ZOOM_LEVELS[i] / mpp))) i = j;
  return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i + (dir === "in" ? -1 : 1)))];
}

/** Swipe zoom with a hold: manual for MANUAL_ZOOM_MS after the last swipe, then automatic. */
export class ZoomState {
  manual: { mpp: number; until: number } | null = null;

  /** The scale to draw: the swipe's while it holds, else `auto`. */
  mpp(auto: number, now: number): number {
    if (this.manual && now >= this.manual.until) this.manual = null;
    return this.manual?.mpp ?? auto;
  }

  isManual(now: number) {
    return !!this.manual && now < this.manual.until;
  }

  swipe(dir: "in" | "out", auto: number, now: number): number {
    const mpp = zoomFrom(this.mpp(auto, now), dir);
    this.manual = { mpp, until: now + MANUAL_ZOOM_MS };
    return mpp;
  }

  reset() {
    this.manual = null;
  }
}

export interface MapKey {
  pos: Pos;
  /** The fix's accuracy (metres), so a wobbling fix doesn't redraw the map in place. */
  acc?: number;
  bearing: number;
  idx: number;
  mpp: number;
  arrived: boolean;
  /** Map width (288, or 576 for the full-map view). */
  w?: number;
}

/**
 * When to redraw: moved > 8 m (or more than the fix's accuracy, up to 25 m), turned >= 15 degrees, a new
 * step, a new zoom, a new view size or arrival; never more than once per 2 s (each 288x288 map is two
 * image pushes over Bluetooth; the full map, four, waits 3 s).
 */
export class MapPolicy {
  last: MapKey | null = null;
  lastAt = -Infinity;
  private forced = false;
  constructor(readonly gapMs = 2000) {}

  /** Milliseconds until a redraw may go (0 = now), or null when nothing changed enough. */
  due(k: MapKey, now: number, gapMs = this.gapMs): number | null {
    const l = this.last;
    const moved = Math.max(8, Math.min(25, k.acc ?? 0));
    const changed = this.forced || !l || haversine(l.pos, k.pos) > moved || angleDiff(l.bearing, k.bearing) >= 15 || l.idx !== k.idx || l.mpp !== k.mpp || (l.w ?? MAP_W) !== (k.w ?? MAP_W) || (k.arrived && !l.arrived);
    if (!changed) return null;
    return Math.max(0, this.lastAt + gapMs - now);
  }

  drawn(k: MapKey, now: number) {
    this.last = k;
    this.lastAt = now;
    this.forced = false;
  }

  /** Redraw next time even if nothing moved (new base-map data). */
  force() {
    this.forced = true;
  }

  /** Redraw now, gap or not (the wearer swiped or switched views and is waiting for it). */
  urgent() {
    this.forced = true;
    this.lastAt = -Infinity;
  }

  reset() {
    this.last = null;
    this.lastAt = -Infinity;
    this.forced = false;
  }
}

// ---------------- navigator ----------------

export interface NavOptions {
  google?: GoogleBase;
  osm?: OsmBase;
  fetcher?: typeof fetch;
  /** The Google Maps Platform key (Places, Routes); default GOOGLE_MAPS_API_KEY, read when used. */
  key?: () => string;
  log?: (s: string) => void;
}

export interface StartOptions {
  /** Transit: only buses, or only trains/metro/tram. */
  prefer?: "bus" | "train";
}

const PROFILES = new Set<string>(["walk", "bike", "drive", "transit"]);
const BY: Record<string, string> = { drive: "driving", bike: "by bike", walk: "walking", transit: "by transit" };

export class Navigator {
  pos: Pos | null = null;
  /** The position came from the phone's GPS (false: the hub's IP-based city guess). */
  gps = false;
  /** Direction of travel from fixes at least 10 m apart (degrees), if known. */
  heading: number | null = null;
  /** Accuracy of the last fix, metres (0 = unknown). */
  private acc = 0;
  /** Last state and map sent, for a glasses page that reconnects mid-route. */
  private lastState: NavState | null = null;
  private lastMap: NavMap | null = null;
  /** Route segment you were last snapped to (-1 before the first). */
  snapIdx = -1;
  route: Pos[] = [];
  private cum: number[] = [];
  private along = 0;
  private onRoute = false;
  private snapped: Pos | null = null;
  private steps: Step[] = [];
  private idx = 0;
  private dest = "";
  private destPos: Pos = { lat: 0, lon: 0 };
  profile: Profile = "walk";
  private total = 0;
  private duration = 0;
  private trafficS = 0;
  private legs: string[] | undefined;
  private startedAt = 0;
  private arrived = false;
  active = false;
  /** The last place search ("find ramen"), so "take me to the second one" / its name needs no new search. */
  lastPlaces: Place[] = [];
  private lastPlacesAt = 0;
  // movement
  private headingFrom: Pos | null = null;
  private lastFix: { pos: Pos; at: number } | null = null;
  private speed = 0;
  // map
  /** What the glasses show: the map beside the readout, the full map, or no map (ESO, another screen). */
  shown: NavView = "map";
  readonly zoom = new ZoomState();
  private zoomTimer: ReturnType<typeof setTimeout> | undefined;
  private zoomIdx = -1;
  private lastBearing = 0;
  private policy = new MapPolicy();
  private seq = 0;
  private drawing = false;
  private again = false;
  private mapTimer: ReturnType<typeof setTimeout> | undefined;
  private google: GoogleBase;
  private osm: OsmBase;
  private fetcher: typeof fetch;
  private places: Places;
  private routes: GoogleRoutes;
  private log: (s: string) => void;

  constructor(
    private emit: (n: NavState | null) => void,
    private emitMap?: (m: NavMap | null) => void,
    o: NavOptions = {},
  ) {
    this.fetcher = o.fetcher ?? ((...a) => fetch(...a));
    this.log = o.log ?? console.log;
    const key = o.key ?? googleKey;
    this.google = o.google ?? new GoogleBase(undefined, this.fetcher);
    this.google.onData = () => {
      this.policy.force();
      this.scheduleMap();
    };
    this.osm = o.osm ?? new OsmBase(() => {
      this.policy.force();
      this.scheduleMap();
    }, UA, this.fetcher);
    this.places = new Places(key, this.fetcher, this.log);
    this.routes = new GoogleRoutes(key, this.fetcher, this.log);
  }

  /** Where searches start from: the phone's GPS, else the Mac's approximate (city-level) location. */
  private async here(): Promise<Pos | null> {
    if (!this.pos) {
      const w = await where().catch(() => null);
      if (w) this.pos = { lat: w.lat, lon: w.lon };
      this.gps = false;
    }
    return this.pos;
  }

  /** Places near you for the voice router ("best ramen open now"), one line each; kept for start(). */
  async find(query: string, o: { openNow?: boolean; sort?: "distance" | "best"; limit?: number } = {}): Promise<string> {
    const here = await this.here();
    if (!here) return "I don't know where you are yet. Share location from the phone page.";
    const p = parsePlaceQuery(query);
    const r = await this.places.search({ query: p.query, near: here, openNow: o.openNow ?? p.openNow, sort: o.sort ?? p.sort, limit: o.limit ?? 5 });
    this.lastPlaces = r.places;
    this.lastPlacesAt = Date.now();
    return describePlaces(r, o.limit ?? 5) + (this.gps ? "" : "\n(Distances from a city-level location: no phone GPS yet.)");
  }

  /** A place from the last search (within 15 min) by its number or name ("2", "the second one", "Ramen Tatsu-ya"). */
  private remembered(q: string): Place | undefined {
    if (Date.now() - this.lastPlacesAt > 15 * 60_000) return undefined;
    const s = q.trim().toLowerCase().replace(/^(the )?/, "");
    const n = /^(?:number |#)?(\d)(?:st|nd|rd|th)?( one)?$/.exec(s);
    if (n) return this.lastPlaces[+n[1] - 1];
    const ord = ["first", "second", "third", "fourth", "fifth"].findIndex((w) => s === w || s === `${w} one`);
    if (ord >= 0) return this.lastPlaces[ord];
    return this.lastPlaces.find((p) => p.name.toLowerCase() === s) ?? (s.length >= 5 ? this.lastPlaces.find((p) => p.name.toLowerCase().startsWith(s)) : undefined);
  }

  async start(query: string, profile: string = "walk", o: StartOptions = {}): Promise<string> {
    const here = await this.here();
    if (!here) return "I don't know where you are yet. Share location from the phone page.";
    let place = this.remembered(query);
    let found: PlaceResult | null = null;
    if (!place) {
      const p = parsePlaceQuery(query);
      found = await this.places.search({ query: p.query, near: here, openNow: p.openNow, sort: p.sort, limit: 5 });
      place = found.places[0];
      if (!place) return found.note && found.source === "google" ? found.note : `Couldn't find "${p.query}".`;
      this.lastPlaces = found.places;
      this.lastPlacesAt = Date.now();
    }
    const to = { lat: place.lat, lon: place.lon };
    let want: Profile = PROFILES.has(profile) ? (profile as Profile) : "walk";
    let plan: Planned | null = null;
    let note = "";
    if (want === "drive" || want === "transit") {
      if (this.routes.hasKey) {
        const r = await this.routes.route(want, here, to, o);
        if (typeof r !== "string") plan = r;
        else note = want === "transit" ? `No transit route (${r}), so walking: ` : "";
      } else if (want === "transit") note = "Transit directions need a Google Maps key, so walking: ";
      if (!plan && want === "transit") want = "walk";
    }
    plan ??= await osrmRoute(want, here, to, this.fetcher);
    if (!plan) return `${note}No ${want} route to ${place.name || query}.`;
    this.profile = want;
    this.route = plan.line.length >= 2 ? plan.line : [here, to];
    this.cum = cumulative(this.route);
    let from = 0;
    this.steps = plan.steps.map((s) => {
      // Maneuvers come in route order, so each is looked for from the previous one on.
      const snap = snapToLine(this.route, this.cum, s, from);
      if (snap) from = snap.idx;
      return { ...s, along: snap?.along ?? 0 };
    });
    this.idx = 1; // step 0 is "depart"; aim for the first real maneuver
    this.dest = place.name;
    this.destPos = to;
    this.total = plan.distance;
    this.duration = plan.duration;
    this.trafficS = plan.staticDuration != null ? Math.max(0, plan.duration - plan.staticDuration) : 0;
    this.legs = plan.legs;
    this.startedAt = Date.now();
    this.snapIdx = -1;
    this.along = 0;
    this.arrived = false;
    this.zoomIdx = -1;
    this.zoom.reset();
    this.policy.reset();
    this.lastMap = null;
    this.active = true;
    this.update();
    const min = Math.round(plan.duration / 60);
    const traffic = this.trafficS >= 60 ? ` (${Math.round(this.trafficS / 60)} min of it traffic)` : "";
    const rated = place.rating != null ? ` (${place.rating.toFixed(1)} stars${place.openNow === true ? ", open now" : place.openNow === false ? ", closed now" : ""})` : "";
    const legs = plan.spoken?.length ? `: ${plan.spoken.join(", then ")}` : "";
    return `${note}Navigating to ${this.dest}${rated}: ${fmtDist(plan.distance)}, about ${min} min ${BY[want]}${traffic}${legs}.`;
  }

  stop() {
    this.active = false;
    this.steps = [];
    this.route = [];
    clearTimeout(this.mapTimer);
    this.mapTimer = undefined;
    clearTimeout(this.zoomTimer);
    this.zoomTimer = undefined;
    this.zoom.reset();
    this.lastState = this.lastMap = null;
    this.emit(null);
    this.emitMap?.(null);
  }

  /** Re-send the route state (and, for the glasses, the map) to a page that just connected. */
  replay(send: (m: { t: "nav"; nav: NavState } | { t: "nav_map"; map: NavMap }) => void, withMap: boolean) {
    if (!this.lastState || !this.active) return; // not after arrival: it would reopen Navigate
    send({ t: "nav", nav: this.lastState });
    if (withMap && this.lastMap) send({ t: "nav_map", map: this.lastMap });
  }

  /** The glasses switched Navigate views: draw the map that view needs now (or stop drawing). */
  setView(v: NavView) {
    if (!["map", "full", "eso", "off"].includes(v) || v === this.shown) return;
    this.shown = v;
    if (v === "map" || v === "full") {
      this.policy.urgent();
      this.scheduleMap();
    } else {
      clearTimeout(this.mapTimer);
      this.mapTimer = undefined;
    }
  }

  /** A swipe: zoom one step, drawn at once; automatic zoom again MANUAL_ZOOM_MS after the last swipe. */
  zoomBy(dir: "in" | "out"): number | null {
    if (!this.active || !this.route.length) return null;
    const now = Date.now();
    const mpp = this.zoom.swipe(dir, this.autoMpp(), now);
    clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => {
      this.zoomTimer = undefined;
      this.zoom.reset();
      this.scheduleMap();
    }, MANUAL_ZOOM_MS + 20);
    this.zoomTimer.unref?.();
    this.policy.urgent();
    this.scheduleMap();
    return mpp;
  }

  /** New GPS fix from the phone. */
  moved(p: { lat: number; lon: number; accuracy?: number }) {
    const fix = { lat: Number(p.lat), lon: Number(p.lon) };
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) return;
    const acc = Number.isFinite(p.accuracy) ? Math.max(0, p.accuracy!) : 0;
    // A very rough fix is worse than the one we have.
    if (this.gps && acc > 150) return;
    this.acc = acc;
    const now = Date.now();
    if (this.lastFix) {
      const dt = (now - this.lastFix.at) / 1000;
      if (dt >= 1) {
        const v = haversine(this.lastFix.pos, fix) / dt;
        this.speed = this.speed ? this.speed * 0.5 + v * 0.5 : v;
        this.lastFix = { pos: fix, at: now };
      }
    } else this.lastFix = { pos: fix, at: now };
    if (!this.headingFrom || !this.gps) this.headingFrom = fix;
    // GPS wander while standing still isn't a direction: it has to beat the fix's accuracy too.
    else if (haversine(this.headingFrom, fix) >= Math.max(10, Math.min(50, acc * 1.5))) {
      this.heading = bearing(this.headingFrom, fix);
      this.headingFrom = fix;
    }
    this.pos = fix;
    this.gps = true;
    if (this.active) this.update();
  }

  /** On a bus or train right now (the step before the one you're heading for is a ride). */
  private riding(): boolean {
    return !!this.steps[this.idx - 1]?.transit;
  }

  /** The ride you're on, or the next one to board. */
  private transitNow(): NavTransit | undefined {
    const on = this.steps[this.idx - 1]?.transit;
    if (on) return { phase: "ride", line: on.line, vehicle: on.vehicle, stop: on.to, time: on.arr, headsign: on.headsign, stops: on.stops };
    const next = this.steps.slice(this.idx).find((s) => s.transit)?.transit;
    return next && { phase: "board", line: next.line, vehicle: next.vehicle, stop: next.from, time: next.dep, headsign: next.headsign, stops: next.stops };
  }

  private update() {
    if (!this.pos || !this.steps.length) return;
    // Near where you were on the route first; anywhere further on only if that fails (a GPS gap).
    const from = Math.max(0, this.snapIdx - 3);
    let snap = snapToLine(this.route, this.cum, this.pos, from, this.snapIdx >= 0 ? this.along + SNAP_AHEAD_M : Infinity);
    if (!snap || snap.off > SNAP_M) snap = snapToLine(this.route, this.cum, this.pos, from);
    this.onRoute = !!snap && snap.off <= SNAP_M;
    if (snap && this.onRoute) {
      this.snapIdx = snap.idx;
      this.along = snap.along;
      this.snapped = snap.pos;
    } else this.snapped = null;
    const toStep = (i: number) => (this.onRoute ? this.steps[i].along - this.along : haversine(this.pos!, this.steps[i]));
    let d = toStep(Math.min(this.idx, this.steps.length - 1));
    // Reached (or passed) the maneuver point: move on to the next one.
    while (d < 15 && this.idx < this.steps.length - 1) {
      this.idx++;
      d = toStep(this.idx);
    }
    d = Math.max(0, d);
    const step = this.steps[this.idx];
    const remaining = this.onRoute
      ? Math.max(d, this.cum[this.cum.length - 1] - this.along)
      : d + this.steps.slice(this.idx).reduce((s, x) => s + x.distance, 0);
    const arrived = this.idx >= this.steps.length - 1 && d < 20;
    const next = this.steps[this.idx + 1];
    let etaMin = Math.max(1, Math.round((remaining / Math.max(1, this.total)) * (this.duration / 60)));
    // Transit runs to a timetable: the planned arrival beats a share of the trip's time.
    if (this.profile === "transit" && this.duration) {
      const planned = (this.startedAt + this.duration * 1000 - Date.now()) / 60_000;
      if (planned > 0) etaMin = Math.max(1, Math.round(planned));
    }
    const transit = arrived ? undefined : this.transitNow();
    const maneuver: Maneuver = arrived ? "arrive" : step.maneuver;
    this.emit((this.lastState = {
      dest: this.dest,
      profile: this.profile,
      arrow: arrived ? "◎" : step.arrow,
      instruction: arrived ? `You've arrived at ${this.dest}` : this.riding() ? `Ride ${transit?.line ?? ""} to ${transit?.stop ?? "your stop"}` : step.instruction,
      distance: Math.round(d),
      then: next ? next.instruction : undefined,
      remaining: Math.round(remaining),
      etaMin,
      arrived,
      maneuver,
      street: arrived ? this.dest : step.maneuver === "arrive" ? this.dest : step.name || undefined,
      thenManeuver: next?.maneuver,
      thenStreet: next ? (next.maneuver === "arrive" ? this.dest : next.name || undefined) : undefined,
      gps: this.gps,
      ...(transit ? { transit } : {}),
      ...(this.legs ? { legs: this.legs } : {}),
      ...(this.trafficS >= 60 ? { trafficMin: Math.round(this.trafficS / 60) } : {}),
    }));
    this.arrived = arrived;
    // zoom: walk/bike by the distance to the turn, drive (and a ride) by speed
    const z = this.zoomTable();
    this.zoomIdx = zoomStep(this.zoomIdx, z.by === "speed" ? this.speed * 3.6 : d, z.thr);
    if (arrived) this.active = false;
    this.scheduleMap();
  }

  // ---------------- map ----------------

  private zoomTable() {
    return ZOOM[this.profile === "transit" ? (this.riding() ? "drive" : "walk") : this.profile] ?? ZOOM.walk;
  }

  private autoMpp(): number {
    const z = this.zoomTable();
    return z.mpp[Math.max(0, Math.min(this.zoomIdx, z.mpp.length - 1))];
  }

  /** Route-up: towards the point 30 m further along the route; off it, the way you're moving; else north. */
  private mapBearing(): number {
    let b: number | null = null;
    if (this.onRoute && this.snapped) {
      const ahead = pointAlong(this.route, this.cum, this.along + 30);
      if (haversine(this.snapped, ahead) >= 3) b = bearing(this.snapped, ahead);
      else b = this.lastBearing;
    } else if (this.heading != null) b = this.heading;
    const q = b == null ? 0 : (Math.round(b / 10) * 10) % 360;
    this.lastBearing = q;
    return q;
  }

  private mapKey(): MapKey | null {
    if (!this.pos || !this.route.length) return null;
    return {
      pos: this.snapped ?? this.pos,
      acc: this.acc,
      bearing: this.mapBearing(),
      idx: this.idx,
      mpp: this.zoom.mpp(this.autoMpp(), Date.now()),
      arrived: this.arrived,
      w: this.shown === "full" ? FULL_W : MAP_W,
    };
  }

  /** The map as it would be drawn now (previews and tests). */
  view(): MapView | null {
    const k = this.mapKey();
    return k && { pos: k.pos, bearing: k.bearing, mpp: k.mpp, route: this.route, snapIdx: this.snapIdx, onRoute: this.onRoute, dest: this.destPos, profile: this.profile, w: k.w };
  }

  private scheduleMap() {
    if (!this.emitMap || !this.route.length || (this.shown !== "map" && this.shown !== "full")) return;
    const k = this.mapKey();
    if (!k) return;
    const wait = this.policy.due(k, Date.now(), k.w === FULL_W ? 3000 : this.policy.gapMs);
    if (wait === null) return;
    if (this.drawing) {
      this.again = true;
      return;
    }
    if (wait > 0) {
      if (!this.mapTimer) {
        this.mapTimer = setTimeout(() => {
          this.mapTimer = undefined;
          this.scheduleMap();
        }, wait);
        this.mapTimer.unref?.();
      }
      return;
    }
    void this.drawMap(k);
  }

  private async drawMap(k: MapKey) {
    this.drawing = true;
    this.policy.drawn(k, Date.now());
    const route = this.route;
    try {
      const v = this.view()!;
      const base = this.google.usable ? this.google : this.osm;
      let out = await renderNavMap(v, base);
      // Google failed, or refused the key just now: OpenStreetMap instead.
      if (out.source === "route" && base !== this.osm) out = await renderNavMap(v, this.osm);
      if (this.route !== route) return; // stopped or rerouted meanwhile
      const step = ZOOM_LEVELS.reduce((b, m, i) => (Math.abs(Math.log(m / v.mpp)) < Math.abs(Math.log(ZOOM_LEVELS[b] / v.mpp)) ? i : b), 0);
      this.lastMap = {
        w: out.img.w === FULL_W ? FULL_W : MAP_W, h: 288, px: toB64(pack4(out.img)), seq: ++this.seq, mpp: Math.round(out.mpp * 100) / 100, bearing: v.bearing, source: out.source,
        zoom: { step, of: ZOOM_LEVELS.length, manual: this.zoom.isManual(Date.now()) },
      };
      this.emitMap?.(this.lastMap);
    } catch (e: any) {
      console.log(`[map] render failed: ${String(e?.message ?? e).slice(0, 160)}`);
    } finally {
      this.drawing = false;
      if (this.again) {
        this.again = false;
        this.scheduleMap();
      }
    }
  }
}

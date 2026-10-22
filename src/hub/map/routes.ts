import type { Maneuver, NavTransit } from "../../shared/protocol.js";
import type { Pos } from "./geo.js";
import { googleStatus } from "./places.js";

// Routing: Google Routes API (computeRoutes) for driving with live traffic and for public transit, when
// GOOGLE_MAPS_API_KEY is set; OSRM (OpenStreetMap, keyless) for walking, cycling and as the fallback for
// driving. Both come out as one Planned route: a line to follow and maneuver steps along it.
// The key goes in the X-Goog-Api-Key header, never in a URL, and is never logged.

export type Profile = "walk" | "bike" | "drive" | "transit";

export interface PlannedStep {
  instruction: string;
  arrow: string;
  lat: number;
  lon: number;
  /** Metres from this maneuver to the next. */
  distance: number;
  maneuver: Maneuver;
  /** The street (or, for a ride, the boarding stop) this maneuver goes onto. */
  name: string;
  /** A ride on public transport starting here (board at this point, get off at the next step). */
  transit?: Omit<NavTransit, "phase" | "stop" | "time"> & { from: string; to: string; dep?: string; arr?: string };
}

export interface Planned {
  line: Pos[];
  steps: PlannedStep[];
  /** Metres. */
  distance: number;
  /** Seconds (with traffic, for Google driving). */
  duration: number;
  /** Seconds the same drive takes without traffic. */
  staticDuration?: number;
  source: "google" | "osrm";
  /** Transit: one short line per leg, for the readout ("WALK 4 MIN", "BUS 38 9:05 PM POWELL ST"). */
  legs?: string[];
  /** Transit: the same legs in words, for the voice reply ("bus 38 at 9:05 PM from Powell St"). */
  spoken?: string[];
}

const UA = { "User-Agent": "g2-orchestrator/0.1 (personal smart-glasses navigation)" };
export const OSRM: Record<string, string> = {
  walk: "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
  bike: "https://routing.openstreetmap.de/routed-bike/route/v1/bike",
  drive: "https://router.project-osrm.org/route/v1/driving",
};

const ARROW: Record<string, string> = {
  left: "←", "sharp left": "↰", "slight left": "↖", right: "→", "sharp right": "↱", "slight right": "↗",
  straight: "↑", uturn: "↶", roundabout: "⟳", arrive: "◎", depart: "↑",
};

const compass = (deg: number) => ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(deg / 45) % 8];

const MANEUVERS = new Set<string>(["straight", "slight left", "left", "sharp left", "slight right", "right", "sharp right", "uturn"]);

/** OSRM's maneuver type + modifier → the shape drawn on the lens. */
export function maneuverOf(m: any): Maneuver {
  const type: string = m?.type ?? "";
  if (type === "depart") return "depart";
  if (type === "arrive") return "arrive";
  if (/roundabout|rotary/.test(type)) return "roundabout";
  const mod: string = m?.modifier ?? "straight";
  return MANEUVERS.has(mod) ? (mod as Maneuver) : "straight";
}

function describe(m: any, name: string): { text: string; arrow: string } {
  const mod: string = m.modifier ?? "straight";
  const onto = name ? ` onto ${name}` : "";
  switch (m.type) {
    case "depart": return { text: `Head ${m.bearing_after != null ? compass(m.bearing_after) : "out"}${onto}`, arrow: "↑" };
    case "arrive": return { text: "Arrive at destination", arrow: "◎" };
    case "roundabout":
    case "rotary": return { text: `Roundabout: exit ${m.exit ?? ""}${onto}`, arrow: "⟳" };
    case "continue":
    case "new name": return { text: `Continue${onto}`, arrow: "↑" };
    default: return { text: `${mod === "straight" ? "Go straight" : "Turn " + mod}${onto}`, arrow: ARROW[mod] ?? "↑" };
  }
}

export const osrmUrl = (profile: string, from: Pos, to: Pos) =>
  `${OSRM[profile] ?? OSRM.walk}/${from.lon},${from.lat};${to.lon},${to.lat}?steps=true&overview=full&geometries=geojson`;

/** OSRM route JSON → Planned (null when there's no route). */
export function parseOsrm(j: any): Planned | null {
  const route = j?.routes?.[0];
  if (!route) return null;
  const line: Pos[] = (route.geometry?.coordinates ?? []).map(([lon, lat]: [number, number]) => ({ lat, lon }));
  const steps: PlannedStep[] = (route.legs?.[0]?.steps ?? []).map((s: any) => {
    const d = describe(s.maneuver, s.name);
    return { instruction: d.text, arrow: d.arrow, lat: s.maneuver.location[1], lon: s.maneuver.location[0], distance: s.distance, maneuver: maneuverOf(s.maneuver), name: s.name ?? "" };
  });
  return { line, steps, distance: route.distance, duration: route.duration, source: "osrm" };
}

export async function osrmRoute(profile: string, from: Pos, to: Pos, fetcher: typeof fetch): Promise<Planned | null> {
  const r = await (await fetcher(osrmUrl(profile, from, to), { headers: UA, signal: AbortSignal.timeout(10000) })).json();
  return parseOsrm(r);
}

// ---------------- Google Routes ----------------

const ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes";
export const ROUTE_FIELDS = [
  "routes.distanceMeters", "routes.duration", "routes.staticDuration", "routes.polyline.encodedPolyline",
  "routes.legs.steps.distanceMeters", "routes.legs.steps.startLocation", "routes.legs.steps.endLocation",
  "routes.legs.steps.navigationInstruction", "routes.legs.steps.travelMode", "routes.legs.steps.staticDuration",
  "routes.legs.steps.transitDetails",
].join(",");

/** Google's encoded polyline (precision 5) → positions. */
export function decodePolyline(s: string): Pos[] {
  const out: Pos[] = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let shift = 0, result = 0, b: number;
    do {
      if (i >= s.length) return NaN;
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    const dlat = next(), dlon = next();
    if (!Number.isFinite(dlat) || !Number.isFinite(dlon)) break;
    lat += dlat;
    lon += dlon;
    out.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }
  return out;
}

const GOOGLE_MANEUVER: Record<string, Maneuver> = {
  DEPART: "depart", STRAIGHT: "straight", NAME_CHANGE: "straight", MERGE: "straight", FERRY: "straight", FERRY_TRAIN: "straight",
  TURN_LEFT: "left", TURN_RIGHT: "right", TURN_SLIGHT_LEFT: "slight left", TURN_SLIGHT_RIGHT: "slight right",
  TURN_SHARP_LEFT: "sharp left", TURN_SHARP_RIGHT: "sharp right", UTURN_LEFT: "uturn", UTURN_RIGHT: "uturn",
  RAMP_LEFT: "slight left", RAMP_RIGHT: "slight right", FORK_LEFT: "slight left", FORK_RIGHT: "slight right",
  ROUNDABOUT_LEFT: "roundabout", ROUNDABOUT_RIGHT: "roundabout",
};

const VEHICLE: Record<string, string> = {
  BUS: "BUS", INTERCITY_BUS: "BUS", TROLLEYBUS: "BUS", SHARE_TAXI: "BUS",
  SUBWAY: "METRO", METRO_RAIL: "METRO", TRAM: "TRAM", LIGHT_RAIL: "TRAM", MONORAIL: "TRAM",
  RAIL: "TRAIN", HEAVY_RAIL: "TRAIN", COMMUTER_TRAIN: "TRAIN", HIGH_SPEED_TRAIN: "TRAIN", LONG_DISTANCE_TRAIN: "TRAIN",
  FERRY: "FERRY", CABLE_CAR: "CABLE CAR", GONDOLA_LIFT: "GONDOLA", FUNICULAR: "FUNICULAR",
};

const secs = (d: unknown) => (typeof d === "string" ? parseFloat(d) || 0 : typeof d === "number" ? d : 0);
const latLng = (l: any): Pos | null => {
  const lat = Number(l?.latLng?.latitude), lon = Number(l?.latLng?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
};

/** "Turn left onto Market St" / "Head north on 4th St toward Mission St" → "Market St" / "4th St". */
export function streetOf(instructions: string): string {
  const m = /\b(?:onto|on)\s+(.+?)(?:\s+toward\b.*|\s*\n.*|\s*\(.*|$)/is.exec(instructions ?? "");
  return m ? m[1].trim() : "";
}

/** "2026-10-21T21:05:00Z" → "9:05 PM" in the hub's local time (when Google sent no localized text). */
const clockOf = (iso: unknown) => {
  const d = new Date(String(iso ?? ""));
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : undefined;
};

const mins = (s: number) => `${Math.max(1, Math.round(s / 60))} MIN`;

/** computeRoutes JSON → Planned (null when there's no route). Transit rides become steps with `transit`. */
export function parseGoogleRoute(j: any): Planned | null {
  const route = j?.routes?.[0];
  if (!route) return null;
  const line = decodePolyline(route.polyline?.encodedPolyline ?? "");
  const raw: any[] = (route.legs ?? []).flatMap((l: any) => l?.steps ?? []);
  const steps: PlannedStep[] = [];
  const legs: string[] = [];
  const spoken: string[] = [];
  let walkS = 0;
  let end: Pos | null = null;
  const flushWalk = () => {
    if (walkS > 0) {
      legs.push(`WALK ${mins(walkS)}`);
      spoken.push(`walk ${mins(walkS).toLowerCase()}`);
    }
    walkS = 0;
  };
  for (const s of raw) {
    const at = latLng(s.startLocation);
    if (!at) continue;
    end = latLng(s.endLocation) ?? end;
    const nav = s.navigationInstruction ?? {};
    const text: string = String(nav.instructions ?? "").replace(/\s*\n\s*/g, ". ");
    const td = s.transitDetails;
    if (s.travelMode === "TRANSIT" && td) {
      flushWalk();
      const tl = td.transitLine ?? {};
      const vehicle = VEHICLE[String(tl.vehicle?.type ?? "")] ?? "TRANSIT";
      const lineName = String(tl.nameShort || tl.name || tl.vehicle?.name?.text || vehicle).trim();
      const from = String(td.stopDetails?.departureStop?.name ?? "").trim();
      const to = String(td.stopDetails?.arrivalStop?.name ?? "").trim();
      const dep = td.localizedValues?.departureTime?.time?.text ?? clockOf(td.stopDetails?.departureTime);
      const arr = td.localizedValues?.arrivalTime?.time?.text ?? clockOf(td.stopDetails?.arrivalTime);
      const headsign = td.headsign ? String(td.headsign) : undefined;
      const stops = typeof td.stopCount === "number" ? td.stopCount : undefined;
      steps.push({
        instruction: `Take ${vehicle.toLowerCase()} ${lineName}${headsign ? ` toward ${headsign}` : ""} from ${from || "the stop"}${dep ? ` at ${dep}` : ""}`,
        arrow: "↑", lat: at.lat, lon: at.lon, distance: Number(s.distanceMeters) || 0, maneuver: "straight", name: from,
        transit: { line: lineName, vehicle, from, to, dep, arr, headsign, stops },
      });
      legs.push(`${vehicle} ${lineName}${dep ? ` ${dep}` : ""}${from ? ` ${from}` : ""}`);
      spoken.push(`${vehicle.toLowerCase()} ${lineName}${dep ? ` at ${dep}` : ""}${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}`);
      continue;
    }
    walkS += s.travelMode === "WALK" ? secs(s.staticDuration) : 0;
    const maneuver = steps.length === 0 ? "depart" : GOOGLE_MANEUVER[String(nav.maneuver ?? "")] ?? "straight";
    steps.push({ instruction: text || "Continue", arrow: ARROW[maneuver] ?? "↑", lat: at.lat, lon: at.lon, distance: Number(s.distanceMeters) || 0, maneuver, name: streetOf(String(nav.instructions ?? "")) });
  }
  flushWalk();
  const last = end ?? line[line.length - 1];
  if (!steps.length || !last) return null;
  steps.push({ instruction: "Arrive at destination", arrow: "◎", lat: last.lat, lon: last.lon, distance: 0, maneuver: "arrive", name: "" });
  const hasTransit = steps.some((s) => s.transit);
  return {
    line: line.length >= 2 ? line : steps.map((s) => ({ lat: s.lat, lon: s.lon })),
    steps,
    distance: Number(route.distanceMeters) || 0,
    duration: secs(route.duration),
    staticDuration: route.staticDuration != null ? secs(route.staticDuration) : undefined,
    source: "google",
    legs: hasTransit ? legs : undefined,
    spoken: hasTransit ? spoken : undefined,
  };
}

export interface RouteRequestOptions {
  /** Transit: only these vehicles. */
  prefer?: "bus" | "train";
}

/** The computeRoutes request body. */
export function routesBody(profile: "drive" | "transit", from: Pos, to: Pos, o: RouteRequestOptions = {}): Record<string, unknown> {
  const wp = (p: Pos) => ({ location: { latLng: { latitude: p.lat, longitude: p.lon } } });
  const body: Record<string, unknown> = { origin: wp(from), destination: wp(to), travelMode: profile === "drive" ? "DRIVE" : "TRANSIT", languageCode: "en-US", units: "METRIC", computeAlternativeRoutes: false };
  // live traffic is for driving only (Google refuses a routing preference on transit)
  if (profile === "drive") body.routingPreference = "TRAFFIC_AWARE";
  else if (o.prefer) body.transitPreferences = { allowedTravelModes: o.prefer === "bus" ? ["BUS"] : ["TRAIN", "SUBWAY", "LIGHT_RAIL", "RAIL"] };
  return body;
}

export class GoogleRoutes {
  constructor(
    private key: () => string,
    private fetcher: typeof fetch = (...a) => fetch(...a),
    private log: (s: string) => void = console.log,
  ) {}

  get hasKey() {
    return !!this.key();
  }

  /** The route, or a reason it failed (a string; no route from Google is also a string). */
  async route(profile: "drive" | "transit", from: Pos, to: Pos, o: RouteRequestOptions = {}): Promise<Planned | string> {
    try {
      const res = await this.fetcher(ROUTES, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": this.key(), "X-Goog-FieldMask": ROUTE_FIELDS },
        body: JSON.stringify(routesBody(profile, from, to, o)),
        signal: AbortSignal.timeout(10000),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        const st = googleStatus(j);
        this.log(`[routes] google ${profile} ${res.status} ${st}`);
        return `Google Routes ${res.status}${st ? ` ${st}` : ""}`;
      }
      const p = parseGoogleRoute(j);
      this.log(`[routes] google ${profile} ${p ? `${p.steps.length} steps` : "no route"}`);
      return p ?? "no route";
    } catch (e: any) {
      this.log(`[routes] google failed: ${e?.name ?? "error"}`);
      return "Google Routes unreachable";
    }
  }
}

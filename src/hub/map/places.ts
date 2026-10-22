import { haversine, type Pos } from "./geo.js";

// Finding places: Google Places API (New) when GOOGLE_MAPS_API_KEY is set (ratings, open now,
// distance), otherwise (or when Google fails) OpenStreetMap's Nominatim, searched outward from you.
// The key goes in the X-Goog-Api-Key header, never in a URL, and is never logged.

export interface Place {
  name: string;
  address?: string;
  lat: number;
  lon: number;
  /** 1..5 */
  rating?: number;
  ratings?: number;
  openNow?: boolean;
  /** "Ramen restaurant", "Cafe". */
  kind?: string;
  /** Metres from where you are. */
  distance: number;
  source: "google" | "osm";
}

export interface PlaceQuery {
  query: string;
  near: Pos;
  openNow?: boolean;
  /** distance = nearest first; best = well rated (and relevant) first. */
  sort?: "distance" | "best";
  limit?: number;
}

export interface PlaceResult {
  places: Place[];
  source: "google" | "osm";
  /** Something the wearer should know (Google failed, OSM can't filter by opening hours). */
  note?: string;
}

export const googleKey = () => process.env.GOOGLE_MAPS_API_KEY?.trim() ?? "";

const PLACES = "https://places.googleapis.com/v1/places";
const FIELDS = [
  "places.displayName", "places.shortFormattedAddress", "places.formattedAddress", "places.location", "places.rating",
  "places.userRatingCount", "places.currentOpeningHours.openNow", "places.primaryTypeDisplayName",
].join(",");
const UA = { "User-Agent": "g2-orchestrator/0.1 (personal smart-glasses navigation)" };

/** "the best ramen open now near me" → { query: "ramen", openNow: true, sort: "best" }. */
export function parsePlaceQuery(raw: string): { query: string; openNow: boolean; sort: "distance" | "best" } {
  let q = raw.trim();
  const openNow = /\bopen( right)? now\b|\bthat'?s open\b|\bstill open\b/i.test(q);
  q = q.replace(/\b(that'?s |which is |still )?open( right)? now\b|\bthat'?s open\b|\bstill open\b/gi, " ");
  const best = /^(the )?(best|top|good|great|highest[- ]rated|top[- ]rated|well[- ]rated)\b/i.test(q);
  q = q
    .replace(/^(the )?(best|top|good|great|highest[- ]rated|top[- ]rated|well[- ]rated|nearest|closest|nearby|a|an)\s+/i, "")
    .replace(/\s+(near(by| me| here)?|close by|around here)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return { query: q || raw.trim(), openNow, sort: best ? "best" : "distance" };
}

/** Everyday words → Places (New) types for Nearby Search; anything else goes to Text Search. */
const TYPES: [RegExp, string][] = [
  [/^coffee( shops?)?$|^coffee place$|^cafes?$/i, "cafe"], [/^gas( station)?$|^petrol( station)?$|^fuel$/i, "gas_station"],
  [/^drug ?store$|^chemist$|^pharmacy$/i, "pharmacy"], [/^grocery( store)?$|^supermarket$/i, "supermarket"],
  [/^atms?$|^cash machine$/i, "atm"], [/^bars?$|^pubs?$/i, "bar"],
  [/^restaurants?$|^food$|^somewhere to eat$/i, "restaurant"], [/^parking$|^car park$/i, "parking"], [/^hospital$/i, "hospital"],
  [/^ev charg(er|ing)( station)?$/i, "electric_vehicle_charging_station"],
];
export const placeType = (q: string) => TYPES.find(([re]) => re.test(q.trim()))?.[1];

/** Places (New) JSON → places, with distances from `here`. */
export function parsePlaces(j: any, here: Pos): Place[] {
  const out: Place[] = [];
  for (const p of j?.places ?? []) {
    const lat = Number(p?.location?.latitude), lon = Number(p?.location?.longitude);
    const name = String(p?.displayName?.text ?? "").trim();
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      name,
      address: p.shortFormattedAddress || p.formattedAddress || undefined,
      lat, lon,
      rating: typeof p.rating === "number" ? p.rating : undefined,
      ratings: typeof p.userRatingCount === "number" ? p.userRatingCount : undefined,
      openNow: typeof p.currentOpeningHours?.openNow === "boolean" ? p.currentOpeningHours.openNow : undefined,
      kind: p.primaryTypeDisplayName?.text || undefined,
      distance: Math.round(haversine(here, { lat, lon })),
      source: "google",
    });
  }
  return out;
}

/** A rating that trusts few reviews less (Bayesian average towards 4.0 with 20 phantom reviews). */
const score = (p: Place) => (p.rating == null ? 0 : (p.rating * (p.ratings ?? 0) + 4 * 20) / ((p.ratings ?? 0) + 20));

function order(places: Place[], sort: "distance" | "best"): Place[] {
  return sort === "best" ? places.slice().sort((a, b) => score(b) - score(a)) : places.slice().sort((a, b) => a.distance - b.distance);
}

/** One line per place for the voice router: "Ramen Tatsu-ya: 4.6 (2100), open, 850 m, 1234 Main St". */
export function describePlaces(r: PlaceResult, n = 5): string {
  if (!r.places.length) return r.note ?? "Nothing found.";
  const fmt = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
  const lines = r.places.slice(0, n).map((p, i) => {
    const bits = [
      p.rating != null ? `${p.rating.toFixed(1)} stars${p.ratings != null ? ` (${p.ratings})` : ""}` : "",
      p.openNow === true ? "open now" : p.openNow === false ? "closed now" : "",
      fmt(p.distance),
      p.kind ?? "",
      p.address ?? "",
    ].filter(Boolean);
    return `${i + 1}. ${p.name}: ${bits.join(", ")}`;
  });
  return [...lines, ...(r.note ? [r.note] : [])].join("\n");
}

export class Places {
  constructor(
    private key: () => string = googleKey,
    private fetcher: typeof fetch = (...a) => fetch(...a),
    private log: (s: string) => void = console.log,
  ) {}

  get hasKey() {
    return !!this.key();
  }

  async search(q: PlaceQuery): Promise<PlaceResult> {
    const sort = q.sort ?? "distance";
    let note: string | undefined;
    if (this.key()) {
      const g = await this.google(q, sort);
      if (g) {
        const open = q.openNow ? g.filter((p) => p.openNow !== false) : g;
        if (open.length) return { places: order(open, sort).slice(0, q.limit ?? 10), source: "google" };
        if (g.length && q.openNow) return { places: [], source: "google", note: `Nothing open right now matching "${q.query}".` };
      } else note = "Google Places failed, so this is OpenStreetMap (no ratings or hours).";
    }
    const places = await this.nominatim(q.query, q.near);
    if (!note && q.openNow) note = "OpenStreetMap can't tell what's open now.";
    if (!note && sort === "best") note = "No ratings without Google Places: nearest first.";
    return { places: places.slice(0, q.limit ?? 10), source: "osm", note };
  }

  /** null = Google failed (the caller falls back); [] = it worked and found nothing. */
  private async google(q: PlaceQuery, sort: "distance" | "best"): Promise<Place[] | null> {
    const type = placeType(q.query);
    const center = { latitude: q.near.lat, longitude: q.near.lon };
    // Nearby Search for plain kinds of place (coffee, pharmacy), Text Search for the rest ("ramen").
    const nearby = !!type;
    const body = nearby
      ? { includedTypes: [type], maxResultCount: 20, rankPreference: sort === "best" ? "POPULARITY" : "DISTANCE", locationRestriction: { circle: { center, radius: 5000 } } }
      : {
        textQuery: q.query, pageSize: 20, rankPreference: sort === "best" ? "RELEVANCE" : "DISTANCE",
        locationBias: { circle: { center, radius: 5000 } }, ...(q.openNow ? { openNow: true } : {}),
      };
    try {
      const res = await this.fetcher(`${PLACES}:${nearby ? "searchNearby" : "searchText"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": this.key(), "X-Goog-FieldMask": FIELDS },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.log(`[places] google ${nearby ? "nearby" : "text"} ${res.status} ${googleStatus(j)}`);
        return null;
      }
      const places = parsePlaces(j, q.near);
      this.log(`[places] google ${nearby ? "nearby" : "text"} ${places.length}`);
      return places;
    } catch (e: any) {
      this.log(`[places] google failed: ${e?.name ?? "error"}`);
      return null;
    }
  }

  /** Nominatim within ~2 km, then ~6 km, then ~20 km, then anywhere; closest first. */
  async nominatim(query: string, here: Pos): Promise<Place[]> {
    // Everyday words → OpenStreetMap categories, which Nominatim matches much better.
    const KIND: [RegExp, string][] = [
      [/^coffee( shop)?s?$|^coffee place$/i, "cafe"], [/^gas( station)?$|^petrol( station)?$/i, "fuel"],
      [/^drug ?store$|^chemist$/i, "pharmacy"], [/^grocery( store)?$|^supermarket$/i, "supermarket"],
      [/^atm$|^cash machine$/i, "atm"], [/^bathroom$|^restroom$/i, "toilets"], [/^bar$|^pub$/i, "bar"],
    ];
    for (const [re, k] of KIND) if (re.test(query.trim())) query = k;
    let found: any[] = [];
    for (const r of [0.02, 0.06, 0.2, 0]) {
      const box = r ? `&bounded=1&viewbox=${here.lon - r},${here.lat + r},${here.lon + r},${here.lat - r}` : "";
      found = await (
        await this.fetcher(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=20${box}&q=${encodeURIComponent(query)}`, { headers: UA, signal: AbortSignal.timeout(8000) })
      ).json();
      if (Array.isArray(found) && found.length) break;
    }
    if (!Array.isArray(found)) return [];
    return found
      .map((p): Place => {
        const pos = { lat: +p.lat, lon: +p.lon };
        return { name: p.name || String(p.display_name ?? "").split(",")[0], address: p.display_name, ...pos, distance: Math.round(haversine(here, pos)), source: "osm" };
      })
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .sort((a, b) => a.distance - b.distance);
  }
}

/** Google's error status ("PERMISSION_DENIED") plus a hint, never the message itself (it can quote the request). */
export function googleStatus(j: any): string {
  const st = String(j?.error?.status ?? "").replace(/[^A-Z_]/g, "");
  const msg = String(j?.error?.message ?? "");
  const hint = /not been used|disabled|not enabled/i.test(msg) ? " (API not enabled for this key's project)" : /API key not valid|invalid/i.test(msg) ? " (key not valid)" : /referer|restricted|not authorized/i.test(msg) ? " (key restrictions block it)" : "";
  return st + hint;
}

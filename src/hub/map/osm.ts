import type { Raster } from "../../shared/raster.js";
import { clipPolyline, haversine, type Pos } from "./geo.js";
import { viewRadius, type BaseMap, type MapView } from "./render.js";

// The keyless base map: OpenStreetMap roads from the Overpass API, drawn as lines (no fills, buildings
// or labels). Overpass is a shared volunteer service: one query per area, at most one a minute, with
// a User-Agent that says who we are; the result is kept in memory and reused while you stay inside it.

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const MIN_GAP_MS = 60_000;
/** How long the first map waits for roads before it goes out with the route alone (the roads follow). */
const FIRST_WAIT_MS = 6000;

type Kind = "major" | "minor" | "path";

const KIND: Record<string, Kind> = {
  motorway: "major", trunk: "major", primary: "major", secondary: "major",
  motorway_link: "major", trunk_link: "major", primary_link: "major", secondary_link: "major",
  tertiary: "minor", tertiary_link: "minor", residential: "minor", unclassified: "minor", service: "minor", living_street: "minor", road: "minor",
  footway: "path", path: "path", pedestrian: "path", cycleway: "path", steps: "path", track: "path", bridleway: "path",
};

interface Way {
  kind: Kind;
  pts: Pos[];
  /** Bounding box, to skip ways nowhere near the view. */
  s: number; w: number; n: number; e: number;
}

/** [level, thickness] per kind and dim step (0 = none). */
const STYLE: Record<Kind, [number, number][]> = {
  major: [[9, 2], [6, 2], [6, 1]],
  minor: [[6, 1], [5, 1], [4, 1]],
  path: [[5, 1], [0, 0], [0, 0]],
};

export const overpassQuery = (p: Pos, r: number, drive: boolean) =>
  `[out:json][timeout:25];way["highway"${drive ? '~"^((motorway|trunk|primary|secondary|tertiary)(_link)?|residential|unclassified)$"' : ""}](around:${r},${p.lat.toFixed(6)},${p.lon.toFixed(6)});out geom;`;

/** Overpass JSON → ways we draw. */
export function parseOverpass(j: any): Way[] {
  const out: Way[] = [];
  for (const el of j?.elements ?? []) {
    const kind = KIND[el?.tags?.highway];
    if (el?.type !== "way" || !kind || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const pts: Pos[] = el.geometry.filter((g: any) => typeof g?.lat === "number" && typeof g?.lon === "number").map((g: any) => ({ lat: g.lat, lon: g.lon }));
    if (pts.length < 2) continue;
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const p of pts) {
      s = Math.min(s, p.lat);
      n = Math.max(n, p.lat);
      w = Math.min(w, p.lon);
      e = Math.max(e, p.lon);
    }
    out.push({ kind, pts, s, w, n, e });
  }
  // paths under streets under main roads
  const order: Record<Kind, number> = { path: 0, minor: 1, major: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** Overpass area radius (metres): 700 walking / 2500 driving, stepped up for wide views (zoomed out, full map). */
export function areaRadius(profile: string, reach: number): number {
  const base = profile === "drive" ? 2500 : 700;
  return [base, 1500, 2500, 4000].find((r) => r >= base && r >= reach * 1.3) ?? 4000;
}

export class OsmBase implements BaseMap {
  readonly source = "osm" as const;
  private data: { center: Pos; r: number; ways: Way[] } | null = null;
  private lastTry = 0;
  private inflight: Promise<void> | null = null;

  /** onData: fresh roads arrived after the map was drawn without them (redraw). */
  constructor(
    private onData?: () => void,
    private ua: Record<string, string> = {},
    private fetcher: typeof fetch = fetch,
  ) {}

  /** Use this data instead of asking Overpass (tests, previews). */
  load(center: Pos, r: number, overpassJson: unknown) {
    this.data = { center, r, ways: parseOverpass(overpassJson) };
  }

  ready() {
    return !!this.data;
  }

  async prepare(v: MapView): Promise<void> {
    const reach = viewRadius(v.mpp, v.w);
    // Zoomed out (4 m/px and more) only the bigger roads, over a wider area, so the query stays small.
    const drive = v.profile === "drive" || v.mpp >= 4;
    const r = areaRadius(v.profile, reach);
    const d = this.data;
    // Reuse while the whole view still fits inside the area (at 2 m/px that's 174 m from its centre,
    // not r / 2: the top of the lens would run out of roads first), but never refetch closer than r / 4.
    if (d && d.r === r && haversine(d.center, v.pos) <= Math.max(r / 4, r - reach)) return;
    if (this.inflight || Date.now() - this.lastTry < MIN_GAP_MS) return;
    this.lastTry = Date.now();
    const center = { ...v.pos };
    const job = this.fetchWays(center, r, drive)
      .then((ways) => {
        this.data = { center, r, ways };
        console.log(`[map] osm ${ways.length} ways r=${r}`);
      })
      .catch((e) => console.log(`[map] osm failed: ${String(e?.message ?? e).slice(0, 120)}`))
      .finally(() => (this.inflight = null));
    this.inflight = job;
    // The first map waits a little for roads; otherwise maps draw what's there (the old area, or the
    // route alone) and redraw when the new roads land. A busy Overpass can take half a minute.
    let late = !!d;
    void job.then(() => late && this.data !== d && this.onData?.());
    if (!d) {
      await Promise.race([job, new Promise((r) => setTimeout(r, FIRST_WAIT_MS).unref?.())]);
      late = true;
    }
  }

  private async fetchWays(p: Pos, r: number, drive: boolean): Promise<Way[]> {
    const body = "data=" + encodeURIComponent(overpassQuery(p, r, drive));
    let err: unknown;
    for (const url of ENDPOINTS) {
      try {
        const res = await this.fetcher(url, {
          method: "POST", body, signal: AbortSignal.timeout(45_000),
          headers: { ...this.ua, "Content-Type": "application/x-www-form-urlencoded" },
        });
        if (!res.ok) throw new Error(`overpass ${res.status}`);
        return parseOverpass(await res.json());
      } catch (e) {
        err = e;
      }
    }
    throw err;
  }

  draw(r: Raster, v: MapView, toPx: (p: Pos) => [number, number], dim: number): void {
    const ways = this.data?.ways;
    if (!ways) return;
    // Degrees around pos that can show on the map, to skip far ways cheaply.
    const reach = viewRadius(v.mpp, v.w) + 20 * v.mpp;
    const dLat = reach / 111195, dLon = reach / (111195 * Math.cos((v.pos.lat * Math.PI) / 180));
    for (const w of ways) {
      if (w.n < v.pos.lat - dLat || w.s > v.pos.lat + dLat || w.e < v.pos.lon - dLon || w.w > v.pos.lon + dLon) continue;
      // zoomed out, the small stuff is only noise: no paths from 3 m/px, only main roads from 6
      if ((v.mpp >= 3 && w.kind === "path") || (v.mpp >= 6 && w.kind !== "major")) continue;
      const [level, t] = STYLE[w.kind][Math.min(dim, 2)];
      if (!level) continue;
      for (const run of clipPolyline(w.pts.map(toPx), -4, -4, r.w + 4, r.h + 4)) r.polyline(run, level, t, w.kind === "path" ? [2, 2] : undefined);
    }
  }
}

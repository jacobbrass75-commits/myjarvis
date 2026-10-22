// Canned Open-Meteo forecast for the weather map tests and previews: the multi-location answer
// (an array, one object per grid point, unixtime hours) shaped like the real one, with a 1000 hPa low
// off the coast at 36N 127W, a 1026 hPa high over Nevada at 40N 116W, wind blowing around them
// (counter-clockwise round the low), a warm inland south, cool coast and rain near the low.

import { GRID, requestPoints, type GridSpec } from "../src/hub/weather/grid.js";

export const LOW = { lat: 36, lon: -127, depth: 14 };
export const HIGH = { lat: 40, lon: -116, height: 12 };
export const T0 = Date.UTC(2026, 9, 21, 18) / 1000;

/** Pressure (hPa) at a point and hour: the low drifts east 0.25 degrees an hour. */
export function pressureAt(lat: number, lon: number, hour = 0): number {
  const k = Math.cos((37 * Math.PI) / 180);
  const d2 = (a: { lat: number; lon: number }, dl = 0) => ((lon - a.lon - dl) * k) ** 2 + (lat - a.lat) ** 2;
  return 1012 - LOW.depth * Math.exp(-d2(LOW, hour * 0.25) / 18) + HIGH.height * Math.exp(-d2(HIGH) / 22);
}

export function cannedOpenMeteo(g: GridSpec = GRID, hours = 26): unknown[] {
  const time = Array.from({ length: hours }, (_, h) => T0 + h * 3600);
  return requestPoints(g).map((p, i) => {
    const series = (fn: (h: number) => number, digits = 1) => time.map((_, h) => +fn(h).toFixed(digits));
    // geostrophic-ish wind: along the isobars, low pressure on the left, from the local gradient
    const wind = (h: number) => {
      const e = 0.05;
      const dx = (pressureAt(p.lat, p.lon + e, h) - pressureAt(p.lat, p.lon - e, h)) / (2 * e * Math.cos((p.lat * Math.PI) / 180));
      const dy = (pressureAt(p.lat + e, p.lon, h) - pressureAt(p.lat - e, p.lon, h)) / (2 * e);
      const u = -dy * 3, v = dx * 3; // northern hemisphere: wind keeps low pressure on its left
      return { speed: Math.hypot(u, v), from: ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360 };
    };
    const temp = (h: number) => 58 + (p.lon + 124) * 2.2 + (37 - p.lat) * 2.5 + 6 * Math.sin(((h + 18 - 15) / 24) * 2 * Math.PI);
    const rain = (h: number) => {
      const d = Math.hypot((p.lon - LOW.lon - h * 0.25 - 3) * 0.8, p.lat - LOW.lat - 1);
      return Math.max(0, 4 * Math.exp(-(d * d) / 3) - 0.3);
    };
    return {
      latitude: p.lat + 0.01, longitude: p.lon - 0.01, generationtime_ms: 0.1, utc_offset_seconds: 0, timezone: "GMT", timezone_abbreviation: "GMT", elevation: 0,
      ...(i ? { location_id: i } : {}),
      hourly_units: { time: "unixtime", pressure_msl: "hPa", temperature_2m: "°F", wind_speed_10m: "mp/h", wind_direction_10m: "°", precipitation: "mm" },
      hourly: {
        time,
        pressure_msl: series((h) => pressureAt(p.lat, p.lon, h)),
        temperature_2m: series(temp),
        wind_speed_10m: series((h) => wind(h).speed),
        wind_direction_10m: series((h) => wind(h).from, 0),
        precipitation: series(rain, 2),
      },
    };
  });
}

/** GFS metadata as Open-Meteo serves it (seconds). */
export const CANNED_META = { last_run_initialisation_time: T0 - 6 * 3600, last_run_availability_time: T0 - 2 * 3600, update_interval_seconds: 21600 };

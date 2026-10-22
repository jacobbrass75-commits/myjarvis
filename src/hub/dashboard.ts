import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Dashboard } from "../shared/protocol.js";
import type { Hub } from "./hub.js";
import { google } from "./google/index.js";
import { todayAgenda } from "./google/calendar.js";

// The glanceable home screen: time, weather, today's calendar, a few headlines, agent status.
// Everything here is free and keyless: Open-Meteo for weather, Hacker News for headlines, and for the
// agenda your Google Calendar once it's connected (google/), else the Mac's own Calendar app (AppleScript).

const run = promisify(execFile);
let cache: { weather?: string; agenda: string[]; headlines: string[]; at: number } = { agenda: [], headlines: [], at: 0 };
let location: { lat: number; lon: number; city: string } | null = null;

const WMO: Record<number, string> = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
  51: "drizzle", 53: "drizzle", 55: "drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 80: "showers", 81: "showers", 82: "heavy showers",
  95: "thunderstorm", 96: "thunderstorm", 99: "thunderstorm",
};

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

export async function where() {
  if (location) return location;
  if (process.env.G2_LAT && process.env.G2_LON)
    return (location = { lat: Number(process.env.G2_LAT), lon: Number(process.env.G2_LON), city: process.env.G2_CITY || "" });
  // Coarse location from the public IP (city level). Set G2_LAT/G2_LON to skip this.
  const j = await getJson("http://ip-api.com/json/?fields=lat,lon,city");
  return (location = { lat: j.lat, lon: j.lon, city: j.city });
}

async function weather(): Promise<string | undefined> {
  const loc = await where();
  const unit = process.env.G2_TEMP_UNIT === "celsius" ? "celsius" : "fahrenheit";
  const j = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&temperature_unit=${unit}&timezone=auto`,
  );
  const u = unit === "celsius" ? "°C" : "°F";
  const now = Math.round(j.current.temperature_2m);
  return `${loc.city ? loc.city + " " : ""}${now}${u} ${WMO[j.current.weather_code] ?? ""} · ${Math.round(j.daily.temperature_2m_max[0])}/${Math.round(j.daily.temperature_2m_min[0])}`;
}

async function headlines(): Promise<string[]> {
  const ids: number[] = await getJson("https://hacker-news.firebaseio.com/v0/topstories.json");
  const items = await Promise.all(ids.slice(0, 4).map((id) => getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)));
  return items.map((i) => String(i?.title ?? "")).filter(Boolean);
}

/** Today's remaining events from macOS Calendar. Needs a one-time Automation permission prompt. */
async function agenda(): Promise<string[]> {
  const script = `
set out to ""
set dayEnd to (current date)
set hours of dayEnd to 23
set minutes of dayEnd to 59
tell application "Calendar"
  repeat with c in calendars
    repeat with e in (every event of c whose start date ≥ (current date) and start date ≤ dayEnd)
      set out to out & (time string of (start date of e)) & "|" & (summary of e) & linefeed
    end repeat
  end repeat
end tell
return out`;
  const { stdout } = await run("osascript", ["-e", script], { timeout: 8000 });
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [t, title] = l.split("|");
      return `${t.replace(/:\d\d\s/, " ").replace(/:00 /, " ")} ${title}`;
    })
    .sort()
    .slice(0, 4);
}

/** Google Calendar when connected; the macOS Calendar otherwise, or if Google fails (G2_CALENDAR=0 turns that one off). */
async function calendar(): Promise<string[]> {
  const mac = () => (process.env.G2_CALENDAR === "0" ? Promise.resolve([]) : agenda());
  if (!google.status().connected) return mac();
  return todayAgenda(google).catch((e) => {
    console.warn(`[dashboard] Google Calendar: ${e?.message ?? e}`);
    return mac();
  });
}

export async function dashboard(hub: Hub): Promise<Dashboard> {
  if (Date.now() - cache.at > 10 * 60_000) {
    const [w, h, a] = await Promise.allSettled([weather(), headlines(), calendar()]);
    cache = {
      weather: w.status === "fulfilled" ? w.value : cache.weather,
      headlines: h.status === "fulfilled" ? h.value : cache.headlines,
      agenda: a.status === "fulfilled" ? a.value : cache.agenda,
      at: Date.now(),
    };
  }
  const s = hub.snapshot();
  const busy = s.agents.filter((x) => x.status === "running").length;
  const now = new Date();
  return {
    time: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    date: now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }),
    weather: cache.weather,
    agenda: cache.agenda,
    headlines: cache.headlines,
    agents: `${busy} running · ${s.approvals.length} waiting · ${s.nodes.filter((n) => n.online).length} devices`,
    at: Date.now(),
  };
}

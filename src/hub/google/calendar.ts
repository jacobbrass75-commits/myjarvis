import type { GoogleAuth } from "./auth.js";

// Google Calendar (primary calendar) over its REST API: list events, create one.

const API = "https://www.googleapis.com/calendar/v3/calendars";

export interface CalEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  /** Other people on the invite (not you), by display name or address. */
  attendees: string[];
  link?: string;
}

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** "2026-10-23" (local midnight), "2026-10-23T13:00" (local) or a full ISO time -> Date. */
export function parseLocal(s: string): Date {
  const t = s.trim();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00` : t);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date/time: "${s}" (use YYYY-MM-DDTHH:MM)`);
  return d;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localIso = (d: Date) => `${ymd(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;

function toEvent(e: any): CalEvent {
  const allDay = !!e.start?.date && !e.start?.dateTime;
  return {
    id: String(e.id ?? ""),
    title: String(e.summary ?? "(no title)"),
    start: allDay ? parseLocal(e.start.date) : new Date(e.start?.dateTime),
    end: allDay ? parseLocal(e.end?.date ?? e.start.date) : new Date(e.end?.dateTime ?? e.start?.dateTime),
    allDay,
    location: e.location || undefined,
    attendees: ((e.attendees ?? []) as any[])
      .filter((a) => !a.self && !a.resource && a.responseStatus !== "declined")
      .map((a) => String(a.displayName || a.email || ""))
      .filter(Boolean),
    link: e.hangoutLink || undefined,
  };
}

/** Events overlapping [from, to), soonest first. Declined and cancelled events are left out. */
export async function listEvents(auth: GoogleAuth, from: Date, to: Date, max = 10, q?: string): Promise<CalEvent[]> {
  const j = await auth.request(`${API}/primary/events`, {
    query: { timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, orderBy: "startTime", maxResults: Math.min(Math.max(max, 1), 50), q: q || undefined },
  });
  return ((j?.items ?? []) as any[])
    .filter((e) => e.status !== "cancelled" && !(e.attendees ?? []).some((a: any) => a.self && a.responseStatus === "declined"))
    .map(toEvent);
}

export interface NewEvent {
  title: string;
  /** Local "YYYY-MM-DDTHH:MM" (or "YYYY-MM-DD" with allDay). */
  start: string;
  end?: string;
  durationMinutes?: number;
  allDay?: boolean;
  location?: string;
  attendees?: string[];
  description?: string;
}

/** The Calendar API body for a new event, plus its resolved times for the confirm card. */
export function eventBody(e: NewEvent): { body: any; start: Date; end: Date } {
  const start = parseLocal(e.start);
  if (e.allDay) {
    const endDay = e.end ? parseLocal(e.end) : start;
    const after = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1); // end date is exclusive
    return {
      body: { summary: e.title, location: e.location, description: e.description, start: { date: ymd(start) }, end: { date: ymd(after) }, attendees: e.attendees?.map((email) => ({ email })) },
      start,
      end: after,
    };
  }
  const end = e.end ? parseLocal(e.end) : new Date(start.getTime() + (e.durationMinutes ?? 60) * 60_000);
  if (end <= start) throw new Error("The event has to end after it starts.");
  const tz = localZone();
  return {
    body: {
      summary: e.title,
      location: e.location,
      description: e.description,
      start: { dateTime: localIso(start), timeZone: tz },
      end: { dateTime: localIso(end), timeZone: tz },
      attendees: e.attendees?.map((email) => ({ email })),
    },
    start,
    end,
  };
}

export async function createEvent(auth: GoogleAuth, body: any): Promise<CalEvent> {
  // sendUpdates=none: Calendar never emails invitees on its own; the wearer can share it later.
  return toEvent(await auth.request(`${API}/primary/events`, { method: "POST", body, query: { sendUpdates: "none" } }));
}

// ---------- wording ----------

const clock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(":00", "");
const day = (d: Date) => d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

/** "Fri, Oct 23 1 PM-2 PM: Lunch with Sam (with Sam Lee; at Cafe X)". */
export function eventLine(e: CalEvent): string {
  const when = e.allDay ? `${day(e.start)} all day` : `${day(e.start)} ${clock(e.start)}-${clock(e.end)}`;
  const extra = [e.attendees.length ? `with ${e.attendees.slice(0, 6).join(", ")}${e.attendees.length > 6 ? ` +${e.attendees.length - 6}` : ""}` : "", e.location ? `at ${e.location}` : "", e.link ? "video call" : ""].filter(Boolean);
  return `${when}: ${e.title}${extra.length ? ` (${extra.join("; ")})` : ""}`;
}

/** Today's remaining events as Today-screen lines ("9:30 AM Standup", "NOW Design review"). */
export function agendaLines(events: CalEvent[], now = new Date()): string[] {
  const timed = events.filter((e) => !e.allDay && e.end > now).map((e) => `${e.start <= now ? "NOW" : clock(e.start)} ${e.title}`);
  const allDay = events.filter((e) => e.allDay).map((e) => `ALL DAY ${e.title}`);
  return [...timed, ...allDay].slice(0, 4);
}

export async function todayAgenda(auth: GoogleAuth, now = new Date()): Promise<string[]> {
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return agendaLines(await listEvents(auth, now, dayEnd, 15), now);
}

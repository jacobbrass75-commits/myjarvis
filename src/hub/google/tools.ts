import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { GoogleAuth } from "./auth.js";
import { createEvent, eventBody, eventLine, listEvents, parseLocal } from "./calendar.js";
import type { Confirm } from "./confirm.js";
import { address, createDraft, displayName, getDraft, readThread, replyDraft, search, sendDraft, unreadSince, type Draft, type MailSummary } from "./gmail.js";

// The voice router's Google tools. Reading is free; writing to the world (a new calendar event, an
// email going out) waits for a tap on the glasses, and anything but a tap means no.

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const safely = (f: () => Promise<string>) => f().then(text, (e: any) => text(String(e?.message ?? e)));

const ago = (date: string, now: number) => {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

const mailLines = (list: MailSummary[], now = Date.now()) =>
  list.map((m, i) => `${i + 1}. ${m.important ? "[important] " : ""}${m.from}: "${m.subject}" ${m.snippet.slice(0, 220)} (thread=${m.threadId}, ${ago(m.date, now)})`).join("\n");

/** First few non-empty lines of a body, for the confirm card. */
export const firstLines = (body: string, n = 3) =>
  body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, n).join(" / ").slice(0, 160);

export function googleTools(google: GoogleAuth, confirm: Confirm) {
  return [
    tool(
      "calendar_events",
      "List the wearer's Google Calendar events ('what's my day', 'when's my next meeting', 'am I free Friday afternoon'). Defaults to the next 7 days from now.",
      {
        from: z.string().optional().describe("Local start, YYYY-MM-DD or YYYY-MM-DDTHH:MM; default now"),
        to: z.string().optional().describe("Local end (exclusive), same format; default 7 days after from. For 'my day' use tomorrow's date"),
        query: z.string().optional().describe("Only events matching this text"),
        max: z.number().optional().describe("At most this many, default 10"),
      },
      ({ from, to, query, max }) =>
        safely(async () => {
          const a = from ? parseLocal(from) : new Date();
          const b = to ? parseLocal(to) : new Date(a.getTime() + 7 * 86_400_000);
          const events = await listEvents(google, a, b, max ?? 10, query);
          return events.length ? events.map(eventLine).join("\n") : `No events between ${a.toLocaleString()} and ${b.toLocaleString()}.`;
        }),
    ),
    tool(
      "calendar_add_event",
      "Add an event to the wearer's Google Calendar ('add lunch with Sam Friday at 1'). Work out the exact local date and time from the local time in <state>. A confirm card appears on the glasses; this returns once the wearer taps yes (added) or double-taps / ignores it (not added). Invitees are never emailed.",
      {
        title: z.string(),
        start: z.string().describe("Local start, YYYY-MM-DDTHH:MM (or YYYY-MM-DD for all day)"),
        end: z.string().optional().describe("Local end, same format; default start + duration"),
        duration_minutes: z.number().optional().describe("Default 60"),
        all_day: z.boolean().optional(),
        location: z.string().optional(),
        attendees: z.array(z.string()).optional().describe("Email addresses to put on the invite, only if the wearer gave them"),
      },
      (a) =>
        safely(async () => {
          const { body, start, end } = eventBody({ title: a.title, start: a.start, end: a.end, durationMinutes: a.duration_minutes, allDay: a.all_day, location: a.location, attendees: a.attendees });
          const preview = eventLine({ id: "", title: a.title, start, end, allDay: !!a.all_day, location: a.location, attendees: a.attendees ?? [] });
          const yes = await confirm({ source: "Calendar", action: "ADD EVENT", summary: preview });
          if (!yes) return "Not added: the wearer said no or didn't answer.";
          const e = await createEvent(google, body);
          return `Added: ${eventLine(e)}`;
        }),
    ),
    tool(
      "gmail_important",
      "'Anything important?': the wearer's unread inbox mail from the last few hours (no promotions/social). Summarize for the lens: at most 4 short lines, each 'Sender: gist', most important first; skip automated mail unless it is urgent. Say 'nothing important' if so.",
      { hours: z.number().optional().describe("How far back, default 12"), max: z.number().optional().describe("Default 15") },
      ({ hours, max }) =>
        safely(async () => {
          const list = await unreadSince(google, hours ?? 12, max ?? 15);
          return list.length ? mailLines(list) : `No unread mail in the last ${hours ?? 12} hours.`;
        }),
    ),
    tool(
      "gmail_search",
      "Find emails with a Gmail search ('from:sam', 'subject:invoice newer_than:7d', 'the email from Sam about the lease').",
      { query: z.string().describe("Gmail search syntax"), max: z.number().optional().describe("Default 8") },
      ({ query, max }) =>
        safely(async () => {
          const list = await search(google, query, max ?? 8);
          return list.length ? mailLines(list) : "No emails match.";
        }),
    ),
    tool(
      "gmail_read_thread",
      "Read an email thread (its newest messages, quoted history removed). Give the gist in a sentence or two unless asked to read it out.",
      { thread_id: z.string() },
      ({ thread_id }) =>
        safely(async () => {
          const msgs = await readThread(google, thread_id);
          if (!msgs.length) return "That thread is empty.";
          return [`Subject: ${msgs[0].subject}`, ...msgs.slice(-4).map((m) => `--- ${m.from} (${m.date}) to ${m.to}${m.cc ? `, cc ${m.cc}` : ""}\n${m.body.slice(0, 1500)}`)].join("\n");
        }),
    ),
    tool(
      "gmail_draft",
      "Write an email draft in the wearer's Gmail: a reply to a thread (give reply_to_thread) or a new email (give to and subject). Write the body the way the wearer would, short, signed with nothing. This does NOT send. If the wearer asked to send it, call gmail_send_draft next; otherwise tell them it's in Drafts.",
      {
        body: z.string(),
        reply_to_thread: z.string().optional().describe("Thread id from gmail_important / gmail_search"),
        to: z.string().optional().describe("For a new email: the address(es)"),
        cc: z.string().optional(),
        subject: z.string().optional(),
      },
      (a) =>
        safely(async () => {
          let d: Draft, threadId: string | undefined;
          if (a.reply_to_thread) {
            const thread = await readThread(google, a.reply_to_thread);
            d = { ...replyDraft(thread, a.body, google.status().email), ...(a.cc ? { cc: a.cc } : {}) };
            threadId = a.reply_to_thread;
          } else {
            if (!a.to || !a.subject) return "For a new email I need the recipient's address and a subject.";
            if (!/@/.test(a.to)) return `"${a.to}" isn't an email address; find it first (gmail_search) or ask.`;
            d = { to: a.to, cc: a.cc, subject: a.subject, body: a.body };
          }
          const { id } = await createDraft(google, d, threadId);
          return `Draft saved (draft_id=${id}) to ${d.to}, subject "${d.subject}".`;
        }),
    ),
    tool(
      "gmail_send_draft",
      "Send a Gmail draft. The glasses show a confirm card with the recipient and first lines; it is sent only if the wearer taps yes, never otherwise. Use only when the wearer asked to send.",
      { draft_id: z.string() },
      ({ draft_id }) =>
        safely(async () => {
          // The card shows what Gmail will actually send, not what we meant to write.
          const d = await getDraft(google, draft_id);
          if (!d.to) return "That draft has no recipient; not sent.";
          const who = d.to.split(",").map((x) => address(x.trim())).join(", ");
          const yes = await confirm({ source: "Gmail", action: `SEND to ${who}`.slice(0, 80), summary: `${d.subject}\n${firstLines(d.body)}` });
          if (!yes) return "Not sent: the wearer said no or didn't answer. The draft is still in Gmail.";
          await sendDraft(google, draft_id);
          return `Sent to ${d.to.split(",").map((x) => displayName(x.trim())).join(", ")}.`;
        }),
    ),
  ];
}

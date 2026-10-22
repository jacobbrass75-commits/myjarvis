import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GoogleAuth, GoogleError } from "./auth.js";
import { listEvents, type CalEvent } from "./calendar.js";

// The hub's Google account: one GoogleAuth for everything, the connect/disconnect routes, and the
// meeting watcher that tells the copilot who is about to be in the room.

export const google = new GoogleAuth();

const json = (res: ServerResponse, code: number, body: unknown) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
const isLocal = (req: IncomingMessage) => /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress ?? "");

/** Open the consent page in this Mac's default browser (the loopback redirect only works here). */
export const openOnMac = (url: string) => execFile("open", [url], () => {});

/** Start a connect flow; logs only the outcome (never the URL's state or any code). */
async function connect(): Promise<string> {
  const { url, done } = await google.beginConnect();
  done.then(
    (email) => console.log(`[google] connected as ${email}`),
    (e) => console.warn(`[google] connect failed: ${e?.message ?? e}`),
  );
  return url;
}

/**
 * GET /google/connect?token=…: in a browser on the Mac, straight to Google's consent page; from any
 * other device, the page opens in the Mac's browser instead. Returns false if the path isn't ours.
 */
export async function googleRoute(req: IncomingMessage, res: ServerResponse, url: URL, tokenOk: (t: unknown) => boolean): Promise<boolean> {
  if (url.pathname !== "/google/connect") return false;
  if (!tokenOk(req.headers["x-hub-token"] ?? url.searchParams.get("token"))) return json(res, 401, { error: "unauthorized" }), true;
  try {
    const consent = await connect();
    if (isLocal(req)) res.writeHead(302, { Location: consent, "Cache-Control": "no-store" }).end();
    else {
      openOnMac(consent);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font:16px -apple-system,sans-serif;margin:40px"><h2>Finish on your Mac</h2><p>Google's sign-in page just opened in the Mac's browser. Google sends you back to the Mac itself (127.0.0.1), so it has to be finished there.</p></body>`,
      );
    }
  } catch (e: any) {
    json(res, e instanceof GoogleError ? 400 : 500, { error: String(e?.message ?? e) });
  }
  return true;
}

/** /api/google/{status,connect,disconnect} (the caller already checked the hub token). */
export async function googleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /api/google/status") return json(res, 200, { ...google.status(), connecting: google.connecting }), true;
    if (route === "POST /api/google/connect") {
      openOnMac(await connect());
      return json(res, 200, { ok: true, opened: "mac" }), true;
    }
    if (route === "POST /api/google/disconnect") {
      await google.disconnect();
      console.log("[google] disconnected");
      return json(res, 200, { ok: true }), true;
    }
  } catch (e: any) {
    return json(res, e instanceof GoogleError ? 400 : 500, { error: String(e?.message ?? e) }), true;
  }
  return false;
}

// ---------- meeting watcher ----------

/** The meeting the copilot should know about now: timed, with other people, starting within 10 min or under way. */
export function meetingSoon(events: CalEvent[], now = new Date()): CalEvent | undefined {
  return events.find((e) => !e.allDay && e.attendees.length > 0 && e.end > now && e.start.getTime() - now.getTime() <= 10 * 60_000);
}

export function meetingContext(e: CalEvent): string {
  const at = e.start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `Calendar: "${e.title}" at ${at} with ${e.attendees.join(", ")}. People speaking are likely these attendees.`;
}

/** Every few minutes, set (or clear) the copilot's meeting line from Google Calendar. Quiet when not connected. */
export function watchMeetings(setContext: (text: string) => void, auth = google, everyMs = 4 * 60_000): () => void {
  let last = "";
  const tick = async () => {
    if (!auth.status().connected) return;
    try {
      const now = new Date();
      const e = meetingSoon(await listEvents(auth, now, new Date(now.getTime() + 15 * 60_000), 5), now);
      const ctx = e ? meetingContext(e) : "";
      if (ctx !== last) {
        last = ctx;
        setContext(ctx);
        if (e) console.log(`[google] copilot primed for a meeting with ${e.attendees.length} attendee(s)`);
      }
    } catch {} // the next tick tries again; tools report errors where someone sees them
  };
  void tick();
  const t = setInterval(tick, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

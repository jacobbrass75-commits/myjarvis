// Google Calendar + Gmail with every Google endpoint mocked: nothing here talks to Google, sends an
// email or creates an event. Run: npm run google:test
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GoogleAuth, GoogleError, NOT_CONFIGURED, NOT_CONNECTED } from "../src/hub/google/auth.js";
import { agendaLines, eventBody, listEvents } from "../src/hub/google/calendar.js";
import { glassesConfirm } from "../src/hub/google/confirm.js";
import { rawMessage, readThread, replyDraft, stripQuoted, unreadSince } from "../src/hub/google/gmail.js";
import { meetingContext, meetingSoon } from "../src/hub/google/index.js";
import { googleTools } from "../src/hub/google/tools.js";
import { Hub } from "../src/hub/hub.js";

type Call = { method: string; url: URL; body: any; auth?: string };
type Route = (c: Call) => { status?: number; json?: unknown } | undefined;

/** A fake fetch for Google's endpoints: routes see each call; every call is recorded. */
function mockGoogle(route: Route) {
  const calls: Call[] = [];
  const fetchFn = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const raw = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body ? JSON.parse(init.body) : undefined;
    const call: Call = { method: init.method ?? "GET", url, body: raw, auth: init.headers?.Authorization };
    calls.push(call);
    const r = route(call) ?? { status: 404, json: { error: { message: `no mock for ${call.method} ${url.pathname}` } } };
    return new Response(r.status === 204 ? null : JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const tokenRoute = (n = { i: 0 }): Route => (c) => {
  if (c.url.href === "https://oauth2.googleapis.com/token" && c.body.grant_type === "refresh_token") {
    n.i++;
    return { json: { access_token: `at-${n.i}`, expires_in: 3600 } };
  }
};

function setup(route: Route, opts: { connected?: boolean; email?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "g2-google-"));
  const tokenFile = join(dir, "google-token.json");
  if (opts.connected !== false) writeFileSync(tokenFile, JSON.stringify({ refresh_token: "rt-1", email: opts.email ?? "me@example.com" }), { mode: 0o600 });
  const refreshes = { i: 0 };
  const tr = tokenRoute(refreshes);
  const { fetchFn, calls } = mockGoogle((c) => tr(c) ?? route(c));
  const auth = new GoogleAuth({ clientId: "cid.apps.googleusercontent.com", clientSecret: "test-secret", tokenFile, fetch: fetchFn });
  return { auth, calls, tokenFile, refreshes };
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const api = (c: Call) => c.url.hostname.endsWith("googleapis.com") && c.url.hostname !== "oauth2.googleapis.com";

// ---------- auth ----------

test("clear errors when not set up or not connected", async () => {
  const noClient = new GoogleAuth({ clientId: "", clientSecret: "", tokenFile: "/nonexistent/x.json" });
  await assert.rejects(noClient.accessToken(), (e: any) => e instanceof GoogleError && e.message === NOT_CONFIGURED);
  const { auth } = setup(() => undefined, { connected: false });
  assert.deepEqual(auth.status(), { configured: true, connected: false, email: undefined, error: undefined });
  await assert.rejects(auth.accessToken(), (e: any) => e.message === NOT_CONNECTED);
});

test("token refresh: cached until near expiry, retried once on 401, rotated refresh token saved", async () => {
  let first = true;
  const { auth, calls, refreshes } = setup((c) => {
    if (c.url.pathname.endsWith("/profile")) {
      if (first) return (first = false), { status: 401, json: {} };
      return { json: { emailAddress: "me@example.com", auth: c.auth } };
    }
  });
  const tokenCalls = () => calls.filter((c) => c.url.hostname === "oauth2.googleapis.com");
  const p = await auth.request("https://gmail.googleapis.com/gmail/v1/users/me/profile");
  assert.equal(p.auth, "Bearer at-2", "401 -> refreshed -> retried with the new token");
  assert.equal(refreshes.i, 2);
  const body = tokenCalls()[0].body;
  assert.deepEqual(body, { grant_type: "refresh_token", refresh_token: "rt-1", client_id: "cid.apps.googleusercontent.com", client_secret: "test-secret" });
  await auth.request("https://gmail.googleapis.com/gmail/v1/users/me/profile");
  assert.equal(refreshes.i, 2, "access token reused while valid");

  // Google rotates the refresh token: it is stored (mode 600) and used from then on.
  const rot = setup(() => undefined);
  const { fetchFn } = mockGoogle((c) => (c.url.hostname === "oauth2.googleapis.com" ? { json: { access_token: "at-x", refresh_token: "rt-2", expires_in: 1 } } : undefined));
  const a2 = new GoogleAuth({ clientId: "c", clientSecret: "s", tokenFile: rot.tokenFile, fetch: fetchFn });
  await a2.accessToken();
  assert.equal(JSON.parse(readFileSync(rot.tokenFile, "utf8")).refresh_token, "rt-2");
  assert.equal(statSync(rot.tokenFile).mode & 0o777, 0o600);
});

test("revoked / expired refresh token -> clear reconnect message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "g2-google-"));
  const tokenFile = join(dir, "t.json");
  writeFileSync(tokenFile, JSON.stringify({ refresh_token: "rt-old" }));
  const { fetchFn } = mockGoogle(() => ({ status: 400, json: { error: "invalid_grant" } }));
  const auth = new GoogleAuth({ clientId: "c", clientSecret: "s", tokenFile, fetch: fetchFn });
  await assert.rejects(auth.accessToken(), /expired or was revoked.*google:connect/);
  assert.match(auth.status().error ?? "", /expired/);
});

test("connect: loopback redirect + PKCE, refresh token stored with mode 600, wrong state refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "g2-google-"));
  const tokenFile = join(dir, "sub", "google-token.json");
  let challenge = "";
  const { fetchFn, calls } = mockGoogle((c) => {
    if (c.url.href === "https://oauth2.googleapis.com/token") {
      assert.equal(c.body.grant_type, "authorization_code");
      assert.equal(c.body.code, "the-code");
      assert.equal(createHash("sha256").update(c.body.code_verifier).digest("base64url"), challenge, "verifier matches the challenge");
      assert.match(c.body.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
      return { json: { access_token: "at", refresh_token: "rt-new", expires_in: 3600, scope: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send" } };
    }
    if (c.url.pathname.endsWith("/profile")) return { json: { emailAddress: "me@example.com" } };
  });
  const auth = new GoogleAuth({ clientId: "cid", clientSecret: "sec", tokenFile, fetch: fetchFn });
  const { url, done } = await auth.beginConnect(10_000);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.deepEqual(u.searchParams.get("scope")!.split(" ").map((s) => s.split("/").pop()), ["calendar.readonly", "calendar.events", "gmail.readonly", "gmail.compose", "gmail.send"]);
  challenge = u.searchParams.get("code_challenge")!;
  const redirect = u.searchParams.get("redirect_uri")!;
  const bad = await fetch(`${redirect}?code=x&state=wrong`);
  assert.equal(bad.status, 400);
  const ok = await fetch(`${redirect}?code=the-code&state=${u.searchParams.get("state")}`);
  assert.equal(ok.status, 200);
  assert.equal(await done, "me@example.com");
  const saved = JSON.parse(readFileSync(tokenFile, "utf8"));
  assert.equal(saved.refresh_token, "rt-new");
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert.deepEqual(auth.status(), { configured: true, connected: true, email: "me@example.com", error: undefined });
  assert.equal(auth.connecting, false, "loopback server closed");
  assert.equal(calls.filter((c) => c.url.hostname === "oauth2.googleapis.com").length, 1);

  // Disconnect revokes at Google and deletes the file.
  await auth.disconnect();
  const revoke = calls.find((c) => c.url.href === "https://oauth2.googleapis.com/revoke");
  assert.equal(revoke?.body.token, "rt-new");
  assert.equal(auth.status().connected, false);
});

// ---------- calendar ----------

const at = (h: number, m = 0, dayOffset = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d;
};

test("calendar list: query, declined/cancelled dropped, attendees without me", async () => {
  const from = at(8), to = at(0, 0, 1);
  const { auth, calls } = setup((c) => {
    if (c.url.pathname === "/calendar/v3/calendars/primary/events" && c.method === "GET")
      return {
        json: {
          items: [
            { id: "1", summary: "Standup", start: { dateTime: at(9, 30).toISOString() }, end: { dateTime: at(10).toISOString() }, attendees: [{ email: "me@example.com", self: true }, { email: "sam@example.com", displayName: "Sam Lee" }, { email: "room@resource.calendar.google.com", resource: true }] },
            { id: "2", summary: "Skipped", start: { dateTime: at(11).toISOString() }, end: { dateTime: at(12).toISOString() }, attendees: [{ email: "me@example.com", self: true, responseStatus: "declined" }] },
            { id: "3", status: "cancelled", summary: "Gone", start: { dateTime: at(13).toISOString() }, end: { dateTime: at(14).toISOString() } },
            { id: "4", summary: "Holiday", start: { date: "2026-10-21" }, end: { date: "2026-10-22" } },
          ],
        },
      };
  });
  const events = await listEvents(auth, from, to, 10);
  const q = calls.find(api)!.url.searchParams;
  assert.equal(q.get("singleEvents"), "true");
  assert.equal(q.get("orderBy"), "startTime");
  assert.equal(q.get("timeMin"), from.toISOString());
  assert.deepEqual(events.map((e) => e.title), ["Standup", "Holiday"]);
  assert.deepEqual(events[0].attendees, ["Sam Lee"]);
  assert.equal(events[1].allDay, true);
  // Today-screen lines: in progress = NOW, all-day last.
  const lines = agendaLines(events, at(9, 45));
  assert.equal(lines[0], "NOW Standup");
  assert.equal(lines[1], "ALL DAY Holiday");
  assert.match(agendaLines(events, at(9))[0], /^9:30\s?AM Standup$/i);
  // Copilot primer for the meeting about to start.
  const soon = meetingSoon(events, at(9, 25));
  assert.equal(soon?.title, "Standup");
  assert.match(meetingContext(soon!), /with Sam Lee/);
  assert.equal(meetingSoon(events, at(9, 10)), undefined, "more than 10 min out");
});

test("calendar event body: local time + zone, default 1 h, all-day end exclusive", () => {
  const { body } = eventBody({ title: "Lunch with Sam", start: "2026-10-23T13:00" });
  assert.equal(body.start.dateTime, "2026-10-23T13:00:00");
  assert.equal(body.end.dateTime, "2026-10-23T14:00:00");
  assert.ok(body.start.timeZone);
  const allDay = eventBody({ title: "Trip", start: "2026-10-23", allDay: true });
  assert.deepEqual([allDay.body.start.date, allDay.body.end.date], ["2026-10-23", "2026-10-24"]);
  assert.throws(() => eventBody({ title: "x", start: "2026-10-23T13:00", end: "2026-10-23T12:00" }), /end after/);
});

/** googleTools with a real Hub and the real glasses confirm card. */
function toolkit(route: Route, timeoutMs = 5000) {
  const s = setup(route);
  const hub = new Hub([]);
  const tools = googleTools(s.auth, glassesConfirm(hub, timeoutMs));
  const call = (name: string, args: any) => tools.find((t) => t.name === name)!.handler(args, {}).then((r: any) => r.content[0].text as string);
  /** Wait for the confirm card, then return it. */
  const card = async () => {
    for (let i = 0; i < 100; i++) {
      const a = hub.snapshot().approvals[0];
      if (a) return a;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no confirm card");
  };
  return { ...s, hub, call, card };
}

test("calendar create: written only after a tap; the router can't answer the card", async () => {
  const { call, card, hub, calls } = toolkit((c) => {
    if (c.method === "POST" && c.url.pathname.endsWith("/primary/events"))
      return { json: { id: "new", summary: c.body.summary, start: { dateTime: "2026-10-23T13:00:00-07:00" }, end: { dateTime: "2026-10-23T14:00:00-07:00" } } };
  });
  const pending = call("calendar_add_event", { title: "Lunch with Sam", start: "2026-10-23T13:00" });
  const c = await card();
  assert.equal(c.tool, "ADD EVENT");
  assert.equal(c.agentName, "Calendar");
  assert.match(c.summary, /Lunch with Sam/);
  assert.equal(calls.filter((x) => x.method === "POST" && api(x)).length, 0, "nothing written before the tap");
  assert.equal(hub.resolve(c.id, "allow", undefined, "router"), false, "router can't approve");
  assert.equal(hub.resolve(c.id, "allow", undefined, "node"), false, "a device daemon can't either");
  assert.equal(hub.resolve(c.id, "allow", undefined, "glasses"), true);
  assert.match(await pending, /^Added: .*Lunch with Sam/);
  const post = calls.find((x) => x.method === "POST" && api(x))!;
  assert.equal(post.url.searchParams.get("sendUpdates"), "none");
  assert.equal(post.body.start.dateTime, "2026-10-23T13:00:00");

  const no = call("calendar_add_event", { title: "Dentist", start: "2026-10-24T09:00" });
  hub.resolve((await card()).id, "deny", undefined, "glasses");
  assert.match(await no, /Not added/);
  assert.equal(calls.filter((x) => x.method === "POST" && api(x)).length, 1);
});

// ---------- gmail ----------

const thread = {
  id: "t1",
  messages: [
    {
      id: "m1",
      threadId: "t1",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: "Sam Lee <sam@example.com>" },
          { name: "To", value: "me@example.com" },
          { name: "Subject", value: "Lunch Friday?" },
          { name: "Message-ID", value: "<abc@mail.example.com>" },
          { name: "Date", value: "Wed, 21 Oct 2026 09:00:00 -0700" },
        ],
        parts: [
          { mimeType: "text/plain", body: { data: b64("Are you free Friday at 1?\n\nOn Tue, Oct 20, 2026 Me <me@example.com> wrote:\n> old stuff") } },
          { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
        ],
      },
    },
  ],
};

test("gmail: unread list query, thread read without quoted history", async () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const { auth, calls } = setup((c) => {
    if (c.url.pathname.endsWith("/messages")) return { json: { messages: [{ id: "m1" }] } };
    if (c.url.pathname.endsWith("/messages/m1"))
      return { json: { id: "m1", threadId: "t1", labelIds: ["UNREAD", "IMPORTANT"], snippet: "Are you free Friday at 1? &amp; more", payload: { headers: thread.messages[0].payload.headers } } };
    if (c.url.pathname.endsWith("/threads/t1")) return { json: thread };
  });
  const list = await unreadSince(auth, 6, 10, now);
  const q = calls.find((c) => c.url.pathname.endsWith("/messages"))!.url.searchParams.get("q")!;
  assert.match(q, /is:unread/);
  assert.match(q, new RegExp(`after:${Math.floor((now - 6 * 3_600_000) / 1000)}`));
  assert.match(q, /-category:promotions/);
  assert.deepEqual(calls.find((c) => c.url.pathname.endsWith("/messages/m1"))!.url.searchParams.getAll("metadataHeaders"), ["From", "Subject", "Date"]);
  assert.deepEqual([list[0].from, list[0].subject, list[0].snippet, list[0].important], ["Sam Lee <sam@example.com>", "Lunch Friday?", "Are you free Friday at 1? & more", true]);
  const msgs = await readThread(auth, "t1");
  assert.equal(msgs[0].body, "Are you free Friday at 1?");
  assert.equal(stripQuoted("hi\n> quoted\nthere"), "hi\nthere");
});

test("gmail reply draft: To, Re: subject, threading headers; no header injection", () => {
  const d = replyDraft(
    [{ id: "m1", from: "Sam Lee <sam@example.com>", to: "me@example.com", cc: "", replyTo: "", subject: "Lunch Friday?", date: "", messageId: "<abc@x>", references: "", body: "" }],
    "Yes, see you at 1.",
    "me@example.com",
  );
  assert.deepEqual([d.to, d.subject, d.inReplyTo, d.references], ["Sam Lee <sam@example.com>", "Re: Lunch Friday?", "<abc@x>", "<abc@x>"]);
  const raw = Buffer.from(rawMessage({ ...d, subject: "Hi\r\nBcc: evil@example.com" }), "base64url").toString("utf8");
  assert.match(raw, /^To: Sam Lee <sam@example\.com>\r\n/);
  assert.doesNotMatch(raw, /\r\nBcc:/);
  const [, body] = raw.split("\r\n\r\n");
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "Yes, see you at 1.");
  assert.match(Buffer.from(rawMessage({ to: "a@b.c", subject: "Café", body: "x" }), "base64url").toString(), /Subject: =\?UTF-8\?B\?/);
});

/** Gmail with one thread and a drafts store; sends are recorded, never performed. */
function gmailToolkit(timeoutMs?: number) {
  const drafts = new Map<string, string>();
  const sent: string[] = [];
  const kit = toolkit((c) => {
    if (c.url.pathname.endsWith("/threads/t1")) return { json: thread };
    if (c.method === "POST" && c.url.pathname.endsWith("/drafts")) {
      const id = `d${drafts.size + 1}`;
      drafts.set(id, c.body.message.raw);
      assert.equal(c.body.message.threadId, "t1");
      return { json: { id } };
    }
    const g = c.url.pathname.match(/\/drafts\/(d\d+)$/);
    if (g && c.method === "GET") {
      const raw = Buffer.from(drafts.get(g[1])!, "base64url").toString("utf8");
      const [head, body] = raw.split("\r\n\r\n");
      const headers = head.split("\r\n").map((l) => ({ name: l.split(": ")[0], value: l.split(": ").slice(1).join(": ") }));
      return { json: { id: g[1], message: { payload: { mimeType: "text/plain", headers, body: { data: Buffer.from(Buffer.from(body.replace(/\r\n/g, ""), "base64")).toString("base64url") } } } } };
    }
    if (c.method === "POST" && c.url.pathname.endsWith("/drafts/send")) {
      sent.push(c.body.id);
      return { json: { id: "sent1", threadId: "t1" } };
    }
  }, timeoutMs);
  return { ...kit, sent };
}

test("gmail send: card shows recipient + first lines; sends only on a tap", async () => {
  const { call, card, hub, sent } = gmailToolkit();
  const drafted = await call("gmail_draft", { reply_to_thread: "t1", body: "Yes, Friday at 1 works.\nSee you there." });
  const id = drafted.match(/draft_id=(\w+)/)![1];
  assert.equal(sent.length, 0, "drafting never sends");

  const go = call("gmail_send_draft", { draft_id: id });
  const c = await card();
  assert.equal(c.agentName, "Gmail");
  assert.equal(c.tool, "SEND to sam@example.com");
  assert.equal(c.summary, "Re: Lunch Friday?\nYes, Friday at 1 works. / See you there.");
  assert.equal(hub.resolve(c.id, "allow", undefined, "router"), false);
  assert.equal(sent.length, 0);
  hub.resolve(c.id, "allow", undefined, "glasses");
  assert.equal(await go, "Sent to Sam Lee.");
  assert.deepEqual(sent, [id]);

  // Double tap = cancel.
  const again = call("gmail_send_draft", { draft_id: id });
  hub.resolve((await card()).id, "deny", "Denied from glasses.", "glasses");
  assert.match(await again, /Not sent/);
  assert.equal(sent.length, 1);
});

test("gmail send: no answer before the timeout = cancelled, card removed", async () => {
  const { call, card, hub, sent } = gmailToolkit(80);
  const id = (await call("gmail_draft", { reply_to_thread: "t1", body: "ok" })).match(/draft_id=(\w+)/)![1];
  const go = call("gmail_send_draft", { draft_id: id });
  await card();
  assert.match(await go, /Not sent.*didn't answer/);
  assert.equal(sent.length, 0);
  assert.equal(hub.snapshot().approvals.length, 0);
});

test("gmail draft: a new email needs a real address", async () => {
  const { call } = gmailToolkit();
  assert.match(await call("gmail_draft", { to: "Sam", subject: "Hi", body: "x" }), /isn't an email address/);
  assert.match(await call("gmail_draft", { body: "x" }), /need the recipient/);
});

test("tools report Google errors as plain text", async () => {
  const { call } = toolkit((c) => (api(c) ? { status: 403, json: { error: { message: "Gmail API has not been used in project 123 before or it is disabled." } } } : undefined));
  assert.match(await call("gmail_important", {}), /^Google gmail error 403: Gmail API has not been used/);
});

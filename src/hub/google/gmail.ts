import type { GoogleAuth } from "./auth.js";

// Gmail over its REST API: list/search messages, read a thread, write drafts, send a draft.
// Bodies are only ever returned to the caller (the voice router); nothing here logs them.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  important: boolean;
}

const header = (m: any, name: string): string =>
  String(((m?.payload?.headers ?? []) as any[]).find((h) => String(h.name).toLowerCase() === name.toLowerCase())?.value ?? "");

/** "Sam Lee <sam@x.com>" -> "Sam Lee"; a bare address stays as is. */
export const displayName = (from: string) => from.replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "").trim() || from;
/** The address part of "Sam Lee <sam@x.com>". */
export const address = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim();

const decodeEntities = (s: string) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

/** Message ids matching a Gmail search, newest first, with sender, subject and Gmail's snippet. */
export async function search(auth: GoogleAuth, q: string, max = 15): Promise<MailSummary[]> {
  const list = await auth.request(`${API}/messages`, { query: { q, maxResults: Math.min(Math.max(max, 1), 30) } });
  const ids: { id: string }[] = list?.messages ?? [];
  const msgs = await Promise.all(
    ids.map((m) => auth.request(`${API}/messages/${encodeURIComponent(m.id)}`, { query: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] } })),
  );
  return msgs.map((m: any) => ({
    id: String(m.id),
    threadId: String(m.threadId),
    from: header(m, "From"),
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    snippet: decodeEntities(String(m.snippet ?? "")),
    important: ((m.labelIds ?? []) as string[]).includes("IMPORTANT"),
  }));
}

/** Unread mail from the last `hours`, leaving out promotions, social and forums. */
export function unreadSince(auth: GoogleAuth, hours: number, max = 15, now = Date.now()) {
  const after = Math.floor((now - hours * 3_600_000) / 1000);
  return search(auth, `is:unread after:${after} -category:promotions -category:social -category:forums in:inbox`, max);
}

// ---------- reading ----------

const unb64 = (s: string) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** The readable text of a message: text/plain if there is one, else de-tagged HTML. */
export function bodyText(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => {
    if (!p) return;
    parts.push(p);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return unb64(plain.body.data);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (!html) return "";
  return decodeEntities(
    unb64(html.body.data)
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

/** Drop quoted history ("On … wrote:" and "> " lines) and squeeze blank lines. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .{4,200}wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim()) || /^From: .+/.test(l) && out.length > 3) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l.trimEnd());
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  subject: string;
  date: string;
  messageId: string;
  references: string;
  body: string;
}

export async function readThread(auth: GoogleAuth, threadId: string): Promise<ThreadMessage[]> {
  const t = await auth.request(`${API}/threads/${encodeURIComponent(threadId)}`, { query: { format: "full" } });
  return ((t?.messages ?? []) as any[]).map((m) => ({
    id: String(m.id),
    from: header(m, "From"),
    to: header(m, "To"),
    cc: header(m, "Cc"),
    replyTo: header(m, "Reply-To"),
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    messageId: header(m, "Message-ID") || header(m, "Message-Id"),
    references: header(m, "References"),
    body: stripQuoted(bodyText(m.payload)),
  }));
}

// ---------- writing ----------

/** RFC 2047 for non-ASCII header values. */
const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim(); // no header injection

export interface Draft {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

/** A plain-text RFC 2822 message, base64url as Gmail's `raw` wants it. */
export function rawMessage(d: Draft): string {
  const headers = [
    `To: ${clean(d.to)}`,
    d.cc ? `Cc: ${clean(d.cc)}` : "",
    `Subject: ${encodeHeader(clean(d.subject))}`,
    d.inReplyTo ? `In-Reply-To: ${clean(d.inReplyTo)}` : "",
    d.references ? `References: ${clean(d.references)}` : "",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  const body = (Buffer.from(d.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

/** A reply to the newest message in a thread from someone else: To = their Reply-To/From, "Re:" subject, threading headers. */
export function replyDraft(thread: ThreadMessage[], body: string, me?: string): Draft & { threadId?: string } {
  const mine = (m: ThreadMessage) => !!me && address(m.from).toLowerCase() === me.toLowerCase();
  const last = [...thread].reverse().find((m) => !mine(m)) ?? thread[thread.length - 1];
  if (!last) throw new Error("That thread is empty.");
  const subject = /^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`;
  const refs = [last.references, last.messageId].filter(Boolean).join(" ");
  return { to: mine(last) ? last.to : last.replyTo || last.from, subject, body, inReplyTo: last.messageId || undefined, references: refs || undefined };
}

export async function createDraft(auth: GoogleAuth, d: Draft, threadId?: string): Promise<{ id: string }> {
  const r = await auth.request(`${API}/drafts`, { method: "POST", body: { message: { raw: rawMessage(d), ...(threadId ? { threadId } : {}) } } });
  return { id: String(r.id) };
}

/** What a draft will actually send: recipients, subject, text. */
export async function getDraft(auth: GoogleAuth, id: string): Promise<{ to: string; cc: string; subject: string; body: string }> {
  const r = await auth.request(`${API}/drafts/${encodeURIComponent(id)}`, { query: { format: "full" } });
  const m = r?.message;
  return { to: header(m, "To"), cc: header(m, "Cc"), subject: header(m, "Subject"), body: bodyText(m?.payload) };
}

export async function sendDraft(auth: GoogleAuth, id: string): Promise<{ id: string; threadId: string }> {
  const r = await auth.request(`${API}/drafts/send`, { method: "POST", body: { id } });
  return { id: String(r?.id ?? ""), threadId: String(r?.threadId ?? "") };
}

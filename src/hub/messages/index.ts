import type { WebSocket } from "ws";
import { type HubMsg, type ListenPurpose, type MessageItem, clip, send } from "../../shared/protocol.js";
import { type Confirm, glassesConfirm } from "../google/confirm.js";
import type { Hub } from "../hub.js";
import { CHAT_DB, ChatDb, OpenError, nodeBinary, type RawMessage } from "./chatdb.js";
import { Contacts, norm, prettyHandle } from "./contacts.js";
import { type Runner, SendError, type SendTarget, osascript, sendText } from "./send.js";

// Texts and iMessages on the glasses, through this Mac's Messages app (same Apple ID as the phone;
// SMS too when Text Message Forwarding is on). New rows in chat.db pop up as a card on the lens,
// unless the wearer is in a conversation mode or do not disturb (then they only raise a badge).
// Replies are voice: the router's send_message puts a confirm card on the glasses and nothing is
// sent until it is tapped. Privacy: message bodies, names and numbers never go to the hub log, and
// only the last KEEP messages are held, in memory.

const KEEP = 50;
const POLL_MS = 2000;
const RETRY_MS = 60_000;
const CONTACTS_MS = 30 * 60_000;
/** "reply: …" goes to the chat the glasses showed in the last few minutes, else the latest incoming. */
const FOCUS_MS = 5 * 60_000;
const CONFIRM_MS = Number(process.env.MESSAGES_CONFIRM_TIMEOUT_S || 45) * 1000;
/** Listening sessions that mean "I'm in a conversation": no popups. */
const BUSY: ListenPurpose[] = ["translate", "copilot", "teleprompter"];
const MAX_TEXT = 1000;

export interface MessagesOptions {
  dbPath?: string;
  contactsDir?: string;
  /** osascript; tests pass a fake. */
  run?: Runner;
  /** The yes/no card (default: the shared glasses confirm card). */
  confirm?: Confirm;
  pollMs?: number;
  listening?: () => ListenPurpose | null;
  log?: (s: string) => void;
}

export interface Recipient {
  /** Who, as the card and the voice reply say it. */
  name: string;
  /** Number, email or "group chat", for the card. */
  detail: string;
  target: SendTarget;
}

interface ChatInfo {
  identifier: string;
  service: string;
  group?: string;
  /** The other person, for one-to-one chats. */
  name?: string;
}

export class Messages {
  /** Newest first, at most KEEP. */
  history: MessageItem[] = [];
  /** Arrived without a popup and not seen in MESSAGES yet. */
  queued = 0;
  dnd = false;
  /** Why messages can't be read right now (shown on the lens), "" when fine. */
  issue = "";
  private db: ChatDb | null = null;
  private contacts: Contacts;
  private last = 0;
  private timer?: NodeJS.Timeout;
  private retryAt = 0;
  private focus: { chat: string; at: number } | null = null;
  private chats = new Map<string, ChatInfo>();
  private logged = new Set<string>();
  private confirm: Confirm;
  private run: Runner;
  private log: (s: string) => void;
  /** Sends waiting on a tap, and the ones in flight (tests wait on them). */
  pending = new Set<Promise<void>>();

  constructor(private hub: Hub, private o: MessagesOptions = {}) {
    this.contacts = new Contacts(o.contactsDir);
    this.confirm = o.confirm ?? glassesConfirm(hub, CONFIRM_MS);
    this.run = o.run ?? osascript;
    this.log = o.log ?? ((s) => console.log(`[messages] ${s}`));
  }

  start() {
    this.open();
    this.timer = setInterval(() => this.poll(), this.o.pollMs ?? POLL_MS);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.db?.close();
    this.db = null;
  }

  private once(key: string, ...lines: string[]) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    for (const l of lines) this.log(l);
  }

  private listening(): ListenPurpose | null {
    return this.o.listening ? this.o.listening() : (this.hub.jarvis?.listening ?? null);
  }

  // ---------------- reading ----------------

  /** Open chat.db (and Contacts); on a permission error, say exactly what to allow. */
  private open(): boolean {
    this.retryAt = Date.now() + RETRY_MS;
    try {
      this.db = new ChatDb(this.o.dbPath ?? CHAT_DB);
    } catch (e: any) {
      const err = e instanceof OpenError ? e : new OpenError("other", this.o.dbPath ?? CHAT_DB, String(e?.message ?? e));
      this.setIssue(err);
      return false;
    }
    this.contacts.load();
    if (this.contacts.issue) this.once("contacts", `contacts unreadable, showing numbers instead of names (${clip(this.contacts.issue, 120)})`);
    this.last = this.db.maxRowId();
    this.history = this.db.recent(KEEP).map((r) => this.item(r));
    this.issue = "";
    this.logged.delete("open");
    this.once("ok", `watching chat.db: ${this.history.length} recent messages loaded, ${this.contacts.people.length} contacts`);
    this.broadcast();
    return true;
  }

  private setIssue(err: OpenError) {
    const { real, launched } = nodeBinary();
    const restart = `launchctl kickstart -k gui/${process.getuid?.() ?? 501}/com.g2.hub`;
    if (err.kind === "permission") {
      this.issue = `Allow Full Disk Access: System Settings > Privacy & Security > Full Disk Access > + > ${real} (switch it on), then restart the hub.`;
      this.once(
        "open",
        `can't read ${err.path}: the hub's node has no Full Disk Access.`,
        `  System Settings → Privacy & Security → Full Disk Access → + → press ⇧⌘G, paste: ${real}`,
        ...(real !== launched ? [`  (launchd starts it as ${launched}, a link to that file)`] : []),
        `  switch it on, then restart the hub: ${restart}`,
      );
    } else if (err.kind === "missing") {
      this.issue = "No Messages database on this Mac: open Messages and sign in with your Apple ID.";
      this.once("open", `${err.path} not found: open Messages on this Mac and sign in with the iPhone's Apple ID.`);
    } else {
      this.issue = `Can't read Messages: ${clip(err.message, 120)}`;
      this.once("open", `can't open ${err.path}: ${clip(err.message, 200)}`);
    }
    this.broadcast();
  }

  /** New rows since the last look: into history, and a popup (or a badge) on the glasses. */
  poll() {
    if (!this.db) {
      if (Date.now() >= this.retryAt) this.open();
      return;
    }
    let rows: RawMessage[];
    try {
      const max = this.db.maxRowId();
      if (max <= this.last) return;
      rows = this.db.since(this.last, 500).filter((r) => r.rowid <= max);
      this.last = max;
      if (Date.now() - this.contacts.loadedAt > CONTACTS_MS) this.contacts.load();
    } catch (e: any) {
      // Busy or replaced (Messages rebuilt it): reopen on the next retry.
      this.once("poll", `chat.db read failed, reopening: ${clip(String(e?.message ?? e), 160)}`);
      this.db.close();
      this.db = null;
      this.retryAt = Date.now() + 5000;
      return;
    }
    this.logged.delete("poll");
    const items = rows.map((r) => this.item(r));
    if (!items.length) return;
    for (const m of items) if (!this.history.some((h) => h.id === m.id)) this.history.unshift(m);
    this.history.sort((a, b) => b.at - a.at);
    this.history.length = Math.min(this.history.length, KEEP);
    const incoming = items.filter((m) => !m.mine);
    if (incoming.length) {
      const quiet = this.dnd || BUSY.includes(this.listening() as ListenPurpose);
      if (quiet) this.queued += incoming.length;
      // One popup for a burst: the newest.
      incoming.forEach((m, i) => this.hub.toUIs({ t: "message_new", message: m, popup: !quiet && i === incoming.length - 1 }));
    }
    this.broadcast();
  }

  private item(r: RawMessage): MessageItem {
    const group = r.group === undefined ? undefined : r.group || "Group";
    const from = r.mine ? "Me" : this.contacts.nameFor(r.handle) ?? prettyHandle(r.handle || r.chatId || "Unknown");
    if (r.chat) {
      const prev = this.chats.get(r.chat);
      this.chats.set(r.chat, { identifier: r.chatId, service: r.service || prev?.service || "", group, name: group ? undefined : r.mine ? prev?.name ?? this.contacts.nameFor(r.chatId) : from });
    }
    return { id: r.guid, chat: r.chat, from, ...(group !== undefined && { group }), text: clip(r.text, MAX_TEXT), at: r.at, mine: r.mine };
  }

  snapshot(): Extract<HubMsg, { t: "messages" }> {
    return { t: "messages", messages: this.history, queued: this.queued, dnd: this.dnd, ...(this.issue && { issue: this.issue }) };
  }

  private broadcast() {
    this.hub.toUIs(this.snapshot());
  }

  /** messages_* from a screen. */
  onClient(ws: WebSocket, m: { t: string; chat?: string; on?: boolean }) {
    switch (m.t) {
      case "messages_get":
        if (!this.db && !this.issue) this.open();
        send(ws, this.snapshot());
        break;
      case "messages_focus":
        this.focus = m.chat ? { chat: String(m.chat), at: Date.now() } : null;
        break;
      case "messages_dnd":
        this.setDnd(!!m.on);
        break;
      case "messages_seen":
        if (this.queued) {
          this.queued = 0;
          this.broadcast();
        }
        break;
    }
  }

  setDnd(on: boolean) {
    this.dnd = on;
    this.broadcast();
  }

  /** "read my messages" / "what did Sam say": recent messages as text for the router (not logged). */
  read(from?: string, limit = 8): string {
    if (this.issue) return this.issue;
    let list = this.history;
    if (from?.trim()) {
      const q = norm(from);
      list = list.filter((m) => norm(m.from).includes(q) || (m.group && norm(m.group).includes(q)));
      if (!list.length && this.db) {
        const r = this.recipient(from);
        if (typeof r !== "string" && r.target.chat) {
          try {
            list = this.db.recent(limit, r.target.chat).map((x) => this.item(x));
          } catch {}
        }
      }
      if (!list.length) return `No recent messages from ${from}.`;
    }
    const when = (t: number) => new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
    return list
      .slice(0, Math.max(1, Math.min(limit, 20)))
      .map((m) => `${when(m.at)} ${m.from}${m.group ? ` in ${m.group}` : ""}: ${m.text}`)
      .join("\n") || "No messages.";
  }

  // ---------------- recipients ----------------

  private forChat(chat: string): Recipient | string {
    const c = this.chats.get(chat);
    if (!c) return "That conversation isn't in recent messages.";
    if (c.group !== undefined) return { name: c.group || "the group", detail: "group chat", target: { chat } };
    const service = c.service === "SMS" ? "SMS" : "iMessage";
    return { name: c.name || prettyHandle(c.identifier), detail: prettyHandle(c.identifier), target: { chat, handle: c.identifier || undefined, service } };
  }

  private forHandles(name: string, handles: string[]): Recipient {
    const ref = this.db?.chatFor(handles) ?? null;
    if (ref) return { name, detail: prettyHandle(ref.identifier), target: { chat: ref.guid, handle: ref.identifier, service: ref.service === "SMS" ? "SMS" : "iMessage" } };
    // No chat yet: a new iMessage to the first number (else email).
    const h = handles.find((x) => !x.includes("@")) ?? handles[0];
    return { name, detail: prettyHandle(h), target: { handle: h.includes("@") ? h : h.replace(/[^\d+]/g, ""), service: "iMessage" } };
  }

  /**
   * Who "to" means: nothing = the chat on the glasses (or the latest incoming); a number or email;
   * a group chat's name; a contact; or a sender in recent messages. A string = can't tell (ask).
   */
  recipient(to?: string): Recipient | string {
    const q = (to ?? "").trim();
    if (!q) {
      const chat = (this.focus && Date.now() - this.focus.at < FOCUS_MS ? this.focus.chat : undefined) ?? this.history.find((m) => !m.mine)?.chat;
      return chat ? this.forChat(chat) : "Who should I text? There's no recent conversation to reply to.";
    }
    if (q.includes("@") || q.replace(/\D/g, "").length >= 7) {
      const name = this.contacts.nameFor(q) ?? prettyHandle(q);
      return this.forHandles(name, [q]);
    }
    const n = norm(q);
    const groups = [...this.chats.entries()].filter(([, c]) => c.group);
    const exactGroup = groups.filter(([, c]) => norm(c.group!) === n);
    if (exactGroup.length === 1) return this.forChat(exactGroup[0][0]);
    let people = this.contacts.find(q);
    if (people.length > 1) {
      // Several Sams: the one you've been texting lately, if only one of them.
      const recent = people.filter((p) => this.history.some((m) => m.from === p.name));
      if (recent.length === 1) people = recent;
    }
    if (people.length === 1) return this.forHandles(people[0].name, people[0].handles);
    if (people.length > 1) return `Which one: ${people.slice(0, 4).map((p) => p.name).join(", ")}?`;
    // No contact (or Contacts unreadable): senders and group chats in recent messages.
    const chats = [...new Set(this.history.filter((m) => (m.group ? norm(m.group).includes(n) : !m.mine && norm(m.from).includes(n))).map((m) => m.chat))];
    if (chats.length === 1) return this.forChat(chats[0]);
    if (chats.length > 1) return `Which one: ${chats.slice(0, 4).map((c) => (this.forChat(c) as Recipient).name).join(", ")}?`;
    return `No contact or recent chat called ${q}.`;
  }

  // ---------------- sending ----------------

  /**
   * Put a confirm card on the glasses; send only on a tap. Returns at once with what to tell the
   * wearer; the outcome comes as a toast (sent / not sent / what permission is missing).
   */
  requestSend(to: string | undefined, text: string): string {
    const body = text.replace(/\s+/g, " ").trim();
    if (!body) return "What should the message say?";
    if (body.length > MAX_TEXT) return "That's too long for a text from the glasses.";
    const r = this.recipient(to);
    if (typeof r === "string") return r;
    const toast = (t: string) => this.hub.toUIs({ t: "toast", text: t });
    const job = (async () => {
      const yes = await this.confirm({ source: "Messages", action: clip(`TEXT ${r.name} ${r.detail === r.name ? "" : r.detail}`.trim(), 80), summary: body });
      if (!yes) {
        this.log("send not confirmed");
        return toast(`Not sent to ${r.name}`);
      }
      toast("Sending…");
      try {
        const how = await sendText(r.target, body, this.run);
        this.log(`sent (${how === "chat" ? "into the existing chat" : "to a number/email"})`);
        toast(`Sent to ${r.name}`);
      } catch (e: any) {
        const err = e instanceof SendError ? e : new SendError("failed", String(e?.message ?? e));
        this.log(`send failed: ${err.kind}`);
        if (err.kind === "automation") {
          this.once(
            "automation",
            "Messages refused the hub's AppleScript (Automation permission):",
            `  System Settings → Privacy & Security → Automation → node (${nodeBinary().real}) → switch on Messages.`,
            "  No node entry there: run `tccutil reset AppleEvents`, restart the hub, send again and click OK on the Mac's prompt.",
          );
          toast("Not sent: allow Automation > Messages for node (System Settings > Privacy & Security)");
        } else if (err.kind === "not-found") toast(`Not sent: Messages can't find the chat with ${r.name}`);
        else toast(`Not sent: ${clip(err.message, 80)}`);
      }
    })();
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
    return `The confirm card is on the glasses: tap sends it to ${r.name}, double tap cancels. It is not sent yet.`;
  }
}

let instance: Messages | null = null;

/** The running Messages service (the router's tools use it). */
export const messages = () => instance;

export function startMessages(hub: Hub, o?: MessagesOptions): Messages {
  instance?.stop();
  instance = new Messages(hub, o).start();
  return instance;
}

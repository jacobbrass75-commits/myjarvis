import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import type { HubMsg, ListenPurpose, MessageItem } from "../src/shared/protocol.js";
import { Hub } from "../src/hub/hub.js";
import { glassesConfirm } from "../src/hub/google/confirm.js";
import { decodeAttributedBody } from "../src/hub/messages/attributed.js";
import { ChatDb, handleKey } from "../src/hub/messages/chatdb.js";
import { Contacts, prettyHandle } from "../src/hub/messages/contacts.js";
import { Messages, startMessages } from "../src/hub/messages/index.js";
import { sendCommand, sendText, type Runner } from "../src/hub/messages/send.js";
import { messageTools } from "../src/hub/messages/tools.js";

// Messages on the glasses, without the real chat.db, Contacts, Messages app or glasses: a temp
// SQLite file in chat.db's schema, a temp AddressBook, a fake osascript, and the hub's real
// approvals (the shared confirm card). Nothing is ever sent.

const dir = mkdtempSync(join(tmpdir(), "g2-messages-"));
after(() => {
  try {
    chmodSync(join(dir, "locked"), 0o755);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const APPLE_EPOCH_MS = 978_307_200_000;
const ns = (ms: number) => BigInt(ms - APPLE_EPOCH_MS) * 1_000_000n;

/** An attributedBody as Messages writes it (typedstream NSAttributedString), around `text`. */
function attributed(text: string): Uint8Array {
  const t = Buffer.from(text, "utf8");
  const len = t.length < 0x80 ? Buffer.from([t.length]) : Buffer.concat([Buffer.from([0x81]), Buffer.from([t.length & 0xff, t.length >> 8])]);
  const cls = (name: string, tail: number[]) => Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from(tail)]);
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]), Buffer.from("streamtyped"), Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]),
    cls("NSMutableAttributedString", [0x00, 0x84, 0x84]), cls("NSAttributedString", [0x00, 0x84, 0x84]),
    cls("NSObject", [0x00, 0x85, 0x92, 0x84, 0x84, 0x84]), cls("NSMutableString", [0x01, 0x84, 0x84]),
    cls("NSString", [0x01, 0x94, 0x84, 0x01, 0x2b]), len, t, Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01, 0x10, 0x92, 0x84]),
  ]);
}

/** A chat.db with the tables and columns the hub reads. */
function chatDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT, chat_identifier TEXT, service_name TEXT, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0,
      item_type INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, attributedBody BLOB);
    CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));`);
  const handle = (id: string, service = "iMessage") => Number(db.prepare("INSERT INTO handle (id, service) VALUES (?, ?)").run(id, service).lastInsertRowid);
  const chat = (guid: string, style: 43 | 45, identifier: string, name = "", service = "iMessage") =>
    Number(db.prepare("INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) VALUES (?, ?, ?, ?, ?)").run(guid, style, identifier, service, name).lastInsertRowid);
  let n = 0;
  const msg = (chatId: number, o: { text?: string | null; body?: Uint8Array; handle?: number; mine?: boolean; at?: number; tapback?: boolean; attachment?: boolean }) => {
    const at = o.at ?? Date.now();
    const id = Number(
      db.prepare("INSERT INTO message (guid, text, attributedBody, handle_id, service, date, is_from_me, associated_message_type, cache_has_attachments) VALUES (?, ?, ?, ?, 'iMessage', ?, ?, ?, ?)")
        .run(`M-${++n}`, o.text ?? null, o.body ?? null, o.handle ?? 0, ns(at), o.mine ? 1 : 0, o.tapback ? 2000 : 0, o.attachment ? 1 : 0).lastInsertRowid,
    );
    db.prepare("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)").run(chatId, id, ns(at));
    return id;
  };
  return { db, handle, chat, msg };
}

/** An AddressBook folder: one database at the top, one under Sources/. */
function addressBook(root: string) {
  const make = (file: string, people: [first: string, last: string, nick: string, phones: string[], emails: string[]][]) => {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME VARCHAR, ZLASTNAME VARCHAR, ZNICKNAME VARCHAR, ZORGANIZATION VARCHAR);
      CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER VARCHAR, ZLABEL VARCHAR);
      CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS VARCHAR, ZLABEL VARCHAR);`);
    people.forEach(([first, last, nick, phones, emails], i) => {
      db.prepare("INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME) VALUES (?, ?, ?, ?)").run(i + 1, first, last, nick);
      for (const p of phones) db.prepare("INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)").run(i + 1, p);
      for (const e of emails) db.prepare("INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)").run(i + 1, e);
    });
    db.close();
  };
  mkdirSync(join(root, "Sources", "ABC-123"), { recursive: true });
  make(join(root, "AddressBook-v22.abcddb"), [["Sam", "Lee", "", ["(555) 123-4567"], ["sam@example.com"]]]);
  make(join(root, "Sources", "ABC-123", "AddressBook-v22.abcddb"), [
    ["Mom", "", "", ["+1 555 999 0000"], []],
    ["Sam", "Park", "", ["555-222-3333"], []],
    ["Ava", "Jones", "", ["555 444 1111"], []],
  ]);
}

// One world for the hub tests: Sam Lee (1:1 chat), the Family group, Mom (no chat yet).
const dbPath = join(dir, "chat.db");
const w = chatDb(dbPath);
const sam = w.handle("+15551234567");
const mom = w.handle("+15559990000");
const samChat = w.chat("any;-;+15551234567", 45, "+15551234567");
const family = w.chat("any;+;chat123456", 43, "chat123456", "Family");
const t0 = Date.now() - 3600_000;
w.msg(samChat, { text: "lunch tomorrow?", handle: sam, at: t0 });
w.msg(samChat, { text: "sure, noon", mine: true, handle: sam, at: t0 + 1000 });
w.msg(samChat, { text: null, body: attributed("see you at the café 🎉"), handle: sam, at: t0 + 2000 }); // attributedBody only
w.msg(samChat, { text: "Loved “sure, noon”", handle: sam, tapback: true, at: t0 + 3000 }); // a tapback: not a message
w.msg(family, { text: "dinner at 7", handle: mom, at: t0 + 4000 });
w.msg(family, { text: "￼", handle: mom, attachment: true, at: t0 + 5000 });
const abDir = join(dir, "AddressBook");
addressBook(abDir);

const fakeWs = (out: HubMsg[]) => ({ readyState: 1, send: (s: string) => out.push(JSON.parse(s)) }) as any;

function world(o: { listening?: () => ListenPurpose | null; run?: Runner; confirmMs?: number } = {}) {
  const hub = new Hub([]);
  const sent: HubMsg[] = [];
  hub.toUIs = (m) => void sent.push(m);
  hub.changed = () => {};
  const logs: string[] = [];
  const calls: string[][] = [];
  const run: Runner = o.run ?? (async (file, args) => (calls.push([file, ...args]), { stdout: "", stderr: "" }));
  const m = new Messages(hub, { dbPath, contactsDir: abDir, run, listening: o.listening, log: (s) => logs.push(s), confirm: glassesConfirm(hub, o.confirmMs ?? 5000), pollMs: 60_000 }).start();
  return { hub, m, sent, logs, calls, stop: () => m.stop() };
}
const toasts = (sent: HubMsg[]) => sent.filter((x) => x.t === "toast").map((x) => (x as { text: string }).text);
const card = (hub: Hub) => hub.snapshot().approvals[0];

// ---------------- decoding & reading ----------------

test("attributedBody: short, long (0x81 length) and garbage", () => {
  assert.equal(decodeAttributedBody(attributed("hi there")), "hi there");
  const long = "a".repeat(300) + " é";
  assert.equal(decodeAttributedBody(attributed(long)), long);
  assert.equal(decodeAttributedBody(Buffer.from("no string here")), null);
  assert.equal(decodeAttributedBody(Buffer.concat([Buffer.from("NSString"), Buffer.from([0x01, 0x2b, 0x40, 0x41])])), null); // length past the end
  assert.equal(decodeAttributedBody(null), null);
});

test("chat.db: messages with sender, group, time; attributedBody decoded, tapbacks skipped", () => {
  const db = new ChatDb(dbPath);
  const recent = db.recent(10);
  assert.deepEqual(recent.map((r) => r.text), ["[attachment]", "dinner at 7", "see you at the café 🎉", "sure, noon", "lunch tomorrow?"]);
  const body = recent[2];
  assert.equal(body.handle, "+15551234567");
  assert.equal(body.chat, "any;-;+15551234567");
  assert.equal(body.group, undefined);
  assert.ok(Math.abs(body.at - (t0 + 2000)) < 2, "Apple nanoseconds -> ms");
  assert.equal(recent[1].group, "Family");
  assert.equal(recent[3].mine, true);
  assert.equal(recent[3].handle, "");
  assert.deepEqual(db.since(recent[2].rowid).map((r) => r.text), ["dinner at 7", "[attachment]"]);
  assert.equal(db.chatFor(["(555) 123-4567"])?.guid, "any;-;+15551234567");
  assert.equal(db.chatFor(["+15559990000"]), null, "Mom has only the group chat");
  db.close();
});

test("contacts: names for numbers in any format, spoken names", () => {
  const c = new Contacts(abDir).load();
  assert.equal(c.issue, "");
  assert.equal(c.nameFor("+15551234567"), "Sam Lee");
  assert.equal(c.nameFor("SAM@example.com"), "Sam Lee");
  assert.equal(c.nameFor("+15559990000"), "Mom");
  assert.deepEqual(c.find("sam").map((p) => p.name).sort(), ["Sam Lee", "Sam Park"]);
  assert.deepEqual(c.find("sam park").map((p) => p.name), ["Sam Park"]);
  assert.deepEqual(c.find("mom").map((p) => p.name), ["Mom"]);
  assert.equal(handleKey("+1 (555) 123-4567"), "5551234567");
  assert.equal(prettyHandle("+15551234567"), "(555) 123-4567");
  assert.equal(new Contacts(join(dir, "nope")).load().people.length, 0);
});

test("history: contact names, groups, at most 50 in memory", () => {
  const { m, stop } = world();
  try {
    assert.equal(m.issue, "");
    const [att, dinner, cafe] = m.history;
    assert.equal(cafe.from, "Sam Lee");
    assert.equal(cafe.text, "see you at the café 🎉");
    assert.equal(dinner.from, "Mom");
    assert.equal(dinner.group, "Family");
    assert.equal(att.text, "[attachment]");
    assert.match(m.read(), /Sam Lee: see you at the café/);
    assert.match(m.read("family"), /Mom in Family: dinner at 7/);
    for (let i = 0; i < 60; i++) w.msg(samChat, { text: `spam ${i}`, handle: sam });
    m.poll();
    assert.equal(m.history.length, 50);
    assert.equal(m.history[0].text, "spam 59");
  } finally {
    stop();
  }
});

// ---------------- focus & do not disturb ----------------

test("new messages pop up, except in conversation modes and do not disturb (queued as a badge)", () => {
  let listening: ListenPurpose | null = null;
  const { m, sent, stop } = world({ listening: () => listening });
  try {
    const news = () => sent.filter((x) => x.t === "message_new") as Extract<HubMsg, { t: "message_new" }>[];
    w.msg(samChat, { text: "you there?", handle: sam });
    m.poll();
    assert.equal(news().at(-1)?.popup, true);
    assert.equal(news().at(-1)?.message.from, "Sam Lee");

    listening = "translate";
    w.msg(samChat, { text: "hello??", handle: sam });
    w.msg(family, { text: "call me", handle: mom });
    m.poll();
    assert.deepEqual(news().slice(-2).map((x) => x.popup), [false, false]);
    assert.equal(m.queued, 2);
    const snap = sent.filter((x) => x.t === "messages").at(-1) as Extract<HubMsg, { t: "messages" }>;
    assert.equal(snap.queued, 2);

    listening = null;
    m.setDnd(true);
    w.msg(samChat, { text: "ok", handle: sam });
    m.poll();
    assert.equal(news().at(-1)?.popup, false);
    assert.equal(m.queued, 3);

    // a burst while free: one popup, the newest
    m.setDnd(false);
    w.msg(samChat, { text: "one", handle: sam });
    w.msg(samChat, { text: "two", handle: sam });
    m.poll();
    assert.deepEqual(news().slice(-2).map((x) => [x.message.text, x.popup]), [["one", false], ["two", true]]);

    // your own messages (sent from the phone) never pop up
    const before = news().length;
    w.msg(samChat, { text: "from my phone", mine: true, handle: sam });
    m.poll();
    assert.equal(news().length, before);
    assert.equal(m.history[0].text, "from my phone");

    const out: HubMsg[] = [];
    m.onClient(fakeWs(out), { t: "messages_seen" });
    assert.equal(m.queued, 0);
    m.onClient(fakeWs(out), { t: "messages_get" });
    assert.equal(out.at(-1)?.t, "messages");
  } finally {
    stop();
  }
});

// ---------------- sending: confirm card, timeout, permissions ----------------

test("send: confirm card shows recipient + text; the router can't answer it; a tap sends into the chat", async () => {
  const { hub, m, sent, calls, logs, stop } = world();
  try {
    const reply = m.requestSend("Sam Lee", "I'm 5 minutes out");
    assert.match(reply, /not sent yet/i);
    assert.equal(calls.length, 0, "nothing runs before the tap");
    const a = card(hub);
    assert.equal(a.agentName, "Messages");
    assert.match(a.tool, /TEXT Sam Lee \(555\) 123-4567/);
    assert.equal(a.summary, "I'm 5 minutes out");
    assert.equal(hub.resolve(a.id, "allow", undefined, "router"), false, "the voice router can't confirm");
    assert.equal(calls.length, 0);
    assert.ok(hub.resolve(a.id, "allow", undefined, "glasses"));
    await Promise.all(m.pending);
    assert.equal(calls.length, 1);
    const [file, ...args] = calls[0];
    assert.equal(file, "/usr/bin/osascript");
    assert.deepEqual(args.slice(-2), ["any;-;+15551234567", "I'm 5 minutes out"], "text goes in as argv, not in the script");
    assert.ok(!args.filter((x, i) => args[i - 1] === "-e").some((l) => l.includes("5 minutes")));
    assert.deepEqual(toasts(sent).slice(-2), ["Sending…", "Sent to Sam Lee"]);
    assert.ok(!logs.some((l) => /5 minutes|Sam|555/.test(l)), "no bodies, names or numbers in the log");
  } finally {
    stop();
  }
});

test("send: double tap cancels, no answer cancels", async () => {
  const { hub, m, sent, calls, stop } = world({ confirmMs: 60 });
  try {
    m.requestSend("family", "running late");
    assert.equal(card(hub).tool, "TEXT Family group chat");
    hub.resolve(card(hub).id, "deny", "Denied from glasses.", "glasses");
    await Promise.all(m.pending);
    assert.equal(toasts(sent).at(-1), "Not sent to Family");

    m.requestSend("Mom", "on my way");
    assert.equal(hub.snapshot().approvals.length, 1);
    await Promise.all(m.pending); // the 60 ms timeout
    assert.equal(hub.snapshot().approvals.length, 0);
    assert.equal(toasts(sent).at(-1), "Not sent to Mom");
    assert.equal(calls.length, 0);
  } finally {
    stop();
  }
});

test("recipients: reply to the focused chat or latest, ambiguity, numbers, new chats", async () => {
  const x = world();
  try {
    assert.equal((x.m.recipient("sam") as any).name, "Sam Lee", "of two Sams, the one you've been texting");
    assert.equal((x.m.recipient("Ava Jones") as any).target.handle, "5554441111", "no chat yet: a new iMessage to the number");
    assert.equal((x.m.recipient("Ava Jones") as any).target.chat, undefined);
    assert.match(String(x.m.recipient("zed")), /No contact/);
    // no name: the latest incoming chat, or the one the glasses show
    const out: HubMsg[] = [];
    assert.equal((x.m.recipient() as any).target.chat, x.m.history.find((h) => !h.mine)!.chat);
    x.m.onClient(fakeWs(out), { t: "messages_focus", chat: "any;+;chat123456" });
    assert.equal((x.m.recipient() as any).name, "Family");
    assert.equal((x.m.recipient("+1 555 123 4567") as any).target.chat, "any;-;+15551234567");
    x.m.requestSend(undefined, "sounds good");
    x.hub.resolve(card(x.hub).id, "allow", undefined, "phone");
    await Promise.all(x.m.pending);
    assert.deepEqual(x.calls[0].slice(-2), ["any;+;chat123456", "sounds good"]);
  } finally {
    x.stop();
  }
});

test("send: falls back from a missing chat to the number; Automation refusal explains itself once", async () => {
  const seen: string[][] = [];
  const notFound: Runner = async (file, args) => {
    seen.push(args);
    if (args.some((a) => a.includes("chat id"))) throw Object.assign(new Error("Command failed: osascript ... secret text"), { stderr: "execution error: Messages got an error: Can’t get chat id \"x\". (-1728)" });
    return { stdout: "", stderr: "" };
  };
  assert.equal(await sendText({ chat: "any;-;+1555", handle: "+1555", service: "iMessage" }, "hi", notFound), "handle");
  assert.ok(seen[1].includes("send (item 2 of argv) to participant (item 1 of argv) of acct"));

  const refuse: Runner = async () => {
    throw Object.assign(new Error("Command failed: /usr/bin/osascript -e … I'm 5 minutes out"), { stderr: "execution error: Not authorized to send Apple events to Messages. (-1743)" });
  };
  const { hub, m, sent, logs, stop } = world({ run: refuse });
  try {
    for (let i = 0; i < 2; i++) {
      m.requestSend("Sam Lee", "I'm 5 minutes out");
      hub.resolve(card(hub).id, "allow", undefined, "glasses");
      await Promise.all(m.pending);
    }
    assert.match(toasts(sent).at(-1)!, /allow Automation > Messages/);
    assert.equal(logs.filter((l) => l.includes("Privacy & Security → Automation")).length, 1);
    assert.ok(logs.some((l) => l.includes(process.execPath) || /node \(\//.test(l)));
    assert.ok(!logs.some((l) => l.includes("5 minutes")), "the command line (with the text) never reaches the log");
  } finally {
    stop();
  }
});

test("dry run: the AppleScript for a send, printed, never run", () => {
  const c = sendCommand("chat", { chat: "any;-;+15551234567" }, "test only");
  assert.equal(c.script, ["on run argv", 'tell application "Messages"', "send (item 2 of argv) to chat id (item 1 of argv)", "end tell", "end run"].join("\n"));
  assert.deepEqual(c.args.slice(-2), ["any;-;+15551234567", "test only"]);
  const sms = sendCommand("handle", { handle: "+15551234567", service: "SMS" }, "x");
  assert.match(sms.script, /service type = SMS/);
});

test("no Full Disk Access: a clear issue with the node path, no crash; missing database too", () => {
  const locked = join(dir, "locked");
  mkdirSync(locked);
  const dbFile = join(locked, "chat.db");
  new DatabaseSync(dbFile).close();
  chmodSync(locked, 0o000);
  const hub = new Hub([]);
  const sent: HubMsg[] = [];
  hub.toUIs = (x) => void sent.push(x);
  const logs: string[] = [];
  const m = new Messages(hub, { dbPath: dbFile, contactsDir: abDir, log: (s) => logs.push(s), pollMs: 60_000 }).start();
  try {
    assert.match(m.issue, /Full Disk Access/);
    assert.ok(m.issue.includes(process.execPath) || m.issue.includes("/node"));
    assert.ok(logs.some((l) => l.includes("Full Disk Access → +")));
    assert.ok(logs.some((l) => l.includes("launchctl kickstart -k")));
    m.poll(); // retries later, logs once
    assert.equal(logs.filter((l) => l.includes("Full Disk Access → +")).length, 1);
    assert.match(m.read(), /Full Disk Access/);
    assert.equal((sent.at(-1) as any).issue, m.issue);
  } finally {
    m.stop();
    chmodSync(locked, 0o755);
  }
  const gone = new Messages(new Hub([]), { dbPath: join(dir, "missing.db"), contactsDir: abDir, log: () => {}, pollMs: 60_000 }).start();
  assert.match(gone.issue, /open Messages and sign in/);
  gone.stop();
});

test("router tools: send_message only queues a card; read_messages opens MESSAGES", async () => {
  const hub = new Hub([]);
  const sent: HubMsg[] = [];
  hub.toUIs = (x) => void sent.push(x);
  hub.changed = () => {};
  const calls: string[][] = [];
  const m = startMessages(hub, { dbPath, contactsDir: abDir, run: async (_f, a) => (calls.push(a), { stdout: "", stderr: "" }), log: () => {}, pollMs: 60_000 });
  try {
    const tools: Record<string, { handler: (a: any, extra: unknown) => Promise<any> }> = Object.fromEntries(messageTools(hub).map((t) => [t.name, t]));
    const r = await tools.send_message.handler({ to: "Sam Lee", text: "hi" }, {});
    assert.match((r.content[0] as any).text, /not sent yet/);
    assert.equal(hub.snapshot().approvals.length, 1);
    assert.equal(calls.length, 0);
    const read = await tools.read_messages.handler({ from: "Sam" }, {});
    assert.match((read.content[0] as any).text, /Sam Lee/);
    assert.deepEqual(sent.find((x) => x.t === "open"), { t: "open", mode: "messages" });
    await tools.messages_do_not_disturb.handler({ on: true }, {});
    assert.equal(m.dnd, true);
    hub.resolve(hub.snapshot().approvals[0].id, "deny", undefined, "glasses");
    await Promise.all(m.pending);
    assert.equal(calls.length, 0);
  } finally {
    m.stop();
  }
});

// ---------------- the glasses ----------------

// The glasses' own files (resolved by tsx at run time; the hub's tsconfig doesn't cover them).
const GLASSES_CORE = "../glasses/src/core.ts";
const GLASSES_MESSAGES = "../glasses/src/modes/messages.ts";

test("glasses: a popup card over normal screens, none in conversation modes; badge for queued", async () => {
  const { badges, core } = await import(GLASSES_CORE);
  const { messagesMode } = await import(GLASSES_MESSAGES);
  type Mode = { id: string; title: string; quiet?: boolean; screen(): any; gesture(): boolean };
  const plain: Mode = { id: "plain", title: "", screen: () => ({ header: "PLAIN", body: "" }), gesture: () => false };
  const talk: Mode = { id: "talk", title: "", quiet: true, screen: () => ({ header: "TALK", body: "" }), gesture: () => false };
  core.modes.set("messages", messagesMode);
  const msg: MessageItem = { id: "M-x", chat: "any;-;+15551234567", from: "Sam Lee", text: "are you close? I'm at the door with the keys and the dog", at: Date.now(), mine: false };

  core.stack = [talk];
  messagesMode.onHub!({ t: "message_new", message: msg, popup: true });
  assert.equal(core.stack.at(-1)?.id, "talk", "no popup in a quiet mode");

  core.stack = [plain];
  messagesMode.onHub!({ t: "message_new", message: msg, popup: true });
  assert.equal(core.stack.at(-1)?.id, "messages");
  const s = messagesMode.screen();
  assert.match(s.header, /MESSAGE/);
  assert.match(s.body!, /^SAM LEE\n\nare you close\?/);
  assert.match(s.boxes![0].text, /HOLD: REPLY/);
  messagesMode.gesture("double", 0); // close: back where it was
  assert.equal(core.stack.at(-1)?.id, "plain");

  messagesMode.onHub!({ t: "message_new", message: { ...msg, id: "M-y" }, popup: false });
  assert.equal(core.stack.at(-1)?.id, "plain", "popup false: the hub said busy / DND");

  messagesMode.onHub!({ t: "messages", messages: [msg], queued: 2, dnd: true });
  assert.equal(badges.get("messages")!(), " [2 MSG]");
  core.stack = [plain, messagesMode];
  const list = messagesMode.screen();
  assert.equal(list.list![0], "DO NOT DISTURB: ON");
  assert.match(list.list![1], /Sam Lee: are you close/);
});

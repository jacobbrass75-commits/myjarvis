import { closeSync, openSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanText, decodeAttributedBody } from "./attributed.js";

// Read-only access to the Mac's Messages database (~/Library/Messages/chat.db). Messages writes it
// in WAL mode, so a read-only connection sees new rows as they commit. Reading it needs Full Disk
// Access for the node binary that runs the hub.

export const CHAT_DB = join(homedir(), "Library", "Messages", "chat.db");

/** Seconds from 1970 to 2001-01-01, Apple's epoch for message.date. */
const APPLE_EPOCH_MS = 978_307_200_000;

export interface RawMessage {
  rowid: number;
  guid: string;
  text: string;
  /** Sender handle (phone/email) for incoming messages; "" for your own. */
  handle: string;
  mine: boolean;
  at: number;
  chat: string;
  /** The chat's identifier: the other person's handle in a one-to-one chat. */
  chatId: string;
  service: string;
  /** Group name ("" = unnamed group); undefined for one-to-one chats. */
  group?: string;
}

export interface ChatRef {
  guid: string;
  identifier: string;
  service: string;
}

/** What went wrong opening a database: permission (Full Disk Access), missing, or something else. */
export class OpenError extends Error {
  constructor(public kind: "permission" | "missing" | "other", public path: string, message: string) {
    super(message);
  }
}

export function classifyOpenError(path: string, e: any): OpenError {
  const code = String(e?.code ?? "");
  const msg = String(e?.message ?? e);
  if (code === "EPERM" || code === "EACCES" || /not permitted|authori[sz]ation denied|permission denied/i.test(msg)) return new OpenError("permission", path, msg);
  if (code === "ENOENT") return new OpenError("missing", path, msg);
  return new OpenError("other", path, msg);
}

/** Open a SQLite file read-only. A plain open() first: TCC refuses it with EPERM, which sqlite reports vaguely. */
export function openReadOnly(path: string): DatabaseSync {
  try {
    closeSync(openSync(path, "r"));
    return new DatabaseSync(path, { readOnly: true, timeout: 2000 });
  } catch (e) {
    throw classifyOpenError(path, e);
  }
}

/** The binary to add under Full Disk Access / Automation: the node running this process, symlinks resolved. */
export function nodeBinary(): { real: string; launched: string } {
  let real = process.execPath;
  try {
    real = realpathSync(process.execPath);
  } catch {}
  return { real, launched: process.argv0.startsWith("/") ? process.argv0 : process.execPath };
}

/** Apple time (ns since 2001 on current macOS, seconds on old ones) as ms since 2001, in SQL so it stays a safe integer. */
const AT = "CASE WHEN m.date > 100000000000 THEN m.date / 1000000 ELSE m.date * 1000 END";

export class ChatDb {
  private db: DatabaseSync;
  private where: string;

  constructor(public path = CHAT_DB) {
    this.db = openReadOnly(path);
    // Only real messages: not tapbacks / reactions (associated_message_type) or renames and other
    // events (item_type). Older databases may lack the columns.
    const cols = new Set((this.db.prepare("PRAGMA table_info(message)").all() as { name: string }[]).map((c) => c.name));
    const w: string[] = [];
    if (cols.has("item_type")) w.push("IFNULL(m.item_type, 0) = 0");
    if (cols.has("associated_message_type")) w.push("IFNULL(m.associated_message_type, 0) = 0");
    this.where = w.length ? ` AND ${w.join(" AND ")}` : "";
  }

  private select(cond: string, order: string, limit: number, ...params: (number | string)[]): RawMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text, m.attributedBody AS body, m.is_from_me AS mine,
           m.cache_has_attachments AS att, ${AT} AS at2001, IFNULL(m.service, '') AS service,
           IFNULL(h.id, '') AS handle, IFNULL(c.guid, '') AS chat, IFNULL(c.chat_identifier, '') AS chatId,
           c.style AS style, IFNULL(c.display_name, '') AS name
         FROM message m
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         LEFT JOIN chat_message_join j ON j.message_id = m.ROWID
         LEFT JOIN chat c ON c.ROWID = j.chat_id
         WHERE ${cond}${this.where}
         ORDER BY m.ROWID ${order} LIMIT ${Math.max(1, Math.floor(limit))}`,
      )
      .all(...params) as any[];
    const out: RawMessage[] = [];
    for (const r of rows) {
      let text = cleanText(r.text ?? "");
      if (!text && r.body) text = cleanText(decodeAttributedBody(r.body) ?? "");
      if (!text && r.att) text = "[attachment]";
      if (!text) continue; // unsent, edited-away, or nothing we can show
      out.push({
        rowid: Number(r.rowid),
        guid: String(r.guid ?? r.rowid),
        text,
        handle: r.mine ? "" : String(r.handle),
        mine: !!r.mine,
        at: Number(r.at2001) + APPLE_EPOCH_MS,
        chat: String(r.chat),
        chatId: String(r.chatId),
        service: String(r.service),
        // style 43 = group chat, 45 = one-to-one
        group: Number(r.style) === 43 ? String(r.name) : undefined,
      });
    }
    return out;
  }

  maxRowId(): number {
    const r = this.db.prepare("SELECT IFNULL(MAX(ROWID), 0) AS n FROM message").get() as { n: number };
    return Number(r.n);
  }

  /** Messages after `rowid`, oldest first. */
  since(rowid: number, limit = 100): RawMessage[] {
    return this.select("m.ROWID > ?", "ASC", limit, rowid);
  }

  /** The latest messages, newest first (optionally in one chat). */
  recent(limit = 50, chat?: string): RawMessage[] {
    return chat ? this.select("c.guid = ?", "DESC", limit, chat) : this.select("1", "DESC", limit);
  }

  /** The most recently used one-to-one chat with any of these handles (phone numbers compared on their last 10 digits). */
  chatFor(handles: string[]): ChatRef | null {
    const keys = new Set(handles.map(handleKey).filter(Boolean));
    if (!keys.size) return null;
    const rows = this.db
      .prepare(
        // (message_date is nanoseconds, past a safe JS integer: sorted on in SQL, never read)
        `SELECT c.guid AS guid, IFNULL(c.chat_identifier, '') AS identifier, IFNULL(c.service_name, '') AS service
         FROM chat c WHERE IFNULL(c.style, 45) <> 43
         ORDER BY IFNULL((SELECT MAX(j.message_date) FROM chat_message_join j WHERE j.chat_id = c.ROWID), 0) DESC`,
      )
      .all() as any[];
    const hit = rows.find((r) => keys.has(handleKey(String(r.identifier))));
    return hit ? { guid: String(hit.guid), identifier: String(hit.identifier), service: String(hit.service) } : null;
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }
}

/** A phone number or email reduced to what identifies it: lowercased email, or the last 10 digits. */
export function handleKey(h: string): string {
  const s = h.trim().toLowerCase();
  if (!s) return "";
  if (s.includes("@")) return s.replace(/^mailto:/, "");
  const d = s.replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-10) : s;
}

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { handleKey, openReadOnly } from "./chatdb.js";

// Names for phone numbers and emails, from the macOS Contacts databases (the same Full Disk Access
// as chat.db covers them). Unreadable = no names: senders show as their number or email.

export const ADDRESS_BOOK = join(homedir(), "Library", "Application Support", "AddressBook");

export interface Person {
  name: string;
  first: string;
  last: string;
  nick: string;
  /** Phone numbers and emails as stored. */
  handles: string[];
}

/** Every AddressBook-v22.abcddb: the local one and one per account under Sources/. */
function databases(dir: string): string[] {
  const out: string[] = [];
  const own = join(dir, "AddressBook-v22.abcddb");
  if (existsSync(own)) out.push(own);
  try {
    for (const s of readdirSync(join(dir, "Sources"))) {
      const f = join(dir, "Sources", s, "AddressBook-v22.abcddb");
      if (existsSync(f)) out.push(f);
    }
  } catch (e: any) {
    if (e?.code === "EPERM" || e?.code === "EACCES") throw e;
  }
  return out;
}

export class Contacts {
  people: Person[] = [];
  private byKey = new Map<string, string>();
  loadedAt = 0;
  /** Why the last load found nobody ("" = fine). */
  issue = "";

  constructor(public dir = ADDRESS_BOOK) {}

  load(): this {
    const people: Person[] = [];
    try {
      for (const file of databases(this.dir)) {
        const db = openReadOnly(file);
        try {
          const cols = new Set((db.prepare("PRAGMA table_info(ZABCDRECORD)").all() as { name: string }[]).map((c) => c.name));
          const col = (c: string) => (cols.has(c) ? `IFNULL(${c}, '')` : "''");
          const recs = db.prepare(`SELECT Z_PK AS id, ${col("ZFIRSTNAME")} AS first, ${col("ZLASTNAME")} AS last, ${col("ZNICKNAME")} AS nick, ${col("ZORGANIZATION")} AS org FROM ZABCDRECORD`).all() as any[];
          const handles = new Map<number, string[]>();
          const add = (owner: number, h: string) => h && (handles.get(owner) ?? handles.set(owner, []).get(owner)!).push(h);
          for (const r of db.prepare("SELECT ZOWNER AS o, IFNULL(ZFULLNUMBER, '') AS h FROM ZABCDPHONENUMBER").all() as any[]) add(Number(r.o), String(r.h));
          for (const r of db.prepare("SELECT ZOWNER AS o, IFNULL(ZADDRESS, '') AS h FROM ZABCDEMAILADDRESS").all() as any[]) add(Number(r.o), String(r.h));
          for (const r of recs) {
            const hs = handles.get(Number(r.id));
            const name = [r.first, r.last].filter(Boolean).join(" ") || r.nick || r.org;
            if (hs?.length && name) people.push({ name, first: String(r.first), last: String(r.last), nick: String(r.nick), handles: hs });
          }
        } finally {
          db.close();
        }
      }
      this.issue = "";
    } catch (e: any) {
      this.issue = String(e?.message ?? e);
    }
    this.people = people;
    this.byKey.clear();
    for (const p of people) for (const h of p.handles) if (!this.byKey.has(handleKey(h))) this.byKey.set(handleKey(h), p.name);
    this.loadedAt = Date.now();
    return this;
  }

  nameFor(handle: string): string | undefined {
    return this.byKey.get(handleKey(handle));
  }

  /** People whose name matches a spoken one: exact full name or nickname first, then first name, then a prefix. */
  find(query: string): Person[] {
    const q = norm(query);
    if (!q) return [];
    const tiers: ((p: Person) => boolean)[] = [
      (p) => norm(p.name) === q || norm(p.nick) === q,
      (p) => norm(p.first) === q || norm(p.last) === q,
      (p) => norm(p.name).startsWith(q) || norm(p.name).split(" ").some((w) => w.startsWith(q)),
    ];
    for (const t of tiers) {
      const hit = this.people.filter(t);
      if (hit.length) return hit;
    }
    return [];
  }
}

export const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9@.+ ]/g, "").replace(/\s+/g, " ").trim();

/** "+15551234567" -> "(555) 123-4567"; emails and other numbers unchanged. */
export function prettyHandle(h: string): string {
  const d = h.replace(/\D/g, "");
  if (!h.includes("@") && d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (!h.includes("@") && d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return h;
}

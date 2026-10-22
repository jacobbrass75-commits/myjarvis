import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Note, Script } from "../shared/protocol.js";

// Small JSON files under ~/.g2-orchestrator/data for things that should survive a hub restart.

/** Where notes, people and conversation logs live. Point G2_DATA_DIR elsewhere for tests. */
export const DATA_DIR = process.env.G2_DATA_DIR || join(homedir(), ".g2-orchestrator", "data");
const DIR = DATA_DIR;
mkdirSync(DIR, { recursive: true });

function load<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(DIR, name), "utf8")) as T;
  } catch {
    return fallback;
  }
}
const save = (name: string, v: unknown) => writeFileSync(join(DIR, name), JSON.stringify(v, null, 2));

export class Store {
  notes: Note[] = load<Note[]>("notes.json", []);
  script: Script | null = load<Script | null>("script.json", null);
  /** What you've learned about people, by name. */
  people: Record<string, { text: string; at: number }[]> = load("people.json", {});

  remember(name: string, fact: string) {
    const key = name.trim();
    if (!key || !fact.trim()) return;
    const list = (this.people[key] ??= []);
    if (!list.some((f) => f.text.toLowerCase() === fact.trim().toLowerCase())) list.push({ text: fact.trim(), at: Date.now() });
    if (list.length > 40) list.splice(0, list.length - 40);
    save("people.json", this.people);
  }

  /** People on file whose name appears in the text. */
  mentioned(text: string): [string, { text: string; at: number }[]][] {
    const low = text.toLowerCase();
    return Object.entries(this.people).filter(([name]) => {
      const first = name.toLowerCase().split(/\s+/)[0];
      return first.length > 2 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(low);
    });
  }

  addNote(text: string): Note {
    const n = { id: randomUUID().slice(0, 8), text: text.trim(), at: Date.now() };
    this.notes.unshift(n);
    save("notes.json", this.notes);
    return n;
  }

  deleteNote(id: string) {
    this.notes = this.notes.filter((n) => n.id !== id);
    save("notes.json", this.notes);
  }

  setScript(s: Script | null) {
    this.script = s;
    save("script.json", s);
  }
}

import type { HubMsg, Note } from "../../../src/shared/protocol";
import { paged, record, type Mode } from "../core";

// Voice notes. Hold to record one (it's transcribed and saved on the hub); tap a note to read it.
// You can also just say "note that…" to Jarvis from anywhere.

let notes: Note[] = [];
let open: { id: string; page: number } | null = null;

const when = (t: number) => {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

export const notesMode: Mode = {
  id: "notes",
  title: "Notes",
  enter() {
    open = null;
  },
  onHub(m: HubMsg) {
    if (m.t === "notes") notes = m.notes;
  },
  hold(down) {
    record(down, "note");
    return true;
  },
  screen() {
    if (open) {
      const id = open.id;
      const n = notes.find((x) => x.id === id);
      if (n) {
        const p = paged(n.text, open.page);
        open.page = p.page;
        return { header: `Note · ${when(n.at)}${p.pages > 1 ? `  ${p.page + 1}/${p.pages}` : ""}`, body: p.body };
      }
      open = null;
    }
    return {
      header: `Notes (${notes.length}) · hold to record`,
      list: notes.length ? notes.slice(0, 20).map((n) => `${when(n.at)}  ${n.text}`) : ["No notes — hold to record one"],
    };
  },
  gesture(g, i) {
    if (open) {
      if (g === "down") open.page++;
      else if (g === "up") open.page = Math.max(0, open.page - 1);
      else open = null;
      return true;
    }
    if (g === "tap" && notes[i]) {
      open = { id: notes[i].id, page: 0 };
      return true;
    }
    return g !== "double";
  },
};

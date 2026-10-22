import { ASSISTANT_NAME } from "../../../src/shared/assistant";
import type { HubMsg } from "../../../src/shared/protocol";
import { colsFor, core, flash, paged, rowsFor, send, wrap, type Mode } from "../core";
import { AVATAR_H, AVATAR_W, bocchiTile, replyMood } from "../ui/bocchi";
import { fromB64, unpack4, type Raster } from "../ui/kit";

// Your Claude Code and Codex agents across devices. Tap an agent to read its output; hold while one is open to
// talk to that agent. Approval cards pop up over every non-conversation mode. A computer-use agent shows its
// latest screen as a tile beside the text when its computer sends thumbnails, and a tap while it's open stops it.

const ICON: Record<string, string> = { running: "▶", waiting: "?", idle: "■", done: "✓", error: "!", starting: "…" };
const engineLabel = (kind: string) => kind === "codex" ? "Codex" : kind === "computer" ? "Computer" : "Claude Code";
const LIVE = new Set(["starting", "running", "waiting"]);

/** Latest computer-use screen per agent (288x144, levels 0..15); the hub sends it only for the agent open here. */
const screens = new Map<string, Raster>();
const SHOT_COLS = colsFor(288);
const SHOT_ROWS = rowsFor(248);
let watching: string | undefined;
function watch(id?: string) {
  if (id === watching) return;
  watching = id;
  send({ t: "agent_watch", agentId: id });
}

type View = { v: "list" } | { v: "detail"; id: string; page: number } | { v: "reply"; heard: string; reply: string; page: number; at: number };
let shownPage = 0;

// A voice reply: Bocchi on the left (talking for a while on each page, then blinking), the words beside her.
const REPLY_X = 12 + AVATAR_W + 12;
const REPLY_COLS = colsFor(576 - REPLY_X, 6);
const REPLY_ROWS = rowsFor(288 - 40, 6);
let view: View = { v: "list" };

export const agents: Mode & { voiceContext(): string | undefined } = {
  id: "agents",
  title: "Agents",
  enter() {
    view = { v: "list" };
    watch(undefined);
  },
  exit() {
    watch(undefined);
  },
  voiceContext: () => (view.v === "detail" ? view.id : undefined),
  onHub(m: HubMsg) {
    if (m.t === "voice_reply") view = { v: "reply", heard: m.heard, reply: m.reply, page: 0, at: Date.now() };
    else if (m.t === "agent_screen") screens.set(m.agentId, unpack4(fromB64(m.px), m.w, m.h));
    else if (m.t === "welcome" && watching) send({ t: "agent_watch", agentId: watching }); // a new hub connection
    else if (m.t === "state") for (const id of screens.keys()) if (!m.state.agents.some((a) => a.id === id)) screens.delete(id);
  },
  screen() {
    const s = core.state;
    if (view.v === "reply") {
      const lines = wrap(`“${view.heard}”\n\n${view.reply}`, REPLY_COLS);
      const pages = Math.max(1, Math.ceil(lines.length / REPLY_ROWS));
      view.page = Math.max(0, Math.min(view.page, pages - 1));
      if (view.page !== shownPage) view.at = Date.now(); // a new page: she "says" it
      shownPage = view.page;
      const body = lines.slice(view.page * REPLY_ROWS, (view.page + 1) * REPLY_ROWS).join("\n");
      return {
        header: `${ASSISTANT_NAME}${pages > 1 ? `  ${view.page + 1}/${pages}` : ""}`,
        tiles: [bocchiTile(replyMood(view.at, view.reply, body), 0, 12, 40 + (248 - AVATAR_H) / 2)],
        main: { x: REPLY_X, y: 40, w: 576 - REPLY_X, h: 248 },
        body: body || " ",
      };
    }
    if (view.v === "detail") {
      const id = view.id;
      const a = s.agents.find((x) => x.id === id);
      if (!a) {
        view = { v: "list" };
        watch(undefined);
        return this.screen();
      }
      watch(a.kind === "computer" ? a.id : undefined);
      const shot = a.kind === "computer" ? screens.get(a.id) : undefined;
      const stop = a.kind === "computer" && LIVE.has(a.status) ? " · TAP: STOP" : "";
      if (shot) {
        // Text on the left, the screen on the right.
        const lines = wrap(a.lastText || "(no output yet)", SHOT_COLS);
        const pages = Math.max(1, Math.ceil(lines.length / SHOT_ROWS));
        view.page = Math.max(0, Math.min(view.page, pages - 1));
        return {
          header: `${ICON[a.status] ?? ""} Computer · ${a.name} · ${a.status}${stop}${pages > 1 ? `  ${view.page + 1}/${pages}` : ""}`,
          main: { x: 0, y: 40, w: 288, h: 248 },
          body: lines.slice(view.page * SHOT_ROWS, (view.page + 1) * SHOT_ROWS).join("\n") || " ",
          tiles: [{ slot: 0, x: 288, y: 92, img: shot }],
        };
      }
      const p = paged(a.lastText || "(no output yet)", view.page);
      view.page = p.page;
      return { header: `${ICON[a.status] ?? ""} ${engineLabel(a.kind)} · ${a.name} · ${a.status}${stop}${p.pages > 1 ? `  ${p.page + 1}/${p.pages}` : ""}`, body: p.body };
    }
    const busy = s.agents.filter((a) => a.status === "running").length;
    return {
      header: `Agents ${busy}/${s.agents.length} busy · ${s.nodes.filter((n) => n.online).length} devices`,
      list: s.agents.length ? s.agents.slice(0, 20).map((a, i) => `${i + 1} ${ICON[a.status] ?? " "} ${engineLabel(a.kind)}: ${a.name}`) : ["No agents yet", "Start on phone or hold to talk"],
    };
  },
  gesture(g, i) {
    if (view.v === "list") {
      if (g === "tap") {
        const a = core.state.agents[i];
        if (a) view = { v: "detail", id: a.id, page: 0 };
        return true;
      }
      return g !== "double";
    }
    if (g === "down") view.page++;
    else if (g === "up") view.page = Math.max(0, view.page - 1);
    else {
      // The ring's hard stop: a tap on a computer-use agent that's still going stops it.
      const a = view.v === "detail" ? core.state.agents.find((x) => x.id === (view as { id: string }).id) : undefined;
      if (g === "tap" && a?.kind === "computer" && LIVE.has(a.status)) {
        send({ t: "agent_stop", agentId: a.id });
        flash("Stopping the computer");
        return true;
      }
      view = { v: "list" }; // tap or double: back to the list
      watch(undefined);
    }
    return true;
  },
};

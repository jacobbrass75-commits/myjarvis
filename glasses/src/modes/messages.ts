import type { HubMsg, MessageItem } from "../../../src/shared/protocol";
import { back, badges, core, current, flash, openMode, paged, render, send, wrap, type Mode } from "../core";
import { caps, clip, G, LV } from "../ui/kit";

// Texts and iMessages from the Mac's Messages app (src/hub/messages). A new one pops up as a card
// for a few seconds (tap: read, hold: reply by voice, double tap: close); in Translate, Copilot,
// Teleprompter or do not disturb it only raises a header badge. MESSAGES lists the last ones; its
// first row toggles do not disturb. Replies: hold and say "reply: on my way" (or "text Sam ...") and
// confirm the card that follows; nothing is sent without that tap.

const CARD_MS = 8000;

let items: MessageItem[] = [];
let queued = 0;
let dnd = false;
let issue = "";

type View = { v: "list" } | { v: "read"; id: string; page: number } | { v: "card"; id: string };
let view: View = { v: "list" };
/** The card was opened over another mode: closing it goes back there. */
let cardOver = false;
/** enter() comes from a popup: keep the card instead of the list. */
let entering: View | null = null;
let cardTimer: ReturnType<typeof setTimeout> | undefined;

const when = (t: number) => {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
const who = (m: MessageItem) => (m.group ? `${m.from} ${G.mid} ${m.group}` : m.from);
const find = (id: string) => items.find((m) => m.id === id);

badges.set("messages", () => (queued ? ` [${queued} MSG]` : ""));

/** The chat on the lens, so "reply: …" goes there. */
function focus(id?: string) {
  const m = id ? find(id) : undefined;
  send({ t: "messages_focus", chat: m?.chat });
}

function closeCard() {
  clearTimeout(cardTimer);
  if (view.v !== "card") return;
  if (cardOver && current()?.id === "messages") {
    cardOver = false;
    back();
  } else view = { v: "list" };
}

/** A popup: the card over whatever is up, or a one-line toast over screens with their own content. */
function popup(m: MessageItem) {
  const mode = current();
  if (mode?.quiet || core.listening) return; // conversation modes: the hub's badge only
  if (core.talking || mode?.id === "apps" || mode?.id === "navigate") return flash(clip(`${m.from}: ${m.text}`, 42), 6000);
  clearTimeout(cardTimer);
  const card: View = { v: "card", id: m.id };
  if (mode?.id === "messages") view = card;
  else {
    entering = card;
    cardOver = true;
    openMode("messages");
  }
  focus(m.id);
  const id = m.id;
  cardTimer = setTimeout(() => {
    if (view.v === "card" && view.id === id) {
      closeCard();
      render();
    }
  }, CARD_MS);
}

export const messagesMode: Mode = {
  id: "messages",
  title: "Messages",
  enter() {
    if (entering) {
      view = entering;
      entering = null;
      return;
    }
    cardOver = false;
    view = { v: "list" };
    send({ t: "messages_get" });
    send({ t: "messages_seen" });
  },
  exit() {
    clearTimeout(cardTimer);
    cardOver = false;
    view = { v: "list" };
    focus();
  },
  onHub(m: HubMsg) {
    if (m.t === "welcome") send({ t: "messages_get" });
    else if (m.t === "messages") {
      items = m.messages;
      queued = m.queued;
      dnd = m.dnd;
      issue = m.issue ?? "";
      // Open on MESSAGES: whatever came in quietly is seen now.
      if (queued && current()?.id === "messages" && view.v === "list") send({ t: "messages_seen" });
    } else if (m.t === "message_new") {
      if (!find(m.message.id)) items = [m.message, ...items].slice(0, 50);
      if (m.popup) popup(m.message);
    }
  },
  hold(down) {
    // Push-to-talk as usual; the hub learns which chat "reply: …" means first.
    if (down && view.v !== "list") focus(view.id);
    return false;
  },
  screen() {
    if (view.v === "card") {
      const m = find(view.id);
      if (m) {
        const lines = wrap(m.text, 42);
        const shown = lines.slice(0, 3);
        if (lines.length > 3) shown[2] = clip(shown[2], 41) + G.ell;
        return {
          header: clip(`${G.dot} MESSAGE  ${when(m.at)}${dnd ? "  DND" : ""}`, 44),
          main: { x: 12, y: 44, w: 552, h: 190, border: 2, borderLevel: LV.focus, pad: 8 },
          body: [clip(caps(who(m)), 42), "", ...shown].join("\n"),
          boxes: [{ slot: 0, x: 12, y: 242, w: 552, h: 40, border: 1, pad: 4, text: "TAP: READ   HOLD: REPLY   DOUBLE: CLOSE" }],
        };
      }
      view = { v: "list" };
    }
    if (view.v === "read") {
      const m = find(view.id);
      if (m) {
        const p = paged(m.text, view.page);
        view.page = p.page;
        return { header: clip(`${who(m)} ${G.mid} ${when(m.at)}${p.pages > 1 ? `  ${p.page + 1}/${p.pages}` : ""}  HOLD: REPLY`, 44), body: p.body };
      }
      view = { v: "list" };
    }
    if (issue) return { header: "MESSAGES", body: wrap(issue, 44).join("\n") };
    return {
      header: `MESSAGES (${items.length})${dnd ? "  DND" : ""}  HOLD: TALK`,
      list: [`DO NOT DISTURB: ${dnd ? "ON" : "OFF"}`, ...(items.length ? items.slice(0, 19).map((m) => `${when(m.at)} ${m.mine ? "> " : ""}${m.group ? `${m.group}: ` : ""}${m.mine ? "" : `${m.from}: `}${m.text}`) : ["No messages yet"])],
    };
  },
  gesture(g, i) {
    if (view.v === "card") {
      if (g === "tap") {
        cardOver = false; // reading it: double tap from here goes to the list, then back
        clearTimeout(cardTimer);
        view = { v: "read", id: view.id, page: 0 };
        return true;
      }
      if (g === "double") {
        if (cardOver) {
          closeCard();
          return true;
        }
        view = { v: "list" };
        return true;
      }
      return true;
    }
    if (view.v === "read") {
      if (g === "down") view.page++;
      else if (g === "up") view.page = Math.max(0, view.page - 1);
      else {
        view = { v: "list" };
        focus();
      }
      return true;
    }
    if (issue) return g !== "double";
    if (g === "tap") {
      if (i === 0) send({ t: "messages_dnd", on: !dnd });
      else if (items[i - 1]) {
        view = { v: "read", id: items[i - 1].id, page: 0 };
        focus(view.id);
      }
      return true;
    }
    return g !== "double";
  },
};

import type { CopilotUpdate, HubMsg } from "../../../src/shared/protocol";
import { send, startListening, stopListening, wrap, paged, type Mode } from "../core";
import { captionLines } from "../ui/caption";

// Live conversation copilot. While open, the glasses mic streams to the hub; Claude stays quiet until
// something interesting is said, then sends the alpha (a specific, current fact) or a fact-check, newest
// first. Swipe to pick a card, tap to read more, hold for alpha on what was just said, double tap to leave.

const LABEL: Record<string, string> = { fact: "ALPHA", ask: "ASK", say: "SAY", term: "TERM", check: "CHECK", next: "NEXT", answer: "ANS" };

let update: CopilotUpdate | null = null;
let engine = "";
let pick = 0;
let open: { page: number } | null = null;

export const copilot: Mode = {
  id: "copilot",
  title: "Copilot",
  quiet: true,
  enter() {
    pick = 0;
    open = null;
    startListening("copilot", navigator.language || "en-US");
  },
  exit() {
    stopListening();
  },
  onHub(m: HubMsg) {
    if (m.t === "copilot") {
      update = m.update;
      pick = 0;
      open = null;
    } else if (m.t === "listening") engine = m.engine ?? "";
  },
  hold(down) {
    if (down) send({ t: "copilot_ask" });
    return true;
  },
  screen() {
    const topic = update?.topic ? ` · ${update.topic}` : "";
    const header = `● Copilot${topic}`.slice(0, 46);
    const cards = update?.cards ?? [];
    if (open && cards[pick]) {
      const c = cards[pick];
      const p = paged(`${LABEL[c.kind] ?? c.kind}  ${c.text}\n\n${c.more ?? ""}`, open.page);
      open.page = p.page;
      return { header, body: p.body };
    }
    const lines: string[] = [];
    cards.forEach((c, i) => {
      const w = wrap(`${LABEL[c.kind] ?? c.kind}  ${c.text}`, 44).slice(0, 2);
      lines.push(...w.map((l, j) => (j === 0 ? (i === pick ? "› " : "  ") : "  ") + l));
    });
    if (!cards.length) lines.push(`  Listening${engine ? ` (${engine})` : ""}… quiet until it's worth it`, "", "  Hold: alpha on what was just said");
    if (update?.direction) lines.push("", `→ ${update.direction}`.slice(0, 46));
    // The conversation's last words at the bottom (YOU > / THEM >), the ones still being heard ending "_".
    const said = captionLines(44, 2, { source: "listen", who: true });
    const tail = [...said.done, ...said.live];
    return { header, body: [...lines.slice(0, tail.length ? 5 : 6), "", ...tail].join("\n") };
  },
  gesture(g) {
    const n = update?.cards.length ?? 0;
    if (open) {
      if (g === "down") open.page++;
      else if (g === "up") open.page = Math.max(0, open.page - 1);
      else open = null;
      return true;
    }
    if (g === "down" && n) pick = (pick + 1) % n;
    else if (g === "up" && n) pick = (pick - 1 + n) % n;
    else if (g === "tap" && n) open = { page: 0 };
    else return false;
    return true;
  },
};

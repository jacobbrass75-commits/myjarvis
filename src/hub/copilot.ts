import { modelFor, onModelChange } from "./models.js";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CopilotCard, CopilotUpdate } from "../shared/protocol.js";
import { ClaudeWorker, parseJsonReply } from "./claude-worker.js";
import { DATA_DIR } from "./store.js";

// The conversation copilot: listens to the live transcript and, every few sentences, asks Claude
// what the conversation is about, where it is going, and what would help right now. Results go to
// the glasses as a handful of very short cards.

// "alpha" (default): stay silent, surface only high-value, non-obvious information when something
// interesting is said. "coach" (COPILOT_STYLE=coach): the older conversation helper with ask/say/next.
const STYLE = process.env.COPILOT_STYLE === "coach" ? "coach" : "alpha";

const ALPHA = `You feed high-signal intel to someone wearing smart glasses while they talk with people.
You receive a rolling transcript of what the glasses hear (with recognition errors). "Me:" is the
wearer, "Them:" is someone else; unlabelled lines could be either.

You are NOT a conversation coach. Never suggest what to say or ask, never describe where the
conversation is going, never define everyday words. Your only job: when something interesting is
said (a company, person, product, market, deal, place, technology, number, claim, event), hand the
wearer the "alpha": the specific, non-obvious, current information an insider would know and that
makes them the most informed person in the room. Examples of good alpha: the latest funding round
and valuation, revenue or growth numbers, who is really behind it, a recent development from the
last weeks, the key stat that frames the topic, the real reason something happened, a little-known
connection, a price or date. Use web search for anything current or numeric; never guess numbers.

Card kinds:
- "fact": alpha as above.
- "check": a claim just made that is wrong or outdated, with the correct figure.
- "answer": only if the wearer asks you something directly.

Rules:
- Default to NOTHING. Most of the time return an empty cards array. Only interrupt when the
  information is genuinely valuable and specific; at most 2 cards per reply.
- Card "text" is at most 80 characters and leads with the concrete thing (the number, the name, the
  date): it is read at a glance on a tiny display. Put supporting detail and the source in "more"
  (at most 300 characters).
- Only about the newest part of the transcript; never repeat or rephrase a card already given.
- Reply with ONLY a JSON object, no prose:
  {"topic": "<2-4 words>", "summary": "", "direction": "", "cards": [{"kind": "fact", "text": "...", "more": "..."}]}`;

const COACH = `You are a discreet real-time conversation copilot for someone wearing smart glasses.
You receive a rolling transcript of what the glasses' microphone hears (the wearer and the people
they are talking to; the transcript has recognition errors). Lines may start with "Me:" (the wearer)
or "Them:" (someone else) when the glasses could tell; unlabelled lines could be either.

Your job, each time: work out what the conversation is about and where it is heading, and give the
wearer at most 3 cards that make them sharper in THIS conversation right now. Card kinds:
- "fact": a specific, genuinely interesting piece of information about what is being discussed
  (names, numbers, history, recent news). Use web search when it adds something concrete or current.
- "check": a claim someone just made that is wrong or doubtful, with the correction.
- "term": a definition of jargon or a name that came up and may not be obvious.
- "ask": a natural, open question the wearer could ask to keep the conversation going or go deeper.
- "say": something insightful the wearer could contribute.
- "next": where the conversation is likely to go, or a smooth way to steer it.
- "answer": if the wearer asked you something directly, the answer.

Priority when choosing the (at most 3) cards: a direct "answer" first, then a "check" for any
false or doubtful claim in the newest part of the transcript (never let a myth slide), then a "term"
for anything the wearer may not know, then "fact", then "ask" / "say" / "next".

Rules:
- Card "text" is at most 80 characters: it is read at a glance on a tiny display. Put any detail in
  "more" (at most 300 characters).
- Never repeat or rephrase a card you already gave (they are listed for you). Prefer nothing over filler:
  return an empty cards array if nothing new is worth interrupting for.
- Be specific to what was said. No generic advice ("ask open questions", "listen actively").
- Reply with ONLY a JSON object, no prose:
  {"topic": "...", "summary": "<one sentence>", "direction": "<where it is heading, short>",
   "cards": [{"kind": "fact", "text": "...", "more": "..."}]}`;

const SYSTEM = STYLE === "coach" ? COACH : ALPHA;

interface Line {
  text: string;
  at: number;
}

export class Copilot {
  private lines: Line[] = [];
  private shown: string[] = [];
  private newWords = 0;
  private lastRun = 0;
  private running = false;
  private again = false;
  private worker: ClaudeWorker;
  private logFile: string;
  last: CopilotUpdate | null = null;
  /** Extra context set from outside, e.g. the meeting about to start and who's in it (google/index.ts). */
  context = "";

  constructor(
    private emit: (u: CopilotUpdate) => void,
    private onError: (msg: string) => void,
    /** Remembered facts about people whose names appear in the given text. */
    private people: (text: string) => [string, { text: string; at: number }[]][] = () => [],
  ) {
    this.worker = new ClaudeWorker({
      name: "copilot",
      system: SYSTEM,
      tools: ["WebSearch", "WebFetch"],
      model: modelFor("copilot"),
      effort: "low",
      maxTurns: 12,
    });
    onModelChange((role) => {
      if (role === "copilot") this.worker.setModel(modelFor("copilot"));
    });
    const day = new Date().toISOString().slice(0, 10);
    this.logFile = join(DATA_DIR, "conversations", `${day}.jsonl`);
  }

  /** A finished sentence from speech-to-text (or typed in). */
  heard(text: string) {
    const line = { text, at: Date.now() };
    this.lines.push(line);
    this.newWords += text.split(/\s+/).length;
    this.log({ type: "heard", ...line });
    // Keep about the last 10 minutes.
    const cutoff = Date.now() - 10 * 60_000;
    while (this.lines.length && this.lines[0].at < cutoff) this.lines.shift();
    // Wait for a short pause so an analysis covers a whole thought, not half a sentence.
    clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      const since = Date.now() - this.lastRun;
      if ((this.newWords >= 25 && since > 8_000) || (this.newWords >= 8 && since > 20_000)) this.analyze();
    }, 1800);
  }

  private settle?: NodeJS.Timeout;

  /** Wearer asked for help now (ring hold), optionally with a question. */
  ask(question?: string) {
    this.analyze(question || (STYLE === "coach"
      ? "The wearer just asked for help: give your best cards for this moment."
      : "The wearer asked for alpha now: give the single most valuable specific, current fact about what was just discussed (search if needed). Return one card even if it is only moderately interesting."));
  }

  /** Words heard since the last reset. */
  get words() {
    return this.lines.reduce((n, l) => n + l.text.split(/\s+/).length, 0);
  }

  /** A short recap with action items, for saving as a note when a conversation ends. */
  async summarize(): Promise<{ note: string; people: { name: string; facts: string[] }[] } | null> {
    if (this.words < 80) return null;
    const transcript = this.lines.map((l) => l.text).join("\n").slice(-20_000);
    const reply = await this.worker.ask(
      `<transcript>\n${transcript}\n</transcript>\n\nThe conversation is over. Reply with ONLY a JSON object: {"summary": "<the gist in at most 3 sentences>", "actions": ["<follow-ups or commitments, each short>"], "people": [{"name": "<a person's name as said>", "facts": ["<a durable, specific thing learned about them: job, family, plans, likes, problems>"]}]}. Only include people actually named, and only facts worth remembering next time you meet them.`,
    );
    const j = parseJsonReply<{ summary?: string; actions?: string[]; people?: { name: string; facts: string[] }[] }>(reply);
    if (!j?.summary) return null;
    const people = (j.people ?? []).filter((p) => p?.name && Array.isArray(p.facts));
    const parts = [`Conversation: ${j.summary}`];
    if (j.actions?.length) parts.push("To do: " + j.actions.join("; "));
    if (people.length) parts.push("People: " + people.map((p) => p.name).join(", "));
    return { note: parts.join("\n"), people };
  }

  reset() {
    this.lines = [];
    this.shown = [];
    this.newWords = 0;
    this.last = null;
    this.worker.close();
  }

  close() {
    this.worker.close();
  }

  private async analyze(request?: string) {
    if (this.running) {
      this.again = true;
      return;
    }
    if (!this.lines.length && !request) return;
    this.running = true;
    this.lastRun = Date.now();
    this.newWords = 0;
    const transcript = this.lines
      .map((l) => `[${new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}] ${l.text}`)
      .join("\n")
      .slice(-12_000);
    const known = this.people(this.context ? `${transcript}\n${this.context}` : transcript)
      .map(([name, facts]) => `${name}: ${facts.slice(-8).map((f) => `${f.text} (${new Date(f.at).toLocaleDateString()})`).join("; ")}`)
      .join("\n");
    const prompt = [
      `<transcript>\n${transcript || "(nothing heard yet)"}\n</transcript>`,
      known ? `<what_the_wearer_knows_about_people_mentioned>\n${known}\n</what_the_wearer_knows_about_people_mentioned>${STYLE === "coach" ? '\nIf someone here is one of these people, a "say" or "ask" card that follows up on what you know about them can be gold.' : ""}` : "",
      this.shown.length ? `<cards_already_given>\n${this.shown.slice(-30).join("\n")}\n</cards_already_given>` : "",
      this.context ? `<context>${this.context}</context>` : "",
      request ? `<wearer_request>${request}</wearer_request>` : "",
      `Local time: ${new Date().toLocaleString()}.`,
    ].filter(Boolean).join("\n\n");
    try {
      const reply = await this.worker.ask(prompt);
      const j = parseJsonReply<{ topic?: string; summary?: string; direction?: string; cards?: CopilotCard[] }>(reply);
      if (!j) throw new Error(`unreadable reply: ${reply.slice(0, 120)}`);
      const fresh = (j.cards ?? [])
        .filter((c) => c && typeof c.text === "string" && c.text.trim())
        .filter((c) => STYLE === "coach" || ["fact", "check", "answer"].includes(c.kind))
        .slice(0, STYLE === "coach" ? 3 : 2)
        .map((c) => ({ kind: c.kind ?? "fact", text: c.text.trim().slice(0, 120), more: c.more?.slice(0, 600) }));
      this.shown.push(...fresh.map((c) => `${c.kind}: ${c.text}`));
      // Alpha keeps a feed (newest first) and stays quiet when there's nothing new; coach replaces the cards.
      if (STYLE === "alpha" && !fresh.length) return;
      const cards = STYLE === "alpha" ? [...fresh, ...(this.last?.cards ?? [])].slice(0, 6) : fresh;
      const update: CopilotUpdate = {
        topic: j.topic ?? this.last?.topic ?? "", summary: STYLE === "alpha" ? "" : j.summary ?? "",
        direction: STYLE === "alpha" ? "" : j.direction ?? "", cards, at: Date.now(),
      };
      this.last = update;
      this.log({ type: "copilot", ...update });
      this.emit(update);
    } catch (e: any) {
      this.onError(`Copilot: ${e?.message ?? e}`);
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        if (this.newWords > 0) this.analyze();
      }
    }
  }

  private log(entry: object) {
    mkdir(join(this.logFile, ".."), { recursive: true })
      .then(() => appendFile(this.logFile, JSON.stringify(entry) + "\n"))
      .catch(() => {});
  }
}

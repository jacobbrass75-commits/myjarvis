import type { WebSocket } from "ws";
import { type ListenPurpose, type TranslateOptions, clip, send } from "../shared/protocol.js";
import { Copilot } from "./copilot.js";
import { dashboard } from "./dashboard.js";
import type { Hub } from "./hub.js";
import { openSpeechStream, type SpeechStream } from "./listen.js";
import { fetchPublic } from "./safe-fetch.js";
import { ClaudeWorker } from "./claude-worker.js";
import { Navigator } from "./nav.js";
import { Studio } from "./studio.js";
import { Store } from "./store.js";
import { Translator, defaultTranslateOptions, mergeTranslateOptions } from "./translate.js";

// The "Jarvis" features that sit on top of the agent hub: continuous listening with a live
// transcript, the conversation copilot, two-way translation, notes, teleprompter scripts and the
// dashboard. One wearer at a time: whoever started listening owns the mic stream.

interface Session {
  owner: WebSocket;
  purpose: ListenPurpose;
  stream: SpeechStream;
  translator?: Translator;
}

const LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", ja: "Japanese",
  ko: "Korean", zh: "Chinese", ar: "Arabic", ru: "Russian", hi: "Hindi", nl: "Dutch", tr: "Turkish", he: "Hebrew",
  pl: "Polish", sv: "Swedish", uk: "Ukrainian", vi: "Vietnamese", th: "Thai", id: "Indonesian",
};
export const langName = (code: string) => LANG_NAMES[code.slice(0, 2).toLowerCase()] ?? code;

export class Jarvis {
  store = new Store();
  copilot: Copilot;
  nav: Navigator;
  studio: Studio;
  /** Answers api.ask(...) from running mini-apps. */
  private appBrain = new ClaudeWorker({
    name: "miniapp-ask",
    system: "You answer requests from small apps running on smart glasses (games, quizzes, tools). Reply with exactly what was asked for, as plain text, concise enough for a tiny display. No markdown.",
    effort: "low",
    maxTurns: 30,
  });
  session: Session | null = null;
  /** How Translate shows Chinese: env defaults, changed per session from the phone (kept for the next one). */
  translateOptions: TranslateOptions = defaultTranslateOptions();
  /** Speaker-role changes reported by the glasses: [time, role]. */
  private roles: [number, "self" | "other" | "unknown"][] = [];

  constructor(private hub: Hub) {
    this.nav = new Navigator(
      (nav) => hub.toUIs({ t: "nav", nav }),
      // ~55 KB each: only the glasses draw it (the phone page shows the text directions).
      (map) => {
        for (const c of hub.clients) if (c.role === "glasses") send(c.ws, { t: "nav_map", map });
      },
    );
    this.studio = new Studio(
      (job) => hub.toUIs({ t: "studio", job }),
      (apps) => hub.toUIs({ t: "miniapps", apps }),
    );
    this.copilot = new Copilot(
      (update) => hub.toUIs({ t: "copilot", update }),
      (msg) => hub.toUIs({ t: "toast", text: clip(msg, 140) }),
      (text) => this.store.mentioned(text),
    );
  }

  /** Bring a newly connected screen up to date. */
  greet(ws: WebSocket) {
    send(ws, { t: "miniapps", apps: this.studio.list() });
    send(ws, { t: "notes", notes: this.store.notes });
    send(ws, { t: "script", script: this.store.script });
    if (this.copilot.last) send(ws, { t: "copilot", update: this.copilot.last });
    send(ws, { t: "listening", purpose: this.session?.purpose ?? null, engine: this.session?.stream.engine });
    send(ws, { t: "translate_options", options: this.translateOptions });
  }

  /** A page that connects mid-route gets the directions now, not at the next fix (the map: glasses only). */
  greetNav(ws: WebSocket, glasses: boolean) {
    this.nav.replay((m) => send(ws, m), glasses);
  }

  setTranslateOptions(o?: Partial<TranslateOptions>) {
    this.translateOptions = mergeTranslateOptions(this.translateOptions, o);
    this.hub.toUIs({ t: "translate_options", options: this.translateOptions });
  }

  owns(ws: WebSocket) {
    return this.session?.owner === ws;
  }

  /** What the open listening session is for, if any. */
  get listening(): ListenPurpose | null {
    return this.session?.purpose ?? null;
  }

  async start(owner: WebSocket, purpose: ListenPurpose, sampleRate: number, lang?: string, target?: string, translate?: Partial<TranslateOptions>) {
    await this.stop();
    // lang = the language being spoken that speech-to-text should expect; for translation that's
    // the other person's language, and target is yours.
    const mine = target || "en";
    const theirs = lang || "en";
    const translator =
      purpose === "translate" ? new Translator({ code: mine, name: langName(mine) }, { code: theirs, name: langName(theirs) }) : undefined;
    if (translator) this.setTranslateOptions(translate);
    if (purpose === "copilot") this.copilot.reset();
    const stream = await openSpeechStream(purpose === "translate" ? theirs : lang || "en-US", sampleRate, {
      // Partials carry who too, so the lens can tag your own live words before the sentence ends.
      partial: (text) => this.hub.toUIs({ t: "transcript", line: { text, at: Date.now(), final: false, who: this.whoSpoke(this.spokenFor(text)) } }),
      final: (text) => this.heard(text),
      error: (msg) => this.hub.toUIs({ t: "toast", text: clip(msg, 140) }),
    }, purpose === "translate" ? { alsoLangs: [mine.slice(0, 2).toLowerCase()] } : {});
    this.session = { owner, purpose, stream, translator };
    this.hub.toUIs({ t: "listening", purpose, engine: stream.engine });
  }

  speaker(role: "self" | "other" | "unknown") {
    this.roles.push([Date.now(), role]);
    if (this.roles.length > 500) this.roles.splice(0, 250);
  }

  /** Roughly 2.5 words a second: about how long `text` took to say, as a look-back for whoSpoke. */
  private spokenFor(text: string) {
    return Math.max(2, Math.min(20, text.split(/\s+/).length / 2.5 + 1));
  }

  /** Who spoke most during the last `seconds`, by the glasses' self/other tags. */
  private whoSpoke(seconds: number): "me" | "them" | undefined {
    if (!this.roles.length) return undefined;
    const now = Date.now(), from = now - seconds * 1000;
    const time = { self: 0, other: 0, unknown: 0 };
    for (let i = 0; i < this.roles.length; i++) {
      const [t, r] = this.roles[i];
      const end = this.roles[i + 1]?.[0] ?? now;
      const span = Math.min(end, now) - Math.max(t, from);
      if (span > 0) time[r] += span;
    }
    if (time.self + time.other < 300) return undefined;
    return time.self >= time.other ? "me" : "them";
  }

  audio(pcm: Buffer) {
    const s = this.session;
    if (!s) return;
    s.stream.write(pcm);
    this.meter(pcm);
  }

  /** Mic level in the hub log every 15 s while listening, so "nothing heard" is diagnosable. */
  private level = { bytes: 0, peak: 0, since: 0 };
  private meter(pcm: Buffer) {
    const l = this.level;
    if (!l.since) l.since = Date.now();
    l.bytes += pcm.length;
    for (let i = 0; i + 1 < pcm.length; i += 2) l.peak = Math.max(l.peak, Math.abs(pcm.readInt16LE(i)));
    const secs = (Date.now() - l.since) / 1000;
    if (secs < 15) return;
    console.log(`[listen] ${this.session?.purpose} audio ${(l.bytes / 32000).toFixed(1)} s in ${secs.toFixed(0)} s, peak ${((l.peak / 32768) * 100).toFixed(0)}%`);
    this.level = { bytes: 0, peak: 0, since: Date.now() };
  }

  async stop() {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.level = { bytes: 0, peak: 0, since: 0 };
    await s.stream.close().catch(() => {});
    s.translator?.close();
    this.hub.toUIs({ t: "listening", purpose: null });
    if (s.purpose === "copilot")
      this.copilot
        .summarize()
        .then((r) => {
          if (!r) return;
          this.addNote(r.note);
          for (const p of r.people) for (const f of p.facts) this.store.remember(p.name, f);
          this.hub.toUIs({ t: "toast", text: "Conversation summary saved to Notes" });
        })
        .catch(() => {});
  }

  // ---- timers & reminders ----
  private timers = new Map<string, { label: string; at: number; t: NodeJS.Timeout }>();

  setTimer(minutes: number, label: string): string {
    const id = Math.random().toString(36).slice(2, 7);
    const at = Date.now() + minutes * 60_000;
    const t = setTimeout(() => {
      this.timers.delete(id);
      this.hub.toUIs({ t: "toast", text: `⏰ ${label || "Timer done"}` });
      this.hub.toUIs({ t: "voice_reply", heard: "Reminder", reply: `⏰ ${label || "Timer done"} (set ${minutes} min ago)` });
    }, minutes * 60_000);
    this.timers.set(id, { label, at, t });
    return id;
  }

  listTimers() {
    return [...this.timers.values()].map((x) => `${x.label || "timer"}: ${Math.max(0, Math.round((x.at - Date.now()) / 60_000))} min left`);
  }

  cancelTimers(match?: string) {
    let n = 0;
    for (const [id, x] of this.timers)
      if (!match || x.label.toLowerCase().includes(match.toLowerCase())) {
        clearTimeout(x.t);
        this.timers.delete(id);
        n++;
      }
    return n;
  }

  /** A finished sentence, from speech-to-text or typed on the phone. */
  heard(text: string) {
    text = text.trim();
    if (!text) return;
    const who = this.whoSpoke(this.spokenFor(text));
    this.hub.toUIs({ t: "transcript", line: { text, at: Date.now(), final: true, who } });
    const s = this.session;
    if (!s || s.purpose === "copilot") this.copilot.heard(who ? `${who === "me" ? "Me" : "Them"}: ${text}` : text);
    if (s?.translator) {
      const tr = s.translator;
      tr.translate(text, this.translateOptions.pinyin)
        .then((r) =>
          this.hub.toUIs({
            t: "translation", source: text, text: r.text, from: r.from, to: r.to, at: Date.now(),
            ...(tr.chinese && { original: r.original, hanzi: r.hanzi, pinyin: r.pinyin }),
          }),
        )
        .catch((e) => this.hub.toUIs({ t: "toast", text: `Translate: ${clip(String(e?.message ?? e), 100)}` }));
    }
  }

  addNote(text: string) {
    const n = this.store.addNote(text);
    this.hub.toUIs({ t: "notes", notes: this.store.notes });
    return n;
  }

  deleteNote(id: string) {
    this.store.deleteNote(id);
    this.hub.toUIs({ t: "notes", notes: this.store.notes });
  }

  setScript(script: { title: string; text: string } | null) {
    this.store.setScript(script);
    this.hub.toUIs({ t: "script", script });
  }

  /** api.ask(...) from a mini-app. */
  async appAsk(ws: WebSocket, reqId: string, prompt: string) {
    try {
      send(ws, { t: "app_answer", reqId, text: (await this.appBrain.ask(String(prompt).slice(0, 4000))).trim() });
    } catch (e: any) {
      send(ws, { t: "app_answer", reqId, error: String(e?.message ?? e) });
    }
  }

  /** api.fetchJson(url) from a mini-app: GET only, public http(s) only, small responses (safe-fetch.ts). */
  async appFetch(ws: WebSocket, reqId: string, url: string) {
    try {
      const r = await fetchPublic(String(url));
      let data: unknown;
      try {
        data = JSON.parse(r.body);
      } catch {
        throw new Error(`not JSON (HTTP ${r.status})`);
      }
      send(ws, { t: "app_answer", reqId, data });
    } catch (e: any) {
      send(ws, { t: "app_answer", reqId, error: String(e?.message ?? e) });
    }
  }

  async dashboard(ws: WebSocket) {
    try {
      send(ws, { t: "dashboard", dashboard: await dashboard(this.hub) });
    } catch (e: any) {
      send(ws, { t: "toast", text: `Dashboard: ${clip(String(e?.message ?? e), 100)}` });
    }
  }
}

// Streaming speech-to-text for the hub: free and local by default, Soniox cloud when its key is set.
//
//   const stt = createStreamingSTT({ lang: "en-US" });          // engine: "auto" by default
//   stt.on("partial", (e) => show(e.text));                      // replaces the current line
//   stt.on("final",   (e) => commit(e.text));                    // one per utterance
//   ws.on("message", (pcm) => stt.write(pcm));                   // s16le 16 kHz mono
//   await stt.close();                                           // flushes the last utterance
//
// Engines: "apple" = tools/speech/bin/g2speech (SpeechAnalyzer on macOS 26, on-device);
// "whisper" = shared whisper-server (whisper.cpp) on VAD-segmented utterances;
// "soniox" = Soniox real-time WebSocket (cloud, needs SONIOX_API_KEY);
// "wispr" = Wispr Flow (cloud, needs WISPR_API_KEY): dictation-style finals per pause-cut utterance, no
// partials, so it's in the live order only when asked for (push-to-talk uses it anyway, see listen.ts).
// "auto" picks soniox when its key is set (and it knows the language), else apple when it supports
// the locale, else whisper. A list ("wispr,soniox,apple,whisper", e.g. STT_ENGINE) is the auto order.
// A failing engine hands over to the next one: soniox/wispr (bad key, offline, gave up reconnecting)
// -> the next in the order, apple (won't start) -> whisper; the audio not transcribed yet is replayed,
// nothing is lost.

import { EventEmitter } from "node:events";
import { AppleStream, appleAvailable, appleLocales, appleSupports } from "./apple.js";
import { WhisperStream, WHISPER_LANGS, whisperAvailable, ensureWhisperServer } from "./whisper.js";
import { SonioxStream, SONIOX_LANGS, sonioxAvailable, sonioxBenched, sonioxCheckKey, sonioxKey, sonioxSupports } from "./soniox.js";
import { WisprStream, wisprAvailable, wisprKey, wisprSupports, wisprWarmUp } from "./wispr.js";
import type { EngineChoice, EngineName, STTEvent } from "./types.js";

export type { STTEvent, EngineName, EngineChoice } from "./types.js";
export { stopWhisperServer } from "./whisper.js";
export { sonioxAvailable, sonioxBenched } from "./soniox.js";
export { wisprAvailable, wisprBenched } from "./wispr.js";

const ENGINES: readonly EngineName[] = ["soniox", "wispr", "apple", "whisper"];
/** The live order "auto" means: Wispr only when listed (it has no partials). */
export const DEFAULT_ORDER: readonly EngineName[] = ["soniox", "apple", "whisper"];

/**
 * "auto" -> the default order; "wispr,soniox,apple" -> that order (unknown names dropped); one name ->
 * just it, forced. null for something else entirely.
 */
export function engineOrder(choice: string | undefined): { order: EngineName[]; forced: boolean } | null {
  const c = (choice ?? "auto").trim().toLowerCase() || "auto";
  if (c === "auto") return { order: [...DEFAULT_ORDER], forced: false };
  const names = c.split(/[\s,]+/).filter(Boolean);
  const order = [...new Set(names.filter((n): n is EngineName => (ENGINES as readonly string[]).includes(n)))];
  if (!order.length) return null;
  return { order, forced: names.length === 1 };
}

export interface StreamingSTTOptions {
  /** BCP-47 locale, e.g. "en-US", "es-ES", "fr-FR", "ja-JP". whisper also accepts "auto". */
  lang?: string;
  engine?: EngineChoice;
  sampleRate?: number;
  /** Pause that ends an utterance (default 600 ms). */
  silenceMs?: number;
  /** whisper only: how often to re-transcribe the open utterance for partials (default 700 ms). */
  partialIntervalMs?: number;
  /** whisper only: output English regardless of spoken language (whisper's built-in translation). */
  translateToEnglish?: boolean;
  /**
   * Other languages likely in the same audio, e.g. the wearer's own during translation. Cloud engines
   * use them as language hints so mixed speech works; local engines ignore them. Default ["en"].
   */
  alsoLangs?: string[];
  /** soniox only: speaker labels on finals, one final per speaker turn. Default: SONIOX_DIARIZATION=1. */
  diarize?: boolean;
}

export interface FallbackInfo {
  from: EngineName;
  to: EngineName;
  reason: string;
}

export interface StreamingSTT {
  write(pcm: Buffer): void;
  on(ev: "partial" | "final", cb: (e: STTEvent) => void): StreamingSTT;
  on(ev: "ready", cb: (info: { engine: EngineName; lang: string; [k: string]: unknown }) => void): StreamingSTT;
  on(ev: "error", cb: (err: Error) => void): StreamingSTT;
  on(ev: "status", cb: (msg: string) => void): StreamingSTT;
  /** The cloud engine failed and a local one took over (once per stream). */
  on(ev: "fallback", cb: (f: FallbackInfo) => void): StreamingSTT;
  off(ev: string, cb: (...a: any[]) => void): StreamingSTT;
  close(): Promise<void>;
  /** Resolves to the engine chosen at start ("auto" may later fall back to a local one; see the "ready" event). */
  readonly engine: Promise<EngineName>;
}

type Inner = AppleStream | WhisperStream | SonioxStream | WisprStream;
type Cloud = SonioxStream | WisprStream;

const MAX_REPLAY_BYTES = 16000 * 2 * 30;

class STT extends EventEmitter {
  engine: Promise<EngineName>;
  private inner: Inner | null = null;
  private pending: Buffer[] = [];
  private replay: Buffer[] | null = []; // audio since start, kept until apple is ready
  private replayBytes = 0;
  private closing = false;
  private dead = false; // no engine to feed (none could start): audio is dropped, not queued forever
  private switching: Promise<void> | null = null; // cloud -> local handover in progress
  private offset = 0; // seconds: where a fallback engine's audio starts in this stream
  private order: EngineName[];
  private forced: boolean; // one engine named: its failures are errors, not fallbacks
  private failed = new Set<EngineName>();
  private o: Required<Omit<StreamingSTTOptions, "translateToEnglish" | "alsoLangs" | "diarize">> & {
    translateToEnglish: boolean;
    alsoLangs?: string[];
    diarize: boolean;
  };

  constructor(opts: StreamingSTTOptions) {
    super();
    this.o = {
      lang: opts.lang ?? "en-US",
      engine: opts.engine ?? "auto",
      sampleRate: opts.sampleRate ?? 16000,
      silenceMs: opts.silenceMs ?? 600,
      partialIntervalMs: opts.partialIntervalMs ?? 700,
      translateToEnglish: opts.translateToEnglish ?? false,
      alsoLangs: opts.alsoLangs,
      diarize: opts.diarize ?? process.env.SONIOX_DIARIZATION === "1",
    };
    const order = engineOrder(this.o.engine);
    if (!order) console.warn(`[stt] engine "${this.o.engine}" isn't auto, soniox, wispr, apple, whisper or a list of them; using auto`);
    this.order = order?.order ?? [...DEFAULT_ORDER];
    this.forced = order?.forced ?? false;
    // Avoid unhandled 'error' crashes when the caller only listens for transcripts.
    this.on("error", () => {});
    this.engine = this.pick().then((e) => {
      this.start(e);
      return e;
    });
    this.engine.catch((e) => {
      this.dead = true;
      this.pending = [];
      this.emit("error", e);
    });
  }

  private async pick(): Promise<EngineName> {
    if (this.forced) {
      const e = this.order[0];
      if (e === "soniox" && !sonioxKey()) throw new Error("SONIOX_API_KEY is not set (get a key at console.soniox.com)");
      if (e === "wispr" && !wisprKey()) throw new Error("WISPR_API_KEY is not set (Wispr Flow API: platform.wisprflow.ai)");
      if (e === "apple" && !appleAvailable()) throw new Error("g2speech binary missing: run tools/speech/build.sh");
      return e;
    }
    return this.pickNext();
  }

  /** The first engine in the order that can take this stream now (skipping ones that failed in it). */
  private async pickNext(): Promise<EngineName> {
    const { lang } = this.o;
    const english = this.o.translateToEnglish; // only whisper translates
    const usable = async (e: EngineName) =>
      e === "soniox" ? !english && sonioxAvailable() && sonioxSupports(lang)
      : e === "wispr" ? !english && wisprAvailable() && wisprSupports(lang)
      : e === "apple" ? !english && lang !== "auto" && appleAvailable() && (await appleSupports(lang))
      : whisperAvailable(lang);
    for (const e of this.order) if (!this.failed.has(e) && (await usable(e))) return e;
    // Last resort, as before: apple even for a locale it may not know.
    if (this.order.includes("apple") && !this.failed.has("apple") && appleAvailable()) return "apple";
    throw new Error("no STT engine available: build tools/speech or brew install whisper-cpp + download a model");
  }

  private start(e: EngineName) {
    const shift = (ev: STTEvent): STTEvent =>
      this.offset ? { ...ev, start: Math.round((ev.start + this.offset) * 1000) / 1000, end: Math.round((ev.end + this.offset) * 1000) / 1000 } : ev;
    const fwd = (inner: Inner) => {
      inner.on("partial", (ev: STTEvent) => this.emit("partial", shift(ev)));
      inner.on("final", (ev: STTEvent) => this.emit("final", shift(ev)));
      inner.on("status", (m: string) => this.emit("status", m));
    };
    if (e === "soniox" || e === "wispr") {
      this.replay = null; // the cloud stream keeps the audio it hasn't finalized; a fallback replays that
      const s: Cloud =
        e === "soniox"
          ? new SonioxStream({ lang: this.o.lang, sampleRate: this.o.sampleRate, alsoLangs: this.o.alsoLangs, diarize: this.o.diarize })
          : new WisprStream({ lang: this.o.lang, sampleRate: this.o.sampleRate, silenceMs: this.o.silenceMs, alsoLangs: this.o.alsoLangs });
      fwd(s);
      s.on("ready", (i) => this.emit("ready", i));
      s.on("error", (err: Error) => {
        if (this.forced) this.emit("error", err);
        else this.switching = this.fallbackFrom(s, e, err);
      });
      this.inner = s;
    } else if (e === "whisper") {
      this.replay = null;
      const w = new WhisperStream({
        lang: this.o.lang,
        sampleRate: this.o.sampleRate,
        silenceMs: this.o.silenceMs,
        partialIntervalMs: this.o.partialIntervalMs,
        translate: this.o.translateToEnglish,
      });
      fwd(w);
      w.on("ready", (i) => this.emit("ready", i));
      w.on("error", (err) => this.emit("error", err));
      this.inner = w;
    } else {
      const a = new AppleStream({ lang: this.o.lang, sampleRate: this.o.sampleRate, silenceMs: this.o.silenceMs });
      fwd(a);
      let failed = false;
      const fallback = (err: Error) => {
        if (failed) return;
        failed = true;
        if (this.forced || !whisperAvailable(this.o.lang)) {
          this.emit("error", err);
        } else {
          this.emit("status", `apple engine failed (${err.message}); falling back to whisper`);
          const replay = this.replay ?? [];
          a.kill();
          this.start("whisper");
          for (const b of replay) this.inner!.write(b);
          if (this.closing) void this.inner!.close();
        }
      };
      a.on("ready", (i) => {
        this.replay = null;
        this.emit("ready", i);
      });
      a.on("error", fallback);
      a.on("exit", (x: any) => {
        if (!this.closing || !a.ready) fallback(new Error(`g2speech exited (${x.code ?? x.signal}) ${x.stderr ?? ""}`.trim()));
      });
      this.inner = a;
    }
    for (const b of this.pending) this.inner.write(b);
    this.pending = [];
  }

  /** A cloud engine gave up: carry on with the next in the order, replaying the audio it hadn't finalized. */
  private async fallbackFrom(s: Cloud, from: EngineName, err: Error) {
    const { pcm, start } = s.pendingAudio();
    this.inner = null; // audio written meanwhile queues in this.pending
    this.failed.add(from);
    let next: EngineName;
    try {
      next = await this.pickNext();
    } catch (e: any) {
      this.switching = null;
      this.dead = true;
      this.pending = [];
      this.emit("error", new Error(`${err.message}; no local engine either (${e?.message ?? e})`));
      return;
    }
    this.emit("status", `${err.message}; falling back to ${next}`);
    this.emit("fallback", { from, to: next, reason: err.message } satisfies FallbackInfo);
    this.offset += start;
    this.pending = [...pcm, ...this.pending];
    this.replay = [...this.pending]; // in case apple then fails over to whisper
    this.replayBytes = this.replay.reduce((a, b) => a + b.length, 0);
    this.start(next);
    this.switching = null;
  }

  write(pcm: Buffer) {
    if (this.closing || this.dead) return;
    if (this.replay) {
      this.replay.push(pcm);
      this.replayBytes += pcm.length;
      while (this.replayBytes > MAX_REPLAY_BYTES && this.replay.length > 1) this.replayBytes -= this.replay.shift()!.length;
    }
    if (this.inner) this.inner.write(pcm);
    else this.pending.push(pcm);
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.engine;
    } catch {
      return;
    }
    let cur: Inner | null = null;
    // The inner engine may be swapped by a fallback while we wait; close whatever is current.
    for (;;) {
      if (this.switching) await this.switching;
      if (!this.inner || this.inner === cur) break;
      cur = this.inner;
      await cur.close();
    }
  }
}

export function createStreamingSTT(opts: StreamingSTTOptions = {}): StreamingSTT {
  return new STT(opts) as unknown as StreamingSTT;
}

export interface LanguageSupport {
  /** On-device Apple SpeechTranscriber locales (macOS 26). Others download on first use. */
  apple: string[];
  appleInstalled: string[];
  /** SFSpeechRecognizer locales (needs Speech Recognition permission). */
  appleLegacy: string[];
  appleLegacyAuthorized: boolean;
  /** whisper language codes (if whisper-server + model are installed). */
  whisper: string[];
  /** Soniox language codes (if SONIOX_API_KEY is set). */
  soniox: string[];
}

export async function listLanguages(): Promise<LanguageSupport> {
  const a = await appleLocales();
  return {
    apple: a?.analyzerAvailable ? a.analyzer : [],
    appleInstalled: a?.analyzerInstalled ?? [],
    appleLegacy: a?.sfspeech ?? [],
    appleLegacyAuthorized: a?.sfspeechAuth === "authorized",
    whisper: whisperAvailable() ? WHISPER_LANGS : [],
    soniox: sonioxKey() ? SONIOX_LANGS : [],
  };
}

/**
 * Optional: start whisper-server ahead of time so the first utterance isn't delayed by model load,
 * warm Wispr's connection, and check the Soniox key (a rejected one is benched, so "auto" goes straight to the local engines).
 */
export async function warmUp(): Promise<void> {
  const soniox = sonioxKey()
    ? sonioxCheckKey().then((r) =>
        r === "ok"
          ? console.log("[stt] soniox: key OK, live speech uses Soniox")
          : console.warn(`[stt] ${r}${sonioxBenched() ? "; using the local engines" : ""}`),
      )
    : null;
  // Wispr has no key-check call (its warm-up needs no auth); a bad key shows on the first clip.
  const wispr = wisprKey() ? wisprWarmUp().then((ok) => console.log(`[stt] wispr: key set, push-to-talk uses Wispr Flow${ok ? "" : " (warm-up failed: offline?)"}`)) : null;
  await Promise.all([appleLocales(), whisperAvailable() ? ensureWhisperServer().catch(() => {}) : null, soniox, wispr]);
  // (non-English whisper streams use the multilingual model; it is started on first use)
}

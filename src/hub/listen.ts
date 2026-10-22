import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ClipEngine, clipEngine, transcribe } from "./stt.js";
import { wisprWarmUp } from "../stt/wispr.js";

// Continuous listening: PCM in, partial and final transcript lines out.
// Prefers the streaming engine in src/stt (Soniox cloud when SONIOX_API_KEY is set, else Apple
// on-device speech / whisper.cpp). Without it, falls back to cutting the audio at pauses and
// transcribing each piece with the batch STT in stt.ts.

export interface SpeechStream {
  /** The engine in use; changes if a cloud engine hands over to a local one. */
  readonly engine: string;
  write(pcm: Buffer): void;
  close(): Promise<void>;
}

/** What the engine knows about a final besides its text (all optional; engines report what they can). */
export interface SpeechInfo {
  engine?: string;
  /** Language heard in this utterance (ISO 639-1, e.g. "zh"), from engines that detect it (Soniox). */
  detectedLang?: string;
  /** Speaker label ("1", "2", ...) when diarization is on. */
  speaker?: string;
  /** Mean token confidence 0-1 (Soniox). */
  confidence?: number;
  /** Seconds from the start of the stream. */
  start?: number;
  end?: number;
}

export interface StreamHandlers {
  partial(text: string): void;
  final(text: string, info?: SpeechInfo): void;
  error(msg: string): void;
}

export interface SpeechOptions {
  /**
   * Other languages likely in the audio, e.g. the wearer's own in a translation session (lang is the
   * other person's). Cloud STT uses them as hints so mixed speech works. Default ["en"].
   */
  alsoLangs?: string[];
}

const textOf = (x: any): string => (typeof x === "string" ? x : String(x?.text ?? "")).trim();
const infoOf = (x: any): SpeechInfo | undefined =>
  x && typeof x === "object"
    ? { engine: x.engine, detectedLang: x.detectedLang, speaker: x.speaker, confidence: x.confidence, start: x.start, end: x.end }
    : undefined;

/** Start the local speech engines early (whisper model load) so the first listen is instant. */
export async function warmUpSpeech() {
  const streaming = join(import.meta.dirname, "../stt/index.ts");
  if (!existsSync(streaming)) return;
  const mod: any = await import(pathToFileURL(streaming).href);
  await mod.warmUp?.();
}

export async function stopSpeech() {
  const streaming = join(import.meta.dirname, "../stt/index.ts");
  if (!existsSync(streaming)) return;
  const mod: any = await import(pathToFileURL(streaming).href);
  await mod.stopWhisperServer?.();
}

export async function openSpeechStream(lang: string, sampleRate: number, h: StreamHandlers, o: SpeechOptions = {}): Promise<SpeechStream> {
  const streaming = join(import.meta.dirname, "../stt/index.ts");
  if (existsSync(streaming)) {
    try {
      // Imported by path so the hub still starts (and typechecks) before src/stt exists.
      const mod: any = await import(pathToFileURL(streaming).href);
      const s = await mod.createStreamingSTT({ lang, sampleRate, engine: process.env.STT_ENGINE || "auto", alsoLangs: o.alsoLangs });
      let current: string | undefined;
      s.on("partial", (p: any) => textOf(p) && h.partial(textOf(p)));
      s.on("final", (f: any) => textOf(f) && h.final(textOf(f), infoOf(f)));
      s.on?.("error", (e: any) => h.error(String(e?.message ?? e)));
      s.on?.("ready", (i: any) => i?.engine && (current = String(i.engine)));
      // Soniox couldn't start or gave up (bad key, offline, out of credit): say so once.
      s.on?.("fallback", (f: any) => {
        current = String(f.to);
        h.error(`${f.reason}; using ${f.to} instead`);
      });
      s.on?.("status", (m: any) => console.log(`[stt] ${m}`));
      // `engine` may be a name or a promise of one ("auto" picks Soniox, Apple or whisper at start).
      const engine = await Promise.race([Promise.resolve(s.engine), new Promise((r) => setTimeout(() => r("auto"), 3000))]).catch(() => "auto");
      const first = String(engine ?? "streaming");
      return {
        get engine() {
          return current ?? first;
        },
        write: (b) => s.write(b),
        close: () => s.close(),
      };
    } catch (e: any) {
      h.error(`streaming STT unavailable (${e?.message ?? e}); using batch fallback`);
    }
  }
  return chunkedStream(sampleRate, h, lang);
}

/** One push-to-talk clip being transcribed while it is recorded. */
export interface Clip {
  write(pcm: Buffer): void;
  /** Flush and return the whole text (batch STT of the recorded audio if streaming gave nothing). */
  finish(): Promise<string>;
  /** Drop it (the speaker went away): no result, no batch fallback. */
  cancel(): void;
}

/** Seams for tests. */
export interface ClipDeps {
  open?: typeof openSpeechStream;
  batch?: typeof transcribe;
  /** The engine for the whole clip's final text; null = the streamed words. Default: clipEngine() (STT_BATCH_ENGINE, or Wispr with its key). */
  final?: ClipEngine | null;
}

/**
 * Push-to-talk, streamed: opens the streaming engine at once and feeds it the audio as it arrives,
 * so update() gets the words while the button is still held. Audio written before the engine is up
 * is queued, not lost. Words so far = finals + the current partial; `stable` = how much of the start
 * is final. Falls back to batch STT of the whole clip when there is no streaming engine (or
 * STT_PROVIDER=deepgram), or when it failed and heard nothing.
 * With a clip engine (Wispr Flow when WISPR_API_KEY is set, or STT_BATCH_ENGINE=openrouter:<model>) the
 * streamed words are only the live preview: on release the whole clip goes to it (one request, so
 * Wispr's auto-edits see the whole thought) and its text is the result; if it fails, the streamed words are.
 */
export function startClip(sampleRate: number, lang: string, h: { update(text: string, stable: number): void }, deps: ClipDeps = {}): Clip {
  const batch = deps.batch ?? transcribe;
  const final = deps.final !== undefined ? deps.final : clipEngine();
  if (final?.name === "wispr" && deps.final === undefined) void wisprWarmUp();
  const pcm: Buffer[] = [];
  const finals: string[] = [];
  let partial = "";
  let failed = false;
  let dead = false;
  let stream: SpeechStream | null = null;
  let queue: Buffer[] | null = [];
  const done = () => finals.join(" ");
  const words = () => [done(), partial].filter(Boolean).join(" ");
  const changed = () => !dead && h.update(words(), done().length);

  const deepgram = process.env.STT_PROVIDER === "deepgram";
  const ready: Promise<SpeechStream | null> = deepgram
    ? Promise.resolve(null)
    : (deps.open ?? openSpeechStream)(lang, sampleRate, {
        partial: (t) => {
          partial = t;
          changed();
        },
        final: (t) => {
          finals.push(t);
          partial = "";
          changed();
        },
        error: () => (failed = true),
      }).then(
        (s) => {
          // The pause-cutting batch stream would transcribe each piece and then the whole clip again.
          if (s.engine === "batch" || dead) {
            void s.close().catch(() => {});
            return null;
          }
          for (const b of queue ?? []) s.write(b);
          queue = null;
          return (stream = s);
        },
        () => ((failed = true), null),
      );

  return {
    write(b) {
      if (dead) return;
      pcm.push(b);
      if (stream) stream.write(b);
      else queue?.push(b);
    },
    async finish() {
      const s = await ready;
      if (s) await s.close().catch(() => (failed = true));
      dead = true;
      const text = words().trim();
      const all = Buffer.concat(pcm);
      // The clip engine gets the clip (not an accidental tap), unless it was also the live stream.
      if (final && s?.engine !== final.name && all.length >= sampleRate * 2 * 0.3) {
        try {
          const w = (await final.run(all, { sampleRate, lang })).trim();
          if (w || !text) return w;
        } catch (e: any) {
          console.warn(`[stt] ${e?.message ?? e}; using the ${text ? "streamed words" : "batch STT"}`);
        }
      }
      if (text || (s && !failed)) return text;
      return deepgram ? batch(all, sampleRate) : batch(all, sampleRate, lang);
    },
    cancel() {
      dead = true;
      queue = null;
      void ready.then((s) => s?.close()).catch(() => {});
    },
  };
}

/**
 * At most one out() per `ms`: the newest words win and the last ones always go out, unless stop()
 * comes first (before the final caption, so no partial can follow it).
 */
export function captionThrottle(ms: number, out: (text: string, stable: number) => void) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let next: { text: string; stable: number } | null = null;
  let stopped = false;
  const flush = () => {
    timer = undefined;
    if (!next || stopped) return;
    last = Date.now();
    const n = next;
    next = null;
    out(n.text, n.stable);
  };
  return {
    update(text: string, stable: number) {
      if (stopped) return;
      next = { text, stable };
      timer ??= setTimeout(flush, Math.max(0, last + ms - Date.now()));
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Transcribe one recorded clip in one go. Uses the streaming engine when available (Soniox with a
 * key, else local), otherwise the batch STT in stt.ts.
 */
export async function transcribeClip(pcm: Buffer, sampleRate: number, lang = "en-US"): Promise<string> {
  const c = startClip(sampleRate, lang, { update() {} });
  // Feed in 100 ms chunks, like live audio, then flush.
  const step = Math.round(sampleRate * 0.1) * 2;
  for (let i = 0; i < pcm.length; i += step) c.write(pcm.subarray(i, i + step));
  return c.finish();
}

/** Energy-based segmentation: a segment ends after ~0.7 s of quiet or 10 s of speech. */
function chunkedStream(sampleRate: number, h: StreamHandlers, lang: string): SpeechStream {
  const frame = Math.round(sampleRate * 0.1) * 2; // 100 ms of s16le
  let pending = Buffer.alloc(0);
  let segment: Buffer[] = [];
  let voiced = 0;
  let quiet = 0;
  let noise = 300; // adaptive noise floor (RMS)
  let chain = Promise.resolve();

  const flush = () => {
    const pcm = Buffer.concat(segment);
    segment = [];
    if (voiced < 3) return; // under 0.3 s of speech: ignore
    voiced = 0;
    chain = chain.then(async () => {
      try {
        const text = (await transcribe(pcm, sampleRate, lang)).trim();
        if (text) h.final(text);
      } catch (e: any) {
        h.error(`STT: ${e?.message ?? e}`);
      }
    });
  };

  return {
    engine: "batch",
    write(b: Buffer) {
      pending = Buffer.concat([pending, b]);
      while (pending.length >= frame) {
        const f = pending.subarray(0, frame);
        pending = pending.subarray(frame);
        let sum = 0;
        for (let i = 0; i + 1 < f.length; i += 2) {
          const v = f.readInt16LE(i);
          sum += v * v;
        }
        const rms = Math.sqrt(sum / (f.length / 2));
        const speaking = rms > noise * 2.5;
        if (!speaking) noise = noise * 0.95 + rms * 0.05;
        if (speaking || segment.length) segment.push(Buffer.from(f));
        if (speaking) {
          voiced++;
          quiet = 0;
        } else if (segment.length) quiet++;
        if ((quiet >= 7 && segment.length) || segment.length >= 100) {
          quiet = 0;
          flush();
        }
      }
    },
    async close() {
      if (segment.length) flush();
      await chain;
    },
  };
}

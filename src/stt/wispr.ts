// Wispr Flow cloud engine: the Flow Voice Interface API (api-docs.wisprflow.ai), the model behind the
// Wispr Flow apps. Unlike plain speech-to-text it returns dictation the way it was meant: auto-edits
// ("6pm, actually 7" -> "7pm"), filler words dropped, names right. Needs WISPR_API_KEY from the
// Developer Platform (platform.wisprflow.ai > API Keys). Access is by approval only (an organization
// the Flow team has approved; enterprise@wisprflow.ai), billed per usage token. The audio leaves the Mac.
//
// It gives one finished text per clip (its WebSocket's interim results come about every 30 s), so it
// suits push-to-talk, not live captions: with the key set, the hub uses it for push-to-talk finals and
// the batch path, and for live listening only when STT_ENGINE lists it (then each pause-cut utterance
// is one request and there are no partials).
//
// REST: POST {WISPR_API_URL}/api, Authorization: Bearer <key>, JSON { audio: base64 16 kHz PCM16 wav,
// language: ISO 639-1 codes, context } -> { text, detected_language, total_time }; at most 25 MB /
// 6 min per request. GET /warmup_dash keeps a connection warm before a clip.

import { EventEmitter } from "node:events";
import { ASSISTANT_NAMES } from "../shared/assistant.js";
import type { STTEvent } from "./types.js";
import { EnergySegmenter } from "./vad.js";

export const DEFAULT_WISPR_URL = "https://platform-api.wisprflow.ai/api/v1/dash";
const MAX_SEC = 6 * 60;

export function wisprKey(): string {
  return process.env.WISPR_API_KEY?.trim() || "";
}

function wisprUrl(): string {
  return (process.env.WISPR_API_URL?.trim() || DEFAULT_WISPR_URL).replace(/\/+$/, "");
}

// As with Soniox: a rejected key benches Wispr until the hub restarts, a billing/rate error for a while,
// so "auto" stops sending every clip to a request that will fail.
let benchedUntil = 0;
let benchedWhy = "";

/** Key set, and not benched by a recent auth/billing failure. */
export function wisprAvailable(): boolean {
  return !!wisprKey() && Date.now() >= benchedUntil;
}

export function wisprBenched(): string | null {
  return Date.now() < benchedUntil ? benchedWhy : null;
}

export function clearWisprBench() {
  benchedUntil = 0;
  benchedWhy = "";
}

/** BCP-47 "zh-CN" -> "zh" (Flow takes ISO 639-1 codes). null = auto-detect. */
export function toWisprLang(lang: string): string | null {
  if (!lang || lang === "auto") return null;
  const base = lang.toLowerCase().split(/[-_]/)[0];
  const code = base === "nb" || base === "nn" ? "no" : base === "fil" ? "tl" : base === "cmn" ? "zh" : base;
  return /^[a-z]{2}$/.test(code) ? code : null;
}

/** Flow covers 100+ languages and auto-detects the rest. */
export function wisprSupports(_lang: string): boolean {
  return true;
}

/**
 * The language list: one code skips detection (more accurate), so the wearer's English is added only
 * for another language (a translate session's "zh" + "en"). Empty = detect from all of them.
 */
export function wisprLangs(lang: string, alsoLangs: string[] = ["en"]): string[] {
  const main = toWisprLang(lang);
  if (!main) return [];
  return [...new Set([main, ...alsoLangs.map(toWisprLang).filter((x): x is string => !!x)])];
}

export class WisprError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
  /** Retrying the same request can't help: bad key, not approved, out of credit, bad audio. */
  get fatal(): boolean {
    return this.status === 400 || this.status === 401 || this.status === 402 || this.status === 403 || this.status === 413;
  }
}

function describe(status: number, detail: string): string {
  if (status === 401) return "Wispr Flow rejected the API key: check WISPR_API_KEY";
  if (status === 403) return "Wispr Flow refused the key (is your organization approved for the API?)";
  if (status === 402) return "Wispr Flow: out of credit; add a payment method at platform.wisprflow.ai";
  if (status === 429) return "Wispr Flow: rate limited";
  return `Wispr Flow ${status}${detail ? `: ${detail}` : ""}`;
}

function bench(err: WisprError) {
  const s = err.status;
  if (s === 401 || s === 403) benchedUntil = Infinity;
  else if (s === 402 || s === 429) benchedUntil = Date.now() + (s === 402 ? 10 * 60_000 : 60_000);
  else return;
  benchedWhy = err.message;
}

/** 16 kHz mono s16le -> a WAV file (the 44-byte header Flow's examples write). */
function wav16k(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Linear resampling to 16 kHz (Flow only takes 16 kHz; the glasses already send that). */
function to16k(pcm: Buffer, rate: number): Buffer {
  if (rate === 16000) return pcm;
  const n = pcm.length >> 1;
  const m = Math.floor((n * 16000) / rate);
  const out = Buffer.alloc(m * 2);
  for (let i = 0; i < m; i++) {
    const x = (i * rate) / 16000;
    const j = Math.floor(x);
    const a = pcm.readInt16LE(Math.min(j, n - 1) * 2);
    const b = pcm.readInt16LE(Math.min(j + 1, n - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * (x - j)), i * 2);
  }
  return out;
}

export interface WisprOptions {
  sampleRate: number;
  /** BCP-47 locale or "auto". */
  lang?: string;
  alsoLangs?: string[];
  /** Uncommon words to get right (context.dictionary_context). Default: her names, Claude, Codex + WISPR_TERMS. */
  terms?: string[];
  timeoutMs?: number;
}

export interface WisprResult {
  text: string;
  detectedLang?: string;
  /** Flow's processing time (ms), as it reports it. */
  ms?: number;
}

const terms = () => [...ASSISTANT_NAMES, "Claude", "Codex", ...(process.env.WISPR_TERMS ?? "").split(",").map((s) => s.trim()).filter(Boolean)];

/** One clip -> Flow's formatted text. Throws WisprError (and benches Wispr on a key/billing failure). */
export async function wisprRequest(pcm: Buffer, o: WisprOptions): Promise<WisprResult> {
  const key = wisprKey();
  if (!key) throw new WisprError("WISPR_API_KEY is not set");
  let audio = to16k(pcm, o.sampleRate);
  if (audio.length > MAX_SEC * 32000) audio = audio.subarray(audio.length - MAX_SEC * 32000); // keep the end
  const body = {
    audio: wav16k(audio).toString("base64"),
    language: wisprLangs(o.lang ?? "en-US", o.alsoLangs),
    // "ai": the wearer is talking to an assistant, so Flow formats it as a prompt, not an email.
    context: { app: { name: "Jarvis", type: "ai" }, dictionary_context: o.terms ?? terms() },
  };
  let res: Response;
  try {
    res = await fetch(`${wisprUrl()}/api`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? (Number(process.env.WISPR_TIMEOUT_MS) || 15_000)),
    });
  } catch (e: any) {
    throw new WisprError(`Wispr Flow unreachable (${e?.name === "TimeoutError" ? "timed out" : e?.message ?? e})`);
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { detail?: unknown };
    const err = new WisprError(describe(res.status, typeof j.detail === "string" ? j.detail : ""), res.status);
    bench(err);
    throw err;
  }
  const j = (await res.json().catch(() => null)) as { text?: unknown; detected_language?: unknown; total_time?: unknown } | null;
  if (!j || typeof j.text !== "string") throw new WisprError("Wispr Flow sent no text");
  return {
    text: j.text.trim(),
    ...(typeof j.detected_language === "string" ? { detectedLang: j.detected_language } : {}),
    ...(typeof j.total_time === "number" ? { ms: j.total_time } : {}),
  };
}

/** One recorded clip -> text (push-to-talk, batch). */
export async function wisprTranscribe(pcm: Buffer, o: WisprOptions): Promise<string> {
  return (await wisprRequest(pcm, o)).text;
}

let warmedAt = 0;
/** Warm Flow's connection before a clip (GET /warmup_dash), at most once a minute; never throws. */
export function wisprWarmUp(): Promise<boolean> {
  const key = wisprKey();
  if (!key || !wisprAvailable() || Date.now() - warmedAt < 60_000) return Promise.resolve(false);
  warmedAt = Date.now();
  return fetch(`${wisprUrl()}/warmup_dash`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
    .then((r) => r.ok)
    .catch(() => false);
}

/** Tests. */
export function resetWisprWarmUp() {
  warmedAt = 0;
}

/**
 * Live listening on Flow: the audio is cut at pauses and each utterance is one request, finals in
 * order, no partials. On a failure it emits "error" once and stops; pendingAudio() is what it hadn't
 * transcribed, for the next engine.
 */
export class WisprStream extends EventEmitter {
  private seg: EnergySegmenter;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private failed = false;
  /** Audio since the end of the last transcribed utterance (bounded), with its first sample. */
  private held: Buffer[] = [];
  private heldStart = 0;
  private heldSamples = 0;

  constructor(private o: { lang: string; sampleRate: number; silenceMs?: number; alsoLangs?: string[]; request?: typeof wisprRequest }) {
    super();
    // Pauses this long end a dictated thought; Flow edits within one request, so not too short.
    this.seg = new EnergySegmenter({ sampleRate: o.sampleRate, silenceMs: Math.max(o.silenceMs ?? 600, 800), maxSegmentMs: 60_000 });
    process.nextTick(() => this.emit("ready", { engine: "wispr", lang: o.lang }));
  }

  write(pcm: Buffer) {
    if (this.closed || this.failed) return;
    this.held.push(pcm);
    this.heldSamples += pcm.length >> 1;
    const max = this.o.sampleRate * 120;
    while (this.heldSamples > max && this.held.length > 1) {
      const b = this.held.shift()!;
      this.heldSamples -= b.length >> 1;
      this.heldStart += b.length >> 1;
    }
    for (const ev of this.seg.push(pcm)) if (ev.type === "end") this.utterance(ev.pcm, ev.startSample, ev.endSample);
  }

  private sec(samples: number) {
    return Math.round((samples / this.o.sampleRate) * 1000) / 1000;
  }

  private utterance(pcm: Buffer, start: number, end: number) {
    this.queue = this.queue.then(async () => {
      if (this.failed) return;
      try {
        const r = await (this.o.request ?? wisprRequest)(pcm, { sampleRate: this.o.sampleRate, lang: this.o.lang, alsoLangs: this.o.alsoLangs });
        this.drop(end);
        if (r.text) {
          const ev: STTEvent = { type: "final", text: r.text, start: this.sec(start), end: this.sec(end), lang: this.o.lang, engine: "wispr" };
          if (r.detectedLang) ev.detectedLang = r.detectedLang;
          this.emit("final", ev);
        }
      } catch (e) {
        this.failed = true;
        this.emit("error", e);
      }
    });
  }

  /** Forget audio up to `sample` (it was transcribed). */
  private drop(sample: number) {
    while (this.held.length && this.heldStart + (this.held[0].length >> 1) <= sample) {
      const b = this.held.shift()!;
      this.heldSamples -= b.length >> 1;
      this.heldStart += b.length >> 1;
    }
  }

  /** What hasn't been transcribed, and where it starts (seconds), for a fallback engine to replay. */
  pendingAudio(): { pcm: Buffer[]; start: number } {
    return { pcm: [...this.held], start: this.sec(this.heldStart) };
  }

  async close(): Promise<void> {
    if (this.closed) return this.queue;
    this.closed = true;
    if (!this.failed) for (const ev of this.seg.flush()) if (ev.type === "end") this.utterance(ev.pcm, ev.startSample, ev.endSample);
    await this.queue;
  }
}

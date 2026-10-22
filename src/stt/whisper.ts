// whisper.cpp engine: one shared `whisper-server` process (model stays loaded, Metal on Apple
// Silicon), fed VAD-segmented utterances. Partials re-transcribe the growing utterance.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { EnergySegmenter } from "./vad.js";
import type { STTEvent } from "./types.js";

const MODELS_DIR = join(homedir(), ".g2-orchestrator", "models");
export const DEFAULT_WHISPER_MODEL = join(MODELS_DIR, "ggml-base.bin");
/** Better multilingual accuracy (~3x slower than base); used for non-English when present. */
export const MULTILINGUAL_WHISPER_MODEL = join(MODELS_DIR, "ggml-small-q5_1.bin");

/** Model for a language: $WHISPER_MODEL, else base for English, small-q5_1 (if downloaded) otherwise. */
export function whisperModelPath(lang = "en"): string {
  if (process.env.WHISPER_MODEL) return process.env.WHISPER_MODEL;
  const english = toWhisperLang(lang) === "en";
  if (!english && existsSync(MULTILINGUAL_WHISPER_MODEL)) return MULTILINGUAL_WHISPER_MODEL;
  return existsSync(DEFAULT_WHISPER_MODEL) ? DEFAULT_WHISPER_MODEL : MULTILINGUAL_WHISPER_MODEL;
}

export function whisperServerBin(): string | null {
  if (process.env.WHISPER_SERVER_BIN) return process.env.WHISPER_SERVER_BIN;
  for (const p of ["/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"]) if (existsSync(p)) return p;
  return null;
}

export function whisperAvailable(lang = "en"): boolean {
  return !!whisperServerBin() && existsSync(whisperModelPath(lang));
}

/** whisper language codes (ISO 639-1 subset whisper knows). */
export const WHISPER_LANGS =
  "en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue".split(
    " ",
  );

export function pcmToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---------- shared server ----------

type ServerState = { proc: ChildProcess | null; ready: Promise<string> };
const servers = new Map<string, ServerState>(); // one whisper-server per model file

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as any).port as number;
      s.close(() => res(port));
    });
  });
}

/** Start (once per model) and return the base URL of a shared whisper-server. */
export function ensureWhisperServer(model = whisperModelPath()): Promise<string> {
  const server = servers.get(model);
  if (server && (!server.proc || server.proc.exitCode === null)) return server.ready;
  const bin = whisperServerBin();
  if (!bin) return Promise.reject(new Error("whisper-server not found (brew install whisper-cpp)"));
  if (!existsSync(model)) return Promise.reject(new Error(`whisper model missing: ${model}`));
  const state: { proc: ChildProcess | null; ready: Promise<string> } = { proc: null, ready: null as any };
  state.ready = (async () => {
    const port = await freePort();
    const proc = spawn(bin, ["-m", model, "--host", "127.0.0.1", "--port", String(port), "-t", "4"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    state.proc = proc;
    let errTail = "";
    proc.stderr!.on("data", (d) => (errTail = (errTail + d).slice(-2000)));
    const kill = () => proc.kill();
    process.once("exit", kill);
    proc.once("exit", () => {
      process.off("exit", kill);
      if (servers.get(model) === state) servers.delete(model);
    });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 200; i++) {
      if (proc.exitCode !== null) throw new Error(`whisper-server exited: ${errTail.slice(-400)}`);
      try {
        const r = await fetch(url + "/");
        if (r.ok) return url;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    proc.kill();
    throw new Error("whisper-server did not become ready in 20 s");
  })();
  state.ready.catch(() => {
    if (servers.get(model) === state) servers.delete(model);
  });
  servers.set(model, state);
  return state.ready;
}

export function stopWhisperServer() {
  for (const s of servers.values()) s.proc?.kill();
  servers.clear();
}

const JUNK = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+|you|thank you\.?|thanks for watching!?)\s*$/i;

export async function whisperTranscribe(
  pcm: Buffer,
  opts: { sampleRate: number; lang: string; translate?: boolean; prompt?: string; model?: string },
): Promise<string> {
  const url = await ensureWhisperServer(opts.model ?? whisperModelPath(opts.lang));
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(pcmToWav(pcm, opts.sampleRate))], { type: "audio/wav" }), "a.wav");
  fd.append("response_format", "json");
  fd.append("temperature", "0");
  fd.append("language", opts.lang);
  if (opts.translate) fd.append("translate", "true");
  if (opts.prompt) fd.append("prompt", opts.prompt);
  const r = await fetch(url + "/inference", { method: "POST", body: fd });
  if (!r.ok) throw new Error(`whisper-server ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { text?: string };
  const text = (j.text ?? "").replace(/\s+/g, " ").trim();
  return JUNK.test(text) ? "" : text;
}

/** BCP-47 "es-ES" -> whisper "es"; "auto" passes through. */
export function toWhisperLang(lang: string): string {
  if (!lang || lang === "auto") return "auto";
  const base = lang.toLowerCase().split(/[-_]/)[0];
  if (lang.toLowerCase().startsWith("yue")) return "yue";
  return base === "nb" ? "no" : base;
}

// ---------- streaming wrapper ----------

export class WhisperStream extends EventEmitter {
  private seg: EnergySegmenter;
  private queue: Promise<void> = Promise.resolve();
  private partialBusy = false;
  private lastPartialAt = 0;
  private closed = false;
  private wlang: string;
  private prevFinal = "";
  private model: string;

  constructor(
    private opts: {
      lang: string;
      sampleRate: number;
      silenceMs: number;
      partialIntervalMs: number;
      translate?: boolean;
    },
  ) {
    super();
    this.wlang = toWhisperLang(opts.lang);
    this.model = whisperModelPath(opts.lang);
    this.seg = new EnergySegmenter({ sampleRate: opts.sampleRate, silenceMs: opts.silenceMs });
    ensureWhisperServer(this.model).then(
      () => this.emit("ready", { engine: "whisper", lang: opts.lang, model: this.model }),
      (e) => this.emit("error", e),
    );
  }

  write(pcm: Buffer) {
    if (this.closed) return;
    for (const ev of this.seg.push(pcm)) {
      if (ev.type === "end") this.final(ev.pcm, ev.startSample, ev.endSample);
    }
    this.maybePartial();
  }

  private sec(samples: number) {
    return Math.round((samples / this.opts.sampleRate) * 1000) / 1000;
  }

  private maybePartial() {
    if (!this.seg.inSpeech || this.partialBusy) return;
    const now = Date.now();
    if (now - this.lastPartialAt < this.opts.partialIntervalMs) return;
    const pcm = this.seg.current();
    if (!pcm || pcm.length < this.opts.sampleRate * 2 * 0.5) return;
    this.lastPartialAt = now;
    this.partialBusy = true;
    const start = this.seg.currentStart();
    const end = start + (pcm.length >> 1);
    const p = this.queue.then(async () => {
      try {
        if (!this.seg.inSpeech || this.seg.currentStart() !== start) return; // already finalized
        const text = await whisperTranscribe(pcm, { ...this.opts, lang: this.wlang, prompt: this.prevFinal, model: this.model });
        if (text && this.seg.inSpeech && this.seg.currentStart() === start)
          this.emit("partial", this.ev("partial", text, start, end));
      } catch (e) {
        this.emit("error", e);
      } finally {
        this.partialBusy = false;
      }
    });
    this.queue = p;
  }

  private final(pcm: Buffer, start: number, end: number) {
    this.queue = this.queue.then(async () => {
      try {
        if (pcm.length < this.opts.sampleRate * 2 * 0.3) return;
        const text = await whisperTranscribe(pcm, { ...this.opts, lang: this.wlang, prompt: this.prevFinal, model: this.model });
        if (text) {
          this.prevFinal = text.slice(-200);
          this.emit("final", this.ev("final", text, start, end));
        }
      } catch (e) {
        this.emit("error", e);
      }
    });
  }

  private ev(type: "partial" | "final", text: string, start: number, end: number): STTEvent {
    return { type, text, start: this.sec(start), end: this.sec(end), lang: this.opts.lang, engine: "whisper" };
  }

  private closing?: Promise<void>;
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      for (const ev of this.seg.flush()) if (ev.type === "end") this.final(ev.pcm, ev.startSample, ev.endSample);
      this.closing = this.queue;
    }
    return this.closing;
  }
}

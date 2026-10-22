// Apple Speech engine: wraps the tools/speech `g2speech` binary (stdin PCM -> stdout NDJSON).

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { STTEvent } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_G2SPEECH_BIN = resolve(here, "../../tools/speech/bin/g2speech");

export function g2speechBin(): string {
  return process.env.G2SPEECH_BIN || DEFAULT_G2SPEECH_BIN;
}

export function appleAvailable(): boolean {
  return process.platform === "darwin" && existsSync(g2speechBin());
}

export interface AppleLocales {
  analyzerAvailable: boolean;
  analyzer: string[];
  analyzerInstalled: string[];
  sfspeech: string[];
  sfspeechOnDevice: string[];
  sfspeechAuth: string;
}

let localesCache: Promise<AppleLocales | null> | null = null;

export function appleLocales(): Promise<AppleLocales | null> {
  if (!appleAvailable()) return Promise.resolve(null);
  localesCache ??= new Promise((res) => {
    execFile(g2speechBin(), ["--list-locales"], { timeout: 20000 }, (err, stdout) => {
      if (err) return res(null);
      try {
        const line = stdout.split("\n").find((l) => l.includes('"locales"'));
        res(line ? (JSON.parse(line) as AppleLocales) : null);
      } catch {
        res(null);
      }
    });
  });
  return localesCache;
}

const norm = (s: string) => s.toLowerCase().replace("_", "-");

/** Which Apple sub-engine can serve this locale (exact or same-language match), if any. */
export async function appleSupports(lang: string): Promise<"analyzer" | "sfspeech" | null> {
  const l = await appleLocales();
  if (!l) return null;
  const want = norm(lang);
  const base = want.split("-")[0];
  const has = (xs: string[]) => xs.some((x) => norm(x) === want) || (!want.includes("-") && xs.some((x) => norm(x).split("-")[0] === base));
  if (l.analyzerAvailable && has(l.analyzer)) return "analyzer";
  if (l.sfspeechAuth === "authorized" && has(l.sfspeech)) return "sfspeech";
  return null;
}

export class AppleStream extends EventEmitter {
  private proc: ChildProcess;
  private exited: Promise<number | null>;
  private stderrTail = "";
  ready = false;

  constructor(opts: { lang: string; sampleRate: number; silenceMs: number; subEngine?: "analyzer" | "sfspeech" | "auto" }) {
    super();
    const args = ["--lang", opts.lang, "--rate", String(opts.sampleRate), "--silence", String(opts.silenceMs / 1000)];
    if (opts.subEngine && opts.subEngine !== "auto") args.push("--engine", opts.subEngine);
    this.proc = spawn(g2speechBin(), args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdin!.on("error", () => {}); // EPIPE if it died; reported via exit
    this.proc.stderr!.on("data", (d) => (this.stderrTail = (this.stderrTail + d).slice(-2000)));
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.type === "partial" || m.type === "final") {
        const ev: STTEvent = { type: m.type, text: m.text, start: m.start, end: m.end, lang: m.lang ?? opts.lang, engine: "apple" };
        this.emit(m.type, ev);
      } else if (m.type === "ready") {
        this.ready = true;
        this.emit("ready", { engine: "apple", sub: m.engine, lang: m.lang, onDevice: m.onDevice });
      } else if (m.type === "error") {
        const e = Object.assign(new Error(m.message), { code: m.code });
        this.emit("error", e);
      } else if (m.type === "status") {
        this.emit("status", m.message);
      }
    });
    this.exited = new Promise((res) =>
      this.proc.once("close", (code, sig) => {
        if (code !== 0) this.emit("exit", { code, signal: sig, stderr: this.stderrTail.slice(-300) });
        res(code);
      }),
    );
  }

  write(pcm: Buffer) {
    if (this.proc.stdin!.writable) this.proc.stdin!.write(pcm);
  }

  async close() {
    this.proc.stdin!.end();
    const t = setTimeout(() => this.proc.kill("SIGTERM"), 15000);
    await this.exited;
    clearTimeout(t);
  }

  kill() {
    this.proc.kill("SIGTERM");
  }
}

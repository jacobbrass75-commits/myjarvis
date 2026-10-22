import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sonioxAvailable, sonioxSupports, sonioxTranscribe } from "../stt/soniox.js";
import { wisprAvailable, wisprKey, wisprSupports, wisprTranscribe } from "../stt/wispr.js";
import { openRouterKey, openRouterTranscribe } from "../stt/openrouter.js";

// The Even Hub SDK has no speech-to-text, so the glasses stream raw mic audio
// (PCM s16le, 16 kHz, mono) to the hub and we transcribe it here.

export function pcmToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function deepgram(wav: Buffer): Promise<string> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY is not set");
  const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true", {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "audio/wav" },
    body: new Uint8Array(wav),
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as any;
  return j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

async function whisperCpp(wav: Buffer): Promise<string> {
  const model = process.env.WHISPER_MODEL;
  if (!model) throw new Error("WHISPER_MODEL (path to a ggml model) is not set");
  const dir = await mkdtemp(join(tmpdir(), "g2-stt-"));
  try {
    const file = join(dir, "in.wav");
    await writeFile(file, wav);
    const bin = process.env.WHISPER_BIN || "whisper-cli";
    const { stdout } = await promisify(execFile)(bin, ["-m", model, "-f", file, "-nt", "-np", "-l", "auto"]);
    return stdout.replace(/\s+/g, " ").trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fastest accurate one on a 6 s push-to-talk test clip (Oct 2026): ~0.25 s, ~$0.26 per hour of audio. */
export const OPENROUTER_STT_DEFAULT_MODEL = "deepgram/nova-3";

/** A request/response engine that transcribes a whole push-to-talk clip at once. */
export interface ClipEngine {
  name: string;
  run(pcm: Buffer, o: { sampleRate: number; lang: string }): Promise<string>;
}

const warned = new Set<string>();
const warnOnce = (m: string) => warned.has(m) || (warned.add(m), console.warn(`[stt] ${m}`));

/**
 * The engine for whole push-to-talk clips (the final text; streamed words are the preview) and the
 * first try of the batch path. STT_BATCH_ENGINE: "wispr", "openrouter:<model>" ("openrouter" alone =
 * deepgram/nova-3) or "none"; unset = Wispr Flow when WISPR_API_KEY is set (WISPR_PTT=0 turns that
 * off), else none. null when there is none or it can't be used now (no key, Wispr benched).
 */
export function clipEngine(env: Record<string, string | undefined> = process.env): ClipEngine | null {
  const v = (env.STT_BATCH_ENGINE ?? "").trim();
  if (/^(none|off|stream)$/i.test(v)) return null;
  const or = /^openrouter(?::(.+))?$/i.exec(v);
  if (or) {
    if (!openRouterKey()) return warnOnce(`STT_BATCH_ENGINE=${v} needs OPENROUTER_API_KEY`), null;
    const model = or[1]?.trim() || OPENROUTER_STT_DEFAULT_MODEL;
    return { name: `openrouter:${model}`, run: async (pcm, o) => (await openRouterTranscribe(pcm, { ...o, model })).text };
  }
  const wispr: ClipEngine = { name: "wispr", run: (pcm, o) => wisprTranscribe(pcm, o) };
  if (/^wispr$/i.test(v)) return wisprKey() ? (wisprAvailable() ? wispr : null) : (warnOnce("STT_BATCH_ENGINE=wispr needs WISPR_API_KEY"), null);
  if (v) return warnOnce(`STT_BATCH_ENGINE="${v}" isn't wispr, openrouter:<model> or none; ignored`), null;
  return wisprAvailable() && env.WISPR_PTT !== "0" ? wispr : null;
}

/**
 * One clip -> text. Provider: STT_PROVIDER (wispr | openrouter:<model> | soniox | deepgram |
 * whisper-cpp), else the clip engine (STT_BATCH_ENGINE, or Wispr Flow when WISPR_API_KEY is set), then
 * Soniox when SONIOX_API_KEY is set (and it knows the language), else Deepgram when DEEPGRAM_API_KEY is
 * set, else whisper-cli. If an automatic cloud pick fails (bad key, offline) the next provider gets the clip.
 */
export async function transcribe(pcm: Buffer, sampleRate: number, lang = "en-US"): Promise<string> {
  if (pcm.length < sampleRate * 2 * 0.3) return ""; // under 0.3 s: an accidental press
  const forced = process.env.STT_PROVIDER;
  if (forced === "wispr") return wisprTranscribe(pcm, { sampleRate, lang });
  if (forced?.startsWith("openrouter")) return (await openRouterTranscribe(pcm, { sampleRate, lang, model: forced.slice(11) || OPENROUTER_STT_DEFAULT_MODEL })).text;
  const first = forced ? null : clipEngine();
  if (first && (first.name !== "wispr" || wisprSupports(lang))) {
    try {
      return await first.run(pcm, { sampleRate, lang });
    } catch (e: any) {
      console.warn(`[stt] ${e?.message ?? e}; trying the next provider`);
    }
  }
  const other = forced && forced !== "soniox" ? forced : process.env.DEEPGRAM_API_KEY ? "deepgram" : "whisper-cpp";
  if (forced === "soniox" || (!forced && sonioxAvailable() && sonioxSupports(lang))) {
    try {
      return await sonioxTranscribe(pcm, { sampleRate, lang });
    } catch (e: any) {
      if (forced) throw e;
      console.warn(`[stt] ${e?.message ?? e}; trying ${other}`);
      return fileSTT(other, pcm, sampleRate).catch(() => {
        throw e;
      });
    }
  }
  return fileSTT(other, pcm, sampleRate);
}

function fileSTT(provider: string, pcm: Buffer, sampleRate: number): Promise<string> {
  const wav = pcmToWav(pcm, sampleRate);
  return provider === "deepgram" ? deepgram(wav) : whisperCpp(wav);
}

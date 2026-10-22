// Self-test: synthesize speech with `say`, convert to 16 kHz s16le with `afconvert`, stream it
// in real time through createStreamingSTT, check the words and measure latency.
//
//   npx tsx src/stt/selftest.ts                 # apple + whisper (+ soniox if SONIOX_API_KEY is set), English + Spanish
//   npx tsx src/stt/selftest.ts --engine apple  # one engine (apple | whisper | soniox)
//   npx tsx src/stt/selftest.ts --fast          # don't pace in real time
//   npx tsx src/stt/selftest.ts --long          # also a 75 s stream (apple rollover / long-form)

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStreamingSTT, listLanguages, stopWhisperServer, warmUp, type EngineName, type STTEvent } from "./index.js";
import { sonioxKey } from "./soniox.js";

const SR = 16000;
const args = process.argv.slice(2);
const fast = args.includes("--fast");
const onlyEngine = args.includes("--engine") ? (args[args.indexOf("--engine") + 1] as EngineName) : null;

function synth(text: string, voice?: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "g2-stt-test-"));
  try {
    const aiff = join(dir, "s.aiff");
    const wav = join(dir, "s.wav");
    execFileSync("say", [...(voice ? ["-v", voice] : []), "-o", aiff, text]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${SR}`, "-c", "1", aiff, wav]);
    const b = readFileSync(wav);
    // find the "data" chunk
    let off = 12;
    while (off < b.length - 8) {
      const id = b.toString("ascii", off, off + 4);
      const len = b.readUInt32LE(off + 4);
      if (id === "data") return b.subarray(off + 8, off + 8 + len);
      off += 8 + len + (len & 1);
    }
    throw new Error("no data chunk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const silence = (sec: number) => Buffer.alloc(Math.round(sec * SR) * 2);

/** Sample index where each speech burst ends (energy drops for >=300 ms). */
function speechEnds(pcm: Buffer): number[] {
  const f = SR / 50;
  const ends: number[] = [];
  let lastVoiced = -1;
  let quiet = 0;
  for (let i = 0; i + f * 2 <= pcm.length; i += f * 2) {
    let acc = 0;
    for (let k = 0; k < f; k++) {
      const v = pcm.readInt16LE(i + k * 2) / 32768;
      acc += v * v;
    }
    const voiced = Math.sqrt(acc / f) > 0.01;
    if (voiced) {
      lastVoiced = i / 2 + f;
      quiet = 0;
    } else if (lastVoiced >= 0 && ++quiet === 15) {
      ends.push(lastVoiced);
    }
  }
  if (lastVoiced >= 0 && (ends.length === 0 || ends[ends.length - 1] !== lastVoiced)) ends.push(lastVoiced);
  return ends;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

interface Case {
  name: string;
  lang: string;
  text: string;
  voice?: string;
  expect: string[];
  repeat?: number;
}

async function runCase(engine: EngineName, c: Case) {
  let speech = synth(c.text, c.voice);
  if (c.repeat) speech = Buffer.concat(Array.from({ length: c.repeat }, () => [speech, silence(0.4)]).flat());
  const pcm = Buffer.concat([silence(0.5), speech, silence(1.5)]);
  const ends = speechEnds(pcm);
  const stt = createStreamingSTT({ lang: c.lang, engine });
  const finals: STTEvent[] = [];
  let partials = 0;
  let firstPartialAt = 0;
  const t0 = Date.now();
  const startedAt: number[] = []; // wall ms when each 20 ms block was written
  let readyAt = 0;
  let readyInfo: any = null;
  const errors: string[] = [];
  stt.on("ready", (i) => {
    readyAt = Date.now() - t0;
    readyInfo = i;
  });
  stt.on("error", (e) => errors.push(e.message));
  stt.on("partial", () => {
    partials++;
    firstPartialAt ||= Date.now();
  });
  stt.on("final", (e) => finals.push({ ...e, at: Date.now() } as any));

  // Wait for the engine before pacing so model load doesn't count as streaming latency.
  await stt.engine.catch(() => {});
  const readyWait = Date.now();
  while (!readyInfo && !errors.length && Date.now() - readyWait < 60000) await new Promise((r) => setTimeout(r, 20));

  const chunk = 640 * 2; // 40 ms
  const tStream = Date.now();
  for (let off = 0, n = 0; off < pcm.length; off += chunk, n++) {
    if (!fast) {
      const due = tStream + n * 40;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    startedAt.push(Date.now());
    stt.write(pcm.subarray(off, off + chunk));
  }
  await stt.close();
  const tDone = Date.now();

  const wallAtSample = (s: number) => startedAt[Math.min(startedAt.length - 1, Math.floor((s * 2) / chunk))] ?? tStream;
  const transcript = finals.map((f) => f.text).join(" ");
  const got = new Set(words(transcript));
  const missing = c.expect.filter((w) => !got.has(w));
  // Latency per final: from when the last word it contains was spoken (end of the last speech
  // burst inside the final's time range) to when the final arrived.
  const lat: number[] = [];
  for (const f of finals) {
    const e = [...ends].reverse().find((x) => x <= f.end * SR + SR * 0.15 && x >= f.start * SR);
    if (e !== undefined) lat.push((f as any).at - wallAtSample(e));
  }
  const firstSpeech = Math.round(0.5 * SR);
  const fp = firstPartialAt ? firstPartialAt - wallAtSample(firstSpeech) : NaN;
  const ok = finals.length > 0 && missing.length <= Math.floor(c.expect.length * 0.2);
  console.log(
    JSON.stringify(
      {
        case: c.name,
        engine,
        actual: readyInfo,
        ok,
        audioSec: +(pcm.length / 2 / SR).toFixed(2),
        realtime: !fast,
        readyMs: readyAt,
        finals: finals.length,
        partials,
        firstPartialAfterSpeechOnsetMs: Math.round(fp),
        finalLatencyMs: lat.map((x) => Math.round(x)),
        totalWallSec: +((tDone - tStream) / 1000).toFixed(2),
        missing,
        errors,
        transcript: transcript.length > 400 ? transcript.slice(0, 200) + " … " + transcript.slice(-150) : transcript,
      },
      null,
      1,
    ),
  );
  return ok;
}

const cases: Case[] = [
  {
    name: "english",
    lang: "en-US",
    text: "The quick brown fox jumps over the lazy dog. Please schedule a meeting with Sarah tomorrow afternoon.",
    expect: ["quick", "brown", "fox", "jumps", "lazy", "dog", "schedule", "meeting", "sarah", "tomorrow", "afternoon"],
  },
  {
    name: "spanish",
    lang: "es-ES",
    voice: "Eddy (Spanish (Spain))",
    text: "Buenos días. ¿Dónde está la estación de tren? Necesito comprar un billete para Madrid.",
    expect: ["buenos", "dias", "donde", "esta", "estacion", "tren", "necesito", "comprar", "billete", "madrid"],
  },
];
if (args.includes("--long"))
  cases.push({
    name: "long-75s",
    lang: "en-US",
    text: "This is a long running test of continuous recognition. We keep talking so the stream lasts more than one minute.",
    expect: ["long", "running", "test", "continuous", "recognition", "minute"],
    repeat: 11,
  });

const langs = await listLanguages();
console.log(
  JSON.stringify({
    appleLocales: langs.apple.length,
    appleInstalled: langs.appleInstalled,
    appleLegacyAuthorized: langs.appleLegacyAuthorized,
    whisperLangs: langs.whisper.length,
  }),
);
await warmUp();
let allOk = true;
for (const engine of (onlyEngine ? [onlyEngine] : ["apple", "whisper", ...(sonioxKey() ? ["soniox"] : [])]) as EngineName[]) {
  for (const c of cases) {
    try {
      allOk = (await runCase(engine, c)) && allOk;
    } catch (e) {
      allOk = false;
      console.log(JSON.stringify({ case: c.name, engine, ok: false, error: String(e) }));
    }
  }
}
stopWhisperServer();
console.log(allOk ? "SELFTEST PASS" : "SELFTEST FAIL");
process.exit(allOk ? 0 : 1);

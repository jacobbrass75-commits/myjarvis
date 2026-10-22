import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { startClip, type SpeechStream, type StreamHandlers } from "../src/hub/listen.js";
import { clipEngine, OPENROUTER_STT_DEFAULT_MODEL, transcribe } from "../src/hub/stt.js";
import { openRouterTranscribe } from "../src/stt/openrouter.js";
import { createStreamingSTT, engineOrder, type STTEvent } from "../src/stt/index.js";
import { clearWisprBench, resetWisprWarmUp, toWisprLang, wisprAvailable, wisprBenched, wisprLangs, wisprRequest, wisprWarmUp } from "../src/stt/wispr.js";

// The Wispr Flow engine against a local mock of its REST API (schema from api-docs.wisprflow.ai:
// POST /api with a Bearer key and base64 16 kHz PCM16 wav -> { text, detected_language, total_time }):
// the request it sends, errors and benching, the batch path, push-to-talk finals, the live engine,
// the configurable auto order and the fallback to the local engine. Also OpenRouter's transcription
// endpoint (POST /v1/audio/transcriptions) as the push-to-talk clip engine (STT_BATCH_ENGINE).
// No network, no key, no microphone.
//   node --import tsx --test scripts/stt-wispr-test.ts

const dir = mkdtempSync(join(tmpdir(), "g2-wispr-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Stand-ins for the local engines: apple reports how much audio it got; whisper-cli prints a line.
const fakeApple = join(dir, "g2speech");
writeFileSync(
  fakeApple,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--list-locales")) {
  console.log(JSON.stringify({ locales: true, analyzerAvailable: true, analyzer: ["en-US", "zh-CN"], analyzerInstalled: [], sfspeech: [], sfspeechOnDevice: [], sfspeechAuth: "denied" }));
  process.exit(0);
}
const lang = args[args.indexOf("--lang") + 1];
console.log(JSON.stringify({ type: "ready", engine: "analyzer", lang, onDevice: true }));
const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const pcm = Buffer.concat(chunks);
  console.log(JSON.stringify({ type: "final", text: "local heard " + pcm.length + " bytes", start: 0, end: pcm.length / 32000, lang }));
  process.exit(0);
});
`,
);
chmodSync(fakeApple, 0o755);
const fakeWhisperCli = join(dir, "whisper-cli");
writeFileSync(fakeWhisperCli, "#!/bin/sh\necho 'whisper cli text'\n");
chmodSync(fakeWhisperCli, 0o755);
process.env.G2SPEECH_BIN = fakeApple;
process.env.WHISPER_BIN = fakeWhisperCli; // the batch path's whisper-cli
process.env.WHISPER_MODEL = join(dir, "no-model.bin"); // no whisper-server: live fallbacks go to the fake apple
process.env.WISPR_API_KEY = "wispr-test-key";
process.env.OPENROUTER_API_KEY = "or-test-key";
for (const k of ["STT_ENGINE", "STT_PROVIDER", "STT_BATCH_ENGINE", "DEEPGRAM_API_KEY", "SONIOX_API_KEY", "WISPR_TERMS", "WISPR_PTT", "WISPR_TIMEOUT_MS"]) delete process.env[k];

// ---------- mock server ----------

interface Req {
  method: string;
  url: string;
  auth: string | undefined;
  body: any;
}
const reqs: Req[] = [];
let orReply: (r: Req) => { status?: number; body?: unknown } = () => ({ body: { text: "openrouter text", usage: { seconds: 1.5, cost: 0.0001 } } });
let reply: (r: Req, n: number) => { status?: number; body?: unknown; delayMs?: number } = () => ({ body: { text: "ok", detected_language: "en", total_time: 12 } });

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const r: Req = { method: req.method!, url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
  reqs.push(r);
  if (r.url.endsWith("/warmup_dash")) return void res.end(JSON.stringify({ status: "warmed" }));
  if (r.url.endsWith("/v1/audio/transcriptions")) {
    const out = orReply(r);
    res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
    return void res.end(JSON.stringify(out.body ?? {}));
  }
  const out = reply(r, reqs.filter((x) => x.url.endsWith("/api")).length - 1);
  if (out.delayMs) await sleep(out.delayMs);
  res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(out.body ?? {}));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
process.env.WISPR_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/dash`;
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(() => server.close());

beforeEach(() => {
  reqs.length = 0;
  reply = () => ({ body: { text: "ok", detected_language: "en", total_time: 12 } });
  clearWisprBench();
  resetWisprWarmUp();
  orReply = () => ({ body: { text: "openrouter text", usage: { seconds: 1.5, cost: 0.0001 } } });
  delete process.env.STT_PROVIDER;
  delete process.env.STT_BATCH_ENGINE;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const apiCalls = () => reqs.filter((r) => r.url.endsWith("/api"));
const orCalls = () => reqs.filter((r) => r.url.endsWith("/v1/audio/transcriptions"));
const wavOf = (r: Req) => Buffer.from(r.body.audio, "base64");

// ---------- audio: 16 kHz s16le ----------

const tone = (ms: number, rate = 16000) => {
  const b = Buffer.alloc(Math.round((ms * rate) / 1000) * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  return b;
};
const silence = (ms: number) => Buffer.alloc(ms * 32);
function feed(sink: { write(b: Buffer): void }, pcm: Buffer, chunkMs = 100) {
  for (let i = 0; i < pcm.length; i += chunkMs * 32) sink.write(pcm.subarray(i, i + chunkMs * 32));
}

// ---------- tests ----------

test("language codes: bare ISO 639-1; one code for English, the wearer's English added for another", () => {
  assert.equal(toWisprLang("zh-CN"), "zh");
  assert.equal(toWisprLang("nb-NO"), "no");
  assert.equal(toWisprLang("auto"), null);
  assert.equal(toWisprLang("yue-CN"), null);
  assert.deepEqual(wisprLangs("en-US"), ["en"]);
  assert.deepEqual(wisprLangs("zh-CN"), ["zh", "en"]);
  assert.deepEqual(wisprLangs("auto"), []);
});

test("request: Bearer key, base64 16 kHz mono PCM16 wav, language list, assistant context, parsed reply", async () => {
  reply = () => ({ body: { id: "x", text: " Let's meet at 7pm. ", detected_language: "en", total_time: 432, generated_tokens: 9 } });
  const pcm = tone(1000);
  const r = await wisprRequest(pcm, { sampleRate: 16000, lang: "en-US" });
  assert.deepEqual(r, { text: "Let's meet at 7pm.", detectedLang: "en", ms: 432 });
  const [q] = apiCalls();
  assert.equal(q.method, "POST");
  assert.match(q.url, /\/api\/v1\/dash\/api$/);
  assert.equal(q.auth, "Bearer wispr-test-key");
  const wav = wavOf(q);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.deepEqual(wav.subarray(44), pcm);
  assert.deepEqual(q.body.language, ["en"]);
  assert.equal(q.body.context.app.type, "ai");
  assert.ok(q.body.context.dictionary_context.includes("Bocchi") && q.body.context.dictionary_context.includes("Claude"));
  assert.ok(!JSON.stringify(q.body).includes("wispr-test-key"));
});

test("request: other sample rates are resampled to 16 kHz; WISPR_TERMS adds words", async () => {
  process.env.WISPR_TERMS = "Soniox, Even G2";
  try {
    await wisprRequest(tone(1000, 48000), { sampleRate: 48000, lang: "en-US" });
  } finally {
    delete process.env.WISPR_TERMS;
  }
  const [q] = apiCalls();
  assert.equal(wavOf(q).length - 44, 32000);
  assert.ok(q.body.context.dictionary_context.includes("Even G2"));
});

test("errors: a rejected key benches Wispr until cleared; a server error doesn't", async () => {
  reply = () => ({ status: 500, body: { detail: "Error running inference" } });
  await assert.rejects(wisprRequest(tone(500), { sampleRate: 16000 }), /Wispr Flow 500: Error running inference/);
  assert.ok(wisprAvailable());
  reply = () => ({ status: 401, body: { detail: "Unauthorized" } });
  await assert.rejects(wisprRequest(tone(500), { sampleRate: 16000 }), /WISPR_API_KEY/);
  assert.equal(wisprAvailable(), false);
  assert.match(wisprBenched()!, /rejected/);
  clearWisprBench();
  reply = () => ({ status: 403, body: {} });
  await assert.rejects(wisprRequest(tone(500), { sampleRate: 16000 }), /approved/);
  assert.equal(wisprAvailable(), false);
});

test("batch transcribe(): Wispr first when its key is set; on failure the next provider; STT_PROVIDER=wispr throws", async () => {
  reply = () => ({ body: { text: "Search for my flight tickets", detected_language: "en" } });
  assert.equal(await transcribe(tone(1500), 16000), "Search for my flight tickets");
  assert.equal(await transcribe(tone(100), 16000), ""); // an accidental press never leaves the Mac
  assert.equal(apiCalls().length, 1);
  reply = () => ({ status: 500, body: { detail: "down" } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await transcribe(tone(1500), 16000), "whisper cli text");
  } finally {
    console.warn = warn;
  }
  process.env.STT_PROVIDER = "wispr";
  await assert.rejects(transcribe(tone(1500), 16000), /Wispr Flow 500/);
});

test("engine order: auto leaves Wispr out of live listening; a list sets the order; one name forces it", () => {
  assert.deepEqual(engineOrder("auto"), { order: ["soniox", "apple", "whisper"], forced: false });
  assert.deepEqual(engineOrder(undefined), { order: ["soniox", "apple", "whisper"], forced: false });
  assert.deepEqual(engineOrder("wispr, soniox,apple"), { order: ["wispr", "soniox", "apple"], forced: false });
  assert.deepEqual(engineOrder("wispr"), { order: ["wispr"], forced: true });
  assert.deepEqual(engineOrder("wispr,banana"), { order: ["wispr"], forced: false });
  assert.equal(engineOrder("banana"), null);
});

test("live: STT_ENGINE-style list puts Wispr first: one request per utterance, finals in order, no partials", async () => {
  let n = 0;
  reply = () => ({ body: { text: ["First thought.", "Second thought."][n++] ?? "", detected_language: "en" } });
  const stt = createStreamingSTT({ lang: "en-US", engine: "wispr,apple" });
  const finals: STTEvent[] = [];
  let partials = 0;
  stt.on("final", (e) => finals.push(e));
  stt.on("partial", () => partials++);
  assert.equal(await stt.engine, "wispr");
  feed(stt, Buffer.concat([tone(1000), silence(1200), tone(800), silence(300)]));
  await stt.close();
  assert.deepEqual(finals.map((f) => [f.text, f.engine, f.detectedLang]), [
    ["First thought.", "wispr", "en"],
    ["Second thought.", "wispr", "en"],
  ]);
  assert.ok(finals[0].start < 0.3 && finals[1].start > 2, JSON.stringify(finals.map((f) => [f.start, f.end])));
  assert.equal(partials, 0);
  assert.equal(apiCalls().length, 2);
});

test("live: plain auto doesn't send live audio to Wispr (it stays on-device)", async () => {
  const stt = createStreamingSTT({ lang: "en-US" });
  assert.equal(await stt.engine, "apple");
  feed(stt, tone(500));
  await stt.close();
  assert.equal(apiCalls().length, 0);
});

test("live: a rejected key hands over to the next engine with the untranscribed audio replayed", async () => {
  reply = () => ({ status: 401, body: {} });
  const stt = createStreamingSTT({ lang: "en-US", engine: "wispr,apple" });
  const finals: STTEvent[] = [];
  const fallbacks: any[] = [];
  stt.on("final", (e) => finals.push(e));
  stt.on("fallback", (f) => fallbacks.push(f));
  assert.equal(await stt.engine, "wispr");
  feed(stt, Buffer.concat([tone(1000), silence(1200)]));
  for (let i = 0; i < 200 && !fallbacks.length; i++) await sleep(10);
  feed(stt, tone(500));
  await stt.close();
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].from, "wispr");
  assert.equal(fallbacks[0].to, "apple");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].engine, "apple");
  // Everything since the start: the failed utterance (2.2 s) + what came after (0.5 s).
  assert.equal(finals[0].text, `local heard ${(2200 + 500) * 32} bytes`);
  // Forced (one engine named), the failure is an error instead.
  clearWisprBench();
  const forced = createStreamingSTT({ lang: "en-US", engine: "wispr" });
  const errors: Error[] = [];
  forced.on("error", (e) => errors.push(e));
  feed(forced, Buffer.concat([tone(1000), silence(1200)]));
  await forced.close();
  assert.match(errors[0]?.message ?? "", /WISPR_API_KEY/);
});

/** A speech engine for push-to-talk we drive by hand. */
function fakeEngine(engine = "apple") {
  const f = {
    h: null as StreamHandlers | null,
    open: (_lang: string, _rate: number, h: StreamHandlers) => {
      f.h = h;
      return Promise.resolve<SpeechStream>({ engine, write() {}, close: async () => {} });
    },
  };
  return f;
}

test("push-to-talk: streamed words preview the clip, Wispr's text of the whole clip is the result", async () => {
  reply = () => ({ body: { text: "Let's meet at 7pm.", detected_language: "en" } });
  const f = fakeEngine();
  const seen: string[] = [];
  const c = startClip(16000, "en-US", { update: (t) => seen.push(t) }, { open: f.open, batch: async () => "BATCH" });
  await sleep(0);
  c.write(tone(1500));
  f.h!.partial("let's meet at 6pm");
  f.h!.final("Let's meet at 6pm, actually let's do 7.");
  assert.equal(await c.finish(), "Let's meet at 7pm.");
  assert.deepEqual(seen, ["let's meet at 6pm", "Let's meet at 6pm, actually let's do 7."]);
  assert.equal(apiCalls().length, 1);
  assert.equal(wavOf(apiCalls()[0]).length - 44, 1500 * 32);
  await sleep(20);
  assert.equal(reqs.filter((r) => r.url.endsWith("/warmup_dash")).length, 1); // warmed when the press began
});

test("push-to-talk: Wispr failing keeps the streamed words; WISPR_PTT=0, a Wispr live stream or a tap skip it", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    reply = () => ({ status: 500, body: {} });
    let f = fakeEngine();
    let c = startClip(16000, "en-US", { update() {} }, { open: f.open, batch: async () => "BATCH" });
    await sleep(0);
    c.write(tone(1500));
    f.h!.final("Turn on the lights.");
    assert.equal(await c.finish(), "Turn on the lights.");
    // The stream failed with nothing heard and Wispr is down: the batch STT gets it.
    f = fakeEngine();
    c = startClip(16000, "en-US", { update() {} }, { open: f.open, batch: async () => "BATCH" });
    await sleep(0);
    c.write(tone(1500));
    f.h!.error("engine died");
    assert.equal(await c.finish(), "BATCH");
  } finally {
    console.warn = warn;
  }
  reqs.length = 0;
  reply = () => ({ body: { text: "WISPR" } });
  process.env.WISPR_PTT = "0";
  try {
    const f = fakeEngine();
    const c = startClip(16000, "en-US", { update() {} }, { open: f.open, batch: async () => "BATCH" });
    await sleep(0);
    c.write(tone(1500));
    f.h!.final("Streamed.");
    assert.equal(await c.finish(), "Streamed.");
  } finally {
    delete process.env.WISPR_PTT;
  }
  const w = fakeEngine("wispr");
  const c2 = startClip(16000, "en-US", { update() {} }, { open: w.open, batch: async () => "BATCH" });
  await sleep(0);
  c2.write(tone(1500));
  w.h!.final("From the Wispr stream.");
  assert.equal(await c2.finish(), "From the Wispr stream.");
  const t = fakeEngine();
  const c3 = startClip(16000, "en-US", { update() {} }, { open: t.open, batch: async () => "BATCH" });
  await sleep(0);
  c3.write(tone(100));
  assert.equal(await c3.finish(), "");
  assert.equal(apiCalls().length, 0);
});

test("warm-up: at most once a minute, never with a benched key", async () => {
  assert.equal(await wisprWarmUp(), true);
  assert.equal(await wisprWarmUp(), false);
  const warm = reqs.filter((r) => r.url.endsWith("/warmup_dash"));
  assert.equal(warm.length, 1);
  assert.equal(warm[0].auth, "Bearer wispr-test-key");
});

// ---------- OpenRouter transcription as the clip engine ----------

test("openrouter stt: Bearer key, model, base64 wav input_audio, ISO language; text and usage back; errors say why", async () => {
  const pcm = tone(1500);
  const r = await openRouterTranscribe(pcm, { sampleRate: 16000, model: "openrouter:deepgram/nova-3", lang: "en-US" });
  assert.deepEqual(r, { text: "openrouter text", cost: 0.0001, seconds: 1.5 });
  const [q] = orCalls();
  assert.equal(q.method, "POST");
  assert.equal(q.url, "/api/v1/audio/transcriptions");
  assert.equal(q.auth, "Bearer or-test-key");
  assert.equal(q.body.model, "deepgram/nova-3");
  assert.equal(q.body.language, "en");
  assert.equal(q.body.input_audio.format, "wav");
  const wav = Buffer.from(q.body.input_audio.data, "base64");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.deepEqual(wav.subarray(44), pcm);
  await openRouterTranscribe(pcm, { sampleRate: 16000, model: "x/y", lang: "auto" });
  assert.equal(orCalls()[1].body.language, undefined); // detected by the model
  orReply = () => ({ status: 401, body: { error: { code: 401, message: "No auth" } } });
  await assert.rejects(openRouterTranscribe(pcm, { sampleRate: 16000, model: "x/y" }), /OPENROUTER_API_KEY/);
  orReply = () => ({ status: 400, body: { error: { code: 400, message: "The selected model does not support keyterms." } } });
  await assert.rejects(openRouterTranscribe(pcm, { sampleRate: 16000, model: "x/y" }), /400: The selected model does not support keyterms/);
});

test("clip engine: STT_BATCH_ENGINE picks openrouter:<model> (default model), wispr or none; unset = Wispr with its key", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(clipEngine({})?.name, "wispr");
    assert.equal(clipEngine({ WISPR_PTT: "0" }), null);
    assert.equal(clipEngine({ STT_BATCH_ENGINE: "openrouter:elevenlabs/scribe-v2" })?.name, "openrouter:elevenlabs/scribe-v2");
    assert.equal(clipEngine({ STT_BATCH_ENGINE: "openrouter" })?.name, `openrouter:${OPENROUTER_STT_DEFAULT_MODEL}`);
    assert.equal(clipEngine({ STT_BATCH_ENGINE: "none" }), null);
    assert.equal(clipEngine({ STT_BATCH_ENGINE: "wispr" })?.name, "wispr");
    assert.equal(clipEngine({ STT_BATCH_ENGINE: "banana" }), null);
    const key = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      assert.equal(clipEngine({ STT_BATCH_ENGINE: "openrouter:deepgram/nova-3" }), null);
    } finally {
      process.env.OPENROUTER_API_KEY = key;
    }
  } finally {
    console.warn = warn;
  }
});

test("push-to-talk + batch with STT_BATCH_ENGINE=openrouter:<model>: its text is the result, Wispr isn't asked", async () => {
  process.env.STT_BATCH_ENGINE = "openrouter:deepgram/nova-3";
  orReply = () => ({ body: { text: "Remind me to call Tanay at 7:30 tomorrow." } });
  const f = fakeEngine();
  const c = startClip(16000, "en-US", { update() {} }, { open: f.open, batch: async () => "BATCH" });
  await sleep(0);
  c.write(tone(1500));
  f.h!.final("Remind me to call Tanae at 730 tomorrow.");
  assert.equal(await c.finish(), "Remind me to call Tanay at 7:30 tomorrow.");
  assert.equal(await transcribe(tone(1500), 16000), "Remind me to call Tanay at 7:30 tomorrow.");
  assert.equal(orCalls().length, 2);
  assert.equal(apiCalls().length, 0);
  // It failing: the streamed words.
  orReply = () => ({ status: 502, body: { error: { message: "upstream" } } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const g = fakeEngine();
    const d = startClip(16000, "en-US", { update() {} }, { open: g.open, batch: async () => "BATCH" });
    await sleep(0);
    d.write(tone(1500));
    g.h!.final("Streamed words.");
    assert.equal(await d.finish(), "Streamed words.");
  } finally {
    console.warn = warn;
  }
});

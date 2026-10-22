import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { transcribe } from "../src/hub/stt.js";
import { createStreamingSTT, type STTEvent } from "../src/stt/index.js";
import { SonioxStream, clearSonioxBench, sonioxAvailable, sonioxHints, toSonioxLang } from "../src/stt/soniox.js";

// The Soniox engine against a local mock of its real-time WebSocket API (message schema from
// soniox.com/docs): auth, start message, partial/final assembly, end of stream, errors, reconnects,
// idle close and the fallback to the local engine. No network, no key, no microphone.
//   node --import tsx --test scripts/stt-soniox-test.ts

const dir = mkdtempSync(join(tmpdir(), "g2-soniox-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// A stand-in for tools/speech/bin/g2speech: reports how much audio it got and the frame index of the
// first sample (test audio encodes its own position), so replays can be checked exactly.
const fakeApple = join(dir, "g2speech");
writeFileSync(
  fakeApple,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--list-locales")) {
  console.log(JSON.stringify({ locales: true, analyzerAvailable: true, analyzer: ["en-US", "zh-CN", "yue-CN"], analyzerInstalled: [], sfspeech: [], sfspeechOnDevice: [], sfspeechAuth: "denied" }));
  process.exit(0);
}
const lang = args[args.indexOf("--lang") + 1];
console.log(JSON.stringify({ type: "ready", engine: "analyzer", lang, onDevice: true }));
const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const pcm = Buffer.concat(chunks);
  const first = pcm.length >= 2 ? pcm.readInt16LE(0) : null;
  console.log(JSON.stringify({ type: "final", text: "local heard " + pcm.length + " bytes from frame " + first, start: 0, end: pcm.length / 32000, lang }));
  process.exit(0);
});
`,
);
chmodSync(fakeApple, 0o755);
process.env.G2SPEECH_BIN = fakeApple;
process.env.WHISPER_MODEL = join(dir, "no-model.bin"); // whisper unavailable: fallbacks go to the fake apple
process.env.SONIOX_API_KEY = "test-key";
process.env.SONIOX_IDLE_CLOSE_S = "0";
for (const k of ["STT_ENGINE", "STT_PROVIDER", "DEEPGRAM_API_KEY", "SONIOX_MODEL", "SONIOX_REGION", "SONIOX_TERMS", "SONIOX_DIARIZATION"])
  delete process.env[k];

// ---------- mock server ----------

interface MockConn {
  ws: WebSocket;
  req: IncomingMessage;
  start: any;
  audio: Buffer;
  texts: string[];
  control: any[];
  ended: boolean;
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(wss, "listening");
process.env.SONIOX_WS_URL = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
after(() => {
  for (const ws of wss.clients) ws.terminate(); // sockets a failed test left open
  wss.close();
});

let script: (c: MockConn) => Promise<void> | void = () => {};
const conns: MockConn[] = [];
wss.on("connection", (ws, req) => {
  const c: MockConn = { ws, req, start: null, audio: Buffer.alloc(0), texts: [], control: [], ended: false };
  conns.push(c);
  ws.on("message", (d: Buffer, binary: boolean) => {
    if (binary) return void (c.audio = Buffer.concat([c.audio, d]));
    const t = d.toString();
    c.texts.push(t);
    if (t === "") c.ended = true;
    else if (!c.start) c.start = JSON.parse(t);
    else c.control.push(JSON.parse(t));
  });
  Promise.resolve(script(c)).catch((e) => console.error("mock script:", e));
});

beforeEach(() => {
  conns.length = 0;
  script = () => {};
  clearSonioxBench();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => unknown, what = "condition", ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
const send = (c: MockConn, m: object) => c.ws.send(JSON.stringify(m));
const tok = (text: string, start_ms: number | undefined, end_ms: number | undefined, is_final: boolean, extra: object = {}) => ({
  text, start_ms, end_ms, confidence: 0.9, is_final, ...extra,
});
const END = { text: "<end>", is_final: true };
const audioMs = (c: MockConn) => c.audio.length / 32;
const finish = (c: MockConn, tokens: object[] = []) => {
  send(c, { tokens, final_audio_proc_ms: audioMs(c), total_audio_proc_ms: audioMs(c) });
  send(c, { tokens: [], final_audio_proc_ms: audioMs(c), total_audio_proc_ms: audioMs(c), finished: true });
  c.ws.close();
};
const authError = (c: MockConn) => {
  send(c, { tokens: [], final_audio_proc_ms: 0, total_audio_proc_ms: 0, error_code: 401, error_type: "unauthenticated", error_message: "Incorrect API key provided.", request_id: "t" });
  c.ws.close(); // the real server closes with 1000 right after the error frame
};

// ---------- audio: 16 kHz s16le; every sample of 10 ms frame n has the value n ----------

const frames = (fromMs: number, toMs: number) => {
  const b = Buffer.alloc((toMs - fromMs) * 32);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.floor(fromMs / 10 + i / 160), i * 2);
  return b;
};
const tone = (ms: number) => {
  const b = Buffer.alloc(ms * 32);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
  return b;
};
const silence = (ms: number) => Buffer.alloc(ms * 32);
async function feed(sink: { write(b: Buffer): void }, pcm: Buffer, chunkMs = 100, gapMs = 0) {
  for (let i = 0; i < pcm.length; i += chunkMs * 32) {
    sink.write(pcm.subarray(i, i + chunkMs * 32));
    if (gapMs) await sleep(gapMs);
  }
}

// ---------- tests ----------

test("language codes and hints: bare ISO 639-1, the wearer's English added", () => {
  assert.equal(toSonioxLang("zh-CN"), "zh");
  assert.equal(toSonioxLang("en-US"), "en");
  assert.equal(toSonioxLang("nb-NO"), "no");
  assert.equal(toSonioxLang("yue-CN"), null);
  assert.equal(toSonioxLang("auto"), null);
  assert.deepEqual(sonioxHints("zh-CN"), ["zh", "en"]);
  assert.deepEqual(sonioxHints("en-US"), ["en"]);
  assert.deepEqual(sonioxHints("es-ES", ["zh-TW"]), ["es", "zh"]);
});

test("auto picks Soniox only with a key and a language it knows", async () => {
  const yue = createStreamingSTT({ lang: "yue-CN" }); // no Cantonese on Soniox: stays on-device
  assert.equal(await yue.engine, "apple");
  await yue.close();
  process.env.SONIOX_API_KEY = "";
  try {
    const local = createStreamingSTT({ lang: "en-US" });
    assert.equal(await local.engine, "apple");
    await local.close();
  } finally {
    process.env.SONIOX_API_KEY = "test-key";
  }
  assert.equal(conns.length, 0);
});

test("streams: auth header, start message, partials then finals in order, end of stream", async () => {
  script = async (c) => {
    await until(() => c.start && c.audio.length >= 3200, "audio");
    send(c, { tokens: [tok("Hel", 0, 200, false, { language: "en" })], final_audio_proc_ms: 0, total_audio_proc_ms: 200 });
    send(c, {
      tokens: [
        tok("Hello", 0, 300, true, { language: "en", translation_status: "original" }),
        tok("你好", undefined, undefined, true, { language: "zh", translation_status: "translation" }), // not configured: ignored
        tok(" wor", 300, 500, false, { language: "en" }),
      ],
      final_audio_proc_ms: 300,
      total_audio_proc_ms: 500,
    });
    send(c, { tokens: [tok(" world", 300, 600, true, { language: "en" }), END], final_audio_proc_ms: 600, total_audio_proc_ms: 600 });
    send(c, { tokens: [tok("你好", 700, 900, true, { language: "zh" }), tok("吗", 900, 1000, false, { language: "zh" })], final_audio_proc_ms: 900, total_audio_proc_ms: 1000 });
    await until(() => c.ended, "end of stream");
    finish(c, [tok("吗", 900, 1000, true, { language: "zh" })]); // no <end>: the last utterance ends with the stream
  };
  const stt = createStreamingSTT({ lang: "zh-CN" });
  const log: string[] = [];
  const finals: STTEvent[] = [];
  let ready: any;
  stt.on("partial", (e) => log.push(`partial:${e.text}`));
  stt.on("final", (e) => (log.push(`final:${e.text}`), finals.push(e)));
  stt.on("ready", (i) => (ready = i));
  assert.equal(await stt.engine, "soniox");
  await feed(stt, frames(0, 1200), 100, 10);
  await stt.close();
  log.push("closed");

  assert.deepEqual(log, ["partial:Hel", "partial:Hello wor", "final:Hello world", "partial:你好吗", "final:你好吗", "closed"]);
  assert.equal(ready?.engine, "soniox");
  const [a, b] = finals;
  assert.deepEqual([a.start, a.end, a.lang, a.detectedLang, a.engine, a.confidence], [0, 0.6, "zh-CN", "en", "soniox", 0.9]);
  assert.deepEqual([b.start, b.end, b.detectedLang], [0.7, 1, "zh"]);

  const c = conns[0];
  assert.equal(conns.length, 1);
  assert.equal(c.req.headers.authorization, "Bearer test-key");
  assert.equal(c.req.headers["sec-websocket-protocol"], undefined); // header auth only, never both
  assert.deepEqual(
    { ...c.start, context: undefined },
    {
      model: "stt-rt-v5", audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1,
      enable_language_identification: true, enable_endpoint_detection: true, max_endpoint_delay_ms: 1500,
      endpoint_latency_adjustment_level: 2, endpoint_sensitivity: 0.3, client_reference_id: "g2-orchestrator",
      language_hints: ["zh", "en"], context: undefined,
    },
  );
  assert.equal(c.start.api_key, undefined);
  assert.equal(c.audio.length, 1200 * 32); // all of it, before the end
  assert.equal(c.texts.at(-1), ""); // end of stream = an empty TEXT frame
});

test("a rejected key hands over to the local engine once, replaying all the audio", async () => {
  script = async (c) => {
    await until(() => c.start, "start");
    authError(c);
  };
  const stt = createStreamingSTT({ lang: "en-US" });
  const fallbacks: any[] = [];
  const errors: Error[] = [];
  const finals: STTEvent[] = [];
  const readies: any[] = [];
  stt.on("fallback", (f) => fallbacks.push(f));
  stt.on("error", (e) => errors.push(e));
  stt.on("final", (e) => finals.push(e));
  stt.on("ready", (i) => readies.push(i));
  assert.equal(await stt.engine, "soniox");
  await feed(stt, frames(0, 500));
  await sleep(300); // the handover happens meanwhile
  await feed(stt, frames(500, 1000));
  await stt.close();

  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].to, "apple");
  assert.match(fallbacks[0].reason, /rejected the API key/);
  assert.deepEqual(errors, []);
  assert.equal(readies.at(-1)?.engine, "apple");
  assert.deepEqual(finals.map((f) => [f.text, f.start]), [["local heard 32000 bytes from frame 0", 0]]);
  // Benched: the next session goes straight to the local engine instead of failing again.
  assert.equal(sonioxAvailable(), false);
  const next = createStreamingSTT({ lang: "en-US" });
  assert.equal(await next.engine, "apple");
  await next.close();
});

test("offline at start: falls back without retrying", async () => {
  const url = process.env.SONIOX_WS_URL;
  process.env.SONIOX_WS_URL = "ws://127.0.0.1:9"; // nothing listens there
  try {
    const stt = createStreamingSTT({ lang: "en-US" });
    const fallbacks: any[] = [];
    const finals: STTEvent[] = [];
    stt.on("fallback", (f) => fallbacks.push(f));
    stt.on("final", (e) => finals.push(e));
    await feed(stt, frames(0, 400));
    await until(() => fallbacks.length, "fallback");
    await stt.close();
    assert.match(fallbacks[0].reason, /Soniox connection failed/);
    assert.deepEqual(finals.map((f) => f.text), ["local heard 12800 bytes from frame 0"]);
    assert.equal(sonioxAvailable(), true); // a network problem doesn't bench it
  } finally {
    process.env.SONIOX_WS_URL = url;
  }
});

test("forcing STT engine soniox reports the error instead of falling back", async () => {
  script = async (c) => {
    await until(() => c.start, "start");
    authError(c);
  };
  const stt = createStreamingSTT({ lang: "en-US", engine: "soniox" });
  const fallbacks: any[] = [];
  const errors: Error[] = [];
  stt.on("fallback", (f) => fallbacks.push(f));
  stt.on("error", (e) => errors.push(e));
  await feed(stt, frames(0, 300));
  await until(() => errors.length, "error");
  await stt.close();
  assert.equal(fallbacks.length, 0);
  assert.match(errors[0].message, /SONIOX_API_KEY/);
});

test("a dropped socket reconnects and re-sends only the audio that wasn't final", async () => {
  let n = 0;
  script = async (c) => {
    if (n++ === 0) {
      await until(() => c.audio.length >= 600 * 32, "600 ms of audio");
      send(c, { tokens: [tok("one", 0, 400, true), tok(" two", 400, 600, false)], final_audio_proc_ms: 400, total_audio_proc_ms: 600 });
      await sleep(30);
      c.ws.terminate(); // no close frame: a network drop
    } else {
      await until(() => c.ended, "end of stream");
      finish(c, [tok(" two", 0, 200, true), END]);
    }
  };
  const s = new SonioxStream({ lang: "en-US", backoffMs: [20], confirmMs: 50 });
  const finals: STTEvent[] = [];
  const status: string[] = [];
  s.on("final", (e: STTEvent) => finals.push(e));
  s.on("status", (m: string) => status.push(m));
  await feed(s, frames(0, 1500), 100, 15);
  await s.close();

  assert.equal(conns.length, 2);
  assert.equal(conns[1].audio.readInt16LE(0), 40, "resumes at 400 ms, where finals stopped");
  assert.equal(conns[1].audio.length, 1100 * 32, "the rest, including audio written while reconnecting");
  assert.deepEqual(finals.map((f) => [f.text, f.start, f.end]), [["one two", 0, 0.6]]);
  assert.ok(status.some((m) => /reconnecting/.test(m)), status.join(" | "));
});

test("a retryable server error (503) mid-session reconnects instead of falling back", async () => {
  let n = 0;
  script = async (c) => {
    if (n++ === 0) {
      await until(() => c.audio.length >= 300 * 32, "audio");
      send(c, { tokens: [tok("still", 0, 300, true)], final_audio_proc_ms: 300, total_audio_proc_ms: 300 });
      send(c, { tokens: [], error_code: 503, error_type: "service_unavailable", error_message: "Try again.", request_id: "t" });
      c.ws.close();
    } else {
      await until(() => c.ended, "end of stream");
      finish(c, [tok(" here", 0, 200, true)]);
    }
  };
  const s = new SonioxStream({ lang: "en-US", backoffMs: [20] });
  const finals: string[] = [];
  const errors: Error[] = [];
  s.on("final", (e: STTEvent) => finals.push(e.text));
  s.on("error", (e: Error) => errors.push(e));
  await feed(s, frames(0, 800), 100, 15);
  await s.close();
  assert.equal(conns.length, 2);
  assert.deepEqual(finals, ["still here"]);
  assert.deepEqual(errors, []);
});

test("a billing error mid-session keeps the open utterance and continues locally from where Soniox stopped", async () => {
  script = async (c) => {
    await until(() => c.audio.length >= 500 * 32, "audio");
    send(c, { tokens: [tok("keep this", 0, 400, true, { language: "en" }), tok(" and", 400, 500, false)], final_audio_proc_ms: 400, total_audio_proc_ms: 500 });
    await sleep(30);
    send(c, { tokens: [], final_audio_proc_ms: 400, total_audio_proc_ms: 500, error_code: 402, error_type: "organization_balance_exhausted", error_message: "Balance exhausted.", request_id: "t" });
    c.ws.close();
  };
  const stt = createStreamingSTT({ lang: "en-US" });
  const fallbacks: any[] = [];
  const finals: STTEvent[] = [];
  stt.on("fallback", (f) => fallbacks.push(f));
  stt.on("final", (e) => finals.push(e));
  await feed(stt, frames(0, 1000), 100, 20);
  await stt.close();
  assert.equal(fallbacks.length, 1);
  assert.match(fallbacks[0].reason, /balance exhausted/);
  assert.deepEqual(
    finals.map((f) => [f.text, f.start, f.end]),
    [
      ["keep this", 0, 0.4],
      ["local heard 19200 bytes from frame 40", 0.4, 1], // times continue from the stream start
    ],
  );
});

test("keepalive while no audio flows", async () => {
  script = async (c) => {
    await until(() => c.ended, "end of stream");
    finish(c);
  };
  const s = new SonioxStream({ lang: "en-US", keepaliveMs: 60, confirmMs: 20 });
  s.write(frames(0, 100));
  await sleep(400);
  await s.close();
  const n = conns[0].control.filter((m) => m.type === "keepalive").length;
  assert.ok(n >= 2, `${n} keepalives`);
});

test("closes the stream after a long silence and reopens it, with the lead-in, on speech", async () => {
  script = async (c) => {
    await until(() => c.ended, "end of stream", 8000);
    finish(c);
  };
  const s = new SonioxStream({ lang: "en-US", idleCloseSec: 0.5, confirmMs: 20 });
  const status: string[] = [];
  s.on("status", (m: string) => status.push(m));
  s.write(tone(200));
  await sleep(60); // open and confirmed
  await feed(s, silence(1000), 100, 5);
  await until(() => conns[0]?.ended, "idle close");
  await feed(s, silence(300));
  await sleep(50);
  assert.equal(conns.length, 1, "still closed during silence");
  await feed(s, tone(200));
  await until(() => conns.length === 2 && conns[1].audio.length, "reopen");
  await s.close();
  const lead = conns[1].audio.length / 32;
  assert.ok(lead >= 200 && lead <= 1300, `reopened with ${lead} ms of audio`);
  assert.ok(status.some((m) => /without speech/.test(m)) && status.some((m) => /speech again/.test(m)), status.join(" | "));
});

test("diarization: speaker labels, one final per speaker turn", async () => {
  script = async (c) => {
    await until(() => c.ended, "end of stream");
    finish(c, [tok("Hi", 0, 200, true, { speaker: "1" }), tok(" there.", 200, 500, true, { speaker: "1" }), tok(" Hello!", 600, 900, true, { speaker: "2" }), END]);
  };
  const s = new SonioxStream({ lang: "en-US", diarize: true });
  const finals: STTEvent[] = [];
  s.on("final", (e: STTEvent) => finals.push(e));
  await feed(s, frames(0, 1000));
  await s.close();
  assert.equal(conns[0].start.enable_speaker_diarization, true);
  assert.deepEqual(finals.map((f) => [f.text, f.speaker]), [["Hi there.", "1"], ["Hello!", "2"]]);
});

test("batch transcribe() (push-to-talk fallback) uses Soniox when its key is set", async () => {
  script = async (c) => {
    await until(() => c.ended, "end of stream");
    finish(c, [tok("Ask Claude", 0, 500, true), tok(" to run the tests", 500, 1200, true)]);
  };
  assert.equal(await transcribe(frames(0, 1500), 16000), "Ask Claude to run the tests");
  assert.equal(conns[0].audio.length, 1500 * 32);
  assert.deepEqual(conns[0].start.context, { terms: ["Claude", "Codex"] });
});

test("a server that accepts and then keeps failing is retried a bounded number of times", async () => {
  let n = 0;
  script = async (c) => {
    await until(() => c.start, "start");
    if (++n > 10) return authError(c); // stops the test itself if retries are unbounded
    send(c, { tokens: [], final_audio_proc_ms: 0, total_audio_proc_ms: 0 }); // looks healthy...
    await sleep(10);
    send(c, { tokens: [], error_code: 503, error_type: "service_unavailable", error_message: "Try again.", request_id: "t" });
    c.ws.close(); // ...then fails, every time
  };
  const s = new SonioxStream({ lang: "en-US", backoffMs: [5], maxReconnects: 3 });
  const errors: Error[] = [];
  s.on("error", (e: Error) => errors.push(e));
  s.write(frames(0, 100));
  await until(() => errors.length, "giving up");
  await sleep(100);
  assert.equal(conns.length, 4, "the first socket + 3 reconnects, not one per server reply");
  assert.match(errors[0].message, /gave up after 3 reconnects/);
});

test("no audio at all: closes the stream (billed while open) and reopens on speech, keeping the open utterance", async () => {
  script = async (c) => {
    await until(() => c.audio.length, "audio");
    send(c, { tokens: [tok("mic went", 0, 300, true), tok(" quiet", 300, 500, false)], final_audio_proc_ms: 300, total_audio_proc_ms: 500 });
    await until(() => c.ended, "end of stream", 15000);
    finish(c, [tok(" quiet", 300, 500, true)]);
  };
  const s = new SonioxStream({ lang: "en-US", idleCloseSec: 0.4, confirmMs: 20 });
  const finals: string[] = [];
  const status: string[] = [];
  s.on("final", (e: STTEvent) => finals.push(e.text));
  s.on("status", (m: string) => status.push(m));
  try {
    s.write(tone(600)); // then nothing: phone asleep
    await until(() => conns[0]?.ended, "close without audio");
    await until(() => finals.length, "final");
    assert.deepEqual(finals, ["mic went quiet"], "the end of stream finalized the open utterance");
    assert.ok(status.some((m) => /no audio for/.test(m)), status.join(" | "));
    await sleep(100);
    assert.equal(conns.length, 1);
    s.write(tone(200));
    await until(() => conns.length === 2, "reopen on speech");
  } finally {
    await s.close();
  }
});

test("a drop with nothing left to re-send waits for audio before reconnecting", async () => {
  let n = 0;
  script = async (c) => {
    if (n++ === 0) {
      await until(() => c.audio.length >= 200 * 32, "audio");
      send(c, { tokens: [tok("done", 0, 200, true), END], final_audio_proc_ms: 200, total_audio_proc_ms: 200 });
      await sleep(10);
      c.ws.terminate();
    } else {
      await until(() => c.ended, "end of stream");
      finish(c);
    }
  };
  const s = new SonioxStream({ lang: "en-US", backoffMs: [5], confirmMs: 1 });
  try {
    s.write(frames(0, 200));
    await until(() => conns.length && conns[0].ws.readyState === conns[0].ws.CLOSED, "drop");
    await sleep(100);
    assert.equal(conns.length, 1, "no socket while the mic is off");
    s.write(frames(200, 300));
    await until(() => conns.length === 2 && conns[1].audio.length, "reconnect on audio");
    assert.equal(conns[1].audio.readInt16LE(0), 20);
  } finally {
    await s.close();
  }
});

test("an error frame ends the socket even if the server doesn't close it", async () => {
  script = async (c) => {
    await until(() => c.start, "start");
    send(c, { tokens: [], error_code: 401, error_type: "unauthenticated", error_message: "Incorrect API key provided.", request_id: "t" });
  };
  const s = new SonioxStream({ lang: "en-US", closeTimeoutMs: 500 });
  const errors: Error[] = [];
  s.on("error", (e: Error) => errors.push(e));
  try {
    s.write(frames(0, 300));
    await until(() => errors.length, "error", 1000);
    assert.match(errors[0].message, /rejected the API key/);
  } finally {
    await s.close();
  }
});

test("no engine left after the fallback: audio is dropped, not queued forever", async () => {
  const bin = process.env.G2SPEECH_BIN;
  process.env.G2SPEECH_BIN = join(dir, "missing-g2speech");
  script = async (c) => {
    await until(() => c.start, "start");
    authError(c);
  };
  const stt = createStreamingSTT({ lang: "en-US" });
  try {
    const errors: Error[] = [];
    stt.on("error", (e) => errors.push(e));
    await feed(stt, frames(0, 300));
    await until(() => errors.length, "error");
    assert.match(errors[0].message, /no local engine either/);
    await feed(stt, frames(0, 5000));
    assert.equal((stt as any).pending.length, 0);
  } finally {
    process.env.G2SPEECH_BIN = bin;
    await stt.close();
  }
});

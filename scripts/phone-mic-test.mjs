import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Executes the actual phone script against fake devices. No browser, microphone, hub or provider is used.
const html = readFileSync(new URL("../phone/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "Phone page must contain its client script");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function events(target = {}) {
  const listeners = new Map();
  target.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  target.removeEventListener = (type, fn) => listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
  target.dispatchEvent = (event) => { for (const fn of listeners.get(event.type) || []) fn(event); return true; };
  return target;
}

function phone({ native = true, startResult, mediaResult, secure = true, mediaAvailable = true } = {}) {
  const elements = new Map();
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, {
    id, dataset: {}, value: "", disabled: false, hidden: false, innerHTML: "", textContent: "",
    classList: { add() {}, remove() {} }, addEventListener() {}, querySelectorAll: () => [], matches: () => false,
  });
  const document = events({
    activeElement: { dataset: {} }, hidden: false, visibilityState: "visible",
    getElementById: (id) => elements.get(id), querySelector: () => null,
  });
  const calls = { nativeStart: 0, nativeStop: 0, nativeSessions: [], nativeStopSessions: [], media: 0, tracksStopped: 0, contextsClosed: 0 };
  const nativeSessions = new Set();
  const stream = { getTracks: () => [{ stop() { calls.tracksStopped++; } }] };
  const window = events({ isSecureContext: secure });
  if (native) window.jarvisPhoneMic = {
    start(requestedSession) {
      calls.nativeStart++;
      calls.nativeSessions.push(requestedSession);
      return Promise.resolve(startResult ? startResult(requestedSession) : { ok: true, session: "native-1", sampleRate: 16000 })
        .then((result) => { if (result.ok) nativeSessions.add(result.session); return result; });
    },
    stop(session) {
      calls.nativeStop++; calls.nativeStopSessions.push(session);
      if (session) nativeSessions.delete(session); else nativeSessions.clear();
      return Promise.resolve({ ok: true });
    },
  };
  const processors = [];
  class AudioContext {
    sampleRate = 48000;
    state = "running";
    destination = {};
    resume() { return Promise.resolve(); }
    close() { this.state = "closed"; calls.contextsClosed++; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      processors.push(processor);
      return processor;
    }
  }
  let socket;
  const sent = [];
  class WebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    constructor() { socket = this; }
    send(value) { sent.push(typeof value === "string" ? JSON.parse(value) : { binary: Buffer.from(value) }); }
    close() { this.readyState = 3; this.onclose?.({}); }
  }
  const navigator = {
    language: "en-US", mediaDevices: { getUserMedia() {
      calls.media++;
      return mediaResult ? mediaResult(stream) : Promise.resolve(stream);
    } },
  };
  if (!mediaAvailable) delete navigator.mediaDevices;
  Object.assign(window, { AudioContext, WebSocket, navigator });
  const context = vm.createContext({
    document, window, navigator, AudioContext, WebSocket, URLSearchParams,
    location: { protocol: secure ? "https:" : "http:", search: "", origin: secure ? "https://jarvis.test" : "http://192.0.2.1:8787", pathname: "/" },
    history: { replaceState() {} }, localStorage: { getItem: () => "test-token", setItem() {} },
    isSecureContext: secure, atob, btoa, console,
    setTimeout: () => 0, clearTimeout() {},
  });
  vm.runInContext(script, context, { filename: "phone/index.html" });
  socket.onopen?.({});
  socket.onmessage({ data: JSON.stringify({ t: "welcome", role: "phone" }) });
  socket.onmessage({ data: JSON.stringify({ t: "state", state: { nodes: [], agents: [], approvals: [], apps: [], voice: {} } }) });
  const dispatch = (target, type, detail) => target.dispatchEvent({ type, detail });
  return {
    calls, sent, processors, socket, elements,
    activeNative: () => [...nativeSessions].at(-1) || null,
    nativeSessions: () => [...nativeSessions],
    async tap(trusted = true) { await elements.get("listenPhone").onclick({ isTrusted: trusted, preventDefault() {} }); await settle(); },
    pcm: (session = "native-1", bytes = Buffer.from([1, 0, 255, 127, 0, 128])) => dispatch(window, "jarvis-phone-mic-pcm", { session, pcm: bytes.toString("base64") }),
    stopped(session = "native-1", reason = "interrupted") { nativeSessions.delete(session); dispatch(window, "jarvis-phone-mic-stopped", { session, reason }); },
    hide() { document.hidden = true; document.visibilityState = "hidden"; dispatch(document, "visibilitychange"); },
    pagehide: () => dispatch(window, "pagehide"),
  };
}

const messages = (p, type) => p.sent.filter((m) => m.t === type);
const binary = (p) => p.sent.filter((m) => m.binary);

// Keep these behavioral assertions independent of private phone state variable names.
test("loading the page never starts a native or browser microphone", () => {
  for (const native of [true, false]) {
    const p = phone({ native });
    assert.equal(p.calls.nativeStart, 0);
    assert.equal(p.calls.media, 0);
    assert.equal(messages(p, "listen_start").length, 0);
    p.pcm();
    assert.equal(binary(p).length, 0);
  }
});

test("an untrusted programmatic click cannot start recording", async () => {
  for (const native of [true, false]) {
    const p = phone({ native });
    await p.tap(false);
    assert.equal(p.calls.nativeStart, 0);
    assert.equal(p.calls.media, 0);
    assert.equal(messages(p, "listen_start").length, 0);
  }
});

test("native start precedes matching PCM; wrong sessions and frames after stop are ignored", async () => {
  const p = phone();
  await p.tap();
  assert.equal(p.calls.nativeStart, 1);
  assert.equal(p.calls.media, 0, "Native host must not open the browser recorder too");
  assert.equal(messages(p, "listen_start").length, 1);
  assert.equal(messages(p, "listen_start")[0].sampleRate, 16000);
  p.pcm("wrong-session");
  assert.equal(binary(p).length, 0);
  p.pcm();
  assert.deepEqual(binary(p)[0]?.binary, Buffer.from([1, 0, 255, 127, 0, 128]));
  assert.ok(p.sent.findIndex((m) => m.t === "listen_start") < p.sent.findIndex((m) => m.binary));
  await p.tap();
  assert.equal(p.activeNative(), null);
  assert.equal(messages(p, "listen_stop").length, 1);
  p.pcm();
  assert.equal(binary(p).length, 1);
});

test("native permission denial leaves capture idle and sends no listen_start", async () => {
  const p = phone({ startResult: () => ({ ok: false, session: "", sampleRate: 16000, error: "Microphone permission denied" }) });
  await p.tap();
  assert.equal(p.activeNative(), null);
  assert.equal(messages(p, "listen_start").length, 0);
  p.pcm();
  assert.equal(binary(p).length, 0);
  assert.match(p.elements.get("toast").textContent, /denied/i);
});

test("a socket close cancels a pending native permission request, including its late success", async () => {
  const permission = deferred();
  const p = phone({ startResult: () => permission.promise });
  const starting = p.tap();
  assert.equal(p.calls.nativeStart, 1);
  p.socket.close();
  permission.resolve({ ok: true, session: "late-session", sampleRate: 16000 });
  await starting;
  await settle();
  assert.equal(p.activeNative(), null, "Permission granted after disconnect must be stopped again");
  assert.equal(messages(p, "listen_start").length, 0);
  p.pcm("late-session");
  assert.equal(binary(p).length, 0);
});

test("cleanup from a canceled start cannot stop a newer native session", async () => {
  const older = deferred(), newer = deferred();
  let starts = 0;
  const p = phone({ startResult: () => ++starts === 1 ? older.promise : newer.promise });
  const oldStart = p.tap();
  const oldSession = p.calls.nativeSessions[0];
  await p.tap(); // Cancel while the first permission request is pending.
  const newStart = p.tap();
  const newSession = p.calls.nativeSessions[1];
  assert.notEqual(newSession, oldSession);
  newer.resolve({ ok: true, session: newSession, sampleRate: 16000 });
  await newStart;
  assert.deepEqual(p.nativeSessions(), [newSession]);
  older.resolve({ ok: true, session: oldSession, sampleRate: 16000 });
  await oldStart;
  assert.deepEqual(p.nativeSessions(), [newSession], "Late cancellation must stop only the older session");
  assert.equal(messages(p, "listen_start").length, 1);
  p.pcm(oldSession);
  assert.equal(binary(p).length, 0);
  p.pcm(newSession);
  assert.equal(binary(p).length, 1);
});

test("a native stopped event cancels a matching pending start", async () => {
  const permission = deferred();
  const p = phone({ startResult: () => permission.promise });
  const starting = p.tap();
  const session = p.calls.nativeSessions[0];
  p.stopped(session);
  permission.resolve({ ok: true, session, sampleRate: 16000 });
  await starting;
  assert.equal(messages(p, "listen_start").length, 0);
  assert.equal(p.activeNative(), null);
});

test("a socket close stops an already active native microphone", async () => {
  const p = phone();
  await p.tap();
  p.socket.close();
  await settle();
  assert.equal(p.activeNative(), null);
  p.pcm();
  assert.equal(binary(p).length, 0);
});

test("native auto-stop resets the phone and rejects remaining session frames", async () => {
  const p = phone();
  await p.tap();
  p.stopped("wrong-session");
  p.pcm();
  assert.equal(binary(p).length, 1, "A different session stopping must not stop the current one");
  p.stopped();
  await settle();
  p.pcm();
  assert.equal(binary(p).length, 1);
  assert.equal(messages(p, "listen_stop").length, 1);
  assert.match(p.elements.get("listenPhone").textContent, /Listen/);
});

for (const lifecycle of ["hide", "pagehide"]) test(`${lifecycle} stops native recording without waiting for another tap`, async () => {
  const p = phone();
  await p.tap();
  p[lifecycle]();
  await settle();
  assert.equal(p.activeNative(), null);
  assert.equal(messages(p, "listen_stop").length, 1);
  p.pcm();
  assert.equal(binary(p).length, 0);
});

test("browser fallback requests audio only after the tap and stops the granted stream", async () => {
  const p = phone({ native: false });
  await p.tap();
  assert.equal(p.calls.media, 1);
  assert.equal(messages(p, "listen_start").length, 1);
  assert.equal(messages(p, "listen_start")[0].sampleRate, 16000);
  assert.equal(p.processors.length, 1);
  p.processors[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([0, .1, .2, .3, .4, .5]) } });
  assert.equal(binary(p).length, 1);
  await p.tap();
  assert.ok(p.calls.tracksStopped >= 1);
  assert.equal(messages(p, "listen_stop").length, 1);
});

test("browser permission granted after socket close is released without starting a session", async () => {
  const permission = deferred();
  let grantedStream;
  const p = phone({ native: false, mediaResult: (stream) => { grantedStream = stream; return permission.promise; } });
  const starting = p.tap();
  p.socket.close();
  permission.resolve(grantedStream);
  await starting;
  await settle();
  assert.ok(p.calls.tracksStopped >= 1);
  assert.equal(messages(p, "listen_start").length, 0);
  assert.equal(binary(p).length, 0);
});

test("browser permission denial reports the error without starting a session", async () => {
  const p = phone({ native: false, mediaResult: () => Promise.reject(new Error("Microphone denied")) });
  await p.tap();
  assert.equal(messages(p, "listen_start").length, 0);
  assert.match(p.elements.get("toast").textContent, /denied/i);
});

test("an unavailable browser microphone explains the native app or HTTPS route", async () => {
  const p = phone({ native: false, secure: false, mediaAvailable: false });
  await p.tap();
  assert.equal(p.calls.media, 0);
  assert.equal(messages(p, "listen_start").length, 0);
  assert.match(p.elements.get("toast").textContent, /iPhone app.*HTTPS/);
});

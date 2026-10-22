// Live words for push-to-talk, offline: the hub's streamed clip (fake speech engine) and caption
// throttle, and the glasses' caption phases and lines.
//   node --import tsx --test scripts/ptt-caption-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { captionThrottle, startClip, type SpeechStream, type StreamHandlers } from "../src/hub/listen.js";

const pcm = (n: number) => Buffer.alloc(n, 1);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A speech engine we drive by hand. ready() resolves openSpeechStream. */
function fakeEngine(engine = "apple") {
  const f = {
    h: null as StreamHandlers | null,
    written: [] as Buffer[],
    closed: false,
    onClose: () => {},
    ready: () => {},
    open: (_lang: string, _rate: number, h: StreamHandlers) =>
      new Promise<SpeechStream>((resolve) => {
        f.h = h;
        f.ready = () => resolve({ engine, write: (b) => void f.written.push(b), close: async () => ((f.closed = true), f.onClose()) });
      }),
  };
  return f;
}

test("startClip: words so far = finals + partial, stable = the finals' length", async () => {
  const f = fakeEngine();
  const seen: [string, number][] = [];
  const c = startClip(16000, "en-US", { update: (t, s) => seen.push([t, s]) }, { open: f.open, batch: async () => "BATCH" });
  f.ready();
  await tick();
  f.h!.partial("turn on");
  f.h!.partial("turn on the");
  f.h!.final("Turn on the lights.");
  f.h!.partial("in the");
  f.h!.partial("in the kitchen");
  assert.deepEqual(seen, [
    ["turn on", 0],
    ["turn on the", 0],
    ["Turn on the lights.", 19],
    ["Turn on the lights. in the", 19],
    ["Turn on the lights. in the kitchen", 19],
  ]);
  f.onClose = () => f.h!.final("In the kitchen.");
  assert.equal(await c.finish(), "Turn on the lights. In the kitchen.");
  assert.ok(f.closed);
});

test("startClip: audio before the engine is up is queued, in order, not lost", async () => {
  const f = fakeEngine();
  const c = startClip(16000, "en-US", { update() {} }, { open: f.open, batch: async () => "BATCH" });
  c.write(pcm(10));
  c.write(pcm(20));
  assert.equal(f.written.length, 0);
  f.ready();
  await tick();
  c.write(pcm(30));
  assert.deepEqual(f.written.map((b) => b.length), [10, 20, 30]);
  f.onClose = () => f.h!.final("hello");
  assert.equal(await c.finish(), "hello");
});

test("startClip: batch STT of the whole clip when the engine is batch, or failed and heard nothing", async () => {
  // No streaming engine: the pause-cutting stream isn't fed; the whole clip goes to batch once.
  let f = fakeEngine("batch");
  let got = 0;
  let c = startClip(16000, "en-US", { update() {} }, { open: f.open, batch: async (b) => ((got = b.length), "from batch") });
  c.write(pcm(100));
  f.ready();
  await tick();
  c.write(pcm(50));
  assert.equal(await c.finish(), "from batch");
  assert.equal(got, 150);
  assert.equal(f.written.length, 0);
  assert.ok(f.closed);

  // Streaming errored and nothing came back.
  f = fakeEngine();
  c = startClip(16000, "en-US", { update() {} }, { open: f.open, batch: async () => "rescued" });
  f.ready();
  await tick();
  c.write(pcm(10));
  f.h!.error("engine died");
  assert.equal(await c.finish(), "rescued");

  // Streaming worked but heard nothing: no second try (silence stays silence).
  f = fakeEngine();
  c = startClip(16000, "en-US", { update() {} }, { open: f.open, batch: async () => "should not run" });
  f.ready();
  await tick();
  assert.equal(await c.finish(), "");

  // The engine couldn't even open.
  c = startClip(16000, "en-US", { update() {} }, { open: async () => Promise.reject(new Error("nope")), batch: async () => "batch after open failed" });
  c.write(pcm(10));
  assert.equal(await c.finish(), "batch after open failed");
});

test("startClip: cancel closes the engine and reports nothing more", async () => {
  const f = fakeEngine();
  const seen: string[] = [];
  const c = startClip(16000, "en-US", { update: (t) => seen.push(t) }, { open: f.open, batch: async () => "x" });
  c.cancel();
  f.ready();
  await tick();
  assert.ok(f.closed);
  f.h!.partial("late");
  assert.deepEqual(seen, []);
});

test("captionThrottle: at most one per interval, newest wins, the last always goes out, none after stop", async () => {
  const out: string[] = [];
  const t = captionThrottle(40, (text) => out.push(text));
  t.update("a", 0);
  await tick(5);
  assert.deepEqual(out, ["a"]); // the first goes out at once
  t.update("ab", 0);
  t.update("abc", 0);
  await tick(10);
  assert.deepEqual(out, ["a"]); // too soon
  await tick(50);
  assert.deepEqual(out, ["a", "abc"]);
  t.update("abcd", 0);
  t.stop();
  await tick(60);
  assert.deepEqual(out, ["a", "abc"]);
});

// ---------------- glasses ----------------

// The glasses code is built by its own tsconfig (bundler resolution); load it untyped here.
const GLASSES_CAPTION = "../glasses/src/ui/caption.ts";
const ui: any = await import(GLASSES_CAPTION);
const { caption, captionLines, captionReply, captionRelease, captionStart, captionStop, onCaptionHub, captionGesture } = ui;
const { captionOwns } = ui;
const cap = (text: string, stable: number, final = false, source: "ptt" | "note" = "ptt", clip?: number) => onCaptionHub({ t: "caption", text, stable, final, source, at: Date.now(), clip });

test("caption phases: live → sent → reply → idle; notes save; nothing heard ends it", () => {
  captionStart("ptt");
  assert.equal(caption.phase, "live");
  cap("what's the weather", 0);
  assert.equal(caption.text, "what's the weather");
  captionRelease();
  assert.equal(caption.phase, "sent");
  cap("What's the weather?", 19, true);
  cap("stale partial", 0); // nothing after the final counts
  assert.equal(caption.text, "What's the weather?");
  assert.equal(captionReply("something else", "not ours"), false); // a reply to another press
  assert.ok(captionReply("What's the weather?", "72 and sunny."));
  assert.equal(caption.phase, "reply");
  assert.ok(captionGesture("tap"));
  assert.equal(caption.phase, "idle");
  assert.equal(captionGesture("tap"), false); // idle: gestures go to the screen

  captionStart("note");
  cap("buy milk", 8, false, "note");
  captionRelease();
  onCaptionHub({ t: "toast", text: "Note saved" }); // before this clip's final: an earlier press's
  assert.equal(caption.phase, "sent");
  cap("buy milk", 8, true, "note");
  assert.equal(captionReply("buy milk", "not for notes"), false);
  onCaptionHub({ t: "toast", text: "Note saved" });
  assert.equal(caption.phase, "reply");
  assert.deepEqual(captionLines(40, 4).done, ["> buy milk", "SAVED"]);
  captionStop();

  captionStart("ptt");
  captionRelease();
  cap("", 0, true);
  assert.equal(caption.phase, "idle");

  captionStart("ptt");
  captionRelease();
  onCaptionHub({ t: "toast", text: "Didn't catch that." }); // an earlier press's (no final yet)
  assert.equal(caption.phase, "sent");
  cap("", 0, true);
  onCaptionHub({ t: "toast", text: "Didn't catch that." });
  assert.equal(caption.phase, "idle");
  captionStart("ptt");
  captionRelease();
  captionStop("live"); // only ends a live caption
  assert.equal(caption.phase, "sent");
  captionStop("sent");
  assert.equal(caption.phase, "idle");
});

test("caption clips: a quick second press never shows the first one's words or reply", () => {
  captionStart("ptt", 1);
  cap("open my notes", 0, false, "ptt", 1);
  captionRelease();
  captionStart("ptt", 2); // pressed again before clip 1's final came back
  cap("open my notes", 13, true, "ptt", 1); // clip 1's final and a late partial: stale
  cap("open my", 0, false, "ptt", 1);
  assert.equal(caption.text, "");
  assert.equal(caption.phase, "live");
  cap("what time", 0, false, "ptt", 2);
  assert.equal(caption.text, "what time");
  captionRelease();
  assert.equal(captionOwns("open my notes"), false); // clip 1's reply
  cap("What time is it?", 16, true, "ptt", 2);
  assert.ok(captionOwns("What time is it?"));
  assert.ok(captionReply("What time is it?", "Nine."));
  captionStop();
});

test("captionLines: finals in done, the rest in live ending _, bottom-anchored, live capped", () => {
  captionStart("ptt");
  assert.deepEqual(captionLines(20, 3), { done: [], live: ["_"] });
  cap("Remind me to call mom tomorrow at", 21);
  // done = "Remind me to call mom" (the finals), live = the rest
  assert.deepEqual(captionLines(20, 3), { done: ["Remind me to call", "mom"], live: ["tomorrow at_"] });
  // Apple-style: nothing final yet, all live; older live rows move up into done.
  cap("remind me to call mom tomorrow at nine about the party", 0);
  const l = captionLines(20, 4, { liveRows: 1 });
  assert.deepEqual(l.live, ["about the party_"]);
  assert.deepEqual(l.done, ["remind me to call", "mom tomorrow at nine"]);
  // Only the newest rows fit.
  assert.deepEqual(captionLines(20, 2, { liveRows: 1 }), { done: ["mom tomorrow at nine"], live: ["about the party_"] });
  captionRelease();
  assert.deepEqual(captionLines(30, 3).live, ["BOCCHI > …"]);
  cap("remind me to call mom tomorrow at nine about the party", 0, true);
  captionReply("remind me to call mom tomorrow at nine about the party", "It is a very long reply that goes on and on for many words, more than fits in the box.");
  const r = captionLines(20, 3).done;
  assert.equal(r.length, 3);
  assert.match(r[0], /^BOCCHI > /);
  assert.match(r[2], /…$/);
  captionStop();
});

test("captionLines listen: who prefixes, partial last with _, stale partials dropped", () => {
  onCaptionHub({ t: "listening", purpose: "copilot" });
  onCaptionHub({ t: "transcript", line: { text: "So the budget is fixed.", at: Date.now(), final: true, who: "them" } });
  onCaptionHub({ t: "transcript", line: { text: "can we move", at: Date.now(), final: false, who: "me" } });
  assert.deepEqual(captionLines(44, 2, { source: "listen", who: true }), { done: ["THEM > So the budget is fixed."], live: ["YOU > can we move_"] });
  onCaptionHub({ t: "transcript", line: { text: "Can we move the date?", at: Date.now(), final: true, who: "me" } });
  assert.deepEqual(captionLines(44, 2, { source: "listen", who: true }), { done: ["THEM > So the budget is fixed.", "YOU > Can we move the date?"], live: [] });
  onCaptionHub({ t: "transcript", line: { text: "old words", at: Date.now() - 20_000, final: false } });
  assert.deepEqual(captionLines(44, 3, { source: "listen" }).live, []);
  onCaptionHub({ t: "listening", purpose: null });
  assert.deepEqual(captionLines(44, 3, { source: "listen" }), { done: [], live: [] });
});

test("core: a quick second press waits for the first one's audio_end; a mic that won't open cancels", async () => {
  const GLASSES_CORE = "../glasses/src/core.ts";
  const core: any = await import(GLASSES_CORE);
  const sent: any[] = [];
  let micDelay = 0;
  let micOk = true;
  core.core.ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) };
  core.core.bridge = {
    // The real bridge answers audioControl after a BLE round trip.
    audioControl: async (on: boolean) => (await tick(micDelay), on ? micOk : true),
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => true,
    textContainerUpgrade: async () => true,
    updateImageRawData: async () => "success",
  };
  core.core.stack = [{ id: "x", title: "", screen: () => ({ header: "", body: "" }), gesture: () => false }];
  const kinds = () => sent.filter((m) => m.t.startsWith("audio_")).map((m) => `${m.t}:${m.clip}`);

  micDelay = 30;
  const p1 = core.record(true, "note");
  const r1 = core.record(false, "note"); // released before the mic even opened
  const p2 = core.record(true, "note"); // and pressed again straight away
  assert.equal(caption.phase, "live");
  await Promise.all([p1, r1, p2]);
  await core.record(false, "note");
  const [c1, c2] = [sent[0].clip, sent.find((m: any) => m.t === "audio_start" && m.clip !== sent[0].clip).clip];
  assert.deepEqual(kinds(), [`audio_start:${c1}`, `audio_end:${c1}`, `audio_start:${c2}`, `audio_end:${c2}`]);

  sent.length = 0;
  micOk = false;
  await core.record(true, "note");
  assert.equal(core.core.talking, false);
  assert.equal(caption.phase, "idle");
  await core.record(false, "note"); // the release after a failed mic sends nothing
  const c3 = sent[0].clip;
  assert.deepEqual(kinds(), [`audio_start:${c3}`, `audio_cancel:${c3}`]);
  await core.rendered();
  core.core.bridge = null;
  core.core.ws = null;
});

// Mini-app isolation and the hub's fetch for them, offline:
//   node --import tsx --test scripts/miniapp-sandbox-test.mjs
// - appFetch (src/hub/safe-fetch.ts) refuses every non-public address, in any notation, after DNS
//   and after redirects (a local server plays the redirecting site).
// - The glasses' Apps mode runs each app in a sandbox (here the Node one, as on the Mac runner): a
//   hostile app can't see the token, the page, the bridge or the env, can't read files, and nothing
//   it sends reaches the hub except the MiniAppApi's own requests. The four shipped apps still run.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BlockedAddress, fetchPublic, isBlockedAddress } from "../src/hub/safe-fetch.ts";
import { core, openMode, pushToTalk, render, rendered } from "../glasses/src/core.ts";
import { appsMode, openApp } from "../glasses/src/modes/apps.ts";
import { captionStop } from "../glasses/src/ui/caption.ts";
import { fakeBridge } from "./lens-preview.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, f, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

// ---------------- appFetch ----------------

const BLOCKED = [
  "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.20.1.1", "172.31.255.255",
  "192.168.0.1", "192.168.255.255", "169.254.169.254", "100.64.0.1", "100.100.100.100", "100.127.255.255",
  "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.250", "255.255.255.255", "198.18.0.1",
  "::", "::1", "0:0:0:0:0:0:0:1", "fe80::1", "febf:ffff::1", "fc00::1", "fd12:3456:789a::1", "ff02::1", "ff05::2",
  "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "::ffff:192.168.1.1", "::ffff:100.64.0.1",
  "::ffff:0:127.0.0.1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::10.1.1.1", "2002:7f00:1::1", "2002:c0a8:101::",
  "not-an-ip", "",
];
const PUBLIC = ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1",
  "169.255.0.1", "11.0.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::"];

test("appFetch: every non-public address is blocked, public ones aren't", () => {
  for (const ip of BLOCKED) assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  for (const ip of PUBLIC) assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
});

test("appFetch: URLs naming a local address in any notation are refused before connecting", async () => {
  const urls = [
    "http://127.0.0.1:8787/api/state", "http://localhost:8787/", "http://LOCALHOST./", "http://[::1]:8787/", "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/", "http://0.0.0.0/", "http://0/", "http://2130706433/", "http://0x7f.1/", "http://017700000001/",
    "http://172.16.5.4/", "http://172.31.0.1/", "http://192.168.1.1/", "http://10.0.0.1/", "http://100.100.100.100/",
    "http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/", "http://[fd00::1]/", "http://[ff02::1]/", "https://[::]/",
    "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/",
  ];
  for (const url of urls) await assert.rejects(fetchPublic(url), BlockedAddress, url);
  for (const url of ["file:///etc/passwd", "ftp://example.com/", "data:application/json,{}", "javascript:1", "nope"])
    await assert.rejects(fetchPublic(url), /only http\(s\)|not a valid URL/, url);
  await assert.rejects(fetchPublic("http://user:pw@example.com/"), /user name or password/);
});

test("appFetch: host names are checked by what they resolve to (any address private = refused)", async () => {
  const lookup = async (host) =>
    ({
      "evil.test": [{ address: "10.0.0.5", family: 4 }],
      "mixed.test": [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
      "v6.test": [{ address: "::ffff:192.168.0.10", family: 6 }],
      "ts.test": [{ address: "100.101.102.103", family: 4 }],
    })[host] ?? [];
  for (const h of ["evil.test", "mixed.test", "v6.test", "ts.test"]) await assert.rejects(fetchPublic(`http://${h}/`, { lookup }), BlockedAddress, h);
  await assert.rejects(fetchPublic("http://nowhere.test/", { lookup }), /no address/);
});

test("appFetch: redirects are followed by hand and each hop is checked; size and time are capped", async (t) => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const go = (to) => res.writeHead(302, { Location: to.replace("PORT", port) }).end();
    if (req.url === "/json") return res.end(JSON.stringify({ ok: true, host: req.headers.host }));
    if (req.url === "/to-json") return go("/json"); // same host: fine
    if (req.url === "/to-ip") return go("http://127.0.0.1:PORT/json");
    if (req.url === "/to-evil") return go("http://evil.test:PORT/json");
    if (req.url === "/to-v6") return go("http://[::ffff:127.0.0.1]:PORT/json");
    if (req.url === "/to-tailscale") return go("http://100.64.1.2:PORT/json");
    if (req.url === "/to-file") return go("file:///etc/passwd");
    if (req.url === "/loop") return go("/loop");
    if (req.url === "/big") return res.end("x".repeat(1_200_000));
    if (req.url === "/big-chunked") {
      res.writeHead(200);
      for (let i = 0; i < 30; i++) res.write("y".repeat(50_000));
      return res.end();
    }
    if (req.url === "/slow") return; // never answers
    res.writeHead(404).end("{}");
  });
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  // "start.test" is the only exception to the block list, and it isn't in any DNS: reaching it at
  // all proves the connection goes to the address that was checked.
  const o = {
    lookup: async (h) => (h === "start.test" ? [{ address: "127.0.0.1", family: 4 }] : h === "evil.test" ? [{ address: "127.0.0.1", family: 4 }] : []),
    allow: (h) => h === "start.test",
  };
  const base = `http://start.test:${port}`;
  const ok = await fetchPublic(`${base}/to-json`, o);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, host: `start.test:${port}` });
  for (const p of ["/to-ip", "/to-evil", "/to-v6", "/to-tailscale"]) await assert.rejects(fetchPublic(base + p, o), BlockedAddress, p);
  await assert.rejects(fetchPublic(`${base}/to-file`, o), /only http\(s\)/);
  await assert.rejects(fetchPublic(`${base}/loop`, o), /too many redirects/);
  assert.equal(hits.filter((h) => h === "/loop").length, 6); // the first request + 5 redirects
  await assert.rejects(fetchPublic(`${base}/big`, o), /too large/);
  await assert.rejects(fetchPublic(`${base}/big-chunked`, o), /too large/);
  const t0 = Date.now();
  await assert.rejects(fetchPublic(`${base}/slow`, { ...o, timeoutMs: 300 }), /timed out|abort/i);
  assert.ok(Date.now() - t0 < 2000);
  // A blocked hop was never requested: /json was only reached through the allowed redirect.
  assert.equal(hits.filter((h) => h === "/json").length, 1);
});

// ---------------- the glasses' Apps mode, sandboxed ----------------

const SECRET = `test-token-${Math.random().toString(36).slice(2)}-secret`;
const dir = mkdtempSync(join(tmpdir(), "g2-miniapp-test-"));
const secretFile = join(dir, "dot-env");
writeFileSync(secretFile, `HUB_TOKEN=${SECRET}\n`);
// If the sandbox inherited this process's env, the app would find the token there.
process.env.HUB_TOKEN = SECRET;
process.env.G2_HUB_TOKEN = SECRET;

const ROOT = new URL("..", import.meta.url).pathname;
const shipped = (id) => {
  const meta = JSON.parse(readFileSync(join(ROOT, "miniapps", id, "meta.json"), "utf8"));
  return { info: { id, title: meta.title, kind: meta.kind, version: meta.version, description: "", updatedAt: 0 }, code: readFileSync(join(ROOT, "miniapps", id, "versions", `v${meta.version}.js`), "utf8") };
};

// Tries everything it can think of and keeps what it found in api.store ("found").
const HOSTILE = `
const found = {};
const probe = (name, f) => { try { const v = f(); found[name] = v === undefined ? "undefined" : typeof v === "string" ? v : typeof v === "object" ? (v === null ? "null" : "object") : typeof v; } catch (e) { found[name] = "threw " + (e && (e.code || e.name)); } };
let api, done = false;
probe("core", () => globalThis.core);
probe("window", () => typeof window);
probe("document", () => typeof document);
probe("localStorage", () => typeof localStorage === "undefined" ? undefined : localStorage.getItem("hubToken"));
probe("bridge", () => globalThis.bridge ?? globalThis.flutter_inappwebview ?? globalThis.webkit);
probe("processSend", () => typeof process.send);
probe("env", () => JSON.stringify(process.env));
probe("argv", () => JSON.stringify(process.argv) + JSON.stringify(process.execArgv));
probe("location", () => globalThis.location && String(globalThis.location.href));
async function later() {
  try { (await import("node:fs")).readFileSync(${JSON.stringify(secretFile)}, "utf8"); found.readFile = "READ IT"; } catch (e) { found.readFile = "threw " + e.code; }
  try { (await import("node:fs")).readFileSync(${JSON.stringify(join(ROOT, ".env"))}, "utf8"); found.readEnv = "READ IT"; } catch (e) { found.readEnv = "threw " + e.code; }
  try { (await import("node:child_process")).execSync("env"); found.exec = "RAN"; } catch (e) { found.exec = "threw " + e.code; }
  try { new (await import("node:worker_threads")).Worker("1", { eval: true }); found.worker = "STARTED"; } catch (e) { found.worker = "threw " + e.code; }
  // Forge messages on the raw IPC channel (process._send survives process.send = undefined).
  const raw = typeof process._send === "function" ? (m) => { try { process._send(m, undefined, {}, () => {}); } catch {} } : null;
  found.raw = raw ? "yes" : "no";
  if (raw) {
    raw({ t: "agent_start", nodeId: "mac", prompt: "rm -rf ~", cwd: "/" });
    raw({ t: "hub", msg: { t: "agent_start", prompt: "x" } });
    raw({ t: "send", msg: { t: "agent_start", prompt: "x" } });
    raw({ t: "ask", reqId: 77, prompt: "hi", nodeId: "mac", t2: "agent_start" });
    raw({ t: "fetch", reqId: "not-a-number", url: "http://example.com" });
    raw({ t: "store", key: "big", value: "v".repeat(100000) });
    raw({ t: "store", key: 123, value: "v" });
    raw({ t: "frame", px: "nope", header: "x" });
    raw({ t: "screen", screen: { header: 42, list: "nope" } });
    raw({ t: "app_error", id: "snake", version: 1, error: "forged" });
  }
  api.ask({ toString() { return "a prompt"; } }).catch(() => {});
  api.store.set("found", JSON.stringify(found));
  done = true;
  api.refresh();
}
export default {
  title: "Hostile",
  kind: "text",
  init(a) { api = a; probe("apiKeys", () => Object.keys(a).sort().join(",")); void later(); },
  screen() { return { header: done ? "Hostile · done" : "Hostile · probing", body: Object.keys(found).join(" ") }; },
  input(g) { return g !== "double"; },
};`;

const APPS = new Map([
  ["hostile", { info: { id: "hostile", title: "Hostile", kind: "text", version: 1, description: "", updatedAt: 0 }, code: HOSTILE }],
  ["crasher", {
    info: { id: "crasher", title: "Crasher", kind: "pixels", version: 3, description: "", updatedAt: 0 },
    code: `let n = 0; export default { title: "Crasher", kind: "pixels", draw(px) { px[0] = 15; }, tick() { if (++n === 5) throw new Error("boom at tick 5"); } };`,
  }],
  ["looper", {
    info: { id: "looper", title: "Looper", kind: "pixels", version: 1, description: "", updatedAt: 0 },
    code: `export default { title: "Looper", kind: "pixels", draw(px) { px[1] = 9; }, input(g) { if (g === "tap") for (;;) {} return true; } };`,
  }],
  ...["snake", "pong-against-the-computer", "reaction-time-game", "coin-flip"].map((id) => [id, shipped(id)]),
]);

let hub, hubPort, bridge, sent, served;
const store = new Map();

test("setup: a fake hub serving mini-app code, and the glasses UI on a fake bridge", async () => {
  served = [];
  hub = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const m = u.pathname.match(/^\/miniapps\/([a-z0-9-]+)\/app\.js$/);
    if (!m || u.searchParams.get("token") !== SECRET) return res.writeHead(401).end("{}");
    const a = APPS.get(m[1]);
    if (!a) return res.writeHead(404).end("{}");
    served.push(m[1]);
    res.writeHead(200, { "Content-Type": "text/javascript" }).end(a.code);
  });
  hubPort = await listen(hub);
  bridge = fakeBridge();
  bridge.getLocalStorage = async (k) => store.get(k) ?? "";
  bridge.setLocalStorage = async (k, v) => (store.set(k, v), true);
  store.set("hubToken", SECRET);
  sent = [];
  core.bridge = bridge;
  core.token = SECRET;
  core.hubUrl = `http://127.0.0.1:${hubPort}`;
  core.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  core.modes.set("apps", appsMode);
  core.stack.length = 0;
  core.stack.push({ id: "launcher", title: "", screen: () => ({ header: "launcher" }), gesture: () => false });
  openMode("apps");
  appsMode.onHub({ t: "miniapps", apps: [...APPS.values()].map((a) => a.info) });
  assert.equal(core.stack.at(-1).id, "apps");
});

const lensText = () => [...bridge.page.text.map((t) => t.content ?? ""), ...(bridge.page.list[0]?.itemContainer?.itemName ?? [])].join("\n");
const picture = () => bridge.images.get(4)?.px;
async function open(id) {
  openApp(id);
  await until(`${id} to open`, () => !lensText().includes("Apps ("));
}
async function close() {
  appsMode.exit();
  appsMode.enter();
  render();
  await rendered();
  await sleep(600); // the sandbox is killed 0.5 s after exit
}

test("sandbox: a hostile app finds no token, page, bridge, env or files, and can't talk to the hub", async () => {
  const before = sent.length;
  openApp("hostile");
  await until("the hostile app to finish probing", () => store.get("miniapp:hostile"));
  await until("its screen", () => lensText().includes("Hostile · done"));
  await sleep(300);
  const raw = store.get("miniapp:hostile");
  const found = JSON.parse(JSON.parse(raw).found);
  // Nothing it could see or keep contains the token.
  assert.ok(!raw.includes(SECRET), "the token leaked into what the app found");
  assert.equal(found.core, "undefined");
  assert.equal(found.window, "undefined");
  assert.equal(found.document, "undefined");
  assert.notEqual(found.localStorage, SECRET);
  assert.equal(found.bridge, "undefined");
  assert.equal(found.processSend, "undefined");
  assert.deepEqual(Object.keys(JSON.parse(found.env)).filter((k) => k !== "__CF_USER_TEXT_ENCODING"), ["PATH"]);
  assert.ok(!found.argv.includes(SECRET));
  assert.equal(found.apiKeys, "H,W,ask,exit,fetchJson,refresh,store,toast");
  assert.equal(found.raw, "yes"); // it did get at the raw channel, so the forged messages below were really sent
  console.log(`hostile app found: ${JSON.stringify({ ...found, env: Object.keys(JSON.parse(found.env)), argv: undefined })}`);
  if (process.allowedNodeEnvironmentFlags.has("--permission") || process.allowedNodeEnvironmentFlags.has("--experimental-permission")) {
    assert.equal(found.readFile, "threw ERR_ACCESS_DENIED");
    assert.equal(found.readEnv, "threw ERR_ACCESS_DENIED");
    assert.equal(found.exec, "threw ERR_ACCESS_DENIED");
    assert.equal(found.worker, "threw ERR_ACCESS_DENIED");
  }
  // Forged messages: only the MiniAppApi's own requests reached the hub, rebuilt from checked fields.
  const out = sent.slice(before).filter((m) => m.t !== "glasses_log"); // (the page's own diagnostics)
  assert.ok(out.length >= 1);
  for (const m of out) if (m.t !== "glasses_log") assert.ok(["app_ask", "app_fetch"].includes(m.t), `unexpected hub message ${JSON.stringify(m)}`);
  for (const m of out) assert.deepEqual(Object.keys(m).sort(), m.t === "app_ask" ? ["prompt", "reqId", "t"] : ["reqId", "t", "url"]);
  assert.ok(out.some((m) => m.t === "app_ask" && m.prompt === "a prompt"));
  assert.ok(!JSON.stringify(sent).includes("agent_start") && !JSON.stringify(sent).includes("forged"));
  // The oversized and non-string store writes were dropped.
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["found"]);
  // Its hub request is answered back into the sandbox (and only there).
  const ask = out.find((m) => m.t === "app_ask");
  appsMode.onHub({ t: "app_answer", reqId: ask.reqId, text: "fine" });
  assert.ok(lensText().includes("Hostile"));
  await close();
});

test("sandbox: a crash is reported once, with app.js (not a blob/data URL) and no token", async () => {
  const before = sent.length;
  openApp("crasher");
  await until("the crash screen", () => lensText().includes("Crasher crashed"));
  const errs = sent.slice(before).filter((m) => m.t === "app_error");
  assert.equal(errs.length, 1);
  assert.equal(errs[0].id, "crasher");
  assert.equal(errs[0].version, 3);
  assert.match(errs[0].error, /boom at tick 5/);
  assert.match(errs[0].error, /app\.js:1:/);
  assert.ok(!errs[0].error.includes("data:") && !errs[0].error.includes(SECRET));
  appsMode.gesture("double", 0); // leave the crash screen
  // Hot reload: a new version of the open (crashed) app starts it again.
  APPS.get("crasher").code = `export default { title: "Crasher", kind: "pixels", draw(px) { px.fill(7); } };`;
  APPS.get("crasher").info = { ...APPS.get("crasher").info, version: 4 };
  openApp("crasher");
  await until("v3 crash again", () => lensText().includes("Crasher crashed"));
  appsMode.onHub({ t: "miniapps", apps: [...APPS.values()].map((a) => a.info) });
  await until("v4 drawing", () => picture()?.some((v) => v === 7));
  await close();
});

test("sandbox: an app stuck in a loop is caught by the watchdog and the glasses stay responsive", async () => {
  const before = sent.length;
  openApp("looper");
  await until("looper frames", () => picture()?.some((v) => v === 9));
  appsMode.gesture("tap", 0);
  const t0 = Date.now();
  await until("the watchdog", () => lensText().includes("Looper crashed"), 9000);
  assert.ok(Date.now() - t0 >= 4000);
  assert.match(sent.slice(before).find((m) => m.t === "app_error").error, /stopped responding/);
  appsMode.gesture("double", 0);
  await close();
});

test("shipped apps: Snake, Pong, Reaction and Coin Flip run sandboxed and take gestures", async () => {
  const frames = async (n) => {
    const seen = [];
    for (let i = 0; i < n; i++) {
      await sleep(120);
      await rendered();
      if (picture()) seen.push(Buffer.from(picture()).toString("base64"));
    }
    return new Set(seen).size;
  };
  const results = {};

  // Snake: tap starts, frames keep coming, double tap leaves.
  await open("snake");
  await until("snake title", () => lensText().includes("tap to start"));
  appsMode.gesture("tap", 0);
  await until("snake playing", () => lensText().includes("Score 0"));
  appsMode.gesture("down", 0);
  results.snake = await frames(14); // it moves a cell every 0.42 s
  assert.ok(results.snake >= 3, `snake frames ${results.snake}`);
  appsMode.gesture("double", 0); // unhandled while playing: leaves the app
  await until("back on the list", () => lensText().includes("Apps ("));
  await close();

  // Pong: tap to start, the ball moves, swipes move the paddle.
  await open("pong-against-the-computer");
  await until("pong title", () => lensText().includes("PONG · tap to start"));
  appsMode.gesture("tap", 0);
  await until("pong playing", () => lensText().includes("CPU"));
  appsMode.gesture("up", 0);
  appsMode.gesture("up", 0);
  results.pong = await frames(12); // (it may wait a moment before serving)
  assert.ok(results.pong >= 3, `pong frames ${results.pong}`);
  await close();

  // Reaction (text): tap → WAIT → GO! → tap → a time, saved as best; hold isn't its, so it's push-to-talk.
  await open("reaction-time-game");
  await until("reaction start screen", () => lensText().includes("Tap to start"));
  appsMode.gesture("tap", 0);
  await until("WAIT", () => lensText().includes("WAIT"));
  await until("GO", () => lensText().includes("G O !"), 7000);
  appsMode.gesture("tap", 0);
  await until("a result", () => lensText().includes("Your time:"));
  assert.match(JSON.parse(store.get("miniapp:reaction-time-game")).best, /^\d+$/);
  // Double tap: Reaction doesn't use it, so the app exits to the list.
  appsMode.gesture("double", 0);
  await until("back on the list", () => lensText().includes("Apps ("));
  await sleep(600);
  await open("reaction-time-game");
  await until("reaction start screen", () => lensText().includes("Tap to start"));
  const ptt = sent.length;
  assert.equal(appsMode.hold(true), true); // taken for now…
  await until("push-to-talk after all", () => sent.slice(ptt).some((m) => m.t === "audio_start"));
  assert.equal(appsMode.hold(false), false);
  await pushToTalk(false); // (what core does with a release the mode didn't take)
  await until("the clip to end", () => sent.slice(ptt).some((m) => m.t === "audio_end"));
  captionStop(); // (the hub's reply would)
  results.reaction = "ok";
  await close();

  // Coin Flip: tap flips (header "Flipping..."), hold resets the tally (the app takes it: no push-to-talk).
  await open("coin-flip");
  appsMode.gesture("tap", 0);
  await until("flipping", () => lensText().includes("Flipping"));
  await until("a result", () => /Heads \d+ · Tails \d+ · 1 flips|Heads \d+ · Tails \d+ · \d+ flips/.test(lensText()) && !lensText().includes("Flipping"));
  const flips = JSON.parse(store.get("miniapp:coin-flip"));
  assert.equal(Number(flips.h) + Number(flips.t) >= 1, true);
  const noPtt = sent.length;
  assert.equal(appsMode.hold(true), true);
  await until("tally reset toast", () => lensText().includes("Tally reset"));
  assert.equal(appsMode.hold(false), true);
  await sleep(200);
  assert.ok(!sent.slice(noPtt).some((m) => m.t === "audio_start"));
  assert.deepEqual(JSON.parse(store.get("miniapp:coin-flip")), { h: "0", t: "0" });
  results.coin = await frames(3);
  await close();
  console.log(`shipped apps: ${JSON.stringify(results)} distinct frames; served ${served.length} downloads`);
});

test("teardown", () => {
  appsMode.exit();
  hub.closeAllConnections();
  hub.close();
  core.ws = null;
});

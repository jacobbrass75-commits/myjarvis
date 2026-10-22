import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.js";
import { PAIR_CODE_TTL_MS, WorkerRegistry, handlePair, helloAuth, workersApi } from "../src/hub/workers.js";
import { mergeEnv } from "./worker-pair.js";

// Worker pairing (src/hub/workers.ts): one-time codes that expire, per-worker tokens the hub stores
// only as hashes, revocation, and the hub's own token never going to a worker.

const MASTER = "master-hub-token-never-leaves-0123456789";
const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-workers-"));

test("a pairing code works once, then never again", () => {
  const dir = tmp();
  try {
    const reg = new WorkerRegistry(join(dir, "workers.json"));
    const { code } = reg.createCode();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const first = reg.redeem(code.toLowerCase().replace("-", " "), { name: "Home Mac", nodeId: "home-mac" });
    assert.equal(first.ok, true);
    const again = reg.redeem(code, { name: "Intruder" });
    assert.equal(again.ok, false);
    assert.equal(!again.ok && again.status, 401);
    assert.equal(reg.list().length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a pairing code expires", () => {
  const dir = tmp();
  try {
    let now = 1_000_000;
    const reg = new WorkerRegistry(join(dir, "workers.json"), () => now);
    const { code, expiresAt } = reg.createCode();
    assert.equal(expiresAt, now + PAIR_CODE_TTL_MS);
    now += PAIR_CODE_TTL_MS + 1;
    const r = reg.redeem(code, { name: "late" });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /expired/);
    // A fresh code still works.
    assert.equal(reg.redeem(reg.createCode().code, { name: "on time" }).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("wrong codes are rate limited", () => {
  const dir = tmp();
  try {
    const reg = new WorkerRegistry(join(dir, "workers.json"));
    const { code } = reg.createCode();
    for (let i = 0; i < 10; i++) assert.equal(reg.redeem(`ZZZZ-ZZ${i}Z`, {}).ok, false);
    const r = reg.redeem(code, {});
    assert.equal(!r.ok && r.status, 429);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("worker tokens: stored only as a hash, bound to their node, revocable", () => {
  const dir = tmp();
  try {
    const file = join(dir, "workers.json");
    const reg = new WorkerRegistry(file);
    const r = reg.redeem(reg.createCode().code, { name: "Home Mac", nodeId: "Home Mac" });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.match(r.token, /^g2w_[\w-]{40,}$/);
    assert.equal(r.nodeId, "home-mac");
    const disk = readFileSync(file, "utf8");
    assert.ok(!disk.includes(r.token), "the token itself is never saved on the hub");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // The registry survives a restart (a new instance reads the file).
    const reloaded = new WorkerRegistry(file);
    assert.equal(reloaded.verify(r.token)?.nodeId, "home-mac");

    const tokenOk = (t: unknown) => t === MASTER;
    assert.deepEqual(helloAuth({ role: "node", token: r.token }, tokenOk, reloaded), { ok: true, worker: reloaded.verify(r.token) });
    // A worker token is for a device daemon only: not the phone or the glasses.
    assert.equal(helloAuth({ role: "phone", token: r.token }, tokenOk, reloaded).ok, false);
    assert.equal(helloAuth({ role: "glasses", token: r.token }, tokenOk, reloaded).ok, false);
    // ...even on an open hub (no HUB_TOKEN), where any other token passes.
    assert.equal(helloAuth({ role: "phone", token: r.token }, () => true, reloaded).ok, false);
    assert.equal(helloAuth({ role: "node", token: MASTER }, tokenOk, reloaded).ok, true);
    assert.equal(helloAuth({ role: "node", token: "g2w_made-up" }, tokenOk, reloaded).ok, false);

    // Pairing the same computer again replaces its old token.
    const again = reloaded.redeem(reloaded.createCode().code, { name: "Home Mac", nodeId: "home-mac" });
    assert.ok(again.ok);
    assert.equal(reloaded.verify(r.token), undefined);
    assert.equal(reloaded.list().length, 1);

    // A worker can't take the node id of a device on the hub's own token.
    const clash = reloaded.redeem(reloaded.createCode().code, { name: "studio" }, (id) => id === "studio");
    assert.equal(clash.ok && clash.nodeId, "studio-2");

    assert.ok(again.ok && reloaded.revoke(again.workerId));
    assert.equal(again.ok && reloaded.verify(again.token), undefined);
    assert.equal(helloAuth({ role: "node", token: again.ok ? again.token : "" }, tokenOk, reloaded).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the hub state lists workers with their online state", () => {
  const dir = tmp();
  try {
    const hub = new Hub([]);
    hub.workers = new WorkerRegistry(join(dir, "workers.json"));
    const r = hub.workers.redeem(hub.workers.createCode().code, { name: "home", os: "macOS 15.3 (arm64)" });
    assert.ok(r.ok);
    assert.equal(hub.snapshot().workers?.[0].online, false);
    hub.nodes.set("home", { id: "home", name: "home", online: true, defaultCwd: "~", os: "macOS 15.3 (arm64)", capabilities: ["computer"], workerId: r.ok ? r.workerId : "" });
    const w = hub.snapshot().workers?.[0];
    assert.equal(w?.online, true);
    assert.equal(w?.os, "macOS 15.3 (arm64)");
    assert.ok(!JSON.stringify(hub.snapshot()).includes("tokenHash"), "no token hashes in the broadcast state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** The pairing HTTP routes as server.ts mounts them, with HUB_TOKEN = MASTER. */
function testHub(reg: WorkerRegistry, revoked: string[]): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/pair") return handlePair(req, res, reg, () => false);
    if (req.headers["x-hub-token"] !== MASTER) return res.writeHead(401).end("{}");
    if (await workersApi(req, res, url, reg, { port: 8787, online: () => false, changed: () => {}, onRevoke: (w) => revoked.push(w.id) })) return;
    res.writeHead(404).end("{}");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(server.address() as any).port}`, server })));
}

test("pairing over HTTP: needs the hub token to make a code, never returns the hub token", async () => {
  const dir = tmp();
  const revoked: string[] = [];
  const reg = new WorkerRegistry(join(dir, "workers.json"));
  const { url, server } = await testHub(reg, revoked);
  try {
    assert.equal((await fetch(`${url}/api/workers/code`, { method: "POST" })).status, 401);
    const made = await (await fetch(`${url}/api/workers/code`, { method: "POST", headers: { "x-hub-token": MASTER } })).text();
    assert.ok(!made.includes(MASTER));
    const { code, command } = JSON.parse(made);
    assert.match(command, new RegExp(`--code ${code}$`));
    const paired = await fetch(`${url}/api/pair`, { method: "POST", body: JSON.stringify({ code, name: "home-mac" }) });
    const body = await paired.text();
    assert.equal(paired.status, 200);
    assert.ok(!body.includes(MASTER), "the hub token is never sent to a worker");
    const { token, workerId } = JSON.parse(body);
    assert.ok(reg.verify(token));
    // Used up.
    assert.equal((await fetch(`${url}/api/pair`, { method: "POST", body: JSON.stringify({ code }) })).status, 401);
    // Unauthenticated, so it refuses big bodies.
    assert.equal((await fetch(`${url}/api/pair`, { method: "POST", body: "x".repeat(10_000) })).status, 413);
    const list = await (await fetch(`${url}/api/workers`, { headers: { "x-hub-token": MASTER } })).text();
    assert.ok(!list.includes(token) && !list.includes("tokenHash"));
    assert.equal((await fetch(`${url}/api/workers/${workerId}/revoke`, { method: "POST", headers: { "x-hub-token": MASTER } })).status, 200);
    assert.deepEqual(revoked, [workerId]);
    assert.equal(reg.verify(token), undefined);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("join (the worker side) writes its own token to .env, mode 600, and never prints it", async () => {
  const dir = tmp();
  const reg = new WorkerRegistry(join(dir, "workers.json"));
  const { url, server } = await testHub(reg, []);
  try {
    const env = join(dir, ".env");
    writeFileSync(env, "# mine\nSONIOX_API_KEY=keep-me\nG2_HUB_URL=http://old:8787\n");
    const { code } = reg.createCode();
    const out = await new Promise<string>((ok, fail) =>
      execFile(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "worker-pair.ts"), "join", "--hub", url, "--name", "home-mac", "--computer"], {
        env: { ...process.env, G2_PAIR_CODE: code, G2_ENV_FILE: env, HUB_TOKEN: MASTER },
      }, (e, stdout, stderr) => (e ? fail(new Error(stderr || e.message)) : ok(stdout + stderr))));
    const written = readFileSync(env, "utf8");
    const token = written.match(/^G2_HUB_TOKEN=(g2w_\S+)$/m)?.[1];
    assert.ok(token && reg.verify(token), "the worker token is saved");
    assert.ok(!out.includes(token!), "the token is never printed");
    assert.ok(!written.includes(MASTER), "the hub token never reaches the worker's .env");
    assert.match(written, /^SONIOX_API_KEY=keep-me$/m);
    assert.match(written, /^# mine$/m);
    assert.match(written, new RegExp(`^G2_HUB_URL=${url}$`, "m"));
    assert.match(written, /^G2_COMPUTER_USE=1$/m);
    assert.equal(statSync(env).mode & 0o777, 0o600);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeEnv replaces keys in place and keeps everything else", () => {
  assert.equal(mergeEnv("A=1\n# note\nexport B=2\n", { B: "3", C: "4" }), "A=1\n# note\nB=3\nC=4\n");
  assert.equal(mergeEnv("", { A: "1" }), "A=1\n");
});

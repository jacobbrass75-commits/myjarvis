import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { Hub, SCREEN_INTERVAL_MS } from "../src/hub/hub.js";
import {
  type Action, type Ask, ComputerGate, ComputerSession, type FocusInfo, type ScreenInput, type Shot, type WindowInfo,
  computerTools, sensitiveContext, sensitiveTarget, toAction,
} from "../src/node/computer.js";

// Computer use (src/node/computer.ts) with a mocked input helper: nothing here moves the mouse,
// clicks or types. The gate must ask before anything changes, honour stop and the kill switch, and
// pause on sensitive screens.

class MockInput implements ScreenInput {
  acts: Action[] = [];
  shots = 0;
  window: WindowInfo = { app: "Safari", title: "Coffee filters - Shop", pid: 1, x: 0, y: 0, w: 1440, h: 900, front: true };
  focus: FocusInfo = { app: "Safari", secure: false };
  /** Runs after each act (e.g. a click that opens a sign-in page). */
  after?: (a: Action) => void;
  async screenshot({ thumb }: { thumb: boolean }): Promise<Shot> {
    this.shots++;
    return { jpeg: "AAAA", w: 1280, h: 800, scale: 1.5, ...(thumb && { thumb: "BBBB" }) };
  }
  async windows() { return [this.window]; }
  async focused() { return this.focus; }
  async act(a: Action) {
    this.acts.push(a);
    this.after?.(a);
  }
}

function setup(mode: "task" | "step", answers: boolean[] = [], killFile = join(tmpdir(), `no-such-kill-${process.pid}`)) {
  const input = new MockInput();
  const asked: { summary: string; sensitive: string | null }[] = [];
  const ask: Ask = async (summary, sensitive) => {
    asked.push({ summary, sensitive });
    return { ok: answers.length ? answers.shift()! : true };
  };
  const gate = new ComputerGate(mode, ask, killFile);
  const progress: string[] = [];
  const session = new ComputerSession({ input, gate, progress: (t) => progress.push(t), settleMs: 0, stepMs: 0 });
  const tools = Object.fromEntries(computerTools(session).map((t) => [t.name, t]));
  const call = (name: string, args: any) => tools[name].handler(args, {}) as Promise<any>;
  return { input, asked, gate, session, tools, call, progress };
}

const textOf = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");

test("tool schemas: the screen tools and nothing else", () => {
  const { tools } = setup("step");
  assert.deepEqual(Object.keys(tools).sort(), ["actions", "click", "double_click", "drag", "key", "list_windows", "move", "open", "screenshot", "scroll", "type_text"]);
  const schema = (n: string) => z.object(tools[n].inputSchema);
  assert.ok(schema("click").safeParse({ x: 10, y: 20 }).success);
  assert.ok(schema("click").safeParse({ x: 10, y: 20, button: "right" }).success);
  assert.ok(!schema("click").safeParse({ x: "10", y: 20 }).success);
  assert.ok(!schema("click").safeParse({ x: 10 }).success);
  assert.ok(!schema("click").safeParse({ x: 1, y: 2, button: "middle" }).success);
  assert.ok(schema("drag").safeParse({ x: 1, y: 2, to_x: 3, to_y: 4 }).success);
  assert.ok(!schema("type_text").safeParse({ text: "x".repeat(2001) }).success);
  assert.ok(schema("actions").safeParse({ steps: [{ action: "click", x: 1, y: 2 }, { action: "type", text: "hi" }, { action: "key", keys: "return" }] }).success);
  assert.ok(!schema("actions").safeParse({ steps: [] }).success);
  assert.ok(!schema("actions").safeParse({ steps: Array(21).fill({ action: "wait" }) }).success);
  assert.ok(!schema("actions").safeParse({ steps: [{ action: "rm -rf" }] }).success);
  assert.ok(schema("screenshot").safeParse({}).success);
  for (const t of Object.values(tools)) assert.ok(t.description.length > 10, `${t.name} has a description`);
});

test("steps are validated: malformed, unknown keys, bad open targets", () => {
  assert.equal(typeof toAction({ action: "click" }), "string");
  assert.equal(typeof toAction({ action: "drag", x: 1, y: 2 }), "string");
  assert.equal(typeof toAction({ action: "key", keys: "cmd+t; rm" }), "string");
  assert.equal(typeof toAction({ action: "open", target: "file:///etc/passwd" }), "string");
  assert.equal(typeof toAction({ action: "open", target: "x-apple.systempreferences:com.apple.preference.security" }), "string");
  assert.deepEqual(toAction({ action: "open", target: "https://example.com/a?b=1" }), { do: "open", target: "https://example.com/a?b=1" });
  assert.deepEqual(toAction({ action: "double_click", x: 3, y: 4 }), { do: "click", x: 3, y: 4, button: "left", count: 2 });
  assert.deepEqual(toAction({ action: "wait", seconds: 60 }), { do: "wait", ms: 5000 });
});

test("screenshot and list_windows change nothing and need no approval", async () => {
  const { call, asked, input } = setup("step");
  const shot = await call("screenshot", {});
  assert.equal(shot.content[0].type, "image");
  assert.match(textOf(shot), /1280x800.*Safari/);
  assert.match(textOf(await call("list_windows", {})), /\* Safari - "Coffee filters - Shop" at 0,0 size 960x600/);
  assert.equal(asked.length, 0);
  assert.equal(input.acts.length, 0);
});

test("every step mode: each acting call asks first; a no runs nothing", async () => {
  const { call, asked, input } = setup("step", [false, true, true]);
  assert.match(textOf(await call("click", { x: 10, y: 10 })), /Take a screenshot first/);
  assert.equal(asked.length, 0, "refused before asking: no coordinates yet");
  await call("screenshot", {});
  const denied = await call("click", { x: 100, y: 200 });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /said no/);
  assert.equal(input.acts.length, 0);
  assert.match(asked[0].summary, /^click 100,200 in Safari: Coffee filters/);
  await call("click", { x: 100, y: 200 });
  await call("type_text", { text: "coffee filters" });
  assert.equal(asked.length, 3);
  // Screenshot pixels are scaled to screen points (scale 1.5).
  assert.deepEqual(input.acts, [{ do: "click", x: 150, y: 300, button: "left", count: 1 }, { do: "type", text: "coffee filters" }]);
});

test("a batch is one approval for all its steps", async () => {
  const { call, asked, input } = setup("step");
  await call("screenshot", {});
  const r = await call("actions", { steps: [{ action: "click", x: 10, y: 10 }, { action: "type", text: "hello" }, { action: "key", keys: "return" }] });
  assert.equal(r.content[0].type, "image", "a fresh screenshot comes back");
  assert.equal(asked.length, 1);
  assert.match(asked[0].summary, /click 10,10; type "hello"; press return/);
  assert.equal(input.acts.length, 3);
});

test("once per task mode: one yes covers ordinary steps, sensitive screens still ask", async () => {
  const { call, asked, input } = setup("task");
  await call("screenshot", {});
  await call("click", { x: 1, y: 1 });
  await call("scroll", { dy: 3 });
  await call("key", { keys: "cmd+f" });
  assert.equal(asked.length, 1);
  input.window = { ...input.window, title: "Checkout - Shop" };
  await call("click", { x: 2, y: 2 });
  assert.equal(asked.length, 2);
  assert.match(asked[1].sensitive ?? "", /sign-in or payment/);
  input.window = { ...input.window, title: "Coffee filters - Shop" };
  await call("click", { x: 3, y: 3 });
  assert.equal(asked.length, 2, "back on an ordinary page: no new card");
  assert.equal(input.acts.length, 5);
});

test("a sign-in page that appears mid-batch pauses before typing", async () => {
  const { call, asked, input } = setup("task", [true, false]);
  await call("screenshot", {});
  input.after = (a) => {
    if (a.do === "click") {
      input.window = { ...input.window, title: "Sign in - Shop" };
      input.focus = { app: "Safari", secure: true };
    }
  };
  const r = await call("actions", { steps: [{ action: "click", x: 5, y: 5 }, { action: "type", text: "hunter2" }] });
  assert.equal(r.isError, true);
  assert.equal(asked.length, 2);
  assert.match(asked[1].sensitive ?? "", /password field/);
  assert.deepEqual(input.acts.map((a) => a.do), ["click"], "nothing was typed");
});

test("stop: nothing more runs, mid-batch included", async () => {
  const { call, gate, input, asked } = setup("step");
  await call("screenshot", {});
  input.after = () => (gate.stopped = true); // the wearer says "stop the computer" during step 1
  const r = await call("actions", { steps: [{ action: "click", x: 5, y: 5 }, { action: "click", x: 6, y: 6 }, { action: "click", x: 7, y: 7 }] });
  assert.match(textOf(r), /Stopped by the wearer.*1 of 3/);
  assert.equal(input.acts.length, 1);
  const after = await call("click", { x: 8, y: 8 });
  assert.match(textOf(after), /Stopped/);
  assert.equal(asked.length, 1, "no card after a stop");
  assert.equal(input.acts.length, 1);
});

test("a stop while the card is up wins over a late yes", async () => {
  const input = new MockInput();
  let gate!: ComputerGate;
  gate = new ComputerGate("step", async () => {
    gate.stopped = true;
    return { ok: true };
  }, join(tmpdir(), "no-such-kill"));
  const session = new ComputerSession({ input, gate, progress: () => {}, settleMs: 0, stepMs: 0 });
  await session.screenshotResult();
  const r = await session.run([{ action: "click", x: 1, y: 1 }]);
  assert.match(textOf(r), /Stopped/);
  assert.equal(input.acts.length, 0);
});

test("the kill switch file blocks everything without asking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-kill-"));
  try {
    const kill = join(dir, "computer-stop");
    const { call, asked, input } = setup("task", [], kill);
    await call("screenshot", {});
    writeFileSync(kill, "");
    const r = await call("click", { x: 1, y: 1 });
    assert.match(textOf(r), /kill switch/);
    assert.equal(asked.length, 0);
    assert.equal(input.acts.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coordinates outside the screenshot are refused before asking", async () => {
  const { call, asked } = setup("step");
  await call("screenshot", {});
  assert.match(textOf(await call("click", { x: 1280, y: 10 })), /outside the 1280x800/);
  assert.match(textOf(await call("drag", { x: 1, y: 1, to_x: 5, to_y: -1 })), /outside/);
  assert.equal(asked.length, 0);
});

test("denylist: password fields, system settings, password managers, sign-in and payment pages", () => {
  assert.match(sensitiveContext({ app: "Safari", secure: true }) ?? "", /password field/);
  assert.match(sensitiveContext({ app: "System Settings" }) ?? "", /denylist/);
  assert.match(sensitiveContext({ app: "system preferences" }) ?? "", /denylist/);
  assert.match(sensitiveContext({ app: "Keychain Access" }) ?? "", /denylist/);
  assert.match(sensitiveContext({ app: "1Password 8", bundle: "com.1password.1password" }) ?? "", /denylist/);
  assert.match(sensitiveContext({ app: "Safari", title: "Checkout - Amazon.com" }) ?? "", /payment/);
  assert.match(sensitiveContext({ app: "Chrome", title: "Sign in to GitHub" }) ?? "", /sign-in/);
  assert.match(sensitiveContext({ app: "Chrome", title: "Enter your verification code" }) ?? "", /sign-in/);
  assert.match(sensitiveContext({ app: "Safari", title: "Chase Bank - Accounts" }) ?? "", /payment/);
  assert.equal(sensitiveContext({ app: "Visual Studio Code", title: "README.md - g2-orchestrator" }), null);
  assert.equal(sensitiveContext({ app: "Safari", title: "Hacker News" }), null);
  assert.equal(sensitiveContext({ app: "Notes", title: "Shopping list" }), null);
  assert.match(sensitiveContext({ app: "Notes" }, ["Notes"]) ?? "", /denylist/, "extra apps from G2_COMPUTER_DENY_APPS");
  assert.match(sensitiveTarget("https://www.paypal.com/signin") ?? "", /payment/);
  assert.match(sensitiveTarget("https://shop.example.com/checkout/cart") ?? "", /payment/);
  assert.match(sensitiveTarget("https://accounts.google.com/") ?? "", /sign-in/);
  assert.match(sensitiveTarget("System Settings") ?? "", /denylist/);
  assert.equal(sensitiveTarget("https://news.ycombinator.com/"), null);
  assert.equal(sensitiveTarget("Safari"), null);
});

test("opening a payment page asks with the reason, even once per task", async () => {
  const { call, asked } = setup("task");
  await call("open", { target: "https://example.com/" });
  await call("open", { target: "https://example.com/checkout" });
  assert.equal(asked.length, 2);
  assert.equal(asked[0].sensitive, null);
  assert.match(asked[1].sensitive ?? "", /payment/);
});

// ---------------- the hub side ----------------

function hubWithComputer() {
  const hub = new Hub([]);
  const sent: Record<string, any[]> = { home: [], dev: [], glasses: [], phone: [] };
  const sock = (k: string) => ({ readyState: 1, send: (s: string) => sent[k].push(JSON.parse(s)) }) as any;
  hub.nodes.set("dev", { id: "dev", name: "Dev box", online: true, defaultCwd: "/", engines: ["claude"] });
  hub.nodes.set("home", { id: "home", name: "Home Mac", online: true, defaultCwd: "/", engines: ["claude"], capabilities: ["computer"] });
  hub.clients.add({ role: "node", nodeId: "dev", ws: sock("dev") });
  hub.clients.add({ role: "node", nodeId: "home", ws: sock("home") });
  const glasses = { role: "glasses" as const, ws: sock("glasses") };
  hub.clients.add(glasses);
  hub.clients.add({ role: "phone", ws: sock("phone") });
  return { hub, sent, glasses };
}

test("'on the home computer, …' goes to the device with computer use; stop reaches it and denies its cards", () => {
  const { hub, sent } = hubWithComputer();
  const a = hub.startComputerAgent(undefined, "Order more coffee filters");
  assert.equal(typeof a, "object");
  if (typeof a !== "object") return;
  assert.equal(a.kind, "computer");
  assert.deepEqual(sent.home.map((m) => [m.t, m.engine]), [["agent_start", "computer"]]);
  assert.equal(sent.dev.length, 0);
  assert.match(hub.startComputerAgent("dev box", "x") as string, /off on Dev box/);
  hub.nodes.get("home")!.capabilities = [];
  hub.nodes.get("home")!.capabilityIssues = { computer: "Grant Screen Recording to node" };
  assert.match(hub.startComputerAgent(undefined, "x") as string, /Screen Recording/);

  hub.addApproval({ approval: { id: "c1", agentId: a.id, agentName: "computer", nodeId: "home", tool: "COMPUTER", summary: "click", createdAt: Date.now() }, detail: "", nodeId: "home", humanOnly: true }, 60_000);
  assert.equal(hub.resolve("c1", "allow", undefined, "router"), false, "the voice router can't approve a computer step");
  assert.equal(hub.resolve("c1", "allow", undefined, "node"), false, "nor can a device");
  assert.equal(hub.stopComputerAgents(), 1);
  assert.deepEqual(sent.home.slice(1).map((m) => [m.t, m.decision ?? m.agentId]), [["approval_result", "deny"], ["agent_stop", a.id]]);
  assert.equal(hub.pending.size, 0);
});

test("thumbnails go only to glasses watching that agent, at most every 1.5 s", async () => {
  const { hub, sent, glasses } = hubWithComputer();
  const a = hub.startComputerAgent(undefined, "x");
  if (typeof a !== "object") return assert.fail(a);
  hub.setScreen(a.id, "AAA");
  assert.equal(sent.glasses.filter((m) => m.t === "agent_screen").length, 0, "nobody is watching");
  hub.watch(glasses, a.id);
  assert.deepEqual(sent.glasses.filter((m) => m.t === "agent_screen").map((m) => m.px), ["AAA"], "the latest one on opening");
  hub.setScreen(a.id, "BBB"); // goes at once (sending the cached one on watch does not count)
  hub.setScreen(a.id, "CCC");
  hub.setScreen(a.id, "DDD");
  const pushes = () => sent.glasses.filter((m) => m.t === "agent_screen").map((m) => m.px);
  assert.deepEqual(pushes(), ["AAA", "BBB"]);
  await new Promise((r) => setTimeout(r, SCREEN_INTERVAL_MS + 100));
  assert.deepEqual(pushes(), ["AAA", "BBB", "DDD"], "one trailing push with the newest");
  assert.equal(sent.phone.filter((m) => m.t === "agent_screen").length, 0, "never to the phone");
  assert.ok(!JSON.stringify(hub.snapshot()).includes("DDD"), "not in the broadcast state");
  hub.removeAgent(a.id);
  assert.equal(hub.screens.size, 0);
});

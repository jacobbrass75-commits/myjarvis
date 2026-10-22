import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { arch, homedir, hostname, platform, release } from "node:os";
import WebSocket from "ws";
import { CodexAgent } from "./codex.js";
import { APPROVAL_MODE, ComputerGate, ComputerSession, KILL_FILE, MacInput, THUMBNAILS, computerOptions, computerReadiness } from "./computer.js";
import { getEngineReadiness, type EngineReadiness } from "./engines.js";
import { loadProjects, projectDirectory } from "./projects.js";
import { type Agent, type Decision, type HubMsg, type NodeCapabilities, clip, send, summarizeTool } from "../shared/protocol.js";

// Runs on every device you want to control (Mac, desktop, server). It connects out to the hub,
// so devices only need to reach the hub (Tailscale makes that trivial), not each other.

const HUB = (process.env.G2_HUB_URL || "http://127.0.0.1:8787").replace(/^http/, "ws") + "/ws";
const TOKEN = process.env.G2_HUB_TOKEN || process.env.HUB_TOKEN || "";
const NAME = process.env.G2_NODE_NAME || hostname().replace(/\.local$/, "");
const NODE_ID = process.env.G2_NODE_ID || NAME;
const DEFAULT_CWD = (process.env.G2_DEFAULT_CWD || homedir()).replace(/^~/, homedir());
const BYPASS = /^(1|true|yes)$/i.test(process.env.G2_BYPASS_PERMISSIONS || "");
// Tools that never need a ring tap. Everything else goes to the glasses.
const AUTO_ALLOW = new Set((process.env.G2_AUTO_ALLOW || "Read,Glob,Grep,LS,TodoWrite,WebSearch").split(","));

interface Running {
  agent: Agent;
  push: (text: string) => void;
  stop: () => void;
}

const running = new Map<string, Running>();
const waiting = new Map<string, (d: { decision: Decision; message?: string }) => void>();
let ws: WebSocket | null = null;
let readiness: EngineReadiness[] = [];
let shuttingDown = false;
let capabilitySignature = "";
let refreshing = false;
let computerReady = false;

/** "macOS 15.3 (arm64)", worked out once. */
const osLabel: Promise<string> = platform() === "darwin"
  ? new Promise((ok) => execFile("/usr/bin/sw_vers", ["-productVersion"], { timeout: 4000 }, (e, out) => ok(`macOS ${e ? release() : String(out).trim()} (${arch()})`)))
  : Promise.resolve(`${platform()} ${release()} (${arch()})`);

async function nodeCapabilities(): Promise<NodeCapabilities> {
  const [engines, computer, os] = await Promise.all([getEngineReadiness(), computerReadiness(), osLabel]);
  readiness = engines;
  computerReady = computer.ready;
  return {
    engines: readiness.filter((r) => r.ready).map((r) => r.engine),
    engineIssues: Object.fromEntries(readiness.filter((r) => !r.ready).map((r) => [r.engine, r.detail])),
    projects: loadProjects(DEFAULT_CWD),
    permissionMode: BYPASS ? "unrestricted" : "approvals",
    os,
    capabilities: computer.ready ? ["computer"] : [],
    capabilityIssues: computer.issue ? { computer: computer.issue } : {},
    ...(computer.enabled && { computerApproval: APPROVAL_MODE }),
  };
}

async function refreshCapabilities() {
  const sock = ws;
  if (refreshing || shuttingDown || !sock || sock.readyState !== WebSocket.OPEN) return;
  refreshing = true;
  try {
    const capabilities = await nodeCapabilities();
    if (ws !== sock || sock.readyState !== WebSocket.OPEN || shuttingDown) return;
    const signature = JSON.stringify(capabilities);
    if (signature !== capabilitySignature) {
      capabilitySignature = signature;
      send(sock, { t: "node_capabilities", ...capabilities });
    }
  } finally { refreshing = false; }
}
const capabilityRefresh = setInterval(() => { void refreshCapabilities(); }, 60_000);
capabilityRefresh.unref();

function upsert(r: Running, patch: Partial<Agent>) {
  Object.assign(r.agent, patch, { updatedAt: Date.now() });
  if (ws) send(ws, { t: "agent_upsert", agent: r.agent });
}

/** A prompt stream that stays open so follow-up messages from the glasses reach the same session. */
function inbox() {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  async function* gen(): AsyncGenerator<SDKUserMessage> {
    while (!closed) {
      if (!queue.length) await new Promise<void>((r) => (wake = r));
      while (queue.length)
        yield { type: "user", message: { role: "user", content: queue.shift()! }, parent_tool_use_id: null };
    }
  }
  return {
    gen,
    push(text: string) {
      queue.push(text);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

async function startAgent(agentId: string, cwd: string, prompt: string, name: string) {
  const box = inbox();
  const abort = new AbortController();
  const agent: Agent = { id: agentId, nodeId: NODE_ID, name, kind: "sdk", cwd, status: "running", lastText: prompt, updatedAt: Date.now() };

  const q = query({
    prompt: box.gen(),
    options: {
      cwd: cwd.replace(/^~/, homedir()),
      abortController: abort,
      // G2_BYPASS_PERMISSIONS=1 lets agents run every tool without asking (no ring approvals).
      ...(BYPASS ? { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true } : { permissionMode: "default" as const }),
      settingSources: ["user", "project", "local"],
      // This session reports to the hub directly; keep the G2 Claude Code hooks out of it.
      env: { ...process.env, G2_HOOK_DISABLE: "1" } as Record<string, string>,
      canUseTool: async (toolName, input, { signal }) => {
        if (AUTO_ALLOW.has(toolName)) return { behavior: "allow", updatedInput: input };
        const id = randomUUID().slice(0, 8);
        upsert(r, { status: "waiting" });
        if (ws)
          send(ws, {
            t: "approval_request",
            approval: { id, agentId, agentName: name, nodeId: NODE_ID, tool: toolName, summary: clip(summarizeTool(toolName, input), 500), createdAt: Date.now() },
            detail: JSON.stringify(input),
          });
        const d = await new Promise<{ decision: Decision; message?: string }>((resolve) => {
          waiting.set(id, resolve);
          signal.addEventListener("abort", () => resolve({ decision: "deny", message: "aborted" }));
          if (!ws) resolve({ decision: "deny", message: "Hub offline; no one to approve." });
        });
        waiting.delete(id);
        upsert(r, { status: "running" });
        return d.decision === "allow"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: d.message || "The user denied this from their glasses." };
      },
    },
  });

  const r: Running = {
    agent,
    push: box.push,
    stop: () => {
      q.interrupt().catch(() => {});
      abort.abort();
    },
  };
  running.set(agentId, r);
  upsert(r, {});
  box.push(prompt);

  try {
    for await (const msg of q) {
      if (msg.type === "assistant" && !msg.parent_tool_use_id) {
        const text = msg.message.content.flatMap((b: any) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
        const tool = msg.message.content.find((b: any) => b.type === "tool_use") as any;
        if (text) upsert(r, { lastText: text, status: "running" });
        else if (tool) upsert(r, { lastText: `${tool.name} ${clip(summarizeTool(tool.name, tool.input), 200)}`, status: "running" });
      } else if (msg.type === "result") {
        const out = msg.subtype === "success" ? msg.result : `Ended: ${msg.subtype}`;
        upsert(r, { status: msg.subtype === "success" ? "idle" : "error", lastText: out || r.agent.lastText });
      }
    }
    upsert(r, { status: "done" });
  } catch (e: any) {
    upsert(r, { status: abort.signal.aborted ? "done" : "error", lastText: abort.signal.aborted ? "Stopped." : `Error: ${e.message}` });
  } finally {
    box.close();
    running.delete(agentId);
  }
}

/** Ask the wearer on the glasses/phone; only a tap answers (humanOnly), never the voice router. */
function askWearer(agentId: string, name: string, tool: string, summary: string, signal: AbortSignal): Promise<{ decision: Decision; message?: string }> {
  const id = randomUUID().slice(0, 8);
  return new Promise((resolve) => {
    const done = (d: { decision: Decision; message?: string }) => { waiting.delete(id); resolve(d); };
    if (!ws) return done({ decision: "deny", message: "Hub offline; no one to approve." });
    waiting.set(id, done);
    signal.addEventListener("abort", () => done({ decision: "deny", message: "stopped" }));
    send(ws, { t: "approval_request", humanOnly: true, approval: { id, agentId, agentName: name, nodeId: NODE_ID, tool, summary: clip(summary, 500), createdAt: Date.now() }, detail: "" });
  });
}

/**
 * A computer-use agent (computer.ts): drives this computer's screen. Its tools ask the wearer before
 * anything changes; agent_stop, "stop the computer" and the kill switch file halt it between steps.
 */
async function startComputer(agentId: string, prompt: string, name: string) {
  const box = inbox();
  const abort = new AbortController();
  const agent: Agent = { id: agentId, nodeId: NODE_ID, name, kind: "computer", cwd: "screen", status: "running", lastText: prompt, updatedAt: Date.now() };
  let thumbAt = 0;
  const gate = new ComputerGate(APPROVAL_MODE, async (summary, sensitive) => {
    upsert(r, { status: "waiting" });
    const first = APPROVAL_MODE === "task" && !sensitive ? `TASK: ${clip(prompt, 80)}\nFIRST: ` : "";
    const d = await askWearer(agentId, name, sensitive ? "COMPUTER (SENSITIVE)" : "COMPUTER", `${sensitive ? `${sensitive.toUpperCase()}\n` : ""}${first}${summary}`, abort.signal);
    upsert(r, { status: "running" });
    return { ok: d.decision === "allow", message: d.message };
  });
  const session = new ComputerSession({
    input: new MacInput(),
    gate,
    thumbnails: THUMBNAILS,
    progress: (t) => upsert(r, { lastText: t, status: "running" }),
    onShot: (shot) => {
      // The glasses take ~1.5 s per tile; never send more often than that.
      if (!shot.thumb || !ws || Date.now() - thumbAt < 1500) return;
      thumbAt = Date.now();
      send(ws, { t: "agent_screen", agentId, w: 288, h: 144, px: shot.thumb });
    },
  });
  const q = query({ prompt: box.gen(), options: computerOptions(session, abort) });
  const r: Running = {
    agent,
    push: box.push,
    stop: () => {
      gate.stopped = true;
      q.interrupt().catch(() => {});
      abort.abort();
    },
  };
  running.set(agentId, r);
  upsert(r, {});
  watchKillSwitch();
  box.push(prompt);
  try {
    for await (const msg of q) {
      if (msg.type === "assistant" && !msg.parent_tool_use_id) {
        const text = msg.message.content.flatMap((b: any) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
        if (text) upsert(r, { lastText: text, status: "running" });
      } else if (msg.type === "result") {
        const out = msg.subtype === "success" ? msg.result : `Ended: ${msg.subtype}`;
        upsert(r, { status: msg.subtype === "success" ? "idle" : "error", lastText: out || r.agent.lastText });
      }
    }
    upsert(r, { status: "done" });
  } catch (e: any) {
    upsert(r, { status: gate.stopped ? "done" : "error", lastText: gate.stopped ? "Stopped." : `Error: ${e.message}` });
  } finally {
    box.close();
    running.delete(agentId);
  }
}

/** While computer agents run, the kill switch file stops them within a second. */
let killWatch: NodeJS.Timeout | null = null;
function watchKillSwitch() {
  killWatch ??= setInterval(() => {
    const computers = [...running.values()].filter((r) => r.agent.kind === "computer");
    if (!computers.length) {
      clearInterval(killWatch!);
      killWatch = null;
    } else if (existsSync(KILL_FILE)) {
      for (const r of computers) {
        r.stop();
        upsert(r, { status: "done", lastText: "Kill switch: stopped." });
      }
      void refreshCapabilities();
    }
  }, 1000);
}

/** A Codex agent (see codex.ts): same lifecycle and status updates as the Claude ones. */
function startCodex(agentId: string, cwd: string, prompt: string, name: string) {
  const agent: Agent = { id: agentId, nodeId: NODE_ID, name, kind: "codex", cwd, status: "running", lastText: prompt, updatedAt: Date.now() };
  const codex = new CodexAgent(cwd.replace(/^~/, homedir()), BYPASS, {
    text: (t) => upsert(r, { lastText: t, status: "running" }),
    activity: (t) => upsert(r, { lastText: t, status: "running" }),
    done: (last) => upsert(r, { status: "idle", lastText: last || r.agent.lastText }),
    error: (msg) => upsert(r, { status: "error", lastText: msg }),
  });
  const r: Running = {
    agent,
    push: (text) => codex.send(text),
    stop: () => {
      codex.stop();
      upsert(r, { status: "done", lastText: "Stopped." });
      running.delete(agentId);
    },
  };
  running.set(agentId, r);
  upsert(r, {});
  codex.send(prompt);
}

function onHub(m: HubMsg) {
  switch (m.t) {
    case "agent_start":
      try {
        if (m.engine === "computer") {
          if (!computerReady) throw new Error("Computer use is off or not ready on this computer.");
          void startComputer(m.agentId, m.prompt, m.name);
          break;
        }
        const engine = m.engine ?? "claude";
        const available = readiness.find((r) => r.engine === engine);
        if (!available?.ready) throw new Error(available?.detail || "That agent is not ready on this computer.");
        const cwd = projectDirectory(m.cwd, DEFAULT_CWD);
        if (engine === "codex") startCodex(m.agentId, cwd, m.prompt, m.name);
        else void startAgent(m.agentId, cwd, m.prompt, m.name);
      } catch (e: any) {
        if (ws) send(ws, { t: "agent_upsert", agent: { id: m.agentId, nodeId: NODE_ID, name: m.name, kind: m.engine === "codex" ? "codex" : m.engine === "computer" ? "computer" : "sdk", cwd: m.cwd, status: "error", lastText: `Could not start: ${e.message}`, updatedAt: Date.now() } });
      }
      break;
    case "agent_send": {
      const r = running.get(m.agentId);
      if (r) {
        r.push(m.text);
        upsert(r, { status: "running", lastText: `> ${m.text}` });
      }
      break;
    }
    case "agent_stop": {
      const r = running.get(m.agentId);
      r?.stop();
      break;
    }
    case "approval_result":
      waiting.get(m.id)?.({ decision: m.decision, message: m.message });
      break;
    case "error":
      console.error("hub:", m.text);
      break;
  }
}

function connect() {
  if (shuttingDown) return;
  const sock = new WebSocket(HUB);
  sock.on("open", async () => {
    const capabilities = await nodeCapabilities();
    if (shuttingDown || sock.readyState !== WebSocket.OPEN) return;
    ws = sock;
    capabilitySignature = JSON.stringify(capabilities);
    send(sock, { t: "hello", role: "node", token: TOKEN, nodeId: NODE_ID, name: NAME, defaultCwd: DEFAULT_CWD, ...capabilities });
    for (const r of running.values()) send(sock, { t: "agent_upsert", agent: r.agent });
    console.log(`connected to ${HUB} as "${NAME}"`);
  });
  sock.on("message", (d) => {
    try {
      onHub(JSON.parse(String(d)));
    } catch {}
  });
  sock.on("close", (code) => {
    if (ws === sock) ws = null;
    // Pending approvals can't be answered without the hub; deny rather than hang.
    for (const resolve of waiting.values()) resolve({ decision: "deny", message: "Lost connection to hub." });
    // A wrong or revoked token won't start working by itself: say so, and retry slowly.
    if (code === 4001 || code === 4003) console.error(`hub refused this computer (${code === 4003 ? "revoked" : "bad token"}); pair it again with scripts/join-worker.sh`);
    if (!shuttingDown) setTimeout(connect, code === 4001 || code === 4003 ? 60_000 : 2000);
  });
  sock.on("error", () => {});
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  shuttingDown = true;
  clearInterval(capabilityRefresh);
  for (const r of running.values()) r.stop();
  for (const resolve of waiting.values()) resolve({ decision: "deny", message: "Device is shutting down." });
  ws?.close();
  setTimeout(() => process.exit(0), 1500).unref();
});

connect();

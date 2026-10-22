import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  type Agent,
  type AgentEngine,
  type AppDef,
  type Approval,
  type Decision,
  type HubMsg,
  type HubState,
  type NodeInfo,
  type NodeCapabilities,
  type Role,
  type TaskEngine,
  clip,
  send,
} from "../shared/protocol.js";

interface Client {
  ws: WebSocket;
  role: Role;
  nodeId?: string;
  /** Signed in with this paired worker's token (src/hub/workers.ts) rather than the hub's own. */
  workerId?: string;
  /** Glasses: the agent open in Agents mode (its computer-use thumbnails go only there). */
  watch?: string;
}

/** At most one computer-use thumbnail per agent this often (a 288x144 tile takes ~1.5 s to reach the lens). */
export const SCREEN_INTERVAL_MS = 1500;

interface Pending {
  approval: Approval;
  detail: string;
  /** Set for approvals raised by a Claude Code hook (HTTP long-poll). */
  resolveHook?: (d: { decision: Decision; message?: string } | null) => void;
  /** Set for approvals raised by a device daemon. */
  nodeId?: string;
  timer?: NodeJS.Timeout;
  /** Only a person (a tap on the glasses or the phone) may answer it, never the voice router (Gmail send, new events). */
  humanOnly?: boolean;
}

/** All orchestrator state lives here. Everything is in memory; agents re-register on reconnect. */
export class Hub {
  clients = new Set<Client>();
  agents = new Map<string, Agent>();
  nodes = new Map<string, NodeInfo>();
  pending = new Map<string, Pending>();
  voice = { listening: false, lastHeard: "", lastReply: "" };
  /** Set by server.ts; lets the voice router reach notes, the copilot and friends. */
  jarvis?: import("./jarvis.js").Jarvis;
  /** Set by server.ts: computers paired with their own tokens. */
  workers?: import("./workers.js").WorkerRegistry;
  /** Latest computer-use thumbnail per agent, in memory only (never logged or saved). */
  screens = new Map<string, { px: string; at: number; sentAt: number; timer?: NodeJS.Timeout }>();

  constructor(public apps: AppDef[]) {}

  snapshot(): HubState {
    const byRecent = <T extends { updatedAt?: number; createdAt?: number }>(a: T, b: T) =>
      (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0);
    return {
      agents: [...this.agents.values()].sort(byRecent),
      approvals: [...this.pending.values()].map((p) => p.approval).sort((a, b) => a.createdAt - b.createdAt),
      nodes: [...this.nodes.values()],
      workers: this.workers?.list((id) => this.nodes.get(id)?.online === true),
      apps: this.apps.map((a) => ({ name: a.name, description: a.description })),
      voice: this.voice,
    };
  }

  /** Coalesce bursts of changes (streaming agent output) into one broadcast per tick. */
  private broadcastQueued = false;
  changed() {
    if (this.broadcastQueued) return;
    this.broadcastQueued = true;
    setTimeout(() => {
      this.broadcastQueued = false;
      const msg: HubMsg = { t: "state", state: this.snapshot() };
      for (const c of this.clients) if (c.role !== "node") send(c.ws, msg);
    }, 50);
  }

  toUIs(msg: HubMsg) {
    for (const c of this.clients) if (c.role !== "node") send(c.ws, msg);
  }

  toNode(nodeId: string, msg: HubMsg): boolean {
    for (const c of this.clients)
      if (c.role === "node" && c.nodeId === nodeId) {
        send(c.ws, msg);
        return true;
      }
    return false;
  }

  // ---------- agents ----------

  updateNodeCapabilities(nodeId: string, capabilities: NodeCapabilities) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    Object.assign(node, capabilities);
    this.changed();
  }

  upsertAgent(a: Agent) {
    this.agents.set(a.id, { ...a, lastText: clip(a.lastText, 4000), updatedAt: Date.now() });
    this.changed();
  }

  patchAgent(id: string, patch: Partial<Agent>) {
    const a = this.agents.get(id);
    if (!a) return;
    Object.assign(a, patch, { updatedAt: Date.now() });
    if (patch.lastText !== undefined) a.lastText = clip(patch.lastText, 4000);
    this.changed();
  }

  removeAgent(id: string) {
    this.agents.delete(id);
    clearTimeout(this.screens.get(id)?.timer);
    this.screens.delete(id);
    this.changed();
  }

  /** Resolve a spoken or typed agent reference ("the alien music one", "agent 2", an id) to an agent. */
  findAgent(ref: string): Agent | undefined {
    const agents = this.snapshot().agents;
    const r = ref.trim().toLowerCase();
    const n = Number(r.replace(/^agent\s*/, ""));
    if (Number.isInteger(n) && n >= 1 && n <= agents.length) return agents[n - 1];
    return (
      agents.find((a) => a.id === ref) ??
      agents.find((a) => a.name.toLowerCase() === r) ??
      agents.find((a) => a.name.toLowerCase().includes(r) || a.cwd.toLowerCase().includes(r))
    );
  }

  startAgent(nodeId: string, prompt: string, cwd?: string, name?: string, engine: AgentEngine = "claude"): Agent | string {
    const node = this.nodes.get(nodeId) ?? [...this.nodes.values()].find((n) => n.name.toLowerCase() === nodeId.toLowerCase());
    if (!node || !node.online) return `Device "${nodeId}" is not connected.`;
    if (engine !== "claude" && engine !== "codex") return "Choose Claude Code or Codex.";
    if (!(node.engines ?? ["claude"]).includes(engine)) return node.engineIssues?.[engine] || `${engine === "codex" ? "Codex" : "Claude Code"} isn't ready on ${node.name}.`;
    if (!prompt.trim()) return "Describe the task first.";
    const dir = cwd || node.defaultCwd;
    const agent: Agent = {
      id: randomUUID().slice(0, 8),
      nodeId: node.id,
      name: name || dir.split("/").filter(Boolean).pop() || "agent",
      kind: engine === "codex" ? "codex" : "sdk",
      cwd: dir,
      status: "starting",
      lastText: prompt,
      updatedAt: Date.now(),
    };
    if (!this.toNode(node.id, { t: "agent_start", agentId: agent.id, cwd: dir, prompt, name: agent.name, engine })) return `Device "${node.name}" is not connected.`;
    this.upsertAgent(agent);
    return agent;
  }

  // ---------- computer use ----------

  /** Online devices that can drive their own screen. */
  computerNodes(): NodeInfo[] {
    return [...this.nodes.values()].filter((n) => n.online && n.capabilities?.includes("computer"));
  }

  /** "On the home computer, …": a computer-use agent on a device with the capability (the only one, or the named one). */
  startComputerAgent(device: string | undefined, prompt: string, name?: string): Agent | string {
    const ref = device?.trim().toLowerCase().replace(/^(?:the|my)\s+/, "") || "";
    const all = [...this.nodes.values()];
    const able = this.computerNodes();
    const named = ref && !/^(home|other|remote)?\s*(computer|mac|machine)$/.test(ref)
      ? all.find((n) => n.id.toLowerCase() === ref || n.name.toLowerCase() === ref) ?? all.find((n) => n.name.toLowerCase().includes(ref))
      : undefined;
    const node = named ?? (able.length === 1 ? able[0] : able.find((n) => /home/i.test(n.name)) ?? able[0]);
    if (!node) {
      const issue = all.map((n) => n.capabilityIssues?.computer && `${n.name}: ${n.capabilityIssues.computer}`).find(Boolean);
      return issue || "No computer with computer use is online. Turn it on with G2_COMPUTER_USE=1 on that computer.";
    }
    if (!node.online) return `${node.name} is offline.`;
    if (!node.capabilities?.includes("computer")) return node.capabilityIssues?.computer || `Computer use is off on ${node.name}.`;
    if (!prompt.trim()) return "Describe the task first.";
    const agent: Agent = { id: randomUUID().slice(0, 8), nodeId: node.id, name: name || "computer", kind: "computer", cwd: "screen", status: "starting", lastText: prompt, updatedAt: Date.now() };
    const engine: TaskEngine = "computer";
    if (!this.toNode(node.id, { t: "agent_start", agentId: agent.id, cwd: "", prompt, name: agent.name, engine })) return `${node.name} is not connected.`;
    this.upsertAgent(agent);
    return agent;
  }

  /** Hard stop ("stop the computer", the ring): every computer-use agent, and their pending approvals denied. */
  stopComputerAgents(): number {
    let n = 0;
    for (const a of this.agents.values()) {
      if (a.kind !== "computer" || a.status === "done" || a.status === "error") continue;
      for (const [id, p] of this.pending) if (p.approval.agentId === a.id) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (p.nodeId) this.toNode(p.nodeId, { t: "approval_result", id, decision: "deny", message: "Stopped by the wearer." });
      }
      if (this.toNode(a.nodeId, { t: "agent_stop", agentId: a.id })) n++;
    }
    this.changed();
    return n;
  }

  /** A computer-use thumbnail from a daemon: kept (latest only) and sent to glasses watching that agent, throttled. */
  setScreen(agentId: string, px: string) {
    const prev = this.screens.get(agentId);
    const s = { px, at: Date.now(), sentAt: prev?.sentAt ?? 0, timer: prev?.timer };
    this.screens.set(agentId, s);
    // Nobody looking: keep it for when someone opens the agent. A pending trailing send picks up this newer one.
    if (s.timer || ![...this.clients].some((c) => c.role === "glasses" && c.watch === agentId)) return;
    const wait = s.sentAt + SCREEN_INTERVAL_MS - Date.now();
    if (wait <= 0) this.pushScreen(agentId);
    else s.timer = setTimeout(() => this.pushScreen(agentId), wait);
  }

  /** Glasses opened (or left) an agent in Agents mode. */
  watch(client: Client, agentId?: string) {
    client.watch = agentId;
    const s = agentId ? this.screens.get(agentId) : undefined;
    if (s) send(client.ws, { t: "agent_screen", agentId: agentId!, w: 288, h: 144, px: s.px, at: s.at });
  }

  private pushScreen(agentId: string) {
    const s = this.screens.get(agentId);
    if (!s) return;
    s.timer = undefined;
    s.sentAt = Date.now();
    for (const c of this.clients) if (c.role === "glasses" && c.watch === agentId) send(c.ws, { t: "agent_screen", agentId, w: 288, h: 144, px: s.px, at: s.at });
  }

  messageAgent(agent: Agent, text: string): string | null {
    if (agent.kind === "claude-code") return `${agent.name} is an interactive terminal session; answer it there or via its approvals.`;
    if (!this.toNode(agent.nodeId, { t: "agent_send", agentId: agent.id, text })) return "Its device is offline.";
    this.patchAgent(agent.id, { status: "running" });
    return null;
  }

  stopAgent(agent: Agent): string | null {
    if (agent.kind === "claude-code") return `${agent.name} is a terminal session; stop it there.`;
    if (!this.toNode(agent.nodeId, { t: "agent_stop", agentId: agent.id })) return "Its device is offline.";
    return null;
  }

  // ---------- approvals ----------

  addApproval(p: Pending, timeoutMs: number) {
    this.pending.set(p.approval.id, p);
    this.patchAgent(p.approval.agentId, { status: "waiting" });
    p.timer = setTimeout(() => this.expire(p.approval.id), timeoutMs);
    this.changed();
  }

  /** `by`: who answered; humanOnly approvals only take an answer from the glasses or the phone. */
  resolve(id: string, decision: Decision, message?: string, by?: Role | "router"): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (p.humanOnly && by !== "glasses" && by !== "phone") return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (p.resolveHook) p.resolveHook({ decision, message });
    if (p.nodeId) this.toNode(p.nodeId, { t: "approval_result", id, decision, message });
    this.patchAgent(p.approval.agentId, { status: "running" });
    this.changed();
    return true;
  }

  /** Hook approvals fall back to the terminal prompt on timeout; SDK approvals are denied. */
  private expire(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.resolveHook) p.resolveHook(null);
    if (p.nodeId) this.toNode(p.nodeId, { t: "approval_result", id, decision: "deny", message: "Timed out waiting for approval." });
    this.changed();
  }

  /** Approvals are cancelled when the daemon that raised them disconnects. */
  dropNode(nodeId: string) {
    const node = this.nodes.get(nodeId);
    if (node) node.online = false;
    for (const [id, p] of this.pending) if (p.nodeId === nodeId) {
      clearTimeout(p.timer);
      this.pending.delete(id);
    }
    for (const a of this.agents.values()) if (a.nodeId === nodeId && (a.kind === "sdk" || a.kind === "codex" || a.kind === "computer")) a.status = "error";
    this.changed();
  }
}

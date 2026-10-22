import { choices, setModel } from "./models.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { type Agent, type ClientMsg, type Role, clip, send, summarizeTool } from "../shared/protocol.js";
import { loadApps } from "./apps.js";
import { Hub } from "./hub.js";
import { Jarvis } from "./jarvis.js";
import { route } from "./router.js";
import { stripWakeName, toolLabel } from "../shared/assistant.js";
import { type Clip, captionThrottle, startClip, stopSpeech, warmUpSpeech } from "./listen.js";
import { googleApi, googleRoute, watchMeetings } from "./google/index.js";
import { startMessages } from "./messages/index.js";
import { weather } from "./weather/service.js";
import { WorkerRegistry, handlePair, helloAuth, workersApi } from "./workers.js";

const PORT = Number(process.env.HUB_PORT || 8787);
const TOKEN = process.env.HUB_TOKEN || "";
const ROOT = resolve(import.meta.dirname, "../..");
const SDK_APPROVAL_TIMEOUT = Number(process.env.APPROVAL_TIMEOUT_S || 600) * 1000;
const HOOK_APPROVAL_TIMEOUT = Number(process.env.HOOK_APPROVAL_TIMEOUT_S || 120) * 1000;

if (!TOKEN) console.warn("⚠ HUB_TOKEN is empty: anyone who can reach this port can control your agents. Set it in .env.");

const hub = new Hub(await loadApps(join(ROOT, "apps.json")));
const jarvis = new Jarvis(hub);
hub.jarvis = jarvis;
// Other computers pair with a one-time code and get their own revocable token (scripts/join-worker.sh).
const workers = new WorkerRegistry();
hub.workers = workers;
/** A node id a worker can't pair as: one already used by a device on the hub's own token. */
const takenByHubToken = (id: string) => [...hub.clients].some((c) => c.role === "node" && c.nodeId === id && !c.workerId);
/** What a device daemon may send. A worker token is for running agents only, never for answering approvals or voice. */
const NODE_MSGS = new Set<ClientMsg["t"]>(["node_capabilities", "agent_upsert", "agent_remove", "approval_request", "agent_screen"]);
// Texts on the glasses: watches the Mac's Messages database (needs Full Disk Access; see the log).
const messages = startMessages(hub);
// Before a Google Calendar meeting, the copilot knows who's in it.
watchMeetings((text) => (jarvis.copilot.context = text));
weather.start(() => jarvis.nav.pos); // the weather map opens without waiting on Open-Meteo

const tokenOk = (t: unknown) => {
  if (!TOKEN) return true;
  const a = Buffer.from(String(t ?? "")), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

// ---------------- voice ----------------

async function handleUtterance(text: string, context = "") {
  text = text.trim();
  if (!text) return;
  hub.voice.lastHeard = text;
  hub.changed();
  // "Hey Bocchi, …" / "Jarvis, …": her name only addresses her (just the name still goes through).
  const command = stripWakeName(text) || text;
  // Hard stop for computer use, without waiting on the router.
  if (/^(?:please\s+)?(?:stop|halt|kill|abort|freeze|pause)\s+(?:the\s+|my\s+)?(?:home\s+|other\s+)?(?:computer|mac)\b/i.test(command)) {
    const n = hub.stopComputerAgents();
    const reply = n ? `Stopped the computer${n > 1 ? ` (${n} tasks)` : ""}.` : "Nothing is running on the computer.";
    hub.voice.lastReply = reply;
    hub.toUIs({ t: "voice_reply", heard: text, reply });
    hub.changed();
    return;
  }
  // While tools run, the glasses show her working face and what she's doing.
  const onTool = (name: string) => hub.toUIs({ t: "voice_working", heard: text, tool: toolLabel(name) });
  const reply = await route(hub, context + command, { onTool }).catch((e) => `Error: ${clip(String(e?.message ?? e), 120)}`);
  hub.voice.lastReply = reply;
  hub.toUIs({ t: "voice_reply", heard: text, reply });
  hub.changed();
}

// ---------------- WebSocket ----------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const from = req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "?";
  let role: Role | null = null;
  let nodeId: string | undefined;
  /** Push-to-talk in progress: transcribed as it is recorded. */
  let ptt: { clip: Clip; feed: ReturnType<typeof captionThrottle>; source: "ptt" | "note"; at: number; id?: number } | null = null;
  let voiceAgent: string | undefined;
  const client = { ws, role: "phone" as Role, nodeId: undefined as string | undefined, workerId: undefined as string | undefined, watch: undefined as string | undefined };

  ws.on("message", async (data, isBinary) => {
    if (isBinary) {
      if (role === "glasses" || role === "phone") {
        if (jarvis.owns(ws)) jarvis.audio(data as Buffer);
        else ptt?.clip.write(data as Buffer);
      }
      return;
    }
    let m: ClientMsg;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!role) {
      // A paired worker's own token works for a device daemon only, and only as the node it paired as.
      const auth = m.t === "hello" ? helloAuth(m, tokenOk, workers) : { ok: false as const };
      const worker = auth.ok ? auth.worker : undefined;
      if (m.t !== "hello" || !auth.ok) {
        send(ws, { t: "error", text: "bad token" });
        return ws.close(4001, "unauthorized");
      }
      role = m.role;
      client.role = role;
      if (role === "node") {
        nodeId = worker ? worker.nodeId : m.nodeId || randomUUID().slice(0, 8);
        client.nodeId = nodeId;
        client.workerId = worker?.id;
        // One live connection per worker: a reconnect replaces the old socket.
        if (worker) for (const c of hub.clients) if (c.workerId === worker.id) c.ws.close(4000, "replaced");
        if (worker) workers.seen(worker.id, m.os);
        hub.nodes.set(nodeId, { id: nodeId, name: worker?.name || m.name || nodeId, online: true, defaultCwd: m.defaultCwd || "~", engines: m.engines ?? ["claude"], projects: m.projects ?? [], engineIssues: m.engineIssues ?? {}, permissionMode: m.permissionMode ?? "approvals",
          os: m.os, capabilities: m.capabilities ?? [], capabilityIssues: m.capabilityIssues ?? {}, computerApproval: m.computerApproval, workerId: worker?.id });
      }
      hub.clients.add(client);
      console.log(`[ws] ${role}${nodeId ? ` ${nodeId}` : ""} connected from ${from}`);
      send(ws, { t: "welcome", role });
      if (role !== "node") {
        send(ws, { t: "state", state: hub.snapshot() });
        jarvis.greet(ws);
        jarvis.greetNav(ws, role === "glasses");
      }
      hub.changed();
      return;
    }

    if (role === "node" && !NODE_MSGS.has(m.t)) return;
    switch (m.t) {
      case "node_capabilities":
        if (role === "node" && nodeId) hub.updateNodeCapabilities(nodeId, { engines: m.engines, projects: m.projects, engineIssues: m.engineIssues, permissionMode: m.permissionMode, os: m.os, capabilities: m.capabilities, capabilityIssues: m.capabilityIssues, computerApproval: m.computerApproval });
        break;
      case "agent_watch":
        if (role === "glasses") hub.watch(client, typeof m.agentId === "string" ? m.agentId : undefined);
        break;
      case "approve":
        hub.resolve(m.id, m.decision, m.message, role);
        break;
      case "voice_text":
        await handleUtterance(m.text);
        break;
      case "voice_context":
        voiceAgent = m.agentId;
        break;
      case "audio_start": {
        ptt?.feed.stop();
        ptt?.clip.cancel();
        voiceAgent = undefined;
        const source = m.purpose === "note" ? "note" : "ptt";
        const id = m.clip;
        // Live words to this screen only, at most one per 120 ms (the newest wins).
        const feed = captionThrottle(120, (text, stable) => send(ws, { t: "caption", text, stable, final: false, source, at: Date.now(), clip: id }));
        ptt = { clip: startClip(m.sampleRate || 16000, "en-US", feed), feed, source, at: Date.now(), id };
        hub.voice.listening = true;
        hub.changed();
        break;
      }
      case "audio_cancel":
        if (ptt && (m.clip === undefined || m.clip === ptt.id)) {
          ptt.feed.stop();
          ptt.clip.cancel();
          ptt = null;
          hub.voice.listening = false;
          hub.changed();
        }
        break;
      case "audio_end": {
        const p = ptt;
        ptt = null;
        // Taken now: the next audio_start may come while this one is still being transcribed.
        const agentId = voiceAgent;
        hub.voice.listening = false;
        hub.changed();
        // The words as heard, before the reply (the glasses show them while Jarvis thinks). Always
        // sent, empty when nothing came back, so the lens never waits on a clip that is over.
        let captioned = false;
        const final = (text: string) => {
          if (captioned) return;
          captioned = true;
          p?.feed.stop();
          send(ws, { t: "caption", text, stable: text.length, final: true, source: p?.source ?? "ptt", at: Date.now(), clip: p?.id ?? m.clip });
        };
        try {
          const released = Date.now();
          const text = p ? (await p.clip.finish()).trim() : "";
          final(text);
          if (p) console.log(`[ptt] ${((released - p.at) / 1000).toFixed(1)} s held, text ${Date.now() - released} ms after release`);
          const a = agentId ? hub.agents.get(agentId) : undefined;
          if (!text) send(ws, { t: "toast", text: "Didn't catch that." });
          else if (p?.source === "note") {
            jarvis.addNote(text);
            send(ws, { t: "toast", text: "Note saved" });
          } else await handleUtterance(text, a ? `(Looking at agent ${a.name}, id=${a.id}) ` : "");
        } catch (e: any) {
          final("");
          send(ws, { t: "toast", text: `Speech-to-text failed: ${clip(e.message, 100)}` });
        }
        break;
      }
      // ---- Jarvis ----
      case "listen_start":
        console.log(`[listen] ${role} from ${from}: start ${m.purpose} lang=${m.lang ?? "-"} target=${m.target ?? "-"}`);
        try {
          await jarvis.start(ws, m.purpose, m.sampleRate || 16000, m.lang, m.target, m.translate);
        } catch (e: any) {
          send(ws, { t: "toast", text: `Listening failed: ${clip(e.message, 100)}` });
        }
        break;
      case "listen_stop":
        console.log(`[listen] ${role} from ${from}: stop`);
        if (jarvis.owns(ws)) await jarvis.stop();
        break;
      case "translate_options":
        jarvis.setTranslateOptions(m.options);
        break;
      case "heard":
        jarvis.heard(m.text);
        break;
      case "speaker":
        if (jarvis.owns(ws)) jarvis.speaker(m.role);
        break;
      case "copilot_ask":
        jarvis.copilot.ask(m.question);
        break;
      case "note_add":
        jarvis.addNote(m.text);
        break;
      case "note_delete":
        jarvis.deleteNote(m.id);
        break;
      case "script_set":
        jarvis.setScript(m.script);
        break;
      case "location":
        jarvis.nav.moved({ lat: m.lat, lon: m.lon, accuracy: m.accuracy });
        break;
      case "nav_start":
        send(ws, { t: "toast", text: await jarvis.nav.start(m.query, m.profile).catch((e) => `Navigation failed: ${e.message}`) });
        break;
      case "messages_get":
      case "messages_focus":
      case "messages_dnd":
      case "messages_seen":
        messages.onClient(ws, m);
        break;
      case "nav_stop":
        jarvis.nav.stop();
        break;
      case "wx_get":
        void weather.handle((msg) => send(ws, msg), m.layer, m.step, jarvis.nav.pos, m.view);
        break;
      case "nav_view":
        jarvis.nav.setView(m.view);
        break;
      case "nav_zoom":
        jarvis.nav.zoomBy(m.dir === "out" ? "out" : "in");
        break;
      // ---- mini-apps & Studio ----
      case "miniapps_get":
        send(ws, { t: "miniapps", apps: jarvis.studio.list() });
        break;
      case "studio_make": {
        const r = jarvis.studio.make(m.prompt, m.id, m.model);
        if ("error" in r) send(ws, { t: "toast", text: r.error });
        break;
      }
      case "studio_models_get":
        send(ws, { t: "studio_models", ...jarvis.studio.modelOptions() });
        break;
      case "studio_delete":
        jarvis.studio.delete(m.id);
        break;
      case "miniapp_open": {
        const a = jarvis.studio.list().find((x) => x.id === m.id);
        if (a) hub.toUIs({ t: "open", mode: "apps", app: a.id });
        else send(ws, { t: "toast", text: "No such app." });
        break;
      }
      case "models_set":
        if (["assistant", "copilot"].includes(m.role) && ["haiku", "sonnet", "opus"].includes(m.model)) setModel(m.role, m.model);
        hub.toUIs({ t: "models", ...choices() });
        break;
      case "models_get":
        send(ws, { t: "models", ...choices() });
        break;
      case "screen_set":
        hub.toUIs({ t: "screen", on: !!m.on });
        break;
      case "listen_text":
        if (!jarvis.listening) send(ws, { t: "toast", text: "Not listening: open Translate or Copilot first." });
        else jarvis.heard(String(m.text ?? "").slice(0, 1000));
        break;
      case "glasses_log":
        console.log(`[glasses ${from}] ${clip(String(m.text), 500)}`);
        break;
      case "app_error":
        jarvis.studio.crashed(m.id, m.version, m.error);
        break;
      case "app_ask":
        void jarvis.appAsk(ws, m.reqId, m.prompt);
        break;
      case "app_fetch":
        void jarvis.appFetch(ws, m.reqId, m.url);
        break;
      case "dashboard_get":
        await jarvis.dashboard(ws);
        break;
      case "agent_start": {
        const r = m.engine === "computer" ? hub.startComputerAgent(m.nodeId, m.prompt, m.name) : hub.startAgent(m.nodeId, m.prompt, m.cwd, m.name, m.engine);
        if (typeof r === "string") send(ws, { t: "toast", text: r });
        break;
      }
      case "agent_send": {
        const a = hub.agents.get(m.agentId);
        const err = a ? hub.messageAgent(a, m.text) : "No such agent.";
        if (err) send(ws, { t: "toast", text: err });
        break;
      }
      case "agent_stop": {
        const a = hub.agents.get(m.agentId);
        const err = a ? hub.stopAgent(a) : "No such agent.";
        if (err) send(ws, { t: "toast", text: err });
        break;
      }
      // ---- from device daemons ----
      case "agent_upsert":
        if (role === "node") hub.upsertAgent({ ...m.agent, nodeId: nodeId! });
        break;
      case "agent_remove":
        if (role === "node") hub.removeAgent(m.agentId);
        break;
      case "approval_request":
        if (role === "node") hub.addApproval({ approval: { ...m.approval, nodeId: nodeId! }, detail: m.detail, nodeId, humanOnly: m.humanOnly === true }, SDK_APPROVAL_TIMEOUT);
        break;
      case "agent_screen": {
        // Only for that device's own computer-use agents; never logged or stored on disk.
        const a = hub.agents.get(m.agentId);
        if (role === "node" && a && a.nodeId === nodeId && a.kind === "computer" && typeof m.px === "string" && m.px.length <= 30_000) hub.setScreen(a.id, m.px);
        break;
      }
    }
  });

  ws.on("close", (code) => {
    if (role) console.log(`[ws] ${role} from ${from} closed (${code})`);
    hub.clients.delete(client);
    ptt?.feed.stop();
    ptt?.clip.cancel();
    if (jarvis.owns(ws)) jarvis.stop();
    // A replaced worker socket must not mark the node that just reconnected as offline.
    if (nodeId && ![...hub.clients].some((c) => c.role === "node" && c.nodeId === nodeId)) hub.dropNode(nodeId);
    hub.changed();
  });
});

// ---------------- Claude Code hooks (HTTP) ----------------
// hooks/cc-hook.mjs forwards hook payloads here. Each terminal session shows up as an agent.

function hookAgent(body: any, status: Agent["status"], lastText?: string) {
  const id = `cc-${String(body.session_id).slice(0, 8)}`;
  const nodeId = body.__host || hostname();
  if (!hub.nodes.has(nodeId)) hub.nodes.set(nodeId, { id: nodeId, name: nodeId, online: true, defaultCwd: body.cwd || "~" });
  const prev = hub.agents.get(id);
  const agent: Agent = {
    id,
    nodeId,
    name: prev?.name || String(body.cwd || "claude").split("/").filter(Boolean).pop() || "claude",
    kind: "claude-code",
    cwd: body.cwd || prev?.cwd || "",
    status,
    lastText: lastText ?? prev?.lastText ?? "",
    updatedAt: Date.now(),
  };
  hub.upsertAgent(agent);
  return agent;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

async function handleHook(req: IncomingMessage, res: ServerResponse, kind: string) {
  const body = await readJson(req);
  switch (body.hook_event_name ?? kind) {
    case "PermissionRequest": {
      const agent = hookAgent(body, "waiting");
      const id = randomUUID().slice(0, 8);
      const summary = summarizeTool(body.tool_name, body.tool_input);
      const decision = await new Promise<{ decision: "allow" | "deny"; message?: string } | null>((resolveHook) => {
        hub.addApproval(
          { approval: { id, agentId: agent.id, agentName: agent.name, nodeId: agent.nodeId, tool: body.tool_name, summary: clip(summary, 500), createdAt: Date.now() }, detail: JSON.stringify(body.tool_input), resolveHook },
          HOOK_APPROVAL_TIMEOUT,
        );
        // If the hook process dies (user answered in the terminal, Ctrl-C), drop the card.
        res.on("close", () => {
          if (!res.writableEnded && hub.pending.has(id)) {
            hub.pending.delete(id);
            hub.changed();
          }
        });
      });
      return json(res, 200, decision ?? {}); // {} = no opinion: Claude Code shows its normal prompt
    }
    case "UserPromptSubmit":
      hookAgent(body, "running", `> ${body.prompt ?? ""}`);
      break;
    case "Notification":
      hookAgent(body, "waiting", body.message ?? "Needs your attention");
      break;
    case "Stop":
      hookAgent(body, "idle", body.last_assistant_message ?? undefined);
      break;
    case "SessionEnd":
      hub.removeAgent(`cc-${String(body.session_id).slice(0, 8)}`);
      break;
    default:
      hookAgent(body, "running");
  }
  json(res, 200, {});
}

// ---------------- static files ----------------

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(res: ServerResponse, dir: string, rel: string) {
  const file = normalize(join(dir, rel || "index.html"));
  if (!file.startsWith(dir)) return json(res, 403, { error: "forbidden" });
  try {
    const s = await stat(file);
    const path = s.isDirectory() ? join(file, "index.html") : file;
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(await readFile(path));
  } catch {
    json(res, 404, { error: "not found" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    // A worker trades its one-time pairing code for its own token; this needs no hub token.
    if (url.pathname === "/api/pair") return await handlePair(req, res, workers, takenByHubToken);
    if (url.pathname.startsWith("/api/")) {
      if (!tokenOk(req.headers["x-hub-token"] ?? url.searchParams.get("token"))) return json(res, 401, { error: "unauthorized" });
      if (url.pathname.startsWith("/api/workers") && (await workersApi(req, res, url, workers, {
        port: PORT,
        online: (id) => hub.nodes.get(id)?.online === true,
        changed: () => hub.changed(),
        onRevoke: (w) => {
          for (const c of hub.clients) if (c.workerId === w.id) c.ws.close(4003, "revoked");
          // Gone from the device list too (unless the hub's own token runs a node by that id).
          if (hub.nodes.get(w.nodeId)?.workerId === w.id) hub.nodes.delete(w.nodeId);
        },
      }))) return;
      if (req.method === "POST" && url.pathname.startsWith("/api/hook/")) return await handleHook(req, res, url.pathname.slice(10));
      if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, hub.snapshot());
      if (url.pathname.startsWith("/api/google/") && (await googleApi(req, res, url))) return;
      if (req.method === "POST" && url.pathname === "/api/voice") {
        const { text } = await readJson(req);
        await handleUtterance(String(text ?? ""));
        return json(res, 200, { reply: hub.voice.lastReply });
      }
      return json(res, 404, { error: "not found" });
    }
    if (await googleRoute(req, res, url, tokenOk)) return;
    if (url.pathname.startsWith("/glasses")) return await serveStatic(res, join(ROOT, "glasses/dist"), url.pathname.slice(9));
    // Mini-app code for the glasses (loaded with import(), so token in the query and CORS open).
    // ?v=N asks for that published version; app.js itself may be mid-edit by Studio.
    const mini = url.pathname.match(/^\/miniapps\/([a-z0-9-]+)\/app\.js$/);
    if (mini) {
      if (!tokenOk(url.searchParams.get("token"))) return json(res, 401, { error: "unauthorized" });
      const file = jarvis.studio.published(mini[1], Number(url.searchParams.get("v")) || undefined);
      if (!file) return json(res, 404, { error: "no such app" }); // (or its first build is still running)
      try {
        const code = await readFile(file);
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
        return res.end(code);
      } catch {
        return json(res, 404, { error: "no such app" });
      }
    }
    // Glasses apps built under apps/<name>/dist, e.g. /apps/platformer/
    const app = url.pathname.match(/^\/apps\/([a-z0-9-]+)(?:\/(.*))?$/);
    if (app) {
      if (app[2] === undefined) return res.writeHead(301, { Location: `/apps/${app[1]}/${url.search}` }).end();
      return await serveStatic(res, join(ROOT, "apps", app[1], "dist"), app[2]);
    }
    return await serveStatic(res, join(ROOT, "phone"), url.pathname.slice(1));
  } catch (e: any) {
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// The warm Claude sessions are child processes; close them so Ctrl-C actually exits.
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    jarvis.copilot.close();
    Promise.allSettled([jarvis.stop(), stopSpeech()]).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });

warmUpSpeech().catch((e) => console.warn(`speech warm-up: ${e?.message ?? e}`));

server.listen(PORT, () => {
  console.log(`G2 hub on http://0.0.0.0:${PORT}`);
  console.log(`  phone UI:   http://<this-machine>:${PORT}/?token=…`);
  console.log(`  apps loaded: ${hub.apps.map((a) => a.name).join(", ") || "none (add apps.json)"}`);
});

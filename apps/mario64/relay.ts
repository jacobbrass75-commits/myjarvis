// Minimal relay for the prototype (the orchestrator hub does not know these message types yet;
// docs/mario64.md describes the hub change). Roles: source (game page, Mac), sink (glasses page,
// Even App WebView), pad (phone controller).
//
//   M64_PORT=8790 M64_TOKEN=secret npx tsx relay.ts
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { M64Msg, M64Role } from "./src/wire";

const PORT = Number(process.env.M64_PORT ?? 8790);
const TOKEN = process.env.M64_TOKEN ?? "";
if (!TOKEN) console.warn("[relay] M64_TOKEN not set: anyone on your network can connect.");

const peers: Record<M64Role, Set<WebSocket>> = { source: new Set(), sink: new Set(), pad: new Set() };
const counts = () => ({ source: peers.source.size, sink: peers.sink.size, pad: peers.pad.size });
const sendJson = (ws: WebSocket, m: M64Msg) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const broadcastPeers = () => {
  for (const set of Object.values(peers)) for (const ws of set) sendJson(ws, { t: "peers", peers: counts() });
};
const tokenOk = (t: unknown) => {
  if (!TOKEN) return true;
  const a = Buffer.from(String(t ?? ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

const http = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`g2 mario64 relay\n${JSON.stringify(counts())}\n`);
});
const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 1 << 20 });

wss.on("connection", (ws) => {
  let role: M64Role | null = null;
  ws.on("message", (data, isBinary) => {
    if (!role) {
      if (isBinary) return ws.close(1008, "hello first");
      let m: M64Msg;
      try {
        m = JSON.parse(String(data));
      } catch {
        return ws.close(1008, "bad json");
      }
      if (m.t !== "hello" || !(m.role in peers) || !tokenOk(m.token)) return ws.close(1008, "unauthorized");
      role = m.role;
      peers[role].add(ws);
      sendJson(ws, { t: "welcome", role, peers: counts() });
      broadcastPeers();
      console.log(`[relay] +${role} ${JSON.stringify(counts())}`);
      return;
    }
    if (isBinary) {
      // Tiles: source -> sinks only.
      if (role === "source") for (const s of peers.sink) s.readyState === 1 && s.send(data, { binary: true });
      return;
    }
    const text = String(data);
    if (role === "pad") {
      const m = JSON.parse(text) as M64Msg;
      if (m.t === "ping") return sendJson(ws, { t: "pong", id: m.id, sentAt: m.sentAt });
      for (const s of peers.source) s.readyState === 1 && s.send(text);
    } else if (role === "sink") {
      for (const s of peers.source) s.readyState === 1 && s.send(text);
    } else {
      // source -> sinks (layout) and pads (pad_echo)
      for (const s of peers.sink) s.readyState === 1 && s.send(text);
      for (const s of peers.pad) s.readyState === 1 && s.send(text);
    }
  });
  ws.on("close", () => {
    if (!role) return;
    peers[role].delete(ws);
    broadcastPeers();
    console.log(`[relay] -${role} ${JSON.stringify(counts())}`);
  });
});

http.listen(PORT, "0.0.0.0", () => console.log(`[relay] ws://0.0.0.0:${PORT}/ws`));

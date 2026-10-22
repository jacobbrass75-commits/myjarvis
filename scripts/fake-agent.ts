import WebSocket from "ws";
import { send, type HubMsg } from "../src/shared/protocol.js";

// A pretend device with one agent that keeps asking for approval. Exercises the glasses,
// ring and phone UI end to end without running Claude.

const HUB = (process.env.G2_HUB_URL || "http://127.0.0.1:8787").replace(/^http/, "ws") + "/ws";
const TOKEN = process.env.G2_HUB_TOKEN || process.env.HUB_TOKEN || "";
const ws = new WebSocket(HUB);
const agent = { id: "fake1", nodeId: "fake-box", name: "demo-agent", kind: "sdk" as const, cwd: "~/demo", status: "running" as const, lastText: "Refactoring the payment module…", updatedAt: Date.now() };
const commands = ["npm test", "git push origin feature/pay", "rm -rf build/"];
let n = 0;

function ask() {
  const command = commands[n++ % commands.length];
  send(ws, {
    t: "approval_request",
    approval: { id: `fa${n}`, agentId: agent.id, agentName: agent.name, nodeId: "fake-box", tool: "Bash", summary: command, createdAt: Date.now() },
    detail: JSON.stringify({ command }),
  });
  console.log(`asked: ${command}`);
}

ws.on("open", () => {
  send(ws, { t: "hello", role: "node", token: TOKEN, nodeId: "fake-box", name: "fake-box", defaultCwd: "~/demo" });
  send(ws, { t: "agent_upsert", agent });
  ask();
});
ws.on("message", (d) => {
  const m = JSON.parse(String(d)) as HubMsg;
  if (m.t === "approval_result") {
    console.log(`→ ${m.decision}`);
    send(ws, { t: "agent_upsert", agent: { ...agent, status: "running", lastText: `Last approval: ${m.decision}` } });
    setTimeout(ask, 4000);
  } else if (m.t === "agent_send") console.log(`message: ${m.text}`);
  else if (m.t === "error") console.error(m.text);
});

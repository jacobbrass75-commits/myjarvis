import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { HubMsg } from "../src/shared/protocol.js";

// End-to-end check of the Jarvis features without glasses or audio: starts its own hub on a spare
// port with a throwaway data folder (your real notes and logs are untouched), feeds typed "heard"
// lines and prints what comes back (copilot cards, translations, notes, dashboard).
// Needs your Claude Code login (run from your own terminal).
//   npm run jarvis-test

const PORT = 8799;
const TOKEN = "jarvis-test";
const dataDir = mkdtempSync(join(tmpdir(), "jarvis-test-"));
const hub = spawn(process.execPath, ["--import", "tsx", "src/hub/server.ts"], {
  env: { ...process.env, HUB_PORT: String(PORT), HUB_TOKEN: TOKEN, G2_DATA_DIR: dataDir, G2_CALENDAR: "0" },
  stdio: "ignore",
});
const cleanup = () => {
  hub.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
};
process.on("exit", cleanup);
await new Promise((r) => setTimeout(r, 2500));
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const sendj = (m: object) => ws.send(JSON.stringify(m));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = <T extends HubMsg["t"]>(t: T, ms: number) =>
  new Promise<Extract<HubMsg, { t: T }> | null>((resolve) => {
    const timer = setTimeout(() => (ws.off("message", on), resolve(null)), ms);
    const on = (d: WebSocket.RawData) => {
      const m = JSON.parse(String(d)) as HubMsg;
      if (m.t === t) {
        clearTimeout(timer);
        ws.off("message", on);
        resolve(m as any);
      }
    };
    ws.on("message", on);
  });

const conversation = [
  "So we're finally doing the Japan trip in April, two weeks, Tokyo then Kyoto.",
  "Nice, cherry blossom season, it's going to be packed though.",
  "Yeah, I heard you can see the Great Wall of China from space on the flight over, which is wild.",
  "Ha. We're thinking of getting the JR pass, but someone said the price went up a lot.",
  "And I really want to try a proper kaiseki dinner in Kyoto but I don't even know what that involves.",
];

ws.on("open", async () => {
  sendj({ t: "hello", role: "phone", token: TOKEN });
  await sleep(300);

  console.log("— copilot —");
  const t0 = Date.now();
  for (const line of conversation) {
    sendj({ t: "heard", text: line });
    await sleep(400);
  }
  sendj({ t: "copilot_ask" });
  const c = await waitFor("copilot", 120_000);
  console.log(c ? JSON.stringify(c.update, null, 2) : "no copilot update within 120 s", `(${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  console.log("— translate —");
  sendj({ t: "listen_start", purpose: "translate", sampleRate: 16000, lang: "es-ES", target: "en" });
  await sleep(500);
  for (const line of ["¿Dónde está la estación de tren más cercana?", "I need two tickets to Kyoto, please."]) {
    const t1 = Date.now();
    sendj({ t: "heard", text: line });
    const tr = await waitFor("translation", 60_000);
    console.log(tr ? `${line}  →  [${tr.to}] ${tr.text}  (${((Date.now() - t1) / 1000).toFixed(1)} s)` : `no translation for: ${line}`);
  }
  sendj({ t: "listen_stop" });

  console.log("— notes —");
  sendj({ t: "note_add", text: "jarvis-test note: book kaiseki in Kyoto" });
  const n = await waitFor("notes", 5000);
  console.log(n ? `${n.notes.length} notes, newest: ${n.notes[0]?.text}` : "no notes reply");
  const added = n?.notes.find((x) => x.text.startsWith("jarvis-test note"));
  if (added) sendj({ t: "note_delete", id: added.id });

  console.log("— dashboard —");
  sendj({ t: "dashboard_get" });
  const d = await waitFor("dashboard", 20_000);
  console.log(d ? JSON.stringify(d.dashboard, null, 2) : "no dashboard");
  ws.close();
  process.exit(0);
});
ws.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});

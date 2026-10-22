// Pair other computers with the hub (src/hub/workers.ts).
//
// On the hub (talks to the running hub on this machine; the hub token never leaves it):
//   npm run worker:pair                 a one-time pairing code (10 minutes) and the command to run
//   npm run worker:pair -- list         paired computers
//   npm run worker:pair -- revoke <id>  revoke one (its token stops working at once)
//
// On the new computer (scripts/join-worker.sh runs this; the code comes from G2_PAIR_CODE or a prompt):
//   node --import tsx scripts/worker-pair.ts join --hub http://100.x.y.z:8787 [--name home-mac] [--computer]
//   It trades the code for this computer's own token and writes it to .env (mode 600). The token is
//   never printed.
//   node --import tsx scripts/worker-pair.ts computer on|off   switch computer use in this computer's .env

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
/** This computer's .env (G2_ENV_FILE for tests). */
const ENV_FILE = process.env.G2_ENV_FILE || join(ROOT, ".env");
const [cmd = "code", ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name: string) => rest.includes(`--${name}`);

/** Set KEY=value lines in a .env, keeping every other line as it is. */
export function mergeEnv(text: string, values: Record<string, string>): string {
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  const left = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (key && left.has(key)) {
      const v = left.get(key)!;
      left.delete(key);
      return `${key}=${v}`;
    }
    return line;
  });
  for (const [k, v] of left) out.push(`${k}=${v}`);
  return out.join("\n") + "\n";
}

async function hubApi(path: string, method = "GET") {
  const port = process.env.HUB_PORT || 8787;
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "x-hub-token": process.env.HUB_TOKEN || "" } }).catch(() => {
    throw new Error(`The hub isn't answering on port ${port}. Is it running? (scripts/autostart.sh status)`);
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function osLabel() {
  try { return `macOS ${execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${process.arch})`; }
  catch { return `${process.platform} (${process.arch})`; }
}

async function join_() {
  const hub = (flag("hub") || process.env.G2_HUB_URL || "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(hub)) throw new Error("Give the hub address: --hub http://<hub tailscale ip>:8787");
  const name = (flag("name") || process.env.G2_NODE_NAME || hostname().replace(/\.local$/, "")).trim();
  let code = process.env.G2_PAIR_CODE || "";
  if (!code) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    code = await rl.question("Pairing code from the phone page (Devices > Pair a computer) or `npm run worker:pair` on the hub: ");
    rl.close();
  }
  const r = await fetch(`${hub}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim(), name, nodeId: name, os: osLabel() }),
  }).catch((e) => {
    throw new Error(`Can't reach the hub at ${hub} (${e.cause?.code ?? e.message}). Is Tailscale connected on both computers?`);
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || typeof j.token !== "string") throw new Error(j.error || `Pairing failed (HTTP ${r.status}).`);
  const file = ENV_FILE;
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const values: Record<string, string> = { G2_HUB_URL: hub, G2_HUB_TOKEN: j.token, G2_NODE_NAME: j.name, G2_NODE_ID: j.nodeId };
  if (has("computer")) values.G2_COMPUTER_USE = "1";
  writeFileSync(file, mergeEnv(before, values), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`Paired as "${j.name}" (node ${j.nodeId}, worker ${j.workerId}). Saved this computer's token in ${file} (only you can read it).`);
}

async function main() {
  switch (cmd) {
    case "code": {
      const j = await hubApi("/api/workers/code", "POST");
      const mins = Math.round((j.expiresAt - Date.now()) / 60000);
      console.log(`Pairing code: ${j.code}  (one use, expires in ${mins} min)\n\nOn the new computer, in its g2-orchestrator folder:\n  ${j.command}\n\nAdd --computer to switch on computer use there.`);
      break;
    }
    case "list": {
      const { workers } = await hubApi("/api/workers");
      if (!workers.length) console.log("No paired computers.");
      for (const w of workers) console.log(`${w.id}  ${w.name}  node=${w.nodeId}  ${w.online ? "online" : "offline"}  ${w.os ?? ""}  paired ${new Date(w.createdAt).toLocaleString()}${w.lastSeen ? `  last seen ${new Date(w.lastSeen).toLocaleString()}` : ""}`);
      break;
    }
    case "revoke": {
      if (!rest[0]) throw new Error("Which one? npm run worker:pair -- revoke <id or node>");
      await hubApi(`/api/workers/${encodeURIComponent(rest[0])}/revoke`, "POST");
      console.log(`Revoked ${rest[0]}. Its token no longer works; it is disconnected now.`);
      break;
    }
    case "join":
      await join_();
      break;
    case "computer": {
      // On a worker: switch computer use on or off in its .env (the daemon needs a restart).
      const on = rest[0] !== "off";
      const file = ENV_FILE;
      writeFileSync(file, mergeEnv(existsSync(file) ? readFileSync(file, "utf8") : "", { G2_COMPUTER_USE: on ? "1" : "0" }), { mode: 0o600 });
      chmodSync(file, 0o600);
      console.log(`Computer use ${on ? "on" : "off"} in ${file}. Restart the daemon: launchctl kickstart -k gui/$(id -u)/com.g2.node`);
      break;
    }
    default:
      throw new Error(`Unknown command ${cmd}: code | list | revoke <id> | join --hub URL | computer on|off`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

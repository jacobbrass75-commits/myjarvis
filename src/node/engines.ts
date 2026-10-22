import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentEngine } from "../shared/protocol.js";
import { codexBin } from "./codex.js";

export interface EngineReadiness {
  engine: AgentEngine;
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  detail: string;
}

function claudeBin(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const bin = join(dir, "claude");
    try { accessSync(bin, constants.X_OK); return bin; } catch {}
  }
  return null;
}

/** Local status checks only. Never return raw account or credential output. */
function probe(bin: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(bin, args, { timeout: 8000, maxBuffer: 64 * 1024, env: process.env }, (error, stdout, stderr) =>
    resolve({ ok: !error, stdout, stderr })));
}

export async function getEngineReadiness(): Promise<EngineReadiness[]> {
  return Promise.all((["claude", "codex"] as const).map(async (engine): Promise<EngineReadiness> => {
    const bin = engine === "claude" ? claudeBin() : codexBin();
    if (!bin) return { engine, installed: false, authenticated: false, ready: false, detail: `${engine === "claude" ? "Claude Code" : "Codex"} CLI is not installed or executable.` };
    const result = await probe(bin, engine === "claude" ? ["auth", "status", "--json"] : ["login", "status"]);
    let authenticated = false;
    if (engine === "claude") {
      try { authenticated = result.ok && JSON.parse(result.stdout).loggedIn === true; } catch {}
    } else authenticated = result.ok && /logged in/i.test(result.stdout + result.stderr) && !/not logged in/i.test(result.stdout + result.stderr);
    return { engine, installed: true, authenticated, ready: authenticated,
      detail: authenticated ? "Signed in." : `Sign in to ${engine === "claude" ? "Claude Code" : "Codex"} on this computer.` };
  }));
}

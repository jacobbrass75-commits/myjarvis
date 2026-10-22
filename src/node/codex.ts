import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Exec has no per-tool approval callback. Keep its workspace sandbox by default; the node's
// explicit G2_BYPASS_PERMISSIONS option retains its existing meaning.
function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** Resolve an explicit override, then PATH, then a desktop app's bundled CLI. */
export function codexBin(): string | null {
  const path = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (process.env.CODEX_BIN) {
    const override = process.env.CODEX_BIN.replace(/^~(?=\/|$)/, homedir());
    if (override.includes("/")) return executable(override) ? override : null;
    return path.map((dir) => join(dir, override)).find(executable) ?? null;
  }
  const candidates = [
    ...path.map((dir) => join(dir, "codex")),
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  ];
  return candidates.find(executable) ?? null;
}

export interface CodexEvents {
  text(t: string): void;
  activity(t: string): void;
  done(lastMessage: string): void;
  error(msg: string): void;
}

export class CodexAgent {
  private thread: string | null = null;
  private proc: ChildProcess | null = null;
  private queue: string[] = [];
  private stopped = false;

  constructor(private cwd: string, private bypass: boolean, private on: CodexEvents) {}

  send(prompt: string) {
    if (this.stopped || !prompt.trim()) return;
    this.queue.push(prompt);
    if (!this.proc) this.next();
  }

  stop() {
    this.stopped = true;
    this.queue = [];
    const p = this.proc;
    if (!p) return;
    p.kill("SIGINT");
    const force = setTimeout(() => { if (this.proc === p) p.kill("SIGKILL"); }, 2000);
    force.unref();
    p.once("close", () => clearTimeout(force));
  }

  private next() {
    if (this.stopped) return;
    const prompt = this.queue.shift();
    if (prompt === undefined) return;
    const bin = codexBin();
    if (!bin) {
      this.queue = [];
      return this.on.error("Codex not found: install the Codex app or CLI, or set CODEX_BIN to an executable.");
    }
    const cwd = this.cwd.replace(/^~(?=\/|$)/, homedir());
    // Exec's sandbox option belongs before resume; resume does not accept -s itself.
    // Stdin prevents leading dashes from becoming flags and keeps task text out of argv.
    const args = ["exec", ...(this.bypass ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "workspace-write"]), "--json", "--skip-git-repo-check",
      ...(this.thread ? ["resume", this.thread, "-"] : ["--cd", cwd, "-"])];
    let p: ChildProcess;
    try {
      p = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, G2_HOOK_DISABLE: "1" } });
    } catch (e: any) {
      this.queue = [];
      return this.on.error(`Could not start Codex: ${e?.message ?? e}`);
    }
    this.proc = p;
    let buf = "", stderr = "", last = "";
    let failed = false;
    const fail = (message: string) => {
      if (failed || this.stopped) return;
      failed = true;
      this.on.error(message);
    };
    const event = (line: string) => {
      if (this.stopped || this.proc !== p) return;
      let e: any;
      try { e = JSON.parse(line); } catch { return; }
      if (e.type === "thread.started" && e.thread_id) this.thread = e.thread_id;
      const item = e.item;
      if (e.type === "item.completed" && item) {
        if (item.type === "agent_message" && item.text) {
          last = item.text;
          this.on.text(item.text);
        } else if (item.type === "command_execution") this.on.activity(`$ ${String(item.command ?? "").slice(0, 200)}`);
        else if (item.type === "file_change") this.on.activity(`edited ${(item.changes ?? []).map((c: any) => c.path).join(", ").slice(0, 200)}`);
      } else if (e.type === "item.started" && item?.type === "command_execution") this.on.activity(`$ ${String(item.command ?? "").slice(0, 200)}`);
      else if (e.type === "turn.failed" || e.type === "error") fail(String(e.error?.message ?? e.message ?? "Codex error"));
    };
    p.stdout!.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        event(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    p.stderr!.on("data", (d) => { stderr = (stderr + String(d)).slice(-2000); });
    p.on("error", (err) => fail(`Could not start Codex: ${err.message}`));
    p.stdin!.on("error", () => {}); // EPIPE when startup fails before reading the prompt.
    p.stdin!.end(prompt);
    p.on("close", (code, signal) => {
      if (buf.trim()) event(buf);
      if (this.proc !== p) return;
      this.proc = null;
      if (this.stopped) return;
      if (code !== 0) fail(`Codex exited (${code ?? signal ?? "unknown"}): ${stderr.trim().split("\n").pop() || "No error detail."}`);
      if (!failed) this.on.done(last);
      this.next();
    });
  }
}

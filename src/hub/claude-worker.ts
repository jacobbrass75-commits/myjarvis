import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A long-lived Claude Code session (your Claude Code login, no API key) that answers one prompt at
// a time. Spawning a fresh session costs a second or two, which is too slow for live translation
// and the conversation copilot, so each feature keeps one of these warm and feeds it messages.

export interface WorkerOptions {
  name: string;
  system: string;
  /** Built-in tools this worker may use, e.g. ["WebSearch", "WebFetch"]. Default: none. */
  tools?: string[];
  /** In-process MCP servers (e.g. the hub's own tools); their tools are allowed automatically. */
  mcpServers?: Options["mcpServers"];
  model?: string;
  effort?: "low" | "medium" | "high";
  /** Start a fresh session after this many turns so context stays small. */
  maxTurns?: number;
}

/** Per-prompt callbacks while its turn runs. */
export interface AskHooks {
  /** The model called a tool (its name, e.g. "WebSearch" or "mcp__hub__start_agent"). */
  onTool?(name: string): void;
}

type Pending = { prompt: string; hooks?: AskHooks; resolve: (s: string) => void; reject: (e: Error) => void };

export class ClaudeWorker {
  private queue: Pending[] = [];
  private busy = false;
  private turns = 0;
  private session: { push: (s: string) => void; close: () => void; next: (hooks?: AskHooks) => Promise<string> } | null = null;

  constructor(private opts: WorkerOptions) {}

  /** Queue a prompt; resolves with the assistant's final text for that turn. */
  ask(prompt: string, hooks?: AskHooks): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, hooks, resolve, reject });
      this.pump();
    });
  }

  /** Drop queued prompts (e.g. stale copilot analyses) without touching the one in flight. */
  clearQueue() {
    for (const p of this.queue.splice(0)) p.reject(new Error("superseded"));
  }

  get pending() {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  close() {
    this.session?.close();
    this.session = null;
  }

  /** Switch models: the next prompt starts a new session on it (one in flight finishes on the old one). */
  setModel(model: string | undefined) {
    if (this.opts.model === model) return;
    this.opts.model = model;
    if (!this.busy) this.close();
  }

  private async pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const job = this.queue.shift()!;
    try {
      if (!this.session || this.turns >= (this.opts.maxTurns ?? 30)) {
        this.close();
        this.session = this.start();
        this.turns = 0;
      }
      this.turns++;
      this.session.push(job.prompt);
      job.resolve(await this.session.next(job.hooks));
    } catch (e: any) {
      this.close(); // a broken session is restarted on the next ask
      job.reject(e instanceof Error ? e : new Error(String(e)));
    } finally {
      this.busy = false;
      this.pump();
    }
  }

  private start() {
    const inbox: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    async function* prompts(): AsyncGenerator<SDKUserMessage> {
      while (!closed) {
        if (!inbox.length) await new Promise<void>((r) => (wake = r));
        while (inbox.length) yield { type: "user", message: { role: "user", content: inbox.shift()! }, parent_tool_use_id: null };
      }
    }
    const cwd = join(homedir(), ".g2-orchestrator", "workers", this.opts.name);
    mkdirSync(cwd, { recursive: true });
    const abort = new AbortController();
    const options: Options = {
      cwd,
      abortController: abort,
      systemPrompt: this.opts.system,
      tools: this.opts.tools ?? [],
      mcpServers: this.opts.mcpServers,
      allowedTools: [...(this.opts.tools ?? []), ...Object.keys(this.opts.mcpServers ?? {}).map((n) => `mcp__${n}`)],
      permissionMode: "dontAsk",
      settingSources: [], // keep the user's CLAUDE.md and hooks out of these helpers
      model: this.opts.model,
      effort: this.opts.effort ?? "low",
      persistSession: false,
      env: { ...process.env, G2_HOOK_DISABLE: "1" } as Record<string, string>,
    };
    const iter = query({ prompt: prompts(), options })[Symbol.asyncIterator]();
    return {
      push(s: string) {
        inbox.push(s);
        wake?.();
      },
      close() {
        closed = true;
        wake?.();
        abort.abort();
      },
      /** Read messages until this turn's result. */
      async next(hooks?: AskHooks): Promise<string> {
        for (;;) {
          const { value, done } = await iter.next();
          if (done) throw new Error("Claude session ended");
          if (value.type === "assistant" && hooks?.onTool)
            for (const b of value.message.content) if (b.type === "tool_use") hooks.onTool(b.name);
          if (value.type === "result") {
            if (value.subtype !== "success") throw new Error(`Claude: ${value.subtype}`);
            return value.result;
          }
        }
      },
    };
  }
}

/** Pull the first JSON object out of a model reply (tolerates code fences and stray prose). */
export function parseJsonReply<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

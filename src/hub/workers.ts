import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import type { WorkerInfo } from "../shared/protocol.js";

// Other computers join the hub as workers (scripts/join-worker.sh). The phone page or
// `npm run worker:pair` makes a short-lived one-time pairing code; the worker trades it for its own
// long-lived token, which only that worker keeps. The hub stores a SHA-256 of each token (never the
// token), can revoke one at any time, and the master HUB_TOKEN never leaves the hub.

export const PAIR_CODE_TTL_MS = Number(process.env.G2_PAIR_CODE_TTL_S || 600) * 1000;
/** No ambiguous characters (0/O, 1/I/L): codes are read off a phone and typed on another computer. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_CODES = 5;
/** Wrong codes before /api/pair refuses everyone for a while (8 random characters are 31^8 guesses). */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 5 * 60_000;

interface WorkerRecord {
  id: string;
  name: string;
  nodeId: string;
  os?: string;
  /** sha256 hex of the worker's token. */
  tokenHash: string;
  createdAt: number;
  lastSeen?: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** "abcd efgh" / "ABCD-EFGH" -> "ABCDEFGH". */
const normalizeCode = (code: string) => String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const cleanName = (s: unknown, fallback: string) => String(s ?? "").replace(/[^\w .-]/g, "").trim().slice(0, 60) || fallback;
const cleanId = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export class WorkerRegistry {
  private workers: WorkerRecord[] = [];
  /** Pairing codes live in memory only (a hub restart voids them): hash -> expiry. */
  private codes = new Map<string, number>();
  private failures: number[] = [];

  constructor(
    private file = process.env.G2_WORKERS_FILE || join(homedir(), ".g2-orchestrator", "workers.json"),
    private now: () => number = Date.now,
  ) {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(data.workers)) this.workers = data.workers.filter((w: any) => w && typeof w.tokenHash === "string" && typeof w.nodeId === "string");
    } catch (e: any) {
      if (e.code !== "ENOENT") console.warn(`[workers] ${this.file} could not be read; no paired workers.`);
    }
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ workers: this.workers }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** A new one-time code, shown as ABCD-EFGH. */
  createCode(ttlMs = PAIR_CODE_TTL_MS): { code: string; expiresAt: number } {
    const now = this.now();
    for (const [h, exp] of this.codes) if (exp <= now) this.codes.delete(h);
    // Only a handful outstanding: the oldest goes first.
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value!);
    let raw = "";
    for (let i = 0; i < 8; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
    const expiresAt = now + ttlMs;
    this.codes.set(sha256(raw), expiresAt);
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  /**
   * Trade a pairing code for a worker token (returned once, never stored here). The code is used up
   * either way it matches. Pairing the same node id again replaces (revokes) its old token.
   * `taken`: node ids already used by a device on the hub's own token (a worker can't take one).
   */
  redeem(code: string, who: { name?: string; nodeId?: string; os?: string }, taken: (nodeId: string) => boolean = () => false):
    { ok: true; workerId: string; nodeId: string; name: string; token: string } | { ok: false; status: number; error: string } {
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    if (this.failures.length >= MAX_FAILURES) return { ok: false, status: 429, error: "Too many wrong codes; wait a few minutes and make a new one." };
    const h = sha256(normalizeCode(code));
    const exp = this.codes.get(h);
    if (exp === undefined || exp <= now) {
      if (exp !== undefined) this.codes.delete(h);
      this.failures.push(now);
      return { ok: false, status: 401, error: exp === undefined ? "Unknown or used pairing code." : "That pairing code expired; make a new one." };
    }
    this.codes.delete(h); // one time only
    const name = cleanName(who.name, "worker");
    let nodeId = cleanId(who.nodeId) || cleanId(name) || `worker-${randomUUID().slice(0, 6)}`;
    const base = nodeId;
    for (let n = 2; taken(nodeId); n++) nodeId = `${base}-${n}`;
    this.workers = this.workers.filter((w) => w.nodeId !== nodeId);
    const token = `g2w_${randomBytes(32).toString("base64url")}`;
    const rec: WorkerRecord = { id: `w-${randomUUID().slice(0, 8)}`, name, nodeId, os: who.os ? String(who.os).slice(0, 60) : undefined, tokenHash: sha256(token), createdAt: now };
    this.workers.push(rec);
    this.save();
    return { ok: true, workerId: rec.id, nodeId, name, token };
  }

  /** The worker a token belongs to, or undefined (unknown or revoked). */
  verify(token: unknown): WorkerRecord | undefined {
    if (typeof token !== "string" || !token.startsWith("g2w_")) return undefined;
    const h = sha256(token);
    return this.workers.find((w) => sameHash(w.tokenHash, h));
  }

  /** Remember when a worker was last connected (saved, so the phone shows it after a restart). */
  seen(id: string, os?: string) {
    const w = this.workers.find((x) => x.id === id);
    if (!w) return;
    w.lastSeen = this.now();
    if (os) w.os = String(os).slice(0, 60);
    this.save();
  }

  revoke(id: string): WorkerRecord | undefined {
    const w = this.workers.find((x) => x.id === id || x.nodeId === id);
    if (!w) return undefined;
    this.workers = this.workers.filter((x) => x !== w);
    this.save();
    return w;
  }

  list(online: (nodeId: string) => boolean = () => false): WorkerInfo[] {
    return this.workers.map((w) => ({ id: w.id, name: w.name, nodeId: w.nodeId, os: w.os, createdAt: w.createdAt, lastSeen: w.lastSeen, online: online(w.nodeId) }));
  }
}

/**
 * Who a WebSocket hello is from: the hub token (any role), or a paired worker's token, which is
 * good for a device daemon only and only as the node it paired as (it can't pose as another one).
 */
export function helloAuth(m: { role: string; token: unknown }, tokenOk: (t: unknown) => boolean, reg: WorkerRegistry):
  { ok: false } | { ok: true; worker?: { id: string; nodeId: string; name: string } } {
  const worker = m.role === "node" ? reg.verify(m.token) : undefined;
  if (worker) return { ok: true, worker };
  // A worker token is never a hub token, even when HUB_TOKEN is empty (an open hub).
  if (typeof m.token === "string" && m.token.startsWith("g2w_")) return { ok: false };
  return tokenOk(m.token) ? { ok: true } : { ok: false };
}

/** This hub's address on the tailnet (Tailscale hands out 100.64.0.0/10), for the join command. */
export function tailnetAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [p, q] = a.address.split(".").map(Number);
      if (p === 100 && q >= 64 && q <= 127) return a.address;
    }
  return undefined;
}

export function hubUrlFor(req: IncomingMessage, port: number): string {
  if (process.env.G2_PUBLIC_HUB_URL) return process.env.G2_PUBLIC_HUB_URL.replace(/\/+$/, "");
  const ts = tailnetAddress();
  if (ts) return `http://${ts}:${port}`;
  return `http://${String(req.headers.host || `127.0.0.1:${port}`)}`;
}

const reply = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

/** A small JSON body (the pairing endpoint is reachable without the hub token). */
async function smallJson(req: IncomingMessage, limit = 4096): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** POST /api/pair {code, name, nodeId, os}: no hub token; the one-time code is the credential. */
export async function handlePair(req: IncomingMessage, res: ServerResponse, reg: WorkerRegistry, taken: (nodeId: string) => boolean) {
  if (req.method !== "POST") return reply(res, 405, { error: "POST a pairing code" });
  let body: any;
  try {
    body = await smallJson(req);
  } catch (e: any) {
    return reply(res, e.status ?? 400, { error: "bad request" });
  }
  const r = reg.redeem(String(body.code ?? ""), { name: body.name, nodeId: body.nodeId, os: body.os }, taken);
  if (!r.ok) return reply(res, r.status, { error: r.error });
  console.log(`[workers] paired ${r.name} as node ${r.nodeId} (${r.workerId})`);
  return reply(res, 200, { workerId: r.workerId, nodeId: r.nodeId, name: r.name, token: r.token });
}

export interface WorkersApiOptions {
  port: number;
  /** A worker was revoked: drop its connection now. */
  onRevoke(w: { id: string; nodeId: string; name: string }): void;
  online(nodeId: string): boolean;
  changed(): void;
}

/** Hub-token routes: POST /api/workers/code, GET /api/workers, POST /api/workers/<id>/revoke. */
export async function workersApi(req: IncomingMessage, res: ServerResponse, url: URL, registry: WorkerRegistry, opts: WorkersApiOptions): Promise<boolean> {
  if (req.method === "POST" && url.pathname === "/api/workers/code") {
    const { code, expiresAt } = registry.createCode();
    const hubUrl = hubUrlFor(req, opts.port);
    reply(res, 200, { code, expiresAt, hubUrl, command: `scripts/join-worker.sh --hub ${hubUrl} --code ${code}` });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/workers") {
    reply(res, 200, { workers: registry.list(opts.online) });
    return true;
  }
  const rev = url.pathname.match(/^\/api\/workers\/([\w-]+)\/revoke$/);
  if (req.method === "POST" && rev) {
    const w = registry.revoke(rev[1]);
    if (!w) reply(res, 404, { error: "No such worker." });
    else {
      console.log(`[workers] revoked ${w.name} (${w.id})`);
      opts.onRevoke(w);
      opts.changed();
      reply(res, 200, { ok: true, revoked: w.id });
    }
    return true;
  }
  return false;
}

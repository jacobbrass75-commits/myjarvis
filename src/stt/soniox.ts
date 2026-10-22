// Soniox cloud engine: real-time WebSocket speech-to-text (stt-rt-v5), very likely what Even's own
// Conversate/Translate use. Needs SONIOX_API_KEY (console.soniox.com, pay-as-you-go, about $0.12 per
// hour the stream is open). Unlike apple/whisper, the audio leaves the Mac.
//
// Final tokens arrive once and never change; non-final ones are replaced by every response. So a
// partial = this utterance's finals + the current non-finals, and a final is emitted on <end>
// (Soniox's semantic endpoint), <fin> (reply to a manual finalize) or at end of stream. Audio that
// isn't final yet is kept (bounded), so a dropped socket is reopened and the open utterance re-sent;
// long silences close the socket (Soniox bills open time) and speech reopens it.

import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { STTEvent } from "./types.js";

const DEFAULT_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
export const DEFAULT_SONIOX_MODEL = "stt-rt-v5";

/** Languages Soniox recognizes (soniox.com/docs/stt/concepts/supported-languages). */
export const SONIOX_LANGS =
  "af sq ar az eu be bn bs bg ca zh hr cs da nl en et fi fr gl de el gu he hi hu id it ja kn kk ko lv lt mk ms ml mr no fa pl pt pa ro ru sr sk sl es sw sv tl ta te th tr uk ur vi cy".split(
    " ",
  );

export function sonioxKey(): string {
  return process.env.SONIOX_API_KEY?.trim() || "";
}

function sonioxUrl(): string {
  if (process.env.SONIOX_WS_URL) return process.env.SONIOX_WS_URL;
  const region = process.env.SONIOX_REGION?.trim(); // eu | jp | in
  return region ? `wss://stt-rt.${region}.soniox.com/transcribe-websocket` : DEFAULT_URL;
}

// After a key or billing failure, "auto" stops picking Soniox for a while instead of failing (and
// toasting) on every session. A rejected key stays benched until the hub restarts with a new one.
let benchedUntil = 0;
let benchedWhy = "";

/** Key set, and not benched by a recent auth/billing failure. */
export function sonioxAvailable(): boolean {
  return !!sonioxKey() && Date.now() >= benchedUntil;
}

/** Why Soniox is benched, if it is. */
export function sonioxBenched(): string | null {
  return Date.now() < benchedUntil ? benchedWhy : null;
}

/** Tests, or after fixing the key/balance without a restart. */
export function clearSonioxBench() {
  benchedUntil = 0;
  benchedWhy = "";
}

/** BCP-47 "zh-CN" -> "zh". Soniox wants bare ISO 639-1 codes (a full tag ends the session). null = auto/unsupported. */
export function toSonioxLang(lang: string): string | null {
  if (!lang || lang === "auto") return null;
  const base = lang.toLowerCase().split(/[-_]/)[0];
  const code = base === "nb" || base === "nn" ? "no" : base === "fil" ? "tl" : base === "cmn" ? "zh" : base;
  return SONIOX_LANGS.includes(code) ? code : null;
}

export function sonioxSupports(lang: string): boolean {
  return !lang || lang === "auto" || toSonioxLang(lang) !== null;
}

/** language_hints: the expected language plus the others likely in the same audio (default: English). */
export function sonioxHints(lang: string, alsoLangs: string[] = ["en"]): string[] {
  return [...new Set([lang, ...alsoLangs].map(toSonioxLang).filter((x): x is string => !!x))];
}

/** Check the key without opening a stream (GET /v1/models). Benches Soniox if it is rejected. */
export async function sonioxCheckKey(): Promise<"ok" | string> {
  const key = sonioxKey();
  if (!key) return "SONIOX_API_KEY is not set";
  try {
    const r = await fetch("https://api.soniox.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (r.ok) return "ok";
    const j = (await r.json().catch(() => ({}))) as { error_type?: string; message?: string };
    const type = j.error_type ?? (r.status === 401 ? "unauthenticated" : undefined);
    const err = new SonioxError(describe(r.status, type, j.message), r.status, type);
    // Only a rejected key benches: a 403/402 from this REST call says nothing certain about real-time access.
    if (type === "unauthenticated") bench(err);
    return err.message;
  } catch (e: any) {
    return `Soniox unreachable (${e?.message ?? e})`;
  }
}

// Errors after which retrying the same request can't help (the docs' 400/401/402/403 rows).
const FATAL = new Set([
  "missing_key",
  "invalid_request",
  "model_not_available",
  "unauthenticated",
  "permission_denied",
  "temp_api_key_session_expired",
  "organization_balance_exhausted",
  "organization_monthly_budget_exhausted",
  "project_monthly_budget_exhausted",
]);

export class SonioxError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly type?: string,
  ) {
    super(message);
  }
  get fatal(): boolean {
    return FATAL.has(this.type ?? "");
  }
}

function describe(code: number | undefined, type: string | undefined, msg: string | undefined): string {
  const t = type ?? "error";
  if (t === "unauthenticated") return "Soniox rejected the API key: check SONIOX_API_KEY";
  if (t.endsWith("_exhausted")) return `Soniox: ${t.replace(/_/g, " ")}; add credit or raise the budget at console.soniox.com`;
  return `Soniox ${code ?? ""} ${t}${msg ? `: ${msg}` : ""}`.replace(/\s+/g, " ").trim();
}

/** A socket that closed without an error frame: HTTP-level rejection or a network drop. */
function dropped(lastError: string | undefined, code: number, reason: string): SonioxError {
  const http = Number(/Unexpected server response: (\d+)/.exec(lastError ?? "")?.[1]);
  if (http) {
    const type =
      http === 401 ? "unauthenticated"
      : http === 402 ? "organization_balance_exhausted"
      : http === 403 ? "permission_denied"
      : http === 429 ? "limit_exceeded"
      : http >= 500 ? "service_unavailable"
      : "invalid_request";
    return new SonioxError(describe(http, type, `HTTP ${http}`), http, type);
  }
  const why = lastError ? `failed (${lastError})` : `closed (${code}${reason ? ` ${reason}` : ""})`;
  return new SonioxError(`Soniox connection ${why}`, undefined, "network");
}

function bench(err: SonioxError) {
  if (!err.fatal || err.type === "missing_key") return;
  const auth = err.type === "unauthenticated" || err.type === "permission_denied";
  benchedUntil = auth ? Infinity : Date.now() + 10 * 60_000;
  benchedWhy = err.message;
}

export interface SonioxOptions {
  /** BCP-47 locale of the expected speech, or "auto". */
  lang: string;
  sampleRate?: number;
  /** Other languages likely in the same audio (language hints; default ["en"]). */
  alsoLangs?: string[];
  /** Speaker labels on finals, and a new final at every speaker change. */
  diarize?: boolean;
  /** Vocabulary hints (context.terms). Default: Claude, Codex + SONIOX_TERMS (comma-separated). */
  terms?: string[];
  apiKey?: string;
  url?: string;
  model?: string;
  /** Close the socket after this much audio with no speech; reopen on speech. 0 = never. Default SONIOX_IDLE_CLOSE_S or 120. */
  idleCloseSec?: number;
  /** Audio kept for re-sending after a drop (and replay into a fallback engine). Default 120 s. */
  maxPendingSec?: number;
  keepaliveMs?: number;
  /** No error frame this long after opening = the key and config were accepted. */
  confirmMs?: number;
  backoffMs?: number[];
  maxReconnects?: number;
  /** A socket that stayed up this long resets the reconnect count (a quick accept-then-fail doesn't). */
  stableMs?: number;
  rotateAfterMs?: number;
  closeTimeoutMs?: number;
}

interface Tok {
  text?: string;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  is_final?: boolean;
  speaker?: string | number;
  language?: string;
  translation_status?: string;
}

/** A token, timed in seconds from the start of the whole stream (across reconnects). */
interface Piece {
  text: string;
  start?: number;
  end?: number;
  conf?: number;
  speaker?: string;
  lang?: string;
}

interface Conn {
  ws: WebSocket;
  /** Stream byte offset of this socket's first audio byte (its token times are relative to it). */
  base: number;
  /** Stream byte offset up to which audio has been sent on this socket. */
  sentTo: number;
  state: "connecting" | "open" | "draining" | "closed";
  openedAt: number;
  confirmed: boolean;
  sentEnd: boolean;
  error?: SonioxError;
  lastError?: string;
  confirmTimer?: NodeJS.Timeout;
  drainTimer?: NodeJS.Timeout;
}

const join = (ps: Piece[]) =>
  ps
    .map((p) => p.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();

/** The value covering most of the text (per-token language/speaker tags are noisy; utterances aren't). */
function majority(ps: Piece[], key: (p: Piece) => string | undefined): string | undefined {
  const w = new Map<string, number>();
  for (const p of ps) {
    const k = key(p);
    if (k) w.set(k, (w.get(k) ?? 0) + Math.max(1, p.text.trim().length));
  }
  let best: string | undefined;
  for (const [k, n] of w) if (!best || n > w.get(best)!) best = k;
  return best;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export class SonioxStream extends EventEmitter {
  ready = false;
  private o: Required<Omit<SonioxOptions, "alsoLangs">> & { alsoLangs?: string[] };
  private bps: number; // bytes per second
  private idleBytes: number;
  private hints: string[];
  private conn: Conn | null = null;
  private pending: { pos: number; buf: Buffer }[] = []; // audio not final yet: sent, or waiting for a socket
  private pendingBytes = 0;
  private written = 0;
  private finals: Piece[] = []; // final tokens of the open utterance
  private live: Piece[] = []; // current non-final tokens
  private lastPartial = "";
  private attempts = 0;
  private retryTimer?: NodeJS.Timeout;
  private keepTimer?: NodeJS.Timeout;
  private closeTimer?: NodeJS.Timeout;
  private lastSent = 0;
  private lastWriteAt = Date.now();
  private awaitAudio = false; // reconnect deferred until audio arrives (nothing to re-send)
  private idle = false;
  private lastVoice = 0;
  private noise = 0.003;
  private warnedDrop = false;
  private closingRequested = false;
  private closePromise?: Promise<void>;
  private resolveClose?: () => void;
  private done = false;

  constructor(opts: SonioxOptions) {
    super();
    const env = (k: string) => (process.env[k] === undefined || process.env[k] === "" ? undefined : Number(process.env[k]));
    this.o = {
      sampleRate: 16000,
      diarize: false,
      terms: ["Claude", "Codex", ...(process.env.SONIOX_TERMS ?? "").split(",").map((s) => s.trim()).filter(Boolean)],
      apiKey: sonioxKey(),
      url: sonioxUrl(),
      model: process.env.SONIOX_MODEL || DEFAULT_SONIOX_MODEL,
      idleCloseSec: env("SONIOX_IDLE_CLOSE_S") ?? 120,
      maxPendingSec: 120,
      keepaliveMs: 8000,
      confirmMs: 1500,
      backoffMs: [250, 500, 1000, 2000, 4000, 8000],
      maxReconnects: 6,
      stableMs: 20_000,
      rotateAfterMs: 290 * 60_000, // streams end at 300 min (413 max_duration_reached)
      closeTimeoutMs: 10_000,
      ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
    } as SonioxStream["o"];
    this.bps = this.o.sampleRate * 2;
    this.idleBytes = Math.round(this.o.idleCloseSec * this.bps);
    this.hints = sonioxHints(this.o.lang, this.o.alsoLangs);
    this.on("error", () => {}); // reported to whoever listens; never an unhandled 'error' crash
    if (!this.o.apiKey) {
      setImmediate(() => this.fail(new SonioxError("SONIOX_API_KEY is not set (get a key at console.soniox.com)", 401, "missing_key")));
      return;
    }
    this.keepTimer = setInterval(() => {
      const c = this.conn;
      if (c?.state !== "open") return;
      // No audio arriving at all (phone asleep, mic off): the write() check never runs, but the open stream is billed.
      if (this.idleBytes && c.confirmed && Date.now() - this.lastWriteAt > this.o.idleCloseSec * 1000) {
        this.idle = true;
        this.emit("status", `soniox: no audio for ${this.o.idleCloseSec} s, closing the stream until there is speech`);
        return this.end(c);
      }
      if (Date.now() - this.lastSent >= this.o.keepaliveMs) this.tx(c, '{"type":"keepalive"}');
    }, Math.min(1000, this.o.keepaliveMs / 2));
    this.keepTimer.unref();
    this.connect();
  }

  write(pcm: Buffer) {
    if (this.done || this.closingRequested || !pcm.length) return;
    this.lastWriteAt = Date.now();
    const voiced = this.idleBytes > 0 && this.voiced(pcm);
    this.pending.push({ pos: this.written, buf: pcm });
    this.pendingBytes += pcm.length;
    this.written += pcm.length;
    if (voiced) this.lastVoice = this.written;
    if (this.idle) {
      if (!voiced) return this.cap(this.bps); // keep ~1 s before speech so the first word isn't clipped
      this.idle = false;
      this.emit("status", "soniox: speech again, reopening the stream");
      if (!this.conn) this.connect(); // else the socket still closing reconnects when it's done
      return;
    }
    this.cap(this.o.maxPendingSec * this.bps);
    if (this.awaitAudio) {
      this.awaitAudio = false;
      return this.connect();
    }
    const c = this.conn;
    if (c?.state !== "open") return; // connecting, reconnecting or draining: sent once a socket is open
    this.tx(c, pcm);
    c.sentTo = this.written;
    if (this.idleBytes && c.confirmed && this.written - this.lastVoice > this.idleBytes && !this.finals.length && !this.live.length) {
      this.idle = true;
      this.emit("status", `soniox: ${this.o.idleCloseSec} s without speech, closing the stream until there is`);
      this.end(c);
    }
  }

  /** Flushes: ends the stream, waits for the last finals (bounded), emits them. */
  close(): Promise<void> {
    this.closePromise ??= new Promise<void>((res) => {
      this.resolveClose = res;
      this.closingRequested = true;
      if (this.done) return res();
      const c = this.conn;
      if (c?.state === "open") this.end(c);
      else if (!c && !this.retryTimer) {
        if (this.idle || !this.pendingBytes) return this.finish();
        this.connect();
      } // connecting: ends on open; draining or reconnecting: ends when that settles
      // Unfinalized audio may be processed no faster than real time (a push-to-talk clip arrives all at once).
      const pendingSec = this.pendingBytes / this.bps;
      this.closeTimer = setTimeout(() => {
        this.emit("status", "soniox: no end-of-stream reply, keeping what arrived");
        this.finish(true);
      }, this.o.closeTimeoutMs + pendingSec * 1000);
    });
    return this.closePromise;
  }

  /** Audio Soniox hasn't finalized (what a fallback engine should replay) and where it starts (s). */
  pendingAudio(): { pcm: Buffer[]; start: number } {
    return { pcm: this.pending.map((p) => p.buf), start: r3((this.pending[0]?.pos ?? this.written) / this.bps) };
  }

  // ---------- socket ----------

  private connect() {
    if (this.done || !this.o.apiKey) return;
    const ws = new WebSocket(this.o.url, { headers: { Authorization: `Bearer ${this.o.apiKey}` }, handshakeTimeout: 5000 });
    const c: Conn = { ws, base: 0, sentTo: 0, state: "connecting", openedAt: 0, confirmed: false, sentEnd: false };
    this.conn = c;
    this.live = []; // re-recognized from the re-sent audio
    ws.on("open", () => {
      if (this.conn !== c) return;
      c.state = "open";
      c.openedAt = this.lastSent = Date.now();
      c.base = this.pending[0]?.pos ?? this.written;
      this.tx(c, JSON.stringify(this.config()));
      for (const p of this.pending) this.tx(c, p.buf);
      c.sentTo = this.written;
      if (this.closingRequested) this.end(c);
      // A bad key still opens the socket; its error frame follows the start message within ~0.1 s.
      c.confirmTimer = setTimeout(() => this.confirm(c), this.o.confirmMs);
    });
    ws.on("message", (d, isBinary) => {
      if (!isBinary && this.conn === c) this.onMessage(c, d.toString());
    });
    ws.on("error", (e) => (c.lastError = e.message));
    ws.on("close", (code, reason) => this.onClose(c, code, reason.toString()));
  }

  private config() {
    const o = this.o;
    const cfg: Record<string, unknown> = {
      model: o.model,
      audio_format: "pcm_s16le",
      sample_rate: o.sampleRate,
      num_channels: 1,
      enable_language_identification: true,
      enable_endpoint_detection: true,
      max_endpoint_delay_ms: 1500,
      client_reference_id: "g2-orchestrator",
    };
    // The docs' low-latency starting point; these two exist from v5 on.
    if (Number(/-v(\d+)/.exec(o.model)?.[1] ?? 5) >= 5) Object.assign(cfg, { endpoint_latency_adjustment_level: 2, endpoint_sensitivity: 0.3 });
    if (this.hints.length) cfg.language_hints = this.hints;
    if (o.diarize) cfg.enable_speaker_diarization = true;
    if (o.terms.length) cfg.context = { terms: o.terms };
    return cfg;
  }

  private tx(c: Conn, data: Buffer | string) {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    c.ws.send(data);
    this.lastSent = Date.now();
  }

  /** End of stream: an EMPTY TEXT frame (an empty binary frame is just an empty audio chunk). */
  private end(c: Conn) {
    if (c.sentEnd || c.state !== "open") return;
    c.sentEnd = true;
    c.state = "draining";
    this.tx(c, "");
    // No finished reply: treat as a drop. The server may still be working through a burst of unfinalized audio.
    c.drainTimer = setTimeout(() => c.ws.terminate(), this.o.closeTimeoutMs + (this.pendingBytes / this.bps) * 1000);
  }

  private confirm(c: Conn) {
    if (c.confirmed || c.error || this.conn !== c) return;
    c.confirmed = true; // (the reconnect count resets only once it has stayed up: see onClose)
    this.warnedDrop = false;
    if (!this.ready) {
      this.ready = true;
      this.emit("ready", { engine: "soniox", lang: this.o.lang, model: this.o.model, hints: this.hints });
    } else this.emit("status", "soniox: connected");
  }

  private retire(c: Conn) {
    clearTimeout(c.confirmTimer);
    clearTimeout(c.drainTimer);
    if (this.conn === c) this.conn = null;
    c.state = "closed";
    if (c.ws.readyState === WebSocket.OPEN) c.ws.close();
    else if (c.ws.readyState === WebSocket.CONNECTING) c.ws.terminate();
  }

  private onClose(c: Conn, code: number, reason: string) {
    if (this.conn !== c) return; // retired already
    this.retire(c);
    if (this.done) return;
    if (c.confirmed && Date.now() - c.openedAt >= this.o.stableMs) this.attempts = 0;
    // Closed after our end-of-stream: clean. (A drop while closing for silence needs no reconnect either.)
    const err = c.error ?? (c.sentEnd && (code === 1000 || this.idle) ? null : dropped(c.lastError, code, reason));
    if (!err) return this.ended(c);
    // Before the first good connection any failure means "use the local engine", without retrying.
    if (err.fatal || !this.ready) return this.fail(err);
    if (this.idle) return this.ended(c); // was closing for silence anyway: speech reopens it
    this.retry(err);
  }

  /** A socket finished after our end-of-stream (closing, idle, or renewing). */
  private ended(c: Conn) {
    this.commit(); // the end of stream finalized the open utterance
    if (this.closingRequested) {
      if (!this.idle && this.written > c.sentTo) return this.connect(); // audio written while it drained
      return this.finish();
    }
    if (!this.idle) this.connect(); // renewing, or speech came back while it was closing for silence
  }

  private retry(err: SonioxError) {
    if (this.attempts >= this.o.maxReconnects)
      return this.fail(new SonioxError(`${err.message} (gave up after ${this.attempts} reconnects)`, err.code, err.type));
    const step = this.o.backoffMs[Math.min(this.attempts, this.o.backoffMs.length - 1)];
    const delay = err.type === "max_duration_reached" ? 0 : err.code === 429 ? Math.max(step, 2000) : step;
    this.attempts++;
    this.emit("status", `soniox: ${err.message}; reconnecting${delay ? ` in ${delay} ms` : ""}`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      // Nothing to re-send: reconnect on the next write, so there is no socket while the mic is off.
      if (!this.pendingBytes && !this.closingRequested) this.awaitAudio = true;
      else this.connect();
    }, delay);
  }

  private stopTimers() {
    clearInterval(this.keepTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.closeTimer);
    this.retryTimer = undefined;
  }

  private finish(force = false) {
    if (this.done) return;
    this.done = true;
    this.stopTimers();
    if (force) this.finals.push(...this.live); // no final reply: the best guess beats nothing
    this.live = [];
    this.commit();
    if (this.conn) this.retire(this.conn);
    this.resolveClose?.();
  }

  private fail(err: SonioxError) {
    if (this.done) return;
    this.done = true;
    bench(err);
    this.stopTimers();
    this.live = [];
    this.commit(); // its finals are kept; the rest of its audio is in pendingAudio()
    if (this.conn) this.retire(this.conn);
    this.emit("error", err);
    this.resolveClose?.();
  }

  // ---------- transcript ----------

  private onMessage(c: Conn, raw: string) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.error_code != null || m.error_type) {
      c.error = new SonioxError(describe(m.error_code, m.error_type, m.error_message), m.error_code, m.error_type);
      c.ws.terminate(); // the server closes right after; don't depend on it
      return;
    }
    this.confirm(c);
    const live: Piece[] = [];
    for (const t of (m.tokens ?? []) as Tok[]) {
      if (t.translation_status === "translation") continue; // only if a translation block is configured
      if (t.text === "<end>" || t.text === "<fin>") {
        this.commit();
        continue;
      }
      const p = this.piece(c, t);
      if (!t.is_final) live.push(p);
      else {
        const prev = this.finals[this.finals.length - 1];
        if (this.o.diarize && prev && p.speaker && prev.speaker && prev.speaker !== p.speaker) this.commit();
        this.finals.push(p);
      }
    }
    this.live = live;
    if (isNum(m.final_audio_proc_ms)) this.trim(c.base + Math.round((m.final_audio_proc_ms * this.o.sampleRate) / 1000) * 2);
    this.partial();
    // (finished without our end-of-stream: its close goes through the reconnect backoff instead)
    if (m.finished && c.sentEnd) {
      this.retire(c);
      return this.ended(c);
    }
    if (c.state === "open" && !this.finals.length && !this.live.length && Date.now() - c.openedAt > this.o.rotateAfterMs) {
      this.emit("status", "soniox: renewing the stream (300 min limit)");
      this.end(c); // between utterances; the next socket picks up the audio written meanwhile
    }
  }

  private piece(c: Conn, t: Tok): Piece {
    const at = (ms?: number) => (isNum(ms) ? c.base / this.bps + ms / 1000 : undefined);
    return {
      text: t.text ?? "",
      start: at(t.start_ms),
      end: at(t.end_ms),
      conf: t.confidence,
      speaker: t.speaker != null ? String(t.speaker) : undefined,
      lang: t.language,
    };
  }

  private partial() {
    const ps = [...this.finals, ...this.live];
    const text = join(ps);
    if (!text || text === this.lastPartial) return;
    this.lastPartial = text;
    this.emit("partial", this.ev("partial", ps));
  }

  private commit() {
    const ps = this.finals;
    this.finals = [];
    this.lastPartial = "";
    if (join(ps)) this.emit("final", this.ev("final", ps));
  }

  private ev(type: "partial" | "final", ps: Piece[]): STTEvent {
    const starts = ps.map((p) => p.start).filter(isNum);
    const ends = ps.map((p) => p.end).filter(isNum);
    const ev: STTEvent = {
      type,
      text: join(ps),
      start: r3(starts.length ? Math.min(...starts) : 0),
      end: r3(ends.length ? Math.max(...ends) : 0),
      lang: this.o.lang,
      engine: "soniox",
    };
    const lang = majority(ps, (p) => p.lang);
    if (lang) ev.detectedLang = lang;
    const speaker = majority(ps, (p) => p.speaker);
    if (speaker) ev.speaker = speaker;
    const confs = ps.map((p) => p.conf).filter(isNum);
    if (confs.length) ev.confidence = r3(confs.reduce((a, b) => a + b, 0) / confs.length);
    return ev;
  }

  // ---------- audio bookkeeping ----------

  /** Drop audio Soniox has finalized (before stream byte `pos`). */
  private trim(pos: number) {
    while (this.pending.length) {
      const p = this.pending[0];
      if (p.pos + p.buf.length <= pos) {
        this.pending.shift();
        this.pendingBytes -= p.buf.length;
        continue;
      }
      if (p.pos < pos) {
        const cut = (pos - p.pos) & ~1;
        p.buf = p.buf.subarray(cut);
        p.pos += cut;
        this.pendingBytes -= cut;
      }
      break;
    }
  }

  private cap(max: number) {
    let dropped = 0;
    while (this.pendingBytes > max && this.pending.length > 1) {
      const p = this.pending.shift()!;
      this.pendingBytes -= p.buf.length;
      dropped += p.buf.length;
    }
    if (dropped && !this.idle && this.conn?.state !== "open" && !this.warnedDrop) {
      this.warnedDrop = true;
      this.emit("status", `soniox: offline for over ${this.o.maxPendingSec} s, dropping the oldest audio`);
    }
  }

  /** Energy check (same idea as vad.ts) for the idle close/reopen. */
  private voiced(pcm: Buffer): boolean {
    const n = pcm.length >> 1;
    if (!n) return false;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      acc += v * v;
    }
    const r = Math.sqrt(acc / n);
    const voiced = r > Math.max(0.008, this.noise * 3);
    if (!voiced) this.noise = r < this.noise ? this.noise * 0.9 + r * 0.1 : this.noise * 0.995 + r * 0.005;
    return voiced;
  }
}

/**
 * One recorded clip -> text (push-to-talk): a real-time stream run on the buffer, then ended (Soniox's
 * async file API would need an upload, a job and polling).
 */
export async function sonioxTranscribe(pcm: Buffer, o: { sampleRate: number; lang?: string; alsoLangs?: string[] }): Promise<string> {
  const sec = pcm.length / (o.sampleRate * 2);
  const s = new SonioxStream({ lang: o.lang ?? "en-US", sampleRate: o.sampleRate, alsoLangs: o.alsoLangs, idleCloseSec: 0, maxPendingSec: sec + 1 });
  const finals: string[] = [];
  let err: Error | undefined;
  s.on("final", (e: STTEvent) => finals.push(e.text));
  s.on("error", (e: Error) => (err = e));
  const step = Math.round(o.sampleRate * 0.12) * 2; // 120 ms frames, as in Soniox's examples
  for (let i = 0; i < pcm.length; i += step) s.write(pcm.subarray(i, i + step));
  await s.close();
  if (err && !finals.length) throw err;
  return finals.join(" ").trim();
}

import type { HubMsg, MiniAppInfo } from "../../../src/shared/protocol";
import type { MiniGesture, MiniScreen } from "../../../src/shared/miniapp";
import { PX_H, PX_W, core, current, flash, log, paged, pushToTalk, render, send, startPicturePump, stopPicturePump, type Mode } from "../core";
import { openSandbox, type Sandbox } from "../sandbox";

// Your vibe-coded mini-apps. Each is one JS module on the hub (miniapps/<id>/app.js), written by
// Claude in Studio. Tap to run; double tap (if the app doesn't use it) to leave. Apps hot-reload
// when Claude changes them, and crashes are reported back so Claude can fix them.
// An app runs in its own sandbox (../sandbox.ts), never in this page: it can't see the hub token or
// the hub connection. All it can do is the MiniAppApi, as messages checked here.

const GESTURES = new Set<string>(["tap", "double", "up", "down", "hold", "release"]);
/** A sandbox that hasn't answered for this long (while it owes a frame or a reply) is stuck. */
const HUNG_MS = 5000;
/** api.ask / api.fetchJson calls one app may have waiting at once. */
const MAX_REQUESTS = 8;
/** api.store per app, as JSON (it lives in the bridge's storage). */
const MAX_STORE = 64_000;

interface Run {
  info: MiniAppInfo;
  box: Sandbox;
  ready: boolean;
  title: string;
  kind: "text" | "pixels";
  hasInput: boolean;
  /** What the app last showed: text apps' screen, pixel apps' picture and header. */
  text: MiniScreen | null;
  px: Uint8Array;
  header: string;
  saved: Record<string, string>;
  /** Gestures sent, waiting for "handled?". */
  inputs: Map<number, MiniGesture>;
  seq: number;
  requests: number;
  /** Last message from the sandbox, and since when it owes one (watchdog). */
  heard: number;
  owedSince: number;
  watchdog: ReturnType<typeof setInterval>;
}

let apps: MiniAppInfo[] = [];
let running: Run | null = null;
let crashed: { info: MiniAppInfo; error: string; page: number; note: string } | null = null;
let pendingOpen: string | null = null;
/** Bumped by every start and stop, so an app still loading can't come alive after the wearer left. */
let loadGen = 0;
/** The app took the current long press, so the release goes to it too (not to push-to-talk). */
let holding = false;
/** The app being downloaded right now (between tap and first frame). */
let loadingId: string | null = null;
let toastText = "";
let toastUntil = 0;
/** Hub requests (api.ask / api.fetchJson) by hub reqId: which run asked, under which of its ids. */
const pending = new Map<string, { run: Run; id: number; timer: ReturnType<typeof setTimeout> }>();

const appUrl = (info: MiniAppInfo) =>
  `${core.hubUrl.replace(/\/$/, "")}/miniapps/${encodeURIComponent(info.id)}/app.js?v=${info.version}&token=${encodeURIComponent(core.token)}`;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Ask the hub on the app's behalf; the answer goes back to the sandbox that asked. */
function request(run: Run, id: number, msg: { t: "app_ask"; prompt: string } | { t: "app_fetch"; url: string }) {
  const answer = (m: { value?: unknown; error?: string }) => running === run && run.box.post({ t: "answer", reqId: id, ...m });
  if (run.requests >= MAX_REQUESTS) return answer({ error: "too many requests at once" });
  run.requests++;
  const reqId = Math.random().toString(36).slice(2);
  const timer = setTimeout(() => {
    if (!pending.delete(reqId)) return;
    run.requests--;
    answer({ error: "timed out" });
  }, 60_000);
  pending.set(reqId, { run, id, timer });
  send({ ...msg, reqId });
}

/** Show a crash screen; `report` asks Studio to fix it (not for a download or a sandbox that failed). */
function fail(info: MiniAppInfo, e: unknown, report = true, note = "Couldn't load it from the hub.") {
  const raw = typeof e === "string" ? e : e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  let error = raw.slice(0, 1500).replace(/([?&])token=[^&\s:)]*/g, "$1token=…"); // a download error may name the URL
  if (core.token.length >= 8) error = error.replaceAll(core.token, "…");
  log(`${info.title} crashed: ${error.split("\n")[0]}`);
  stop();
  crashed = { info, error, page: 0, note: report ? "Sent to Studio." : note };
  if (report) send({ t: "app_error", id: info.id, version: info.version, error });
  render();
}

/** The sandbox now owes an answer (a reply to a gesture, or its first word after loading). */
function owe(r: Run) {
  if (!r.owedSince) r.owedSince = Date.now();
}

/** Everything a sandbox sends: only the MiniAppApi's messages, checked, get through. */
function fromApp(r: Run, m: any) {
  if (!m || typeof m !== "object") return;
  if (running !== r) {
    // Closing: app.exit() may still save something (a high score).
    if (m.t === "store") keep(r, m);
    else if (m.t === "exited") r.box.kill();
    return;
  }
  r.heard = Date.now();
  switch (m.t) {
    case "ready":
      r.ready = true;
      r.title = str(m.title, 60).trim() || r.info.title;
      r.kind = m.kind === "pixels" ? "pixels" : "text";
      r.hasInput = m.hasInput === true;
      if (!r.inputs.size) r.owedSince = 0;
      if (r.kind === "pixels") startPicturePump();
      return render();
    case "screen": {
      const s = m.screen ?? {};
      r.text = {
        header: str(s.header, 200),
        body: str(s.body, 4000),
        list: Array.isArray(s.list) ? s.list.slice(0, 200).map((x: unknown) => str(x, 200)) : undefined,
      };
      return render();
    }
    case "frame":
      // A fresh buffer each time, handed over (transferred): nothing else holds it.
      if (m.px instanceof Uint8Array && m.px.length === PX_W * PX_H) {
        r.px = m.px;
        r.header = str(m.header, 200);
      }
      return; // the picture pump draws it
    case "input": {
      const g = r.inputs.get(m.seq);
      if (!g) return;
      r.inputs.delete(m.seq);
      if (!r.inputs.size) r.owedSince = 0;
      const handled = m.handled === true;
      if (g === "double" && !handled) {
        stop();
        render();
      } else if (g === "hold" && !handled && holding) {
        // The app let the long press go: it's push-to-talk after all (its release ends the clip).
        holding = false;
        void pushToTalk(true);
      }
      return;
    }
    case "store":
      return keep(r, m);
    case "ask":
      return typeof m.reqId === "number" && request(r, m.reqId, { t: "app_ask", prompt: str(m.prompt, 4000) });
    case "fetch":
      return typeof m.reqId === "number" && request(r, m.reqId, { t: "app_fetch", url: str(m.url, 2048) });
    case "toast":
      toastText = str(m.text, 44);
      toastUntil = Date.now() + 3000;
      return render();
    case "exit":
      stop();
      return render();
    case "error":
      return fail(r.info, str(m.error, 1500) || "the app crashed");
  }
}

/** api.store.set: kept in the bridge's storage, per app. */
function keep(r: Run, m: any) {
  if (typeof m.key !== "string" || typeof m.value !== "string" || m.key.length > 200) return;
  const next = { ...r.saved, [m.key]: m.value };
  const json = JSON.stringify(next);
  if (json.length > MAX_STORE) return log(`${r.title}: api.store is full`);
  r.saved = next;
  void core.bridge?.setLocalStorage(`miniapp:${r.info.id}`, json);
}

async function start(info: MiniAppInfo) {
  stop();
  crashed = null;
  const gen = ++loadGen;
  loadingId = info.id;
  // The page downloads the code (the URL carries the token); the sandbox only ever gets the text.
  let source: string;
  try {
    const res = await fetch(appUrl(info));
    if (!res.ok) throw new Error(`the hub answered ${res.status}`);
    source = await res.text();
  } catch (e) {
    if (gen !== loadGen) return;
    return fail(info, e, false); // (the hub unreachable isn't the app's fault)
  }
  let saved: Record<string, string> = {};
  try {
    const parsed = JSON.parse((await core.bridge?.getLocalStorage(`miniapp:${info.id}`)) || "{}");
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") saved[k] = v;
  } catch {}
  if (gen !== loadGen) return; // opened something else, or left, while it loaded
  loadingId = null;
  if (current()?.id !== "apps") return;
  let r: Run | undefined;
  let box: Sandbox;
  try {
    box = await openSandbox(
      (m) => r && fromApp(r, m),
      (why) => r && running === r && fail(info, why, false, "The app sandbox stopped."),
    );
  } catch (e) {
    return fail(info, e, false, "Apps can't run here.");
  }
  if (gen !== loadGen || current()?.id !== "apps") return box.kill();
  let lastCheck = Date.now();
  r = {
    info, box, ready: false, title: info.title, kind: info.kind === "pixels" ? "pixels" : "text", hasInput: false,
    text: null, px: new Uint8Array(PX_W * PX_H), header: "", saved, inputs: new Map(), seq: 0, requests: 0,
    heard: Date.now(), owedSince: Date.now(),
    watchdog: setInterval(() => {
      const now = Date.now();
      // This page was asleep (screen off, app in the background): so was the sandbox; start counting again.
      if (now - lastCheck > 2500) r!.heard = now;
      lastCheck = now;
      const owed = r!.owedSince || (r!.ready && r!.kind === "pixels" ? r!.heard : 0); // pictures come every frame
      if (owed && now - Math.max(r!.heard, owed) > HUNG_MS) fail(info, "The app stopped responding: it is stuck (an endless loop?). Every call must return quickly.");
    }, 1000),
  };
  running = r;
  box.post({ t: "load", source, store: saved });
  render();
}

function stop() {
  loadGen++;
  holding = false;
  loadingId = null;
  if (!running) return;
  const r = running;
  running = null;
  clearInterval(r.watchdog);
  stopPicturePump();
  for (const [reqId, p] of pending) if (p.run === r) (clearTimeout(p.timer), pending.delete(reqId));
  // Let app.exit() run (it may save a score), then end the sandbox whether or not it answers.
  r.box.post({ t: "exit" });
  setTimeout(() => r.box.kill(), 500);
}

/** A gesture for the app; the answer (handled or not) comes back as an "input" message. */
function input(r: Run, g: MiniGesture, index?: number) {
  const seq = ++r.seq;
  r.inputs.set(seq, g);
  owe(r);
  r.box.post({ t: "input", seq, g, index });
}

export function openApp(id: string) {
  const info = apps.find((a) => a.id === id);
  if (info) void start(info);
  else pendingOpen = id; // list not here yet: try once more when it arrives
}

export const appsMode: Mode = {
  id: "apps",
  title: "Apps",
  enter() {
    send({ t: "miniapps_get" });
  },
  exit() {
    stop();
    crashed = null;
  },
  onHub(m: HubMsg) {
    if (m.t === "miniapps") {
      apps = m.apps;
      // Hot reload: Claude just changed the app that's open.
      const cur = running?.info ?? crashed?.info;
      const next = cur && apps.find((a) => a.id === cur.id);
      if (cur && next && next.version !== cur.version) {
        flash(`${next.title} updated`);
        void start(next);
      }
      if (pendingOpen) {
        const info = apps.find((a) => a.id === pendingOpen);
        pendingOpen = null;
        if (info) void start(info);
      }
    } else if (m.t === "app_answer") {
      const p = pending.get(m.reqId);
      if (!p) return;
      pending.delete(m.reqId);
      clearTimeout(p.timer);
      p.run.requests--;
      if (running !== p.run) return;
      p.run.box.post(m.error ? { t: "answer", reqId: p.id, error: String(m.error) } : { t: "answer", reqId: p.id, value: m.text ?? m.data });
    } else if (m.t === "studio") {
      const j = m.job;
      if (crashed?.info.id === j.id)
        crashed.note = j.status === "failed" ? `Claude couldn't fix it. ${j.log}` : j.status === "ready" ? "Fixed, reloading…" : "Claude is fixing it; it reloads when ready.";
      else if (!running && !loadingId && j.status === "ready") flash(`App ready: ${j.title}`); // (an open app says "updated")
      // A build asked for by voice can fail long after the reply; say so.
      else if (!running && j.status === "failed") flash(`Couldn't build ${j.title}`.slice(0, 44), 5000);
    }
  },
  screen() {
    if (crashed) {
      const p = paged(`${crashed.error}\n\n${crashed.note}\nDouble tap to go back.`, crashed.page);
      crashed.page = p.page;
      return { header: `✗ ${crashed.info.title} crashed`, body: p.body };
    }
    if (running) {
      const r = running;
      const toast = Date.now() < toastUntil ? `» ${toastText}` : "";
      if (r.kind === "pixels") return { header: (toast || r.header || r.title).slice(0, 46), pixels: r.px };
      const s = r.text ?? { header: r.title, body: " " }; // (until its first screen arrives)
      return { header: (toast || s.header || r.title).slice(0, 46), body: s.list ? undefined : (s.body ?? ""), list: s.list };
    }
    return {
      header: `Apps (${apps.length}) · make more in Studio`,
      list: apps.length ? apps.map((a) => `${a.kind === "pixels" ? "◆" : "≡"} ${a.title}`) : ["No apps yet — hold and say “make me a…”"],
    };
  },
  gesture(g, i) {
    if (crashed) {
      if (g === "down") crashed.page++;
      else if (g === "up") crashed.page = Math.max(0, crashed.page - 1);
      else if (g === "double") crashed = null;
      return true;
    }
    if (running) {
      // A double tap the app doesn't handle exits it (when its answer comes back). Gestures while it
      // is still starting wait for it in the sandbox.
      if (GESTURES.has(g)) input(running, g as MiniGesture, i);
      return true;
    }
    if (g === "tap" && apps[i]) {
      void start(apps[i]);
      return true;
    }
    return false;
  },
  hold(down) {
    // Games can use long press; otherwise it's push-to-talk to Jarvis (e.g. "make the snake faster").
    // The app answers a moment later, so an app with input() takes the press for now; if it turns
    // out not to want it, push-to-talk starts then. The release follows its press either way.
    if (!down) {
      const mine = holding;
      holding = false;
      if (mine && running) input(running, "release");
      return mine;
    }
    holding = !!running?.ready && running.hasInput;
    if (holding) input(running!, "hold");
    return holding;
  },
};

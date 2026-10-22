// Phone touch controller: floating analog stick on the left, N64 buttons on the right.
// Multi-touch via pointer events; fingers can slide between buttons (A <-> B). State is sent on
// every change, repeated every 50 ms while held, and as a 250 ms heartbeat while idle (the game
// releases everything if it hears nothing for 1 s).

import { BTN, type BtnName, type M64Msg, type PadState, connectRelay } from "./wire";

const $ = (id: string) => document.getElementById(id)!;
const RADIUS = 60;

const state: PadState = { x: 0, y: 0, buttons: 0 };
let seq = 0;
let lastSent = "";
let lastSentAt = 0;
let rtt = 0;
let relayRtt = 0;

const relay = connectRelay("pad", {
  onStatus: (s) => ($("conn").textContent = s),
  onMsg: (m: M64Msg) => {
    const now = Date.now();
    if (m.t === "pad_echo") rtt = rtt ? rtt * 0.8 + (now - m.sentAt) * 0.2 : now - m.sentAt;
    else if (m.t === "pong") relayRtt = relayRtt ? relayRtt * 0.8 + (now - m.sentAt) * 0.2 : now - m.sentAt;
  },
});

function send(force = false) {
  const key = `${state.x.toFixed(3)},${state.y.toFixed(3)},${state.buttons}`;
  const now = performance.now();
  const held = state.buttons !== 0 || state.x !== 0 || state.y !== 0;
  if (!force && key === lastSent && now - lastSentAt < (held ? 50 : 250)) return;
  lastSent = key;
  lastSentAt = now;
  relay.send({ t: "pad", seq: ++seq, sentAt: Date.now(), state: { ...state } });
}
setInterval(() => send(), 25);
setInterval(() => relay.send({ t: "ping", id: seq, sentAt: Date.now() }), 1000);
setInterval(() => ($("rtt").textContent = `pad→game→pad ${rtt.toFixed(0)} ms · relay ${relayRtt.toFixed(0)} ms`), 500);

// ---------------- stick ----------------

const base = $("base");
const knob = $("knob");
let stickId: number | null = null;
let origin = { x: 0, y: 0 };

function placeStick(x: number, y: number, kx = x, ky = y) {
  base.style.left = `${x}px`;
  base.style.top = `${y}px`;
  knob.style.left = `${kx}px`;
  knob.style.top = `${ky}px`;
}
function restStick() {
  const z = $("stickZone").getBoundingClientRect();
  placeStick(z.left + z.width * 0.45, z.top + z.height * 0.62);
}
restStick();
addEventListener("resize", restStick);

function moveStick(px: number, py: number) {
  let dx = px - origin.x;
  let dy = py - origin.y;
  const m = Math.hypot(dx, dy);
  if (m > RADIUS) {
    dx = (dx / m) * RADIUS;
    dy = (dy / m) * RADIUS;
  }
  placeStick(origin.x, origin.y, origin.x + dx, origin.y + dy);
  // Small radial dead zone, then rescale so the full range is still reachable.
  const r = Math.min(1, m / RADIUS);
  const dead = 0.08;
  const k = r < dead ? 0 : (r - dead) / (1 - dead) / (r || 1);
  state.x = (dx / RADIUS) * k;
  state.y = (-dy / RADIUS) * k;
  send();
}

// ---------------- buttons ----------------

const buttonEls = new Map<HTMLElement, BtnName>();
for (const name of Object.keys(BTN) as BtnName[]) {
  const el = document.getElementById(name);
  if (el) buttonEls.set(el, name);
}
const fingerOn = new Map<number, BtnName | null>();

function buttonAt(x: number, y: number): BtnName | null {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el && !buttonEls.has(el)) el = el.parentElement;
  return el ? buttonEls.get(el)! : null;
}

function recompute() {
  let b = 0;
  for (const n of fingerOn.values()) if (n) b |= BTN[n];
  if (b & ~state.buttons && "vibrate" in navigator) navigator.vibrate?.(8);
  state.buttons = b;
  for (const [el, n] of buttonEls) el.classList.toggle("on", !!(b & BTN[n]));
  send(true);
}

const pad = $("pad");
pad.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const zone = $("stickZone").getBoundingClientRect();
  const btn = buttonAt(e.clientX, e.clientY);
  if (!btn && stickId === null && e.clientX < zone.right) {
    stickId = e.pointerId;
    origin = { x: e.clientX, y: e.clientY };
    moveStick(e.clientX, e.clientY);
  } else {
    fingerOn.set(e.pointerId, btn);
    recompute();
  }
  try {
    pad.setPointerCapture(e.pointerId);
  } catch {
    // synthetic pointers (tests) cannot be captured
  }
});
pad.addEventListener("pointermove", (e) => {
  if (e.pointerId === stickId) return moveStick(e.clientX, e.clientY);
  if (!fingerOn.has(e.pointerId)) return;
  const btn = buttonAt(e.clientX, e.clientY);
  if (btn !== fingerOn.get(e.pointerId)) {
    fingerOn.set(e.pointerId, btn);
    recompute();
  }
});
const up = (e: PointerEvent) => {
  if (e.pointerId === stickId) {
    stickId = null;
    state.x = 0;
    state.y = 0;
    restStick();
    send(true);
  } else if (fingerOn.delete(e.pointerId)) recompute();
};
pad.addEventListener("pointerup", up);
pad.addEventListener("pointercancel", up);
// iOS: block long-press menus / double-tap zoom.
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("gesturestart", (e) => e.preventDefault());

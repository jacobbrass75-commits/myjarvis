// Input plumbing on the game page.
//
// The phone controller's state is exposed to the page as a *virtual standard-mapping Gamepad* by
// patching navigator.getGamepads(). Emscripten/SDL2 builds (sm64ex `TARGET_WEB=1`) read gamepads
// through that API, so the real game needs no source changes to accept the phone as a controller.
// A real Bluetooth pad paired with the Mac shows up through the same API and keeps working.

import { BTN, type PadState } from "./wire";

const EMPTY: PadState = { x: 0, y: 0, buttons: 0 };
let phone: PadState = { ...EMPTY };
let phoneAt = 0;
let installed = false;

/** Standard-mapping button indices (W3C Gamepad "standard" layout). */
const STD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

/**
 * N64 -> standard gamepad mapping. sm64ex's SDL defaults (unverified per build; remap in sm64config.txt):
 * A -> A, B -> X (sm64ex uses the left face button for B), Z -> LT, R -> RB, L -> LB, Start -> Start,
 * C buttons -> right stick.
 */
const MAP: [number, number][] = [
  [BTN.A, STD.A],
  [BTN.B, STD.X],
  [BTN.Z, STD.LT],
  [BTN.R, STD.RB],
  [BTN.L, STD.LB],
  [BTN.START, STD.START],
];

export function setPhonePad(s: PadState) {
  phone = s;
  phoneAt = performance.now();
}

function phoneLive(): PadState {
  // Fail safe: if the phone goes quiet (screen locked, Wi-Fi drop) release everything.
  return performance.now() - phoneAt > 1000 ? EMPTY : phone;
}

function virtualGamepad(): Gamepad {
  const s = phoneLive();
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  for (const [bit, idx] of MAP) if (s.buttons & bit) buttons[idx] = { pressed: true, touched: true, value: 1 };
  const cx = (s.buttons & BTN.CR ? 1 : 0) - (s.buttons & BTN.CL ? 1 : 0);
  const cy = (s.buttons & BTN.CD ? 1 : 0) - (s.buttons & BTN.CU ? 1 : 0);
  return {
    id: "G2 phone controller (virtual, STANDARD GAMEPAD)",
    index: 0,
    connected: true,
    mapping: "standard",
    timestamp: phoneAt,
    // Gamepad axes are +y = down.
    axes: [s.x, -s.y, cx, cy],
    buttons,
    hapticActuators: [],
    vibrationActuator: null,
  } as unknown as Gamepad;
}

/** Patch navigator.getGamepads so the phone appears as gamepad 0 (real pads shift to 1+). Idempotent. */
export function installVirtualGamepad() {
  if (installed) return;
  installed = true;
  const real = navigator.getGamepads?.bind(navigator) ?? (() => []);
  navigator.getGamepads = () => {
    const rs = Array.from(real()).filter((g): g is Gamepad => !!g);
    const shifted = rs.map(
      (g, i) => ({ id: g.id, index: i + 1, connected: g.connected, mapping: g.mapping, timestamp: g.timestamp, axes: g.axes, buttons: g.buttons, hapticActuators: [], vibrationActuator: g.vibrationActuator }) as unknown as Gamepad,
    );
    return [virtualGamepad(), ...shifted];
  };
  // SDL/emscripten listens for this to open the joystick.
  const ev = new Event("gamepadconnected");
  Object.defineProperty(ev, "gamepad", { value: virtualGamepad() });
  window.dispatchEvent(ev);
}

// ---------------- reading input (test scene) ----------------

const keys = new Set<string>();
addEventListener("keydown", (e) => keys.add(e.code));
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());

const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);

/** Merged input: phone (via the virtual gamepad), any real gamepad, and keyboard (WASD/arrows, J=A, K=B, L=Z). */
export function readInput(): PadState {
  let x = 0;
  let y = 0;
  let buttons = 0;
  for (const g of navigator.getGamepads()) {
    if (!g) continue;
    x += dz(g.axes[0] ?? 0);
    y -= dz(g.axes[1] ?? 0);
    for (const [bit, idx] of MAP) if (g.buttons[idx]?.pressed) buttons |= bit;
    if ((g.axes[2] ?? 0) > 0.5) buttons |= BTN.CR;
    if ((g.axes[2] ?? 0) < -0.5) buttons |= BTN.CL;
    if ((g.axes[3] ?? 0) > 0.5) buttons |= BTN.CD;
    if ((g.axes[3] ?? 0) < -0.5) buttons |= BTN.CU;
  }
  const k = (c: string) => keys.has(c);
  x += (k("KeyD") || k("ArrowRight") ? 1 : 0) - (k("KeyA") || k("ArrowLeft") ? 1 : 0);
  y += (k("KeyW") || k("ArrowUp") ? 1 : 0) - (k("KeyS") || k("ArrowDown") ? 1 : 0);
  if (k("KeyJ") || k("Space")) buttons |= BTN.A;
  if (k("KeyK")) buttons |= BTN.B;
  if (k("KeyL")) buttons |= BTN.Z;
  if (k("KeyQ")) buttons |= BTN.CL;
  if (k("KeyE")) buttons |= BTN.CR;
  if (k("Enter")) buttons |= BTN.START;
  const m = Math.hypot(x, y);
  if (m > 1) {
    x /= m;
    y /= m;
  }
  return { x, y, buttons };
}

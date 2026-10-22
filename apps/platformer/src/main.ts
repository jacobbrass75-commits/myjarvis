import { inEvenApp, previewer, startGlasses } from "../../shared/glasses";
import { Game, VH, VW, type Input } from "./game";

// Everything runs on the phone: the game ticks at 60 fps here, the phone screen is the controller,
// and frames go to the glasses as fast as the BLE link accepts them.

const $ = (id: string) => document.getElementById(id)!;
const game = new Game();
const input: Input = { left: false, right: false, jump: false, run: false };

// ---------------- phone controls ----------------

function hold(id: keyof Input) {
  const el = $(id);
  const set = (on: boolean) => {
    input[id] = on;
    el.classList.toggle("on", on);
  };
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    set(true);
    navigator.vibrate?.(8);
  });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(ev, () => set(false));
}
(["left", "right", "jump", "run"] as const).forEach(hold);
$("pause").addEventListener("click", () => game.togglePause());

const KEYS: Record<string, keyof Input> = { ArrowLeft: "left", a: "left", ArrowRight: "right", d: "right", " ": "jump", w: "jump", ArrowUp: "jump", Shift: "run", j: "run" };
addEventListener("keydown", (e) => { if (KEYS[e.key]) { input[KEYS[e.key]] = true; e.preventDefault(); } });
addEventListener("keyup", (e) => { if (KEYS[e.key]) input[KEYS[e.key]] = false; });

// ---------------- game loop + phone preview ----------------

const draw = previewer($("screen") as HTMLCanvasElement, VW, VH);
let acc = 0;
let last = performance.now();
function tick(now: number) {
  acc = Math.min(acc + (now - last), 100);
  last = now;
  while (acc >= 1000 / 60) {
    game.step(input);
    acc -= 1000 / 60;
  }
  draw(game.render());
  $("hud").textContent = `★ ${game.coins}   ♥ ${Math.max(0, game.lives)}${game.status() ? "   · " + game.status().replace("\n", " · ") : ""}`;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------- glasses ----------------
// Ring / temple: tap = jump, double tap = pause, swipe = nudge left / right.

if (inEvenApp()) {
  $("fps").textContent = "connecting to glasses…";
  startGlasses({
    width: VW,
    height: VH,
    render: () => game.buf,
    hud: () => {
      const s = game.status();
      return `COINS\n${game.coins}\n\nLIVES\n${Math.max(0, game.lives)}${s ? "\n\n" + s : ""}`;
    },
    onGesture: (g) => {
      if (g === "tap") game.tapJump();
      else if (g === "double") game.togglePause();
      else {
        const k = g === "up" ? "left" : "right";
        input[k] = true;
        setTimeout(() => (input[k] = false), 350);
      }
    },
    onFps: (f) => ($("fps").textContent = `glasses ${f.toFixed(1)} fps`),
    onLog: (s) => ($("log").textContent = s),
  }).catch((e) => ($("log").textContent = `glasses error: ${e?.message ?? e}`));
} else $("fps").textContent = "browser preview (open in the Even app to play on glasses)";

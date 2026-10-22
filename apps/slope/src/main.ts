import { inEvenApp, previewer, startGlasses } from "../../shared/glasses";
import { Slope, VH, VW } from "./game";

// Runs on the phone inside the Even App. Ring: swipe up = left, swipe down = right (flip on the
// phone screen), tap = start / retry, double tap = pause.

const $ = (id: string) => document.getElementById(id)!;
const game = new Slope();

let flipped = false;
try {
  flipped = localStorage.getItem("slope-flip") === "1";
} catch {}
const flipBtn = $("flip");
const showFlip = () => (flipBtn.textContent = `Ring: swipe ${flipped ? "down" : "up"} = left`);
showFlip();
flipBtn.addEventListener("click", () => {
  flipped = !flipped;
  try {
    localStorage.setItem("slope-flip", flipped ? "1" : "0");
  } catch {}
  showFlip();
});

const press = (id: string, fn: () => void) =>
  $(id).addEventListener("pointerdown", (e) => {
    e.preventDefault();
    fn();
    navigator.vibrate?.(8);
    $(id).classList.add("on");
    setTimeout(() => $(id).classList.remove("on"), 120);
  });
press("left", () => game.move(-1));
press("right", () => game.move(1));
press("screen", () => game.tap());
$("pause").addEventListener("click", () => game.togglePause());
addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" || e.key === "a") game.move(-1);
  else if (e.key === "ArrowRight" || e.key === "d") game.move(1);
  else if (e.key === " " || e.key === "Enter") game.tap();
  else if (e.key === "p") game.togglePause();
});

const draw = previewer($("screen") as HTMLCanvasElement, VW, VH);
let last = performance.now();
function tick(now: number) {
  game.step(Math.min(0.05, (now - last) / 1000));
  last = now;
  draw(game.render());
  $("hud").textContent = `${game.score}   best ${game.best}${game.status() ? "   · " + game.status().replace("\n", " · ") : ""}`;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

if (inEvenApp()) {
  $("fps").textContent = "connecting to glasses…";
  startGlasses({
    width: VW,
    height: VH,
    render: () => game.buf,
    hud: () => `SCORE\n${game.score}\n\nBEST\n${game.best}${game.status() ? "\n\n" + game.status() : ""}`,
    onGesture: (g) => {
      if (g === "tap") game.tap();
      else if (g === "double") game.togglePause();
      else game.move((g === "up") !== flipped ? -1 : 1);
    },
    onFps: (f) => ($("fps").textContent = `glasses ${f.toFixed(1)} fps`),
    onLog: (s) => ($("log").textContent = s),
  }).catch((e) => ($("log").textContent = `glasses error: ${e?.message ?? e}`));
} else $("fps").textContent = "browser preview (open in the Even app to play on glasses)";

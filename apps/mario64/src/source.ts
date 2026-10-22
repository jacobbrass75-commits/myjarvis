// Game page (runs on the Mac in a desktop browser): test scene + streamer + stats.
// For the real game, replace TestScene with the SM64 web build's canvas (see README "Plugging in SM64").

import { type Dither } from "./gray";
import { installVirtualGamepad, readInput, setPhonePad } from "./pad";
import { TestScene } from "./scene";
import { DISPLAY_H, DISPLAY_W, LAYOUTS, type StreamOptions, DEFAULT_OPTIONS, startStreaming, type CaptureResult } from "./stream";
import { type BridgeFormat, type M64Msg, connectRelay } from "./wire";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

installVirtualGamepad();

const scene = new TestScene($<HTMLCanvasElement>("game"));
let last = performance.now();
let gameFrames = 0;
let gameFpsAt = last;
let gameFps = 0;
const loop = (now: number) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  scene.step(dt, readInput());
  scene.render();
  gameFrames++;
  if (now - gameFpsAt > 1000) {
    gameFps = (gameFrames * 1000) / (now - gameFpsAt);
    gameFrames = 0;
    gameFpsAt = now;
  }
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

// ---------------- preview of what the glasses should show ----------------

const preview = $<HTMLCanvasElement>("preview");
preview.width = DISPLAY_W;
preview.height = DISPLAY_H;
const pctx = preview.getContext("2d")!;
const pimg = pctx.createImageData(DISPLAY_W, DISPLAY_H);
let opts: StreamOptions = { ...DEFAULT_OPTIONS };

function drawPreview(r: CaptureResult) {
  const { layout } = opts;
  pimg.data.fill(0);
  for (let i = 3; i < pimg.data.length; i += 4) pimg.data[i] = 255;
  for (let y = 0; y < layout.frameH; y++)
    for (let x = 0; x < layout.frameW; x++) {
      const v = r.levels[y * layout.frameW + x] * 17;
      const o = ((layout.y + y) * DISPLAY_W + layout.x + x) * 4;
      pimg.data[o] = v * 0.2;
      pimg.data[o + 1] = v;
      pimg.data[o + 2] = v * 0.3;
    }
  pctx.putImageData(pimg, 0, 0);
  pctx.strokeStyle = "rgba(255,255,255,0.15)";
  for (const t of layout.tiles) pctx.strokeRect(t.x + 0.5, t.y + 0.5, t.w - 1, t.h - 1);
}

// ---------------- relay + streaming ----------------

let padRate = 0;
let padCount = 0;
let padCountAt = performance.now();

const link = connectRelay("source", {
  onStatus: (s) => {
    $("conn").textContent = s;
    if (s === "connected") link.send({ t: "sync" });
  },
  onMsg: (m: M64Msg) => {
    if (m.t === "pad") {
      setPhonePad(m.state);
      padCount++;
      // Echo so the phone can show phone -> relay -> game -> phone round trip.
      link.send({ t: "pad_echo", seq: m.seq, sentAt: m.sentAt });
    } else if (m.t === "peers") {
      $("peers").textContent = `sinks ${m.peers.sink} · pads ${m.peers.pad}`;
    } else if (m.t === "welcome") {
      $("peers").textContent = `sinks ${m.peers.sink} · pads ${m.peers.pad}`;
    } else if (m.t === "sink_input") {
      $("sinkInput").textContent = m.event;
    }
    stream.onMsg(m);
  },
});

const stream = startStreaming(() => ({ src: scene.canvas, w: scene.w, h: scene.h }), link, opts, drawPreview);

// ---------------- controls ----------------

const layoutSel = $<HTMLSelectElement>("layout");
for (const l of LAYOUTS) layoutSel.add(new Option(l.label, l.key));
layoutSel.onchange = () => apply({ layout: LAYOUTS.find((l) => l.key === layoutSel.value)! });
$<HTMLSelectElement>("dither").onchange = (e) => apply({ dither: (e.target as HTMLSelectElement).value as Dither });
$<HTMLSelectElement>("fmt").onchange = (e) => apply({ bridgeFormat: (e.target as HTMLSelectElement).value as BridgeFormat });
$<HTMLSelectElement>("fit").onchange = (e) => apply({ fit: (e.target as HTMLSelectElement).value as "contain" | "cover" });
for (const k of ["gamma", "contrast", "brightness"] as const) {
  const el = $<HTMLInputElement>(k);
  el.value = String(opts.tone[k]);
  el.oninput = () => apply({ tone: { ...opts.tone, [k]: Number(el.value) } });
}
$<HTMLInputElement>("pause").onchange = (e) => (scene.paused = (e.target as HTMLInputElement).checked);

function apply(p: Partial<StreamOptions>) {
  opts = { ...opts, ...p };
  stream.setOptions(p);
}

setInterval(() => {
  const now = performance.now();
  padRate = (padCount * 1000) / (now - padCountAt);
  padCount = 0;
  padCountAt = now;
  const s = stream.stats();
  const rows: [string, string][] = [
    ["glasses fps (acked)", s.fps.toFixed(1)],
    ["predicted on G2", `${s.predictedFps.toFixed(1)} fps`],
    ["frame round trip", `${s.frameMs.toFixed(0)} ms`],
    ["bridge call / tile", `${s.tileMs.toFixed(0)} ms`],
    ["tiles / frame", s.tilesPerFrame.toFixed(2)],
    ["wire bytes / frame", s.bytesPerFrame.toFixed(0)],
    ["capture+dither", `${s.captureMs.toFixed(1)} ms`],
    ["unchanged captures", String(s.idleCaptures)],
    ["failures", String(s.failures)],
    ["last result", s.lastResult || "-"],
    ["sink", s.sinkReady ? (s.sinkInEvenApp ? "Even App (real BLE)" : "browser (simulated delay)") : "none"],
    ["game fps", gameFps.toFixed(0)],
    ["pad msgs/s", padRate.toFixed(0)],
  ];
  $("stats").innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
}, 500);

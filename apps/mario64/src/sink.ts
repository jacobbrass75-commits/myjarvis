// Glasses page: runs inside the Even App WebView on the iPhone. Receives 4-bit tiles from the relay
// and pushes them with bridge.updateImageRawData, strictly one call at a time, then acks the frame
// so the source captures the next one. Outside the Even App it renders to a local canvas with a
// simulated per-call delay from the community cost model (?simdelay=0 to disable).

import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  RebuildPageContainer,
  TextContainerProperty,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { encodeGrayPng, predictTileMs, unpack4ToGray8 } from "./gray";
import { type BridgeFormat, type M64Msg, type TileDef, connectRelay, decodeTile } from "./wire";

const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);
const inEvenApp = !!(window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview && !params.has("emulate");
const simDelay = !inEvenApp && params.get("simdelay") !== "0";

const log = (s: string) => {
  const el = $("log");
  el.textContent = `${new Date().toLocaleTimeString()} ${s}\n${el.textContent}`.slice(0, 3000);
};

let bridge: EvenAppBridge | null = null;
let tiles: TileDef[] = [];
let format: BridgeFormat = "png8";
let pageCreated = false;
// Every bridge call goes through this chain: the SDK/host cannot overlap image sends.
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => (chain = chain.then(fn, fn)) as Promise<T>;
const pending = new Map<number, { index: number; ms: number; ok: boolean; result: string; bytes: number }[]>();
const frameStart = new Map<number, number>();

// ---------------- page layout ----------------

function page(t: TileDef[]) {
  // Full-screen text container behind the images captures taps/swipes (image containers cannot).
  const textObject = [
    new TextContainerProperty({ containerID: 1, containerName: "m64-input", xPosition: 0, yPosition: 0, width: 576, height: 288, isEventCapture: 1, zOrderIndex: 0, content: t.length ? " " : "Waiting for stream…" }),
  ];
  const imageObject = t.map(
    (d, i) => new ImageContainerProperty({ containerID: d.id, containerName: d.name, xPosition: d.x, yPosition: d.y, width: d.w, height: d.h, zOrderIndex: i + 1 }),
  );
  return { containerTotalNum: textObject.length + imageObject.length, textObject, imageObject };
}

async function buildPage(t: TileDef[]) {
  if (!bridge) return;
  if (!pageCreated) {
    const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page(t)));
    pageCreated = true;
    log(`createStartUpPage: ${r}`);
  } else {
    const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(page(t)));
    log(`rebuildPage: ${ok}`);
  }
}

// ---------------- local fallback renderer ----------------

const emu = $("emu") as HTMLCanvasElement;
const ectx = emu.getContext("2d")!;
function drawLocal(d: TileDef, gray8: Uint8Array) {
  const img = ectx.createImageData(d.w, d.h);
  for (let i = 0; i < gray8.length; i++) {
    const v = gray8[i];
    img.data[i * 4] = v * 0.2;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v * 0.3;
    img.data[i * 4 + 3] = 255;
  }
  ectx.putImageData(img, d.x, d.y);
}

// ---------------- frames ----------------

async function toBridgeData(levelsPacked: Uint8Array, w: number, h: number): Promise<number[]> {
  const n = w * h;
  if (format === "gray8") return Array.from(unpack4ToGray8(levelsPacked, n));
  if (format === "png8") return Array.from(await encodeGrayPng(unpack4ToGray8(levelsPacked, n), w, h, 8));
  // png4 wants levels 0..15, one per array slot.
  const levels = new Uint8Array(n);
  for (let i = 0; i < n; i++) levels[i] = i & 1 ? levelsPacked[i >> 1] & 15 : levelsPacked[i >> 1] >> 4;
  return Array.from(await encodeGrayPng(levels, w, h, 4));
}

function onTile(buf: ArrayBuffer) {
  const f = decodeTile(buf);
  if (!f) return log("bad tile frame");
  const d = tiles[f.tileIndex];
  if (!d || d.w !== f.w || d.h !== f.h) return log(`tile ${f.tileIndex} does not match layout`);
  if (f.part === 0) frameStart.set(f.seq, performance.now());
  serial(async () => {
    const t0 = performance.now();
    let result = "success";
    let ok = true;
    let bytes = 0;
    try {
      const data = await toBridgeData(f.packed, f.w, f.h);
      bytes = data.length;
      if (bridge) {
        const r = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: d.id, containerName: d.name, imageData: data }));
        result = String(r);
        ok = ImageRawDataUpdateResult.isSuccess(r);
      } else {
        drawLocal(d, unpack4ToGray8(f.packed, f.w * f.h));
        if (simDelay) await new Promise((r) => setTimeout(r, predictTileMs(f.w, f.h)));
      }
    } catch (e) {
      ok = false;
      result = `error: ${(e as Error)?.message ?? e}`;
    }
    const list = pending.get(f.seq) ?? [];
    list.push({ index: f.tileIndex, ms: performance.now() - t0, ok, result, bytes });
    pending.set(f.seq, list);
    if (f.part === f.parts - 1) {
      const totalMs = performance.now() - (frameStart.get(f.seq) ?? t0);
      relay.send({ t: "ack", seq: f.seq, tiles: list, totalMs });
      pending.delete(f.seq);
      frameStart.delete(f.seq);
      stats(list, totalMs);
    }
  });
}

let acked = 0;
let ackedAt = performance.now();
let lastLine = "";
function stats(list: { ms: number; bytes: number; result: string }[], totalMs: number) {
  acked++;
  const now = performance.now();
  if (now - ackedAt > 1000) {
    lastLine = `${((acked * 1000) / (now - ackedAt)).toFixed(1)} fps · ${totalMs.toFixed(0)} ms/frame · ${list.length} tile(s) · ${list[0]?.bytes ?? 0} B · ${list[0]?.result}`;
    $("stats").textContent = lastLine;
    acked = 0;
    ackedAt = now;
  }
}

// ---------------- relay ----------------

const relay = connectRelay("sink", {
  onStatus: (s) => {
    $("conn").textContent = s;
    if (s === "connected") relay.send({ t: "ready", inEvenApp, simulatedDelay: simDelay });
  },
  onMsg: (m: M64Msg) => {
    if (m.t === "sync") relay.send({ t: "ready", inEvenApp, simulatedDelay: simDelay });
    if (m.t === "layout") {
      format = m.bridgeFormat;
      const t = m.tiles;
      serial(async () => {
        tiles = t;
        ectx.fillStyle = "#000";
        ectx.fillRect(0, 0, emu.width, emu.height);
        await buildPage(t);
        log(`layout: ${t.map((d) => `${d.w}x${d.h}@${d.x},${d.y}`).join(" ")} → ${format}`);
      });
    }
  },
  onBinary: onTile,
});

function onEvent(e: EvenHubEvent) {
  const raw = e.textEvent ?? e.sysEvent ?? e.listEvent;
  if (!raw) return;
  const type = (raw as { eventType?: number }).eventType;
  // Forward glasses gestures (temple / R1 ring) so the game can use them, e.g. as Start.
  relay.send({ t: "sink_input", event: `eventType ${type ?? "?"}` });
}

async function main() {
  $("mode").textContent = inEvenApp ? "Even App (real glasses)" : `browser preview${simDelay ? " (simulated BLE delay)" : ""}`;
  if (inEvenApp) {
    bridge = await waitForEvenAppBridge();
    bridge.onEvenHubEvent(onEvent);
    await serial(() => buildPage([]));
  }
}

main().catch((e) => log(`boot failed: ${e?.message ?? e}`));

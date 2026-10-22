import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { encodeGrayPng } from "../mario64/src/gray";

// Shared by the phone-run games: the game draws a w x h buffer of grey levels (0..15); this
// streams it 2x-scaled into one image container (max 288x144) in the middle of the lens, keeps a
// HUD text box on the left, and turns ring / temple gestures into callbacks.

export type Gesture = "tap" | "double" | "up" | "down";

export interface GlassesGame {
  width: number; // logical pixels; shown at 2x
  height: number;
  render(): Uint8Array;
  hud(): string;
  onGesture(g: Gesture): void;
  /** Called about once a second with the frame rate the glasses actually accepted. */
  onFps?(fps: number): void;
  onLog?(s: string): void;
}

export const inEvenApp = () => !!(window as any).flutter_inappwebview;

export async function startGlasses(game: GlassesGame) {
  const W = game.width * 2, H = game.height * 2;
  const bridge = await waitForEvenAppBridge();
  const r = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 3,
      textObject: [
        // Full-screen text box behind everything: image containers can't receive taps.
        new TextContainerProperty({ containerID: 1, containerName: "input", xPosition: 0, yPosition: 0, width: 576, height: 288, content: " ", isEventCapture: 1, zOrderIndex: 0, borderWidth: 0 }),
        new TextContainerProperty({ containerID: 3, containerName: "hud", xPosition: 8, yPosition: (288 - H) / 2, width: (576 - W) / 2 - 12, height: H, content: game.hud(), isEventCapture: 0, zOrderIndex: 1, borderWidth: 0 }),
      ],
      imageObject: [new ImageContainerProperty({ containerID: 2, containerName: "game", xPosition: (576 - W) / 2, yPosition: (288 - H) / 2, width: W, height: H, zOrderIndex: 2 })],
    }),
  );
  game.onLog?.(`glasses page: ${r}`);

  let last = 0;
  bridge.onEvenHubEvent((e: EvenHubEvent) => {
    const ev = e.sysEvent ?? e.textEvent;
    if (!ev) return;
    const now = Date.now();
    if (now - last < 120) return; // the same press can arrive twice
    last = now;
    const t = ev.eventType;
    if (t === undefined || t === OsEventTypeList.CLICK_EVENT) game.onGesture("tap");
    else if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) game.onGesture("double");
    else if (t === OsEventTypeList.SCROLL_TOP_EVENT) game.onGesture("up");
    else if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) game.onGesture("down");
  });

  pushLoop(bridge, game, W, H);
}

async function pushLoop(bridge: EvenAppBridge, game: GlassesGame, W: number, H: number) {
  const scaled = new Uint8Array(W * H);
  let prev: Uint8Array | null = null;
  let lastHud = "";
  let frames = 0;
  let t0 = performance.now();
  for (;;) {
    const src = game.render();
    for (let y = 0; y < game.height; y++)
      for (let x = 0; x < game.width; x++) {
        const v = src[y * game.width + x];
        const o = y * 2 * W + x * 2;
        scaled[o] = scaled[o + 1] = scaled[o + W] = scaled[o + W + 1] = v;
      }
    if (prev && prev.every((v, i) => v === scaled[i])) await new Promise((r) => setTimeout(r, 30));
    else {
      prev = scaled.slice();
      const png = await encodeGrayPng(scaled, W, H, 4);
      // One update in flight at a time: the BLE link can't overlap them.
      const r = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 2, containerName: "game", imageData: Array.from(png) }));
      if (!ImageRawDataUpdateResult.isSuccess(r)) game.onLog?.(`image: ${r}`);
      frames++;
    }
    const hud = game.hud();
    if (hud !== lastHud) {
      lastHud = hud;
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 3, containerName: "hud", content: hud }));
    }
    const now = performance.now();
    if (now - t0 > 1000) {
      game.onFps?.((frames * 1000) / (now - t0));
      frames = 0;
      t0 = now;
    }
  }
}

/** Draws a grey-level buffer onto a canvas in the glasses' green, for the phone screen. */
export function previewer(canvas: HTMLCanvasElement, w: number, h: number) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  return (b: Uint8Array) => {
    for (let i = 0; i < b.length; i++) {
      const v = b[i] * 17;
      img.data[i * 4] = v * 0.25;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v * 0.45;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  };
}

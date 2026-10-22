// Stream any canvas to the G2: downscale -> tone map -> 16-level dither -> split into image-container
// tiles -> skip tiles identical to what the glasses already show -> send over the relay with
// one-frame-in-flight backpressure (the glasses page acks after updateImageRawData resolves).
//
// Game-agnostic: the SM64 web build's <canvas> plugs in exactly like the test scene's.

import { type Dither, type ToneOptions, DEFAULT_TONE, bytesEqual, luminance, pack4, predictTileMs, quantize } from "./gray";
import { type BridgeFormat, type M64Msg, type TileDef, type TileFrame, encodeTile } from "./wire";

export const DISPLAY_W = 576;
export const DISPLAY_H = 288;
const MAX_TILE_W = 288;
const MAX_TILE_H = 144;
const MIN_TILE = 20;

export interface Layout {
  key: string;
  label: string;
  /** Size of the streamed frame on the display (sum of its tiles). */
  frameW: number;
  frameH: number;
  /** Top-left of the frame on the 576x288 display. */
  x: number;
  y: number;
  tiles: TileDef[];
}

/** Split a frameW x frameH area at (x, y) into the fewest equal tiles that fit the container limits. */
export function makeLayout(key: string, label: string, frameW: number, frameH: number, x = (DISPLAY_W - frameW) >> 1, y = (DISPLAY_H - frameH) >> 1): Layout {
  const cols = Math.ceil(frameW / MAX_TILE_W);
  const rows = Math.ceil(frameH / MAX_TILE_H);
  if (cols * rows > 4) throw new Error(`${frameW}x${frameH} needs ${cols * rows} image containers; max is 4 per page`);
  if (frameW % cols || frameH % rows) throw new Error(`${frameW}x${frameH} does not split evenly into ${cols}x${rows}`);
  const w = frameW / cols;
  const h = frameH / rows;
  if (w < MIN_TILE || h < MIN_TILE) throw new Error("tiles must be at least 20x20");
  const tiles: TileDef[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = tiles.length;
      tiles.push({ id: 10 + i, name: `m64-${i}`, x: x + c * w, y: y + r * h, w, h });
    }
  return { key, label, frameW, frameH, x, y, tiles };
}

/** Predicted frames/s on hardware if every tile changes every frame (serial sends). */
export const predictFps = (l: Layout) => 1000 / l.tiles.reduce((s, t) => s + predictTileMs(t.w, t.h), 0);

export const LAYOUTS: Layout[] = [
  makeLayout("s192", "4:3 192x144, 1 tile (recommended)", 192, 144),
  makeLayout("s160", "4:3 160x120, 1 tile (fastest)", 160, 120),
  makeLayout("s288", "2:1 288x144, 1 tile (crops 4:3)", 288, 144),
  makeLayout("q384", "4:3 384x288, 4 tiles of 192x144", 384, 288),
  makeLayout("q576", "2:1 576x288, 4 tiles of 288x144 (full screen)", 576, 288),
];

export interface StreamOptions {
  layout: Layout;
  dither: Dither;
  tone: ToneOptions;
  /** "contain" letterboxes the source into the frame, "cover" crops it. */
  fit: "contain" | "cover";
  bridgeFormat: BridgeFormat;
  /** Tiles differing from the last sent version in fewer pixels than this are not resent (0 = exact diff). */
  minChangedPixels: number;
}

export const DEFAULT_OPTIONS: StreamOptions = {
  layout: LAYOUTS[0],
  dither: "bayer",
  tone: DEFAULT_TONE,
  fit: "contain",
  bridgeFormat: "png8",
  minChangedPixels: 0,
};

export interface CaptureResult {
  /** Changed tiles only, ready to send. */
  tiles: TileFrame[];
  /** Full frame of levels 0..15 (frameW x frameH), for previews. */
  levels: Uint8Array;
  ms: number;
}

/** Stateless-ish capture + diff. Keeps the last sent version of each tile. */
export class CanvasStreamer {
  private scratch: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private sent: (Uint8Array | null)[] = [];
  private seq = 0;

  constructor(public opts: StreamOptions = DEFAULT_OPTIONS) {
    this.scratch = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    const ctx = this.scratch.getContext("2d", { willReadFrequently: true } as CanvasRenderingContext2DSettings);
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx as CanvasRenderingContext2D;
    this.reset();
  }

  setOptions(p: Partial<StreamOptions>) {
    const layoutChanged = p.layout && p.layout !== this.opts.layout;
    this.opts = { ...this.opts, ...p };
    if (layoutChanged || p.dither || p.tone || p.fit) this.reset();
  }

  /** Forget what the glasses show; next capture resends every tile. */
  reset() {
    this.sent = this.opts.layout.tiles.map(() => null);
  }

  /** Mark a tile as not delivered (failed ack) so it is resent. */
  invalidate(tileIndex: number) {
    this.sent[tileIndex] = null;
  }

  capture(src: CanvasImageSource, srcW: number, srcH: number): CaptureResult {
    const t0 = performance.now();
    const { layout, fit, tone, dither, minChangedPixels } = this.opts;
    const fw = layout.frameW;
    const fh = layout.frameH;
    if (this.scratch.width !== fw || this.scratch.height !== fh) {
      this.scratch.width = fw;
      this.scratch.height = fh;
    }
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, fw, fh);
    const scale = fit === "contain" ? Math.min(fw / srcW, fh / srcH) : Math.max(fw / srcW, fh / srcH);
    const dw = srcW * scale;
    const dh = srcH * scale;
    ctx.drawImage(src, (fw - dw) / 2, (fh - dh) / 2, dw, dh);
    const img = ctx.getImageData(0, 0, fw, fh);
    const levels = quantize(luminance(img.data, fw, fh, tone), fw, fh, dither);

    const changed: { index: number; packed: Uint8Array; tile: TileDef }[] = [];
    layout.tiles.forEach((tile, index) => {
      const ox = tile.x - layout.x;
      const oy = tile.y - layout.y;
      const sub = new Uint8Array(tile.w * tile.h);
      for (let y = 0; y < tile.h; y++) sub.set(levels.subarray((oy + y) * fw + ox, (oy + y) * fw + ox + tile.w), y * tile.w);
      const packed = pack4(sub);
      const prev = this.sent[index];
      if (prev && (bytesEqual(prev, packed) || (minChangedPixels > 0 && diffPixels(prev, packed) < minChangedPixels))) return;
      changed.push({ index, packed, tile });
    });

    const seq = changed.length ? ++this.seq : this.seq;
    const tiles = changed.map((c, part) => {
      this.sent[c.index] = c.packed;
      return { tileIndex: c.index, part, parts: changed.length, w: c.tile.w, h: c.tile.h, seq, packed: c.packed };
    });
    return { tiles, levels, ms: performance.now() - t0 };
  }
}

function diffPixels(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ^ b[i];
    if (x & 0xf0) n++;
    if (x & 0x0f) n++;
  }
  return n;
}

// ---------------- driver ----------------

export interface Link {
  send(m: M64Msg): void;
  sendBinary(b: ArrayBuffer): void;
}

export interface StreamStats {
  /** Frames acknowledged by the glasses page per second (the number that matters). */
  fps: number;
  /** Mean source->ack round trip per frame, ms. */
  frameMs: number;
  /** Mean updateImageRawData time per tile as reported by the glasses page, ms. */
  tileMs: number;
  tilesPerFrame: number;
  bytesPerFrame: number;
  captureMs: number;
  framesAcked: number;
  /** Captures where nothing changed (nothing sent). */
  idleCaptures: number;
  failures: number;
  lastResult: string;
  predictedFps: number;
  sinkReady: boolean;
  sinkInEvenApp: boolean;
}

/**
 * Pump frames from `canvas` to the glasses as fast as the glasses accept them: capture only when the
 * previous frame has been acked ("latest frame wins", never queue). Call `onMsg` with relay messages.
 */
export function startStreaming(getSource: () => { src: CanvasImageSource; w: number; h: number } | null, link: Link, opts: StreamOptions = DEFAULT_OPTIONS, onPreview?: (r: CaptureResult) => void) {
  const streamer = new CanvasStreamer(opts);
  let inFlight: { seq: number; t0: number; bytes: number; tiles: number } | null = null;
  let sinkReady = false;
  let sinkInEvenApp = false;
  let running = true;
  const acks: number[] = [];
  const ema = { frameMs: 0, tileMs: 0, tilesPerFrame: 0, bytesPerFrame: 0, captureMs: 0 };
  const counters = { framesAcked: 0, idleCaptures: 0, failures: 0, lastResult: "" };
  const mix = (k: keyof typeof ema, v: number) => (ema[k] = ema[k] ? ema[k] * 0.85 + v * 0.15 : v);

  const sendLayout = () => link.send({ t: "layout", tiles: streamer.opts.layout.tiles, bridgeFormat: streamer.opts.bridgeFormat });

  const tick = () => {
    if (!running) return;
    requestAnimationFrame(tick);
    if (inFlight && performance.now() - inFlight.t0 > 4000) {
      // Lost ack (sink reloaded, BLE hiccup): forget glasses state and carry on.
      counters.failures++;
      counters.lastResult = "ack timeout";
      inFlight = null;
      streamer.reset();
    }
    if (!sinkReady || inFlight) return;
    const s = getSource();
    if (!s) return;
    const r = streamer.capture(s.src, s.w, s.h);
    mix("captureMs", r.ms);
    onPreview?.(r);
    if (!r.tiles.length) {
      counters.idleCaptures++;
      return;
    }
    let bytes = 0;
    for (const t of r.tiles) {
      const b = encodeTile(t);
      bytes += b.byteLength;
      link.sendBinary(b);
    }
    inFlight = { seq: r.tiles[0].seq, t0: performance.now(), bytes, tiles: r.tiles.length };
  };
  requestAnimationFrame(tick);

  return {
    streamer,
    onMsg(m: M64Msg) {
      if (m.t === "ready") {
        sinkReady = true;
        sinkInEvenApp = m.inEvenApp;
        inFlight = null;
        streamer.reset();
        sendLayout();
      } else if (m.t === "peers" && m.peers.sink === 0) {
        sinkReady = false;
      } else if (m.t === "ack" && inFlight && m.seq === inFlight.seq) {
        const now = performance.now();
        acks.push(now);
        counters.framesAcked++;
        mix("frameMs", now - inFlight.t0);
        mix("tilesPerFrame", inFlight.tiles);
        mix("bytesPerFrame", inFlight.bytes);
        for (const t of m.tiles) {
          mix("tileMs", t.ms);
          counters.lastResult = t.result;
          if (!t.ok) {
            counters.failures++;
            streamer.invalidate(t.index);
          }
        }
        inFlight = null;
      }
    },
    setOptions(p: Partial<StreamOptions>) {
      streamer.setOptions(p);
      if (p.layout || p.bridgeFormat) {
        inFlight = null;
        if (sinkReady) sendLayout();
      }
    },
    stats(): StreamStats {
      const now = performance.now();
      while (acks.length && now - acks[0] > 3000) acks.shift();
      const fps = acks.length > 1 ? ((acks.length - 1) * 1000) / (acks[acks.length - 1] - acks[0]) : 0;
      return { fps: now - (acks[acks.length - 1] ?? 0) > 3000 ? 0 : fps, ...ema, ...counters, predictedFps: predictFps(streamer.opts.layout), sinkReady, sinkInEvenApp };
    },
    stop() {
      running = false;
    },
  };
}

/**
 * WebGL canvases (the SM64 emscripten build) clear their drawing buffer after compositing, so a
 * drawImage() from rAF can read black. Call this BEFORE the game creates its context.
 */
export function forcePreserveDrawingBuffer() {
  const orig = HTMLCanvasElement.prototype.getContext as (this: HTMLCanvasElement, id: string, o?: unknown) => RenderingContext | null;
  (HTMLCanvasElement.prototype as unknown as { getContext: typeof orig }).getContext = function (this: HTMLCanvasElement, id: string, o?: unknown) {
    if (id === "webgl" || id === "webgl2" || id === "experimental-webgl") o = { ...((o as object) ?? {}), preserveDrawingBuffer: true };
    return orig.call(this, id, o);
  };
}

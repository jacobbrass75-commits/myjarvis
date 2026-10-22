// Wire protocol between the game page (source, on the Mac), the glasses page (sink, in the Even App
// WebView on the iPhone) and the phone controller (pad). Carried by relay.ts today; see
// docs/mario64.md for the equivalent hub (src/hub/server.ts) change.
//
// JSON text frames carry control messages; binary frames carry tiles (source -> sink only).

export type M64Role = "source" | "sink" | "pad";

/** One image container on the glasses. Display coords are in the 576x288 canvas. */
export interface TileDef {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pad button bits (N64 layout). */
export const BTN = {
  A: 1 << 0,
  B: 1 << 1,
  Z: 1 << 2,
  R: 1 << 3,
  L: 1 << 4,
  START: 1 << 5,
  CU: 1 << 6,
  CD: 1 << 7,
  CL: 1 << 8,
  CR: 1 << 9,
} as const;
export type BtnName = keyof typeof BTN;

export interface PadState {
  /** Analog stick, -1..1, +y = up. */
  x: number;
  y: number;
  buttons: number;
}

export type M64Msg =
  | { t: "hello"; role: M64Role; token?: string }
  | { t: "welcome"; role: M64Role; peers: Record<M64Role, number> }
  | { t: "peers"; peers: Record<M64Role, number> }
  // source -> sink ("sync" asks sinks to (re)send "ready", e.g. when the game page loads after the glasses page)
  | { t: "sync" }
  | { t: "layout"; tiles: TileDef[]; bridgeFormat: BridgeFormat }
  // sink -> source
  | { t: "ready"; inEvenApp: boolean; simulatedDelay: boolean }
  | { t: "ack"; seq: number; tiles: { index: number; ms: number; ok: boolean; result: string; bytes: number }[]; totalMs: number }
  | { t: "sink_input"; event: string }
  // pad -> source (seq lets the source echo it back for an end-to-end RTT)
  | { t: "pad"; seq: number; sentAt: number; state: PadState }
  | { t: "ping"; id: number; sentAt: number }
  | { t: "pong"; id: number; sentAt: number }
  // source -> pad
  | { t: "pad_echo"; seq: number; sentAt: number };

/** What the glasses page hands to updateImageRawData. */
export type BridgeFormat = "png8" | "png4" | "gray8";

// ---- binary tile frame ----
// [0]  u8  magic 0x47 'G'
// [1]  u8  version 1
// [2]  u8  tile index (into layout.tiles)
// [3]  u8  part index within this frame
// [4]  u8  part count within this frame (only changed tiles are sent)
// [5]  u8  encoding: 1 = 4-bit packed levels, high nibble = left pixel
// [6]  u16 width   (LE)
// [8]  u16 height  (LE)
// [10] u32 frame seq (LE)
// [14] u16 reserved
// [16] payload
export const TILE_HEADER = 16;

export interface TileFrame {
  tileIndex: number;
  part: number;
  parts: number;
  w: number;
  h: number;
  seq: number;
  packed: Uint8Array;
}

export function encodeTile(f: TileFrame): ArrayBuffer {
  const buf = new ArrayBuffer(TILE_HEADER + f.packed.length);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x47);
  dv.setUint8(1, 1);
  dv.setUint8(2, f.tileIndex);
  dv.setUint8(3, f.part);
  dv.setUint8(4, f.parts);
  dv.setUint8(5, 1);
  dv.setUint16(6, f.w, true);
  dv.setUint16(8, f.h, true);
  dv.setUint32(10, f.seq, true);
  new Uint8Array(buf, TILE_HEADER).set(f.packed);
  return buf;
}

export function decodeTile(buf: ArrayBuffer): TileFrame | null {
  if (buf.byteLength < TILE_HEADER) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== 0x47 || dv.getUint8(1) !== 1 || dv.getUint8(5) !== 1) return null;
  const w = dv.getUint16(6, true);
  const h = dv.getUint16(8, true);
  const packed = new Uint8Array(buf, TILE_HEADER);
  if (packed.length !== (w * h + 1) >> 1) return null;
  return { tileIndex: dv.getUint8(2), part: dv.getUint8(3), parts: dv.getUint8(4), w, h, seq: dv.getUint32(10, true), packed };
}

/** ws URL for pages: ?relay=ws://host:port/ws overrides; default is same origin /ws (Vite proxies it to relay.ts). */
export function relayUrl(): string {
  const p = new URLSearchParams(location.search);
  const r = p.get("relay");
  if (r) return r;
  return location.origin.replace(/^http/, "ws") + "/ws";
}

/** Small reconnecting socket wrapper shared by the three pages. */
export function connectRelay(role: M64Role, handlers: { onMsg?: (m: M64Msg) => void; onBinary?: (b: ArrayBuffer) => void; onStatus?: (s: string) => void }) {
  const token = new URLSearchParams(location.search).get("token") ?? "";
  let ws: WebSocket | null = null;
  const open = () => {
    const sock = new WebSocket(relayUrl());
    sock.binaryType = "arraybuffer";
    sock.onopen = () => {
      ws = sock;
      sock.send(JSON.stringify({ t: "hello", role, token } satisfies M64Msg));
      handlers.onStatus?.("connected");
    };
    sock.onmessage = (e) => {
      if (typeof e.data === "string") handlers.onMsg?.(JSON.parse(e.data));
      else handlers.onBinary?.(e.data as ArrayBuffer);
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      handlers.onStatus?.("reconnecting");
      setTimeout(open, 1000);
    };
  };
  open();
  return {
    send(m: M64Msg) {
      if (ws?.readyState === 1) ws.send(JSON.stringify(m));
    },
    sendBinary(b: ArrayBuffer) {
      if (ws?.readyState === 1) ws.send(b);
    },
    /** Bytes queued in the socket; used to avoid piling frames up on a slow link. */
    get buffered() {
      return ws?.bufferedAmount ?? 0;
    },
    get open() {
      return ws?.readyState === 1;
    },
  };
}

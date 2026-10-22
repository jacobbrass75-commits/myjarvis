/**
 * Even R1 ring. The ring is its OWN BLE peripheral ("EVEN R1_xxxxxx", service bae80001-…).
 * Normal operation: the ring is bound to the glasses and relays gestures to them over its own
 * link; the glasses then report them on EvenHub as Sys_ItemEvent with EventSource = RING (2).
 * So for UI input you do NOT need to connect to the ring at all - only the glasses.
 *
 * Connecting to the ring directly (what MentraOS R1.kt does) gives raw gestures and battery, and
 * lets you (re)bind it to the glasses. Two incompatible descriptions of the ring's command format
 * exist (both reverse engineered, neither verified by us):
 *   - MentraOS R1.kt (Apache-2.0): init writes 0xFC then 0x11 to both write chars; advStart =
 *     [0x00, 0x00, 0x09, ...glassesLeftMac] on bae80012 (R1.kt itself has a TODO that an outer
 *     wrapper may be needed).
 *   - g2-kit-unofficial ring.ts (MIT): 15-byte header frames with a 4-byte anti-replay hash; the
 *     "link to glasses" command is cmd 0x0a sub 0x12 with the RIGHT-arm MAC reversed, and full
 *     pairing needs a server-issued key (pairAuth) that is not reproducible offline.
 * Gesture notifications ([0xFF, type, param]) are only documented by MentraOS.
 */

export type RingGesture = "hold" | "tap" | "double_tap" | "swipe_up" | "swipe_down";

/** Parse a ring notification. Recognises [0xFF, type, param] anywhere in the packet (MentraOS). */
export function parseRingNotification(data: Uint8Array):
  | { kind: "gesture"; gesture: RingGesture }
  | { kind: "battery"; level: number }
  | { kind: "state"; state: "ready" | "menu" | number }
  | { kind: "unknown" } {
  const ff = data.indexOf(0xff);
  if (ff >= 0 && ff + 2 < data.length) {
    const g = gestureFrom(data[ff + 1]!, data[ff + 2]!);
    if (g) return { kind: "gesture", gesture: g };
  }
  if (data.length === 2 && data[0]! <= 100) return { kind: "battery", level: data[0]! };
  if (data.length === 1) return { kind: "state", state: data[0] === 1 ? "ready" : data[0] === 0 ? "menu" : data[0]! };
  return { kind: "unknown" };
}

function gestureFrom(type: number, param: number): RingGesture | null {
  if (type === 0x03) return "hold";
  if (type === 0x04) return param === 0x01 ? "tap" : param === 0x02 ? "double_tap" : null;
  if (type === 0x05) return param < 0x80 ? "swipe_up" : "swipe_down";
  return null;
}

/** MentraOS init: 0xFC then (200 ms later) 0x11, written without response to both write chars. */
export const R1_INIT = [Uint8Array.of(0xfc), Uint8Array.of(0x11)] as const;

/** MentraOS advStart: tell the ring to connect to the glasses (left-lens MAC, big-endian bytes). */
export function r1AdvStart(glassesLeftMac: Uint8Array): Uint8Array {
  if (glassesLeftMac.length !== 6) throw new RangeError("MAC must be 6 bytes");
  return Uint8Array.of(0x00, 0x00, 0x09, ...glassesLeftMac);
}

export function parseMac(s: string): Uint8Array {
  const clean = s.replace(/[:-]/g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(clean)) throw new Error(`bad MAC: ${s}`);
  return Uint8Array.from({ length: 6 }, (_, i) => parseInt(clean.slice(i * 2, i * 2 + 2), 16));
}

export const formatMac = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0").toUpperCase()).join(":");

/** Ring id from the advertised name, e.g. "EVEN R1_CEC5BA" -> "CEC5BA". */
export function ringIdFromName(name: string): string | null {
  const i = name.indexOf("R1_");
  return i >= 0 && name.length > i + 3 ? name.slice(i + 3) : null;
}

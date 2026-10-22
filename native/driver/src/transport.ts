/**
 * Transport abstraction. The protocol code only needs "write bytes to characteristic X" and
 * "give me notifications from characteristic Y" on two peripherals (left and right lens), so it
 * can run over noble (macOS/Linux), CoreBluetooth (iOS app), bleak (Python bridge), Web
 * Bluetooth, or an in-memory mock in tests.
 */

export interface Advertisement {
  /** Platform id (CoreBluetooth UUID on macOS/iOS, MAC on Linux/Android). */
  id: string;
  name: string;
  rssi?: number;
  /** Manufacturer-specific data WITHOUT the 2-byte company id (bleak/Android convention). */
  manufacturerData?: Uint8Array;
}

export interface BlePeripheral {
  readonly id: string;
  readonly name: string;
  write(characteristic: string, data: Uint8Array, withoutResponse: boolean): Promise<void>;
  /** Enable notifications; returns an unsubscribe function. */
  subscribe(characteristic: string, onData: (data: Uint8Array) => void): Promise<() => Promise<void>>;
  read?(characteristic: string): Promise<Uint8Array>;
  onDisconnect(cb: () => void): void;
  disconnect(): Promise<void>;
}

export interface BleCentral {
  /** Scan until `stop` is called or the signal aborts. */
  scan(onAdvert: (a: Advertisement) => void, opts?: { serviceUuids?: string[]; signal?: AbortSignal }): Promise<void>;
  connect(id: string): Promise<BlePeripheral>;
  close?(): Promise<void>;
}

// ---------------------------------------------------------------- G2 advertisement helpers

export type Side = "left" | "right";

/** "Even G2_32_L_1A2B3C" -> "left". */
export function sideFromName(name: string): Side | null {
  const n = name.toUpperCase();
  if (!n.includes("G2")) return null;
  if (n.includes("_L_")) return "left";
  if (n.includes("_R_")) return "right";
  return null;
}

/**
 * G2 manufacturer data (company id stripped): bytes 0..13 ASCII serial (shared by both lenses,
 * used to pair L with R), bytes 14..19 the lens BLE MAC in little-endian order (men-g2-ble-gateway).
 */
export function parseG2Manufacturer(data: Uint8Array | undefined): { serial?: string; mac?: string } {
  if (!data || data.length < 14) return {};
  const serial = new TextDecoder().decode(data.subarray(0, 14)).replace(/[\x00-\x1f\x7f]/g, "") || undefined;
  if (data.length < 20) return { serial };
  const mac = Array.from(data.subarray(14, 20))
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(":");
  return { serial, mac };
}

export interface G2Pair {
  serial: string;
  left: Advertisement & { mac?: string };
  right: Advertisement & { mac?: string };
}

/** Collect adverts until both lenses of one pair are seen (optionally matching a serial substring). */
export async function findPair(central: BleCentral, opts: { serial?: string; timeoutMs?: number } = {}): Promise<G2Pair> {
  const ac = new AbortController();
  const seen = new Map<string, Partial<Record<Side, Advertisement & { mac?: string }>>>();
  const result: { pair?: G2Pair } = {};
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 20000);
  try {
    await central.scan(
      (a) => {
        const side = sideFromName(a.name);
        if (!side || result.pair) return;
        const { serial, mac } = parseG2Manufacturer(a.manufacturerData);
        // Without manufacturer data fall back to the name suffix after _L_/_R_.
        const key = serial ?? a.name.toUpperCase().split(side === "left" ? "_L_" : "_R_")[1] ?? a.name;
        if (opts.serial && !key.includes(opts.serial)) return;
        const entry = seen.get(key) ?? {};
        entry[side] = { ...a, mac };
        seen.set(key, entry);
        if (entry.left && entry.right) {
          result.pair = { serial: key, left: entry.left, right: entry.right };
          ac.abort();
        }
      },
      { signal: ac.signal },
    );
  } finally {
    clearTimeout(timer);
  }
  if (!result.pair) throw new Error("did not see both G2 lenses (is the Even App still connected? turn off phone Bluetooth)");
  return result.pair;
}

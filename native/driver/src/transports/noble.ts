/**
 * BleCentral over @abandonware/noble (CoreBluetooth on macOS, BlueZ/HCI on Linux).
 * noble is an optional peer dependency: `npm --prefix native i @abandonware/noble`.
 * Written against noble's documented async API; NOT yet run against real glasses.
 *
 * macOS notes:
 *  - Peripheral ids are CoreBluetooth UUIDs, not MACs. The lens MAC (needed for ring binding)
 *    comes from the manufacturer data instead (see parseG2Manufacturer).
 *  - The terminal app running node needs Bluetooth permission (System Settings > Privacy).
 *  - noble's manufacturerData INCLUDES the 2-byte company id; we strip it for the shared convention.
 */
import type { Advertisement, BleCentral, BlePeripheral } from "../transport.ts";

interface NobleChar {
  uuid: string;
  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
  subscribeAsync(): Promise<void>;
  unsubscribeAsync(): Promise<void>;
  readAsync(): Promise<Buffer>;
  on(ev: "data", cb: (data: Buffer, isNotification: boolean) => void): void;
  removeListener(ev: "data", cb: (data: Buffer, isNotification: boolean) => void): void;
  setMaxListeners?(n: number): void;
}
interface NoblePeripheral {
  id: string;
  rssi: number;
  advertisement: { localName?: string; manufacturerData?: Buffer };
  connectAsync(): Promise<void>;
  disconnectAsync(): Promise<void>;
  discoverAllServicesAndCharacteristicsAsync(): Promise<{ characteristics: NobleChar[] }>;
  once(ev: "disconnect", cb: () => void): void;
}
interface Noble {
  state: string;
  on(ev: "discover", cb: (p: NoblePeripheral) => void): void;
  on(ev: "stateChange", cb: (s: string) => void): void;
  removeListener(ev: string, cb: (...a: never[]) => void): void;
  startScanningAsync(uuids?: string[], allowDuplicates?: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
}

/** noble uses lowercase UUIDs without dashes. */
const norm = (u: string) => u.toLowerCase().replace(/-/g, "");

export async function createNobleCentral(): Promise<BleCentral> {
  const specifier = "@abandonware/noble";
  let noble: Noble;
  try {
    const mod = await import(specifier);
    noble = (mod.default ?? mod) as Noble;
  } catch {
    throw new Error("noble is not installed. Run: npm --prefix native install @abandonware/noble");
  }
  await waitPoweredOn(noble);
  const known = new Map<string, NoblePeripheral>();

  return {
    async scan(onAdvert, opts = {}) {
      const handler = (p: NoblePeripheral) => {
        known.set(p.id, p);
        const md = p.advertisement.manufacturerData;
        const a: Advertisement = {
          id: p.id,
          name: p.advertisement.localName ?? "",
          rssi: p.rssi,
          manufacturerData: md && md.length > 2 ? new Uint8Array(md.subarray(2)) : undefined,
        };
        onAdvert(a);
      };
      noble.on("discover", handler);
      await noble.startScanningAsync((opts.serviceUuids ?? []).map(norm), true);
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) return resolve();
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await noble.stopScanningAsync();
      noble.removeListener("discover", handler as never);
    },

    async connect(id) {
      const p = known.get(id);
      if (!p) throw new Error(`unknown peripheral ${id}; scan first`);
      await p.connectAsync();
      const { characteristics } = await p.discoverAllServicesAndCharacteristicsAsync();
      const byUuid = new Map(characteristics.map((c) => [norm(c.uuid), c]));
      const char = (u: string) => {
        const c = byUuid.get(norm(u));
        if (!c) throw new Error(`characteristic ${u} not found on ${p.advertisement.localName ?? id}`);
        return c;
      };
      const peripheral: BlePeripheral = {
        id,
        name: p.advertisement.localName ?? "",
        async write(u, data, withoutResponse) {
          await char(u).writeAsync(Buffer.from(data), withoutResponse);
        },
        async subscribe(u, onData) {
          const c = char(u);
          c.setMaxListeners?.(64);
          const h = (d: Buffer) => onData(new Uint8Array(d));
          c.on("data", h);
          await c.subscribeAsync();
          return async () => {
            c.removeListener("data", h);
            await c.unsubscribeAsync();
          };
        },
        async read(u) {
          return new Uint8Array(await char(u).readAsync());
        },
        onDisconnect(cb) {
          p.once("disconnect", cb);
        },
        async disconnect() {
          await p.disconnectAsync();
        },
      };
      return peripheral;
    },
  };
}

function waitPoweredOn(noble: Noble): Promise<void> {
  if (noble.state === "poweredOn") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Bluetooth not powered on (state: ${noble.state}).` + (noble.state === "unknown" || noble.state === "unauthorized" ? " macOS probably hasn't allowed this app to use Bluetooth: System Settings → Privacy & Security → Bluetooth → turn on the app running this terminal (Terminal, iTerm, Claude…), then run it again." : ""))), 10000);
    noble.on("stateChange", (s) => {
      if (s === "poweredOn") {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

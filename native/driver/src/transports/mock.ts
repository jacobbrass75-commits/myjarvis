/** In-memory peripheral for tests and dry runs: records writes, lets you inject notifications. */
import type { BlePeripheral } from "../transport.ts";

export class MockPeripheral implements BlePeripheral {
  readonly id: string;
  readonly name: string;
  readonly writes: { characteristic: string; data: Uint8Array; withoutResponse: boolean }[] = [];
  private subs = new Map<string, Set<(d: Uint8Array) => void>>();
  private disconnectCbs: (() => void)[] = [];
  /** Called after each write; lets a test act as the glasses (e.g. ack an image fragment). */
  onWrite?: (characteristic: string, data: Uint8Array) => void;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  async write(characteristic: string, data: Uint8Array, withoutResponse: boolean) {
    this.writes.push({ characteristic: characteristic.toLowerCase(), data: Uint8Array.from(data), withoutResponse });
    this.onWrite?.(characteristic.toLowerCase(), data);
  }

  async subscribe(characteristic: string, onData: (d: Uint8Array) => void) {
    const key = characteristic.toLowerCase();
    const set = this.subs.get(key) ?? new Set();
    set.add(onData);
    this.subs.set(key, set);
    return async () => {
      set.delete(onData);
    };
  }

  /** Simulate a notification from the device. */
  notify(characteristic: string, data: Uint8Array) {
    for (const cb of this.subs.get(characteristic.toLowerCase()) ?? []) cb(data);
  }

  subscribed(characteristic: string) {
    return (this.subs.get(characteristic.toLowerCase())?.size ?? 0) > 0;
  }

  onDisconnect(cb: () => void) {
    this.disconnectCbs.push(cb);
  }

  async disconnect() {
    for (const cb of this.disconnectCbs) cb();
  }
}

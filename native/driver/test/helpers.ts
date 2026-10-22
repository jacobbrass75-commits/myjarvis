import { buildPackets } from "../src/framing.ts";

/** Build what the glasses would send: same framing with route 0x12 and status 0x00. */
export function rxPackets(service: number, payload: Uint8Array, syncId = 0x40, status = 0): Uint8Array[] {
  return buildPackets(payload, { syncId, service, flag: status }).map((p) => {
    const q = Uint8Array.from(p);
    q[1] = 0x12;
    return q;
  });
}

export const bytes = (...xs: number[]) => Uint8Array.from(xs);
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * Transport framing for the G2 write (…5401) / notify (…5402) characteristics.
 *
 *   byte 0   0xAA
 *   byte 1   (dest << 4) | src   0x21 phone->glasses, 0x12 glasses->phone
 *   byte 2   sync id: one value per logical message, SAME on every fragment of it (reassembly key)
 *   byte 3   length of this packet's data after the header, INCLUDING the 2 CRC bytes on the last packet
 *   byte 4   total packet count of the message (1..255)
 *   byte 5   packet serial, 1-based
 *   byte 6   service id
 *   byte 7   status/flag. Host->glasses: 0x20 for most services, 0x00 for device-settings (0x80).
 *            Glasses->host: bits 1..4 are a result code; non-zero means the message failed.
 *   data     protobuf chunk (<= 236 bytes)
 *   [crc]    last packet only: CRC-16/CCITT-FALSE of the WHOLE payload, little-endian
 *
 * Behaviour mirrors MentraOS buildPackets/handlePacket (Apache-2.0), reimplemented here.
 */
import { FRAME } from "./constants.ts";
import { crc16 } from "./crc.ts";

export interface BuildOptions {
  syncId: number;
  service: number;
  /** Byte 7. Default: 0x20 unless service is device-settings (0x80). */
  flag?: number;
  /** Max protobuf bytes per packet. Default 236 (MentraOS). */
  maxChunk?: number;
}

export function defaultFlag(service: number): number {
  return service === 0x80 ? 0x00 : FRAME.reserveFlag;
}

export function buildPackets(payload: Uint8Array, opts: BuildOptions): Uint8Array[] {
  const max = opts.maxChunk ?? FRAME.maxChunk;
  if (max < 1 || max > 253) throw new RangeError("maxChunk must be 1..253");
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < payload.length; off += max) chunks.push(payload.subarray(off, Math.min(off + max, payload.length)));
  if (chunks.length === 0) chunks.push(new Uint8Array(0));
  // A full last chunk would exceed the packet budget once the CRC is added (8 + 236 + 2 > 244 =
  // MTU 247 - 3), so MentraOS sends the CRC in an extra, data-less packet. Same rule for any max.
  if (chunks[chunks.length - 1]!.length === max) chunks.push(new Uint8Array(0));
  if (chunks.length > 255) throw new RangeError(`payload too large: ${payload.length} bytes`);

  const crc = crc16(payload);
  const flag = opts.flag ?? defaultFlag(opts.service);
  return chunks.map((chunk, i) => {
    const last = i === chunks.length - 1;
    const out = new Uint8Array(FRAME.headerLen + chunk.length + (last ? 2 : 0));
    out[0] = FRAME.magic;
    out[1] = FRAME.phoneToGlasses;
    out[2] = opts.syncId & 0xff;
    out[3] = chunk.length + (last ? 2 : 0);
    out[4] = chunks.length;
    out[5] = i + 1;
    out[6] = opts.service & 0xff;
    out[7] = flag & 0xff;
    out.set(chunk, FRAME.headerLen);
    if (last) {
      out[out.length - 2] = crc & 0xff;
      out[out.length - 1] = (crc >> 8) & 0xff;
    }
    return out;
  });
}

export interface RawPacket {
  route: number;
  syncId: number;
  total: number;
  serial: number;
  service: number;
  status: number;
  /** (status >> 1) & 0x0f — non-zero means the glasses reported an error for this message. */
  resultCode: number;
  isLast: boolean;
  /** Protobuf chunk without header/CRC. */
  chunk: Uint8Array;
  /** CRC bytes as received on the last packet. */
  crc?: number;
}

export function parsePacket(raw: Uint8Array): RawPacket | null {
  if (raw.length < FRAME.headerLen || raw[0] !== FRAME.magic) return null;
  const len = raw[3]!;
  if (raw.length < FRAME.headerLen + len) return null;
  const total = raw[4]!;
  const serial = raw[5]!;
  const isLast = serial === total;
  if (isLast && len < 2) return null;
  const end = FRAME.headerLen + len - (isLast ? 2 : 0);
  const status = raw[7]!;
  return {
    route: raw[1]!,
    syncId: raw[2]!,
    total,
    serial,
    service: raw[6]!,
    status,
    resultCode: (status >> 1) & 0x0f,
    isLast,
    chunk: raw.subarray(FRAME.headerLen, end),
    crc: isLast ? raw[end]! | (raw[end + 1]! << 8) : undefined,
  };
}

export interface Message {
  service: number;
  syncId: number;
  payload: Uint8Array;
  /** CRC check over the reassembled payload (undefined if no CRC was present). */
  crcOk: boolean | undefined;
  source: string;
  status: number;
}

/**
 * Reassembles fragmented notifications. Keyed by source (lens) + service + sync id so concurrent
 * L/R replies with the same sync id do not cross-merge (a bug MentraOS hit).
 */
export class Reassembler {
  private partial = new Map<string, { parts: Uint8Array[]; next: number; total: number }>();
  /** Messages whose status carried a non-zero result code are dropped (as MentraOS does) and counted here. */
  rejected = 0;

  reset() {
    this.partial.clear();
  }

  push(raw: Uint8Array, source = ""): Message | null {
    const p = parsePacket(raw);
    if (!p) return null;
    if (p.resultCode !== 0) {
      this.rejected++;
      return null;
    }
    const key = `${source}|${p.service}|${p.syncId}`;
    if (p.total <= 1) return this.finish([p.chunk], p, source);
    if (p.serial === 1) {
      this.partial.set(key, { parts: [p.chunk], next: 2, total: p.total });
      return null;
    }
    const st = this.partial.get(key);
    if (!st || st.next !== p.serial || st.total !== p.total) {
      this.partial.delete(key);
      return null;
    }
    st.parts.push(p.chunk);
    st.next++;
    if (!p.isLast) return null;
    this.partial.delete(key);
    return this.finish(st.parts, p, source);
  }

  private finish(parts: Uint8Array[], last: RawPacket, source: string): Message {
    const size = parts.reduce((n, c) => n + c.length, 0);
    const payload = new Uint8Array(size);
    let off = 0;
    for (const c of parts) {
      payload.set(c, off);
      off += c.length;
    }
    return {
      service: last.service,
      syncId: last.syncId,
      payload,
      crcOk: last.crc === undefined ? undefined : crc16(payload) === last.crc,
      source,
      status: last.status,
    };
  }
}

/** One-byte rolling counter (sync id / magic random). */
export class Counter8 {
  private v: number;
  constructor(start = 0) {
    this.v = start & 0xff;
  }
  next(): number {
    const cur = this.v;
    this.v = (this.v + 1) & 0xff;
    return cur;
  }
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (s: string) => {
  const clean = s.replace(/[\s:-]/g, "");
  if (clean.length % 2) throw new Error("odd hex length");
  return Uint8Array.from({ length: clean.length / 2 }, (_, i) => parseInt(clean.slice(i * 2, i * 2 + 2), 16));
};

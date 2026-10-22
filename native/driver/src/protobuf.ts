/**
 * Minimal protobuf (proto3 wire format) writer/reader. The G2 payloads are small and we only need
 * varint, length-delimited and fixed32 fields, so a hand-rolled codec keeps the driver dependency
 * free. Field ORDER matters for byte-exact fixtures: write fields in the order MentraOS does.
 */

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

export class PbWriter {
  private buf: number[] = [];

  varint(value: number | bigint): this {
    // Negative int32 are encoded as 10-byte two's complement varints (proto3 int32 semantics).
    let v = typeof value === "bigint" ? BigInt.asUintN(64, value) : value < 0 ? BigInt.asUintN(64, BigInt(value)) : value;
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new RangeError(`varint out of range: ${v}`);
      while (v > 0x7f) {
        this.buf.push((v % 128) | 0x80);
        v = Math.floor(v / 128);
      }
      this.buf.push(v);
      return this;
    }
    while (v > 0x7fn) {
      this.buf.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.buf.push(Number(v));
    return this;
  }

  private tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }

  int(field: number, value: number): this {
    return this.tag(field, 0).varint(value);
  }

  bool(field: number, value: boolean): this {
    return this.int(field, value ? 1 : 0);
  }

  bytes(field: number, value: Uint8Array): this {
    this.tag(field, 2).varint(value.length);
    for (const b of value) this.buf.push(b);
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, enc.encode(value));
  }

  message(field: number, sub: Uint8Array | PbWriter): this {
    return this.bytes(field, sub instanceof PbWriter ? sub.finish() : sub);
  }

  float(field: number, value: number): this {
    this.tag(field, 5);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, value, true);
    for (const x of b) this.buf.push(x);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

export type PbValue = number | Uint8Array;

export interface PbField {
  field: number;
  wire: number;
  /** varint fields: number (int32-truncated like Kotlin `toInt()`); fixed32: raw uint32; bytes: Uint8Array. */
  value: PbValue;
}

export class PbReader {
  private off = 0;
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }

  get done() {
    return this.off >= this.data.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.off < this.data.length) {
      const b = this.data[this.off++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("varint too long");
    }
    throw new Error("truncated varint");
  }

  private take(n: number): Uint8Array {
    if (this.off + n > this.data.length) throw new Error("truncated field");
    const out = this.data.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  /** Read every field. Malformed tails stop parsing and are reported via `truncated`. */
  fields(): { fields: PbField[]; truncated: boolean } {
    const fields: PbField[] = [];
    try {
      while (!this.done) {
        const tag = Number(this.varint());
        const field = tag >>> 3;
        const wire = tag & 7;
        if (wire === 0) fields.push({ field, wire, value: Number(BigInt.asIntN(32, this.varint())) });
        else if (wire === 2) fields.push({ field, wire, value: this.take(Number(this.varint())) });
        else if (wire === 5) {
          const b = this.take(4);
          fields.push({ field, wire, value: new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) });
        } else if (wire === 1) this.take(8);
        else throw new Error(`unsupported wire type ${wire}`);
      }
      return { fields, truncated: false };
    } catch {
      return { fields, truncated: true };
    }
  }
}

/** Parsed message as a multimap: field number -> values in order. */
export class PbMessage {
  readonly map = new Map<number, PbField[]>();
  readonly truncated: boolean;

  constructor(data: Uint8Array) {
    const { fields, truncated } = new PbReader(data).fields();
    this.truncated = truncated;
    for (const f of fields) {
      const list = this.map.get(f.field);
      if (list) list.push(f);
      else this.map.set(f.field, [f]);
    }
  }

  has(field: number) {
    return this.map.has(field);
  }

  /** Last varint value for a field (proto3 "last one wins"). */
  int(field: number): number | undefined {
    const list = this.map.get(field);
    const f = list?.[list.length - 1];
    return f && f.wire === 0 ? (f.value as number) : undefined;
  }

  bytes(field: number): Uint8Array | undefined {
    const list = this.map.get(field);
    const f = list?.[list.length - 1];
    return f && f.wire === 2 ? (f.value as Uint8Array) : undefined;
  }

  allBytes(field: number): Uint8Array[] {
    return (this.map.get(field) ?? []).filter((f) => f.wire === 2).map((f) => f.value as Uint8Array);
  }

  string(field: number): string | undefined {
    const b = this.bytes(field);
    return b ? dec.decode(b) : undefined;
  }

  message(field: number): PbMessage | undefined {
    const b = this.bytes(field);
    return b ? new PbMessage(b) : undefined;
  }

  /** A float field. Accepts fixed32 (what MentraOS observed for IMU) and fixed64/double is skipped. */
  float(field: number): number | undefined {
    const list = this.map.get(field);
    const f = list?.[list.length - 1];
    if (!f || f.wire !== 5) return undefined;
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, f.value as number, true);
    return new DataView(b.buffer).getFloat32(0, true);
  }
}

export const utf8 = {
  encode: (s: string) => enc.encode(s),
  decode: (b: Uint8Array) => dec.decode(b),
  byteLength: (s: string) => enc.encode(s).length,
};

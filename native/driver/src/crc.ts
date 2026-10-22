/**
 * CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR.
 * Check value: crc16("123456789") === 0x29B1.
 *
 * G2 computes it over the protobuf payload only (not the 8-byte header), concatenated across all
 * fragments of a message, and appends it little-endian to the LAST fragment.
 * Verified against a real captured packet (see test/crc.test.ts).
 */

const TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

export function crc16(data: Uint8Array, init = 0xffff): number {
  let crc = init;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) & 0xffff) ^ TABLE[((crc >> 8) ^ data[i]!) & 0xff]!;
  }
  return crc;
}

/**
 * The byte-wise shift/xor formulation MentraOS uses (G2.kt `g2Crc16`). Kept to prove in tests that
 * it is the same CRC as the table version, so captures from either code base are comparable.
 */
export function crc16Mentra(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc >> 8) | ((crc << 8) & 0xff00)) ^ data[i]!;
    crc ^= (crc & 0xff) >> 4;
    crc ^= (crc << 12) & 0xffff;
    crc ^= ((crc & 0xff) << 5) & 0xffff;
  }
  return crc & 0xffff;
}

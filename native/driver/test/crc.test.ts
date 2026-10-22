import { test } from "node:test";
import assert from "node:assert/strict";
import { crc16, crc16Mentra } from "../src/crc.ts";
import { buildPackets, fromHex, hex, parsePacket } from "../src/framing.ts";
import { utf8 } from "../src/protobuf.ts";

test("CRC-16/CCITT-FALSE check value", () => {
  assert.equal(crc16(utf8.encode("123456789")), 0x29b1);
  assert.equal(crc16(new Uint8Array(0)), 0xffff);
});

test("MentraOS byte-wise CRC formulation is the same CRC", () => {
  let seed = 7;
  for (let n = 0; n < 200; n++) {
    const data = Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) & 0xff));
    assert.equal(crc16Mentra(data), crc16(data), `len ${n}`);
  }
});

// Real packet captured from the official Even App (btsnoop), published in g2-kit-unofficial
// ble/messages.ts as PRELUDE_F5872: sid 0x01 (dashboard) Cmd 2, sync id 0x92, flag 0x20.
const CAPTURED = "aa21921301010120" + "0802109c01220a1a0812061204080010" + "00" + "a142";

test("captured Even App packet: CRC matches and our framer reproduces it byte for byte", () => {
  const raw = fromHex(CAPTURED);
  const p = parsePacket(raw)!;
  assert.equal(p.service, 0x01);
  assert.equal(p.syncId, 0x92);
  assert.equal(p.total, 1);
  assert.equal(p.crc, 0x42a1);
  assert.equal(crc16(p.chunk), p.crc);
  const rebuilt = buildPackets(p.chunk, { syncId: 0x92, service: 0x01, flag: 0x20 });
  assert.equal(rebuilt.length, 1);
  assert.equal(hex(rebuilt[0]!), CAPTURED);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Counter8, Reassembler, buildPackets, fromHex, hex, parsePacket } from "../src/framing.ts";
import { crc16 } from "../src/crc.ts";
import { auth, pipeRoleChange, timeSync } from "../src/messages/device.ts";
import { PbWriter } from "../src/protobuf.ts";
import { rxPackets } from "./helpers.ts";

const withCrc = (header: string, payload: string) => {
  const p = fromHex(payload);
  const c = crc16(p);
  return header + payload + hex(Uint8Array.of(c & 0xff, c >> 8));
};

// i-soxi/even-g2-protocol examples/teleprompter/teleprompter.py hard-codes the first handshake
// packets the Even App sends (header + protobuf); CRC added by their add_crc().
test("AUTH packet matches the even-g2-protocol capture", () => {
  const pkt = buildPackets(auth(0x0c), { syncId: 0x01, service: 0x80 })[0]!;
  assert.equal(hex(pkt), withCrc("aa21010c01018000", "0804100c1a0408011004"));
});

test("PIPE_ROLE_CHANGE (role 2, as in the capture) matches", () => {
  const pkt = buildPackets(pipeRoleChange(0x0e, 2), { syncId: 0x02, service: 0x80, flag: 0x20 })[0]!;
  assert.equal(hex(pkt), withCrc("aa21020a01018020", "0805100e22020802"));
});

test("TIME_SYNC uses field 128 (tag 82 08) like the capture", () => {
  const p = timeSync(0x0f, new Date(0));
  assert.equal(hex(p.subarray(0, 6)), "088001100f82");
  assert.equal(p[6], 0x08);
});

test("negative int32 encodes as 10-byte varint (the capture's E8 FF..FF 01 field)", () => {
  assert.equal(hex(new PbWriter().varint(-24).finish()), "e8ffffffffffffffff01");
  assert.equal(hex(new PbWriter().varint(300).finish()), "ac02");
});

test("single packet: length byte counts payload + CRC, flag defaults per service", () => {
  const [a] = buildPackets(Uint8Array.of(1, 2, 3), { syncId: 5, service: 0xe0 });
  assert.deepEqual(Array.from(a!.subarray(0, 8)), [0xaa, 0x21, 5, 5, 1, 1, 0xe0, 0x20]);
  const [b] = buildPackets(Uint8Array.of(1), { syncId: 5, service: 0x80 });
  assert.equal(b![7], 0x00);
});

test("empty payload still yields one packet carrying the CRC", () => {
  const ps = buildPackets(new Uint8Array(0), { syncId: 1, service: 0xe0 });
  assert.equal(ps.length, 1);
  assert.equal(ps[0]![3], 2);
  assert.equal(hex(ps[0]!.subarray(8)), "ffff");
});

test("multi-packet: 236-byte chunks, constant sync id, serials 1..N, CRC of whole payload on the last", () => {
  const payload = Uint8Array.from({ length: 600 }, (_, i) => i & 0xff);
  const ps = buildPackets(payload, { syncId: 0x33, service: 0xe0 });
  assert.equal(ps.length, 3);
  assert.deepEqual(ps.map((p) => p[2]), [0x33, 0x33, 0x33]);
  assert.deepEqual(ps.map((p) => p[4]), [3, 3, 3]);
  assert.deepEqual(ps.map((p) => p[5]), [1, 2, 3]);
  assert.deepEqual(ps.map((p) => p[3]), [236, 236, 128 + 2]);
  const crc = crc16(payload);
  const last = ps[2]!;
  assert.equal(last[last.length - 2]! | (last[last.length - 1]! << 8), crc);
});

test("payload that exactly fills the last chunk gets a CRC-only trailing packet", () => {
  const ps = buildPackets(new Uint8Array(236), { syncId: 1, service: 0xe0 });
  assert.equal(ps.length, 2);
  assert.equal(ps[0]![3], 236);
  assert.equal(ps[1]![3], 2);
  assert.equal(ps[1]!.length, 10);
});

test("reassembler round trip and CRC check", () => {
  const payload = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff);
  const r = new Reassembler();
  const pk = rxPackets(0xe0, payload, 9);
  for (const p of pk.slice(0, -1)) assert.equal(r.push(p, "R"), null);
  const m = r.push(pk[pk.length - 1]!, "R")!;
  assert.deepEqual(m.payload, payload);
  assert.equal(m.crcOk, true);
  assert.equal(m.service, 0xe0);
});

test("reassembler keeps lenses apart when they reuse a sync id", () => {
  const a = rxPackets(0xe0, new Uint8Array(300).fill(0xaa), 7);
  const b = rxPackets(0xe0, new Uint8Array(300).fill(0xbb), 7);
  const r = new Reassembler();
  r.push(a[0]!, "L");
  r.push(b[0]!, "R");
  const ma = r.push(a[1]!, "L")!;
  const mb = r.push(b[1]!, "R")!;
  assert.ok(ma.payload.every((x) => x === 0xaa));
  assert.ok(mb.payload.every((x) => x === 0xbb));
});

test("non-zero result code in the status byte drops the message", () => {
  const r = new Reassembler();
  const [p] = rxPackets(0xe0, Uint8Array.of(8, 1), 1, 0x02);
  assert.equal(parsePacket(p!)!.resultCode, 1);
  assert.equal(r.push(p!), null);
  assert.equal(r.rejected, 1);
});

test("out-of-order fragment resets the partial message", () => {
  const pk = rxPackets(0xe0, new Uint8Array(600), 3);
  const r = new Reassembler();
  r.push(pk[0]!);
  assert.equal(r.push(pk[2]!), null);
  assert.equal(r.push(pk[1]!), null);
});

test("garbage is ignored", () => {
  const r = new Reassembler();
  assert.equal(r.push(Uint8Array.of(1, 2, 3)), null);
  assert.equal(r.push(fromHex("aa1201ff01010e00")), null); // claims 255 bytes, has none
});

test("Counter8 wraps at 256", () => {
  const c = new Counter8(254);
  assert.deepEqual([c.next(), c.next(), c.next()], [254, 255, 0]);
});

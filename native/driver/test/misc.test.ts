import { test } from "node:test";
import assert from "node:assert/strict";
import { build4BitBmp, solid } from "../src/bmp.ts";
import { AudioDeduper, audioTrailer, pcmToBytes, splitAudioPacket } from "../src/audio.ts";
import { formatMac, parseMac, parseRingNotification, r1AdvStart, ringIdFromName } from "../src/r1.ts";
import { parseG2Manufacturer, sideFromName } from "../src/transport.ts";
import { ringConnectInfo } from "../src/messages/device.ts";
import { hex } from "../src/framing.ts";
import { PbMessage } from "../src/protobuf.ts";

test("4-bit BMP: headers, palette, bottom-up rows, high nibble first, rows padded to 4 bytes", () => {
  // 4x2 image: top row 0,17,34,51 -> indices 0,1,2,3 ; bottom row 255,238,221,204 -> 15,14,13,12
  const bmp = build4BitBmp({ width: 4, height: 2, pixels: Uint8Array.of(0, 17, 34, 51, 255, 238, 221, 204) });
  const v = new DataView(bmp.buffer);
  assert.equal(String.fromCharCode(bmp[0]!, bmp[1]!), "BM");
  assert.equal(v.getUint32(2, true), bmp.length);
  assert.equal(v.getUint32(10, true), 118);
  assert.equal(v.getUint16(28, true), 4);
  assert.equal(v.getUint32(46, true), 16);
  assert.deepEqual(Array.from(bmp.subarray(54 + 15 * 4, 54 + 16 * 4)), [255, 255, 255, 0]);
  assert.equal(bmp.length, 118 + 2 * 4);
  assert.deepEqual(Array.from(bmp.subarray(118, 122)), [0xfe, 0xdc, 0, 0]); // first stored row = bottom
  assert.deepEqual(Array.from(bmp.subarray(122, 126)), [0x01, 0x23, 0, 0]);
});

test("BMP of a full 288x144 tile fits in 6 image fragments", () => {
  const bmp = build4BitBmp(solid(288, 144, 255));
  assert.equal(bmp.length, 118 + 144 * 144);
  assert.equal(Math.ceil(bmp.length / 4096), 6);
});

test("audio: 200 bytes = five 40-byte LC3 frames; trailer kept separately; runts ignored", () => {
  const pkt = Uint8Array.from({ length: 205 }, (_, i) => i);
  const frames = splitAudioPacket(pkt);
  assert.equal(frames.length, 5);
  assert.equal(frames[4]![0], 160);
  assert.deepEqual(Array.from(audioTrailer(pkt)), [200, 201, 202, 203, 204]);
  assert.equal(splitAudioPacket(new Uint8Array(30)).length, 0);
});

test("audio dedupe drops the second lens' identical packet", () => {
  const d = new AudioDeduper();
  const a = new Uint8Array(200).fill(1);
  assert.equal(d.accept(a), true);
  assert.equal(d.accept(Uint8Array.from(a)), false);
  assert.equal(d.accept(new Uint8Array(200).fill(2)), true);
});

test("pcm bytes are s16le", () => {
  assert.equal(hex(pcmToBytes(Int16Array.of(1, -2))), "0100feff");
});

test("R1 notifications (MentraOS R1.kt formats)", () => {
  assert.deepEqual(parseRingNotification(Uint8Array.of(0xff, 0x04, 0x01)), { kind: "gesture", gesture: "tap" });
  assert.deepEqual(parseRingNotification(Uint8Array.of(0xff, 0x04, 0x02)), { kind: "gesture", gesture: "double_tap" });
  assert.deepEqual(parseRingNotification(Uint8Array.of(0xff, 0x03, 0x00)), { kind: "gesture", gesture: "hold" });
  assert.deepEqual(parseRingNotification(Uint8Array.of(0xff, 0x05, 0x10)), { kind: "gesture", gesture: "swipe_up" });
  assert.deepEqual(parseRingNotification(Uint8Array.of(0xff, 0x05, 0xf0)), { kind: "gesture", gesture: "swipe_down" });
  assert.deepEqual(parseRingNotification(Uint8Array.of(1, 2, 0xff, 0x04, 0x01, 9)), { kind: "gesture", gesture: "tap" });
  assert.deepEqual(parseRingNotification(Uint8Array.of(76, 0)), { kind: "battery", level: 76 });
  assert.deepEqual(parseRingNotification(Uint8Array.of(1)), { kind: "state", state: "ready" });
});

test("R1 advStart and glasses-side ring binding", () => {
  const mac = parseMac("1B:08:26:8E:0E:E6");
  assert.equal(formatMac(mac), "1B:08:26:8E:0E:E6");
  assert.equal(hex(r1AdvStart(mac)), "0000091b08268e0ee6");
  const m = new PbMessage(ringConnectInfo(3, true, mac, "EVEN R1_CEC5BA"));
  assert.equal(m.int(1), 6);
  const r = m.message(5)!;
  assert.equal(r.int(1), 1);
  assert.equal(hex(r.bytes(2)!), "1b08268e0ee6");
  assert.equal(r.string(3), "EVEN R1_CEC5BA");
  assert.equal(ringIdFromName("EVEN R1_CEC5BA"), "CEC5BA");
});

test("G2 advertisement: side from name, serial + reversed MAC from manufacturer data", () => {
  assert.equal(sideFromName("Even G2_32_L_1A2B3C"), "left");
  assert.equal(sideFromName("Even G2_32_R_1A2B3C"), "right");
  assert.equal(sideFromName("Even G1_32_L_1A2B3C"), null);
  const md = new Uint8Array(20);
  md.set(new TextEncoder().encode("S110LABC123456"), 0);
  md.set([0x66, 0x55, 0x44, 0x33, 0x22, 0x11], 14);
  assert.deepEqual(parseG2Manufacturer(md), { serial: "S110LABC123456", mac: "11:22:33:44:55:66" });
});

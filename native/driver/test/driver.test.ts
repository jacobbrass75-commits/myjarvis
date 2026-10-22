import { test } from "node:test";
import assert from "node:assert/strict";
import { G2Driver } from "../src/driver.ts";
import { MockPeripheral } from "../src/transports/mock.ts";
import { G2_UUID } from "../src/constants.ts";
import { Reassembler, parsePacket } from "../src/framing.ts";
import { PbMessage, PbWriter } from "../src/protobuf.ts";
import { rxPackets, tick } from "./helpers.ts";

const W = G2_UUID.write;

function lenses() {
  return { L: new MockPeripheral("L", "Even G2_32_L_ABC"), R: new MockPeripheral("R", "Even G2_32_R_ABC") };
}

/** Decode everything written to a lens back into (service, protobuf) messages. */
function sent(p: MockPeripheral) {
  const r = new Reassembler();
  const out: { service: number; m: PbMessage }[] = [];
  for (const w of p.writes.filter((w) => w.characteristic === W)) {
    const msg = r.push(w.data);
    if (msg) out.push({ service: msg.service, m: new PbMessage(msg.payload) });
  }
  return out;
}

const fast = { stepDelayMs: 0, packetGapMs: 0, heartbeatMs: 0, imageAckTimeoutMs: 100 };

test("handshake: AUTH to both lenses, then PIPE_ROLE + TIME_SYNC to the right lens; notify+audio subscribed", async () => {
  const { L, R } = lenses();
  const g2 = await G2Driver.attach(L, R, fast);
  for (const p of [L, R]) {
    assert.ok(p.subscribed(G2_UUID.notify));
    assert.ok(p.subscribed(G2_UUID.audioNotify));
  }
  assert.deepEqual(sent(L).map((x) => [x.service, x.m.int(1)]), [[0x80, 4]]);
  assert.deepEqual(sent(R).map((x) => [x.service, x.m.int(1)]), [[0x80, 4], [0x80, 5], [0x80, 128]]);
  assert.ok(L.writes.every((w) => w.withoutResponse));
  await g2.close();
});

test("auth ACK from the glasses marks the lens authenticated", async () => {
  const { L, R } = lenses();
  const g2 = await G2Driver.attach(L, R, fast);
  const ack = new PbWriter().int(1, 4).int(2, 0).message(3, new PbWriter().int(1, 1)).finish();
  for (const p of rxPackets(0x80, ack)) R.notify(G2_UUID.notify, p);
  assert.deepEqual(g2.authenticated, { left: false, right: true });
  await g2.close();
});

test("first createPage is CREATE (cmd 0), later ones REBUILD (cmd 7); UI goes to the right lens only", async () => {
  const { L, R } = lenses();
  const g2 = await G2Driver.attach(L, R, fast);
  const page = { text: [{ id: 1, x: 0, y: 0, width: 576, height: 288, captureEvents: true, content: "a" }] };
  await g2.createPage(page);
  await g2.createPage(page);
  await g2.setText(1, "b");
  const hub = sent(R).filter((x) => x.service === 0xe0).map((x) => x.m.int(1));
  assert.deepEqual(hub, [0, 7, 5]);
  assert.equal(sent(L).length, 1);
  assert.ok(R.writes.filter((w) => parsePacket(w.data)!.service === 0xe0).every((w) => w.data[7] === 0x20));
  await g2.close();
});

test("multi-packet messages are never interleaved on a lens", async () => {
  const { L, R } = lenses();
  const g2 = await G2Driver.attach(L, R, { ...fast, packetGapMs: 2 });
  R.writes.length = 0;
  const long = "x".repeat(900);
  await Promise.all([g2.setText(1, long), g2.setText(2, long), g2.setText(3, "short")]);
  const syncs = R.writes.map((w) => w.data[2]);
  const runs = syncs.filter((s, i) => i === 0 || s !== syncs[i - 1]);
  assert.equal(new Set(runs).size, runs.length, `interleaved: ${syncs.join(",")}`);
  await g2.close();
});

test("image upload waits for each fragment ACK and succeeds", async () => {
  const { L, R } = lenses();
  const g2 = await G2Driver.attach(L, R, fast);
  const rx = new Reassembler();
  R.onWrite = (_c, data) => {
    const msg = rx.push(data);
    if (!msg || msg.service !== 0xe0) return;
    const m = new PbMessage(msg.payload);
    if (m.int(1) !== 3) return;
    const f = m.message(5)!;
    const ack = new PbWriter().int(1, 4).int(2, 0).message(6, new PbWriter().int(1, f.int(1)!).int(3, f.int(3)!).int(6, f.int(6) ?? 0).int(8, 4)).finish();
    setTimeout(() => rxPackets(0xe0, ack).forEach((p) => R.notify(G2_UUID.notify, p)), 1);
  };
  const ok = await g2.setImage(5, { width: 288, height: 144, pixels: new Uint8Array(288 * 144).fill(200) }, "img");
  assert.equal(ok, true);
  const frags = sent(R).filter((x) => x.service === 0xe0 && x.m.int(1) === 3);
  assert.equal(frags.length, 6);
  await g2.close();
});

test("image upload retries with a new session on failure ACK, then gives up", async () => {
  const { L, R } = lenses();
  const g2 = await G2Driver.attach(L, R, { ...fast, imageAttempts: 2 });
  const rx = new Reassembler();
  R.onWrite = (_c, data) => {
    const msg = rx.push(data);
    if (!msg) return;
    const m = new PbMessage(msg.payload);
    if (m.int(1) !== 3) return;
    const f = m.message(5)!;
    const nack = new PbWriter().int(1, 4).message(6, new PbWriter().int(3, f.int(3)!).int(6, f.int(6) ?? 0).int(8, 5)).finish();
    setTimeout(() => rxPackets(0xe0, nack).forEach((p) => R.notify(G2_UUID.notify, p)), 1);
  };
  assert.equal(await g2.setImage(5, new Uint8Array(100)), false);
  const sessions = sent(R).filter((x) => x.m.int(1) === 3).map((x) => x.m.message(5)!.int(3));
  assert.deepEqual(sessions, [1, 2]);
  await g2.close();
});

test("onInput gets ring and temple gestures; the other lens' echo is dropped", async () => {
  const { L, R } = lenses();
  const g2 = await G2Driver.attach(L, R, fast);
  const got: string[] = [];
  g2.onInput((g, s) => got.push(`${g}/${s}`));
  const ev = (type: number, src: number) =>
    rxPackets(0xe0, new PbWriter().int(1, 2).message(13, new PbWriter().message(3, new PbWriter().int(1, type).int(2, src))).finish());
  ev(3, 2).forEach((p) => R.notify(G2_UUID.notify, p));
  ev(3, 2).forEach((p) => L.notify(G2_UUID.notify, p)); // echo
  ev(0, 1).forEach((p) => R.notify(G2_UUID.notify, p));
  assert.deepEqual(got, ["double_tap/ring", "tap/glasses_right"]);
  ev(7, 0).forEach((p) => R.notify(G2_UUID.notify, p));
  assert.equal(g2.pageAlive, false);
  await g2.close();
});

test("mic: audioControl on the right lens, LC3 frames delivered once, decoder output as s16le", async () => {
  const { L, R } = lenses();
  const g2 = await G2Driver.attach(L, R, { ...fast, lc3: { decodeFrame: () => new Int16Array(160).fill(1) } });
  const chunks: { frames: number; pcm: number }[] = [];
  await g2.startMic(({ lc3Frames, pcm }) => chunks.push({ frames: lc3Frames.length, pcm: pcm?.length ?? 0 }));
  const audio = new Uint8Array(205).fill(9);
  L.notify(G2_UUID.audioNotify, audio);
  R.notify(G2_UUID.audioNotify, audio);
  assert.deepEqual(chunks, [{ frames: 5, pcm: 5 * 160 * 2 }]);
  const last = sent(R).at(-1)!;
  assert.equal(last.m.int(1), 15);
  assert.equal(last.m.message(18)!.int(1), 1);
  await g2.close();
});

test("heartbeat: dev-settings always, EvenHub once a page exists", async () => {
  const { L, R } = lenses();
  const g2 = await G2Driver.attach(L, R, { ...fast, heartbeatMs: 20 });
  await tick(30);
  await g2.createPage({ text: [{ id: 1, x: 0, y: 0, width: 100, height: 100, captureEvents: true }] });
  await tick(30);
  await g2.close();
  const cmds = sent(R).map((x) => `${x.service.toString(16)}:${x.m.int(1)}`);
  assert.ok(cmds.includes("80:14"), cmds.join(" "));
  assert.ok(cmds.includes("e0:12"), cmds.join(" "));
  assert.ok(cmds.indexOf("e0:12") > cmds.indexOf("e0:0"));
});

test("device info reply updates battery", async () => {
  const { L, R } = lenses();
  const g2 = await G2Driver.attach(L, R, fast);
  const p = g2.requestDeviceInfo(500);
  const reply = new PbWriter().int(1, 2).message(4, new PbWriter().int(12, 64).int(13, 0)).finish();
  rxPackets(0x09, reply).forEach((x) => R.notify(G2_UUID.notify, x));
  assert.deepEqual(await p, { battery: 64, charging: false });
  await g2.close();
});

test("optional dashboard prelude reproduces the captured Even App payload (with our magic)", async () => {
  const { L, R } = lenses();
  const g2 = await G2Driver.attach(L, R, { ...fast, dashboardPrelude: true });
  const dash = R.writes.map((w) => parsePacket(w.data)!).find((p) => p.service === 0x01)!;
  // Captured: 08 02 10 9c01 22 0a 1a 08 12 06 12 04 08 00 10 00 (magic 0x9c there, 4 here)
  assert.equal(Buffer.from(dash.chunk).toString("hex"), "08021004220a1a0812061204080010" + "00");
  await g2.close();
});

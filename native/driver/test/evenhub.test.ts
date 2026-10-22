import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PageError,
  audioControl,
  createPage,
  heartbeat,
  imageMessages,
  imuControl,
  parseHubPayload,
  rebuildPage,
  textContainerProperty,
  updateText,
} from "../src/messages/evenhub.ts";
import { parseDevPayload, parseSettingPayload } from "../src/messages/device.ts";
import { fromHex, hex } from "../src/framing.ts";
import { PbMessage, PbWriter } from "../src/protobuf.ts";

const page = { text: [{ id: 1, name: "main", x: 0, y: 0, width: 576, height: 288, captureEvents: true, content: "hi" }] };

test("text container property field layout (G2.kt order)", () => {
  // 1 x, 2 y, 3 w, 4 h, 5..8 border/padding, 9 id, 10 name, 11 capture, 12 content
  assert.equal(hex(textContainerProperty(page.text[0]!)), "0800" + "1000" + "18c004" + "20a002" + "2800300038004000" + "4801" + "52046d61696e" + "5801" + "62026869");
});

test("createPage wraps CreateStartUpPageContainer in cmd 0 / field 3", () => {
  const m = new PbMessage(createPage(page, 5));
  assert.equal(m.int(1), 0);
  assert.equal(m.int(2), 5);
  const c = m.message(3)!;
  assert.equal(c.int(1), 1);
  assert.equal(c.allBytes(3).length, 1);
});

test("rebuildPage uses cmd 7 / field 7, list containers go in field 2, images in field 4", () => {
  const spec = {
    list: [{ id: 2, name: "menu", x: 0, y: 0, width: 300, height: 200, captureEvents: true, items: ["a", "b"] }],
    image: [{ id: 3, name: "pic", x: 300, y: 0, width: 200, height: 100 }],
  };
  const m = new PbMessage(rebuildPage(spec));
  assert.equal(m.int(1), 7);
  const c = m.message(7)!;
  assert.equal(c.int(1), 2);
  const list = new PbMessage(c.allBytes(2)[0]!);
  assert.equal(list.int(9), 2);
  assert.equal(list.int(12), 1);
  const items = list.message(11)!;
  assert.equal(items.int(1), 2);
  assert.deepEqual(items.allBytes(4).map((b) => new TextDecoder().decode(b)), ["a", "b"]);
  assert.equal(new PbMessage(c.allBytes(4)[0]!).int(5), 3);
});

test("page validation mirrors the SDK rules", () => {
  assert.throws(() => createPage({ text: [{ ...page.text[0]!, captureEvents: false }] }), PageError);
  assert.throws(() => createPage({ text: [{ ...page.text[0]!, content: "" }] }), PageError);
  assert.throws(() => createPage({ text: [{ ...page.text[0]!, content: "x".repeat(1001) }] }), PageError);
  assert.throws(() => createPage({ text: [page.text[0]!], image: [{ id: 2, x: 0, y: 0, width: 300, height: 100 }] }), PageError);
  assert.throws(() => createPage({ text: [page.text[0]!, { ...page.text[0]!, name: "b", captureEvents: false }] }), /duplicate container id/);
});

test("text upgrade: cmd 5, field 9 {1 id, 3 offset, 4 byte length, 5 content}", () => {
  const m = new PbMessage(updateText(4, "héllo"));
  assert.equal(m.int(1), 5);
  const u = m.message(9)!;
  assert.equal(u.int(1), 4);
  assert.equal(u.int(3), 0);
  assert.equal(u.int(4), 6); // UTF-8 bytes, not chars
  assert.equal(u.string(5), "héllo");
});

test("heartbeat, audio and IMU control payloads", () => {
  assert.equal(hex(heartbeat(3)), "080c10037200");
  assert.equal(hex(audioControl(true, 1)), "080f1001920102" + "0801");
  assert.equal(hex(audioControl(false)), "080f1000920102" + "0800");
  const imu = new PbMessage(imuControl(true, 500));
  assert.equal(imu.int(1), 19);
  assert.equal(imu.message(20)!.int(2), 500);
});

test("image is split into 4096-byte fragments sharing one session id", () => {
  const bmp = new Uint8Array(10000).fill(1);
  const msgs = imageMessages(7, bmp, 42, "img");
  assert.equal(msgs.length, 3);
  const frags = msgs.map((m) => new PbMessage(m).message(5)!);
  assert.deepEqual(frags.map((f) => f.int(3)), [42, 42, 42]);
  assert.deepEqual(frags.map((f) => f.int(6)), [0, 1, 2]);
  assert.deepEqual(frags.map((f) => f.int(7)), [4096, 4096, 1808]);
  assert.deepEqual(frags.map((f) => f.int(4)), [10000, 10000, 10000]);
  assert.equal(frags[0]!.string(2), "img");
});

// ---- glasses -> host. Fixtures: payload hex strings MentraOS G2.kt matches on real traffic.
test("heartbeat ACK 080C7A02100C (G2.kt)", () => {
  assert.deepEqual(parseHubPayload(fromHex("080C7A02100C")), [{ kind: "heartbeat_ack", count: undefined }]);
});

test("text upgrade ACK 080652020808 = text_success (G2.kt)", () => {
  assert.deepEqual(parseHubPayload(fromHex("080652020808")), [{ kind: "result", cmd: 6, code: 8 }]);
});

const sysEvent = (fields: PbWriter) => new PbWriter().int(1, 2).int(2, 0).message(13, new PbWriter().message(3, fields)).finish();

test("ring double tap: Sys_ItemEvent {1: 3, 2: 2}", () => {
  assert.deepEqual(parseHubPayload(sysEvent(new PbWriter().int(1, 3).int(2, 2))), [{ kind: "input", gesture: "double_tap", source: "ring", via: "sys" }]);
});

test("proto3 drops eventType 0, so an empty Sys_ItemEvent is a CLICK; left temple source = 3", () => {
  assert.deepEqual(parseHubPayload(sysEvent(new PbWriter().int(2, 3))), [{ kind: "input", gesture: "tap", source: "glasses_left", via: "sys" }]);
});

test("long press / release (SDK 0.0.16 event types 9, 10)", () => {
  assert.equal((parseHubPayload(sysEvent(new PbWriter().int(1, 9).int(2, 1)))[0] as { gesture: string }).gesture, "long_press");
  assert.equal((parseHubPayload(sysEvent(new PbWriter().int(1, 10).int(2, 1)))[0] as { gesture: string }).gesture, "long_press_release");
});

test("IMU report with fixed32 floats", () => {
  const imu = new PbWriter().float(1, 0.5).float(2, -0.25).float(3, 1);
  const [e] = parseHubPayload(sysEvent(new PbWriter().int(1, 8).message(3, imu)));
  assert.deepEqual(e, { kind: "imu", x: 0.5, y: -0.25, z: 1 });
});

test("text and list item events", () => {
  const text = new PbWriter().int(1, 2).message(13, new PbWriter().message(2, new PbWriter().int(1, 4).string(2, "main").int(3, 1))).finish();
  assert.deepEqual(parseHubPayload(text), [{ kind: "input", gesture: "scroll_up", source: "unknown", via: "text", containerId: 4, containerName: "main" }]);
  const list = new PbWriter().int(1, 2).message(13, new PbWriter().message(1, new PbWriter().int(1, 2).string(2, "menu").string(3, "b").int(4, 1))).finish();
  assert.deepEqual(parseHubPayload(list), [{ kind: "input", gesture: "tap", source: "unknown", via: "list", containerId: 2, containerName: "menu", itemName: "b", itemIndex: 1 }]);
});

test("image fragment ACK carries session, index, error code", () => {
  const ack = new PbWriter().int(1, 4).int(2, 0).message(6, new PbWriter().int(1, 7).int(3, 42).int(6, 2).int(8, 4)).finish();
  assert.deepEqual(parseHubPayload(ack), [{ kind: "result", cmd: 4, code: 4, sessionId: 42, fragmentIndex: 2 }]);
});

test("menu selection (cmd 17, field 20)", () => {
  assert.deepEqual(parseHubPayload(new PbWriter().int(1, 17).message(20, new PbWriter().int(1, 9)).finish()), [{ kind: "menu_select", appId: 9 }]);
});

test("device settings: auth ack and battery/firmware", () => {
  assert.deepEqual(parseDevPayload(new PbWriter().int(1, 4).int(2, 1).message(3, new PbWriter().int(1, 1)).finish()), { kind: "auth", ok: true });
  const info = new PbWriter().int(1, 2).int(2, 1).message(4, new PbWriter().string(5, "2.2.20").string(6, "2.2.20").int(12, 87).int(13, 1)).finish();
  assert.deepEqual(parseSettingPayload(info), { battery: 87, charging: true, firmwareLeft: "2.2.20", firmwareRight: "2.2.20" });
});

// The glasses page's image path, offline: the BMP encoder (byte-equal to G2Kit's build4BitBmp), the
// iPhone app's native image call (base64 BMP), identical frames not re-sent, tiles pushed only when
// their pixels change, a slow push collapsing later frames into the latest one, and the fallback to
// the SDK's PNG path when the native call fails.
//   node --import tsx --test scripts/image-path-test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToBase64, encodeGray4Bmp } from "../glasses/src/png.ts";
import { Raster } from "../src/shared/raster.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("encodeGray4Bmp matches G2Kit's build4BitBmp (MiscTests.fourBitBmpMatchesThePageEncoder)", () => {
  const bmp = encodeGray4Bmp(Uint8Array.from([0, 1, 2, 15, 8, 0]), 3, 2);
  assert.equal(
    Buffer.from(bmp).toString("hex"),
    "424d7e0000000000000076000000280000000300000002000000010004000000000008000000130b0000130b00001000000000000000" +
      "00000000111111002222220033333300444444005555550066666600777777008888880099999900aaaaaa00bbbbbb00cccccc00dddddd00eeeeee00ffffff00" +
      "f800000001200000",
  );
  assert.equal(encodeGray4Bmp(new Uint8Array(288 * 144), 288, 144).length, 20854);
});

test("bytesToBase64 equals Buffer's base64 (chunked path)", () => {
  const b = new Uint8Array(20854 + 0x8000).map((_, i) => (i * 131) & 255);
  assert.equal(bytesToBase64(b), Buffer.from(b).toString("base64"));
  assert.equal(bytesToBase64(new Uint8Array(0)), "");
});

test("core: native image call, no resend of identical frames, latest-wins while a push is slow, SDK fallback", async () => {
  const core = await import("../glasses/src/core.ts");
  const calls = [];
  let gate = null; // when set, native pushes wait for it
  let fail = false;
  globalThis.__jarvisImageHost = 1;
  globalThis.flutter_inappwebview = {
    async callHandler(name, req) {
      assert.equal(name, "jarvisImage");
      if (fail) throw new Error("no method");
      calls.push(req);
      if (gate) await gate;
      return "success";
    },
  };
  const sdkImages = [];
  core.core.bridge = {
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => true,
    textContainerUpgrade: async () => true,
    updateImageRawData: async (u) => (sdkImages.push(u), "success"),
    audioControl: async () => true,
  };
  let px = new Uint8Array(144 * 72).fill(3);
  core.core.stack = [{ id: "game", title: "", screen: () => ({ header: "G", pixels: px }), gesture: () => false }];

  core.render();
  await core.rendered();
  assert.equal(calls.length, 1);
  const req = calls[0];
  assert.equal(req.containerID, 4);
  assert.equal(req.containerName, "picture");
  assert.equal(typeof req.sentAt, "number");
  assert.equal(typeof req.encodeMs, "number");
  // The 2x-scaled frame as the BMP the lenses take.
  assert.deepEqual(new Uint8Array(Buffer.from(req.bmp, "base64")), encodeGray4Bmp(new Uint8Array(288 * 144).fill(3), 288, 144));

  // The same frame again: nothing goes out.
  core.render();
  await core.rendered();
  core.render();
  await core.rendered();
  assert.equal(calls.length, 1);

  // While one push is slow, later frames collapse into the newest.
  let release;
  gate = new Promise((r) => (release = r));
  px = new Uint8Array(144 * 72).fill(5);
  core.render();
  await tick(5);
  assert.equal(calls.length, 2);
  for (const v of [6, 7, 8]) {
    px = new Uint8Array(144 * 72).fill(v);
    core.render();
    await tick(1);
  }
  assert.equal(calls.length, 2); // nothing queued up behind the slow push
  gate = null;
  release();
  await core.rendered();
  await core.rendered();
  assert.equal(calls.length, 3);
  const last = new Uint8Array(Buffer.from(calls[2].bmp, "base64"));
  assert.equal(last[118], 0x88); // first stored pixels are level 8: frames 6 and 7 never went out

  // An app without the native call: fall back to the SDK's PNG path for the rest of the session.
  fail = true;
  px = new Uint8Array(144 * 72).fill(9);
  core.render();
  await core.rendered();
  assert.equal(sdkImages.length, 1);
  assert.deepEqual(sdkImages[0].imageData.slice(0, 4), [137, 80, 78, 71]);
  fail = false;
  px = new Uint8Array(144 * 72).fill(10);
  core.render();
  await core.rendered();
  assert.equal(calls.length, 3);
  assert.equal(sdkImages.length, 2);

  core.core.bridge = null;
  core.core.stack = [];
  delete globalThis.flutter_inappwebview;
  delete globalThis.__jarvisImageHost;
});

test("core: tiles go out only when their pixels change (plus the one resend after a new page)", async () => {
  const core = await import("../glasses/src/core.ts");
  const pushed = [];
  core.core.bridge = {
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => true,
    textContainerUpgrade: async () => true,
    updateImageRawData: async (u) => (pushed.push(u.containerName), "success"),
    audioControl: async () => true,
  };
  const a = new Raster(100, 60);
  const b = new Raster(100, 60);
  a.clear(4);
  b.clear(9);
  core.core.stack = [{
    id: "tiles", title: "",
    screen: () => ({ header: "T", tiles: [{ slot: 0, x: 0, y: 40, img: a }, { slot: 1, x: 200, y: 40, img: b }] }),
    gesture: () => false,
  }];
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await core.rendered();
      await tick(1);
    }
  };
  core.render();
  await settle();
  assert.deepEqual(pushed, ["tile0", "tile1", "tile0"]);
  pushed.length = 0;
  core.render();
  await settle();
  assert.deepEqual(pushed, []);
  b.set(3, 3, 15);
  core.render();
  await settle();
  assert.deepEqual(pushed, ["tile1"]);
  core.core.bridge = null;
  core.core.stack = [];
});

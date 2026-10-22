// LENS TEST page 4 (image formats), offline. Its own file: image-path-test.mjs turns the native
// image call off for its process when it tests the SDK fallback.
//   node --import tsx --test scripts/image-lenstest-test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("LENS TEST page 4: one pattern tile per format, forced in the native call, result in the body", async () => {
  const core = await import("../glasses/src/core.ts");
  const { lenstest } = await import("../glasses/src/modes/lenstest.ts");
  const reqs = [];
  globalThis.__jarvisImageHost = 1;
  globalThis.flutter_inappwebview = { callHandler: async (_n, req) => (reqs.push(req), req.format === "rle8" ? "sendFailed" : "success") };
  const texts = [];
  core.core.bridge = {
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => true,
    textContainerUpgrade: async (u) => (texts.push(u.content), true),
    updateImageRawData: async () => "success",
    audioControl: async () => true,
  };
  core.core.stack = [lenstest];
  lenstest.enter();
  for (let i = 0; i < 3; i++) lenstest.gesture("down", 0);
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await core.rendered();
      await tick(1);
    }
  };
  core.render();
  await settle();
  assert.deepEqual([...new Set(reqs.map((r) => r.format))], ["standard"]);
  for (const f of ["rle4", "rle8", "1bit", "lz4", "lz4-frag"]) {
    reqs.length = 0;
    lenstest.gesture("tap", 0);
    core.render();
    await settle();
    assert.deepEqual(reqs.map((r) => r.format), [f], f);
    assert.match(lenstest.screen().body, new RegExp(`${f.toUpperCase()}.*${f === "rle8" ? "SENDFAILED" : "SUCCESS"} IN \\d+ MS`));
  }
  assert.ok(texts.some((t) => t.includes("LZ4-FRAG") && t.includes("SUCCESS")));
  core.core.bridge = null;
  core.core.stack = [];
  delete globalThis.flutter_inappwebview;
  delete globalThis.__jarvisImageHost;
});

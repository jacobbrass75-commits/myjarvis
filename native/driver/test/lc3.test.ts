import { test } from "node:test";
import assert from "node:assert/strict";
import { createLc3Decoder, createLc3Encoder } from "../../lc3.ts";

test("lc3: a 440 Hz tone survives encode → decode at the G2's 40-byte frames", () => {
  const enc = createLc3Encoder(40);
  const dec = createLc3Decoder();
  const n = 160, frames = 50;
  const src = new Int16Array(n * frames);
  for (let i = 0; i < src.length; i++) src[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000));
  const outAll = new Int16Array(src.length);
  for (let f = 0; f < frames; f++) outAll.set(dec.decodeFrame(enc(src.subarray(f * n, (f + 1) * n))), f * n);
  // LC3 adds a short algorithmic delay; find the best alignment, then check correlation.
  let best = 0;
  for (let lag = 0; lag < 200; lag++) {
    let num = 0, a = 0, b = 0;
    for (let i = 800; i < src.length - 200; i++) { num += src[i]! * outAll[i + lag]!; a += src[i]! ** 2; b += outAll[i + lag]! ** 2; }
    best = Math.max(best, num / Math.sqrt(a * b));
  }
  assert.ok(best > 0.95, `correlation ${best.toFixed(3)}`);
});

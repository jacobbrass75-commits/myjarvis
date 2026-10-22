// Node checks for the pixel pipeline: dithering levels, 4-bit pack/unpack, tile wire format, and that
// our greyscale PNGs decode (via Python/Pillow if available) to exactly the dithered levels.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeGrayPng, luminance, pack4, quantize, unpack4ToGray8, predictTileMs } from "../src/gray";
import { decodeTile, encodeTile } from "../src/wire";

const w = 192, h = 144;
const rgba = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const o = (y * w + x) * 4;
  rgba[o] = rgba[o + 1] = rgba[o + 2] = Math.round((x / (w - 1)) * 255);
  rgba[o + 3] = 255;
}
const tone = { gamma: 1, contrast: 1, brightness: 0 };
const lum = luminance(rgba, w, h, tone);
for (const d of ["none", "bayer", "fs"] as const) {
  const q = quantize(lum, w, h, d);
  assert.ok(q.every((v) => v >= 0 && v <= 15), `${d}: levels in range`);
  // A horizontal ramp should keep its mean brightness per column (within half a level).
  for (const x of [0, 50, 100, 191]) {
    let s = 0;
    for (let y = 0; y < h; y++) s += q[y * w + x];
    assert.ok(Math.abs(s / h - lum[x] * 15) < 0.75, `${d}: column ${x} mean ${s / h} vs ${lum[x] * 15}`);
  }
}
// Bayer is temporally stable: same input, same output (needed for tile diffing).
assert.deepEqual(quantize(lum, w, h, "bayer"), quantize(lum, w, h, "bayer"));

const levels = quantize(lum, w, h, "bayer");
const packed = pack4(levels);
assert.equal(packed.length, (w * h) / 2);
const gray8 = unpack4ToGray8(packed, w * h);
assert.ok(gray8.every((v, i) => v === levels[i] * 17 && v >> 4 === levels[i]), "unpack = level*17 and >>4 round-trips");

const buf = encodeTile({ tileIndex: 2, part: 0, parts: 1, w, h, seq: 77, packed });
const back = decodeTile(buf)!;
assert.equal(back.seq, 77);
assert.equal(back.tileIndex, 2);
assert.deepEqual(Array.from(back.packed), Array.from(packed));

const png8 = await encodeGrayPng(gray8, w, h, 8);
const png4 = await encodeGrayPng(levels, w, h, 4);
console.log(`192x144: gray4 ${packed.length} B, png8 ${png8.length} B, png4 ${png4.length} B, predicted ${predictTileMs(w, h).toFixed(0)} ms/tile`);

const dir = mkdtempSync(join(tmpdir(), "m64-"));
writeFileSync(join(dir, "a8.png"), png8);
writeFileSync(join(dir, "a4.png"), png4);
writeFileSync(join(dir, "levels.bin"), levels);
try {
  const out = execFileSync("python3", ["-c", `
import sys
from PIL import Image
d = sys.argv[1]
lv = open(d + "/levels.bin", "rb").read()
a8 = Image.open(d + "/a8.png"); a8.load()
a4 = Image.open(d + "/a4.png"); a4.load()
assert a8.size == (${w}, ${h}) and a4.size == (${w}, ${h})
p8 = list(a8.getdata()); p4 = list(a4.convert("L").getdata())
assert all(p8[i] == lv[i] * 17 for i in range(len(lv))), "png8 mismatch"
# Pillow expands 4-bit grey to 8-bit by *17
assert all(p4[i] == lv[i] * 17 for i in range(len(lv))), "png4 mismatch"
print("pillow decode ok", a8.mode, a4.mode)
`, dir]).toString();
  process.stdout.write(out);
} catch (e) {
  console.warn("PNG decode check skipped/failed:", (e as Error).message);
  process.exitCode = 1;
}
console.log("all good");

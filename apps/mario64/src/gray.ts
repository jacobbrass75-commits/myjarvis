// Pure pixel helpers (no DOM): RGBA -> luminance -> 16 grey levels (dithered) -> packed 4-bit,
// and back to 8-bit grey / PNG for the Even Hub SDK. Runs in browsers and in Node (tests).

export type Dither = "none" | "bayer" | "fs";

export interface ToneOptions {
  /** >1 darkens mid-tones. The micro-LED is very bright and black is "off", so ~1.2-1.6 usually reads better. */
  gamma: number;
  /** Multiplier around mid-grey. */
  contrast: number;
  /** Added after contrast, in 0..1 units. */
  brightness: number;
}

export const DEFAULT_TONE: ToneOptions = { gamma: 1.3, contrast: 1.1, brightness: 0 };

/** Rec.601 luma of an RGBA buffer, tone-mapped, as 0..1 floats. */
export function luminance(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, tone: ToneOptions = DEFAULT_TONE): Float32Array {
  const n = w * h;
  const out = new Float32Array(n);
  // 256-entry LUT keeps this ~1 ms for 288x144 even on a phone.
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    let v = Math.pow(i / 255, tone.gamma);
    v = (v - 0.5) * tone.contrast + 0.5 + tone.brightness;
    lut[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    out[i] = lut[y];
  }
  return out;
}

// 4x4 Bayer matrix, normalised to (-0.5, 0.5) of one quantisation step.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);

/**
 * Quantise 0..1 luminance to levels 0..15.
 * - "bayer": ordered; temporally stable, so static parts of a moving scene stay identical frame to frame
 *   (good for tile diffing, no shimmer). Recommended for streaming.
 * - "fs": Floyd-Steinberg error diffusion; nicer stills, but any change ripples through the rest of the tile.
 */
export function quantize(lum: Float32Array, w: number, h: number, dither: Dither): Uint8Array {
  const out = new Uint8Array(w * h);
  if (dither === "fs") {
    const buf = Float32Array.from(lum, (v) => v * 15);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = buf[i];
        const q = old < 0 ? 0 : old > 15 ? 15 : Math.round(old);
        out[i] = q;
        const e = old - q;
        if (x + 1 < w) buf[i + 1] += (e * 7) / 16;
        if (y + 1 < h) {
          if (x > 0) buf[i + w - 1] += (e * 3) / 16;
          buf[i + w] += (e * 5) / 16;
          if (x + 1 < w) buf[i + w + 1] += e / 16;
        }
      }
    }
    return out;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = dither === "bayer" ? BAYER4[(y & 3) * 4 + (x & 3)] : 0;
      const q = Math.round(lum[i] * 15 + t);
      out[i] = q < 0 ? 0 : q > 15 ? 15 : q;
    }
  }
  return out;
}

/** Two pixels per byte, left pixel in the high nibble. This is the wire format to the glasses page. */
export function pack4(levels: Uint8Array): Uint8Array {
  const out = new Uint8Array((levels.length + 1) >> 1);
  for (let i = 0, j = 0; i < levels.length; i += 2, j++) out[j] = (levels[i] << 4) | (levels[i + 1] ?? 0);
  return out;
}

/** Packed 4-bit -> one byte per pixel, level*17 (0,17,...,255) so a host-side `v >> 4` recovers the level exactly. */
export function unpack4ToGray8(packed: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = packed[i >> 1];
    out[i] = ((i & 1 ? b & 15 : b >> 4) * 17) & 255;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Cost model for one `updateImageRawData` call on real G2 hardware, from community measurements
 * (nickustinov/even-g2-notes docs/performance.md, fw 2.2.7.14 / SDK 0.0.13):
 *   ms ~= 104 + 0.0039 * gray4Bytes   (gray4Bytes = w*h/2)
 * Calls are strictly serial, so a frame of N tiles costs the sum.
 */
export const predictTileMs = (w: number, h: number) => 104 + 0.0039 * ((w * h) / 2);

// ---------------- PNG (greyscale) ----------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  // "deflate" in CompressionStream is the zlib (RFC 1950) wrapper, which is what PNG IDAT wants.
  const cs = new CompressionStream("deflate");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Greyscale PNG. bitDepth 4 uses the packed levels directly (half the size); bitDepth 8 expects gray8 input.
 * Community apps (zenn bigdra, g2-engine, WAD Player) confirm PNG works with updateImageRawData.
 */
export async function encodeGrayPng(pixels: Uint8Array, w: number, h: number, bitDepth: 4 | 8): Promise<Uint8Array> {
  const rowBytes = bitDepth === 8 ? w : (w + 1) >> 1;
  const raw = new Uint8Array((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (rowBytes + 1)] = 0; // filter: none
    if (bitDepth === 8) raw.set(pixels.subarray(y * w, y * w + w), y * (rowBytes + 1) + 1);
    else {
      // pixels are levels 0..15 here; repack per row (rows must start on a byte boundary).
      for (let x = 0; x < w; x += 2) {
        raw[y * (rowBytes + 1) + 1 + (x >> 1)] = (pixels[y * w + x] << 4) | (x + 1 < w ? pixels[y * w + x + 1] : 0);
      }
    }
  }
  const idat = await zlib(raw);
  const chunks: [string, Uint8Array][] = [
    ["IHDR", ihdr(w, h, bitDepth)],
    ["IDAT", idat],
    ["IEND", new Uint8Array(0)],
  ];
  const size = 8 + chunks.reduce((s, [, d]) => s + 12 + d.length, 0);
  const out = new Uint8Array(size);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const dv = new DataView(out.buffer);
  let o = 8;
  for (const [type, data] of chunks) {
    dv.setUint32(o, data.length);
    for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
    out.set(data, o + 8);
    dv.setUint32(o + 8 + data.length, crc32(out, o + 4, o + 8 + data.length));
    o += 12 + data.length;
  }
  return out;
}

function ihdr(w: number, h: number, bitDepth: number): Uint8Array {
  const b = new Uint8Array(13);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  b[8] = bitDepth;
  b[9] = 0; // colour type: greyscale
  b[10] = 0; // deflate
  b[11] = 0; // adaptive filtering
  b[12] = 0; // no interlace
  return b;
}

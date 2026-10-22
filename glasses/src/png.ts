// Greyscale PNG encoder for pushing pictures to the glasses (copied from apps/mario64/src/gray.ts).


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

/**
 * The 4-bit grey BMP the lenses take, byte for byte what G2Kit's build4BitBmp makes (so the iPhone app
 * passes it straight through): BITMAPINFOHEADER, 16-entry grey palette, bottom-up rows padded to
 * 4 bytes, high nibble = left pixel. `levels` are 0..15, row-major, top row first. Synchronous, no zlib.
 */
export function encodeGray4Bmp(levels: Uint8Array, w: number, h: number): Uint8Array {
  const rowBytes = (((w + 1) >> 1) + 3) & ~3;
  const header = 14 + 40 + 16 * 4;
  const out = new Uint8Array(header + rowBytes * h);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; // B
  out[1] = 0x4d; // M
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, header, true);
  dv.setUint32(14, 40, true);
  dv.setUint32(18, w, true);
  dv.setUint32(22, h, true); // positive = bottom-up
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 4, true);
  dv.setUint32(34, rowBytes * h, true);
  dv.setUint32(38, 2835, true);
  dv.setUint32(42, 2835, true);
  dv.setUint32(46, 16, true);
  for (let i = 0; i < 16; i++) out[54 + i * 4] = out[55 + i * 4] = out[56 + i * 4] = i * 17;
  for (let row = 0; row < h; row++) {
    const src = (h - 1 - row) * w;
    const dst = header + row * rowBytes;
    for (let x = 0; x < w; x += 2) {
      out[dst + (x >> 1)] = ((levels[src + x] & 15) << 4) | (x + 1 < w ? levels[src + x + 1] & 15 : 0);
    }
  }
  return out;
}

/** Base64 without a 4x-larger intermediate number array (the WebView bridge carries strings cheaply). */
export function bytesToBase64(b: Uint8Array): string {
  const native = (b as any).toBase64;
  if (typeof native === "function") return native.call(b);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

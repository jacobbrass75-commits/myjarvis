/**
 * 4-bit grayscale BMP, the format G2 image containers accept (MentraOS + men-g2-ble-gateway send
 * uncompressed BITMAPINFOHEADER BMPs with a 16-entry grey palette; compressMode = 0).
 * Layout follows the gateway's build_4bit_bmp (MIT); independent reimplementation.
 */

export interface GrayImage {
  width: number;
  height: number;
  /** 8-bit luminance, row-major, top row first. */
  pixels: Uint8Array;
}

export function build4BitBmp(img: GrayImage): Uint8Array {
  const { width, height, pixels } = img;
  if (pixels.length !== width * height) throw new RangeError("pixel buffer size mismatch");
  const rowBytes = (Math.ceil(width / 2) + 3) & ~3;
  const dataSize = rowBytes * height;
  const headerSize = 14 + 40 + 16 * 4;
  const out = new Uint8Array(headerSize + dataSize);
  const v = new DataView(out.buffer);
  out[0] = 0x42; // B
  out[1] = 0x4d; // M
  v.setUint32(2, out.length, true);
  v.setUint32(10, headerSize, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, width, true);
  v.setInt32(22, height, true); // positive = bottom-up
  v.setUint16(26, 1, true);
  v.setUint16(28, 4, true);
  v.setUint32(30, 0, true); // BI_RGB
  v.setUint32(34, dataSize, true);
  v.setInt32(38, 2835, true);
  v.setInt32(42, 2835, true);
  v.setUint32(46, 16, true);
  v.setUint32(50, 0, true);
  for (let i = 0; i < 16; i++) {
    const g = i * 17;
    out.set([g, g, g, 0], 54 + i * 4);
  }
  for (let row = 0; row < height; row++) {
    const src = (height - 1 - row) * width;
    const dst = headerSize + row * rowBytes;
    for (let x = 0; x < width; x++) {
      const idx = pixels[src + x]! >> 4;
      out[dst + (x >> 1)]! |= x & 1 ? idx : idx << 4;
    }
  }
  return out;
}

/** Convenience: a 1-bit-ish test pattern / solid fill, useful for smoke tests without an image library. */
export function solid(width: number, height: number, level: number): GrayImage {
  return { width, height, pixels: new Uint8Array(width * height).fill(Math.max(0, Math.min(255, level))) };
}

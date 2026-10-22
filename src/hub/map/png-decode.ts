import { inflateSync } from "node:zlib";

// Just enough PNG decoding for map images: non-interlaced, colour types 0 (grey), 2 (RGB), 3 (palette),
// 4 (grey + alpha) and 6 (RGBA) at 8 bits, plus 1/2/4-bit grey and palette. Output is luminance
// (alpha composited onto black), one byte per pixel.

export interface Gray {
  w: number;
  h: number;
  /** Luminance 0..255, row-major. */
  px: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const luma = (r: number, g: number, b: number) => (r * 299 + g * 587 + b * 114) / 1000;

export function decodePng(buf: Uint8Array): Gray {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 33 || sig.some((b, i) => buf[i] !== b)) throw new Error("png: not a PNG");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let alpha: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let o = 8; o + 8 <= buf.length; ) {
    const len = dv.getUint32(o);
    const kind = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (kind === "IHDR") {
      w = dv.getUint32(o + 8);
      h = dv.getUint32(o + 12);
      depth = buf[o + 16];
      type = buf[o + 17];
      interlace = buf[o + 20];
    } else if (kind === "PLTE") palette = data;
    else if (kind === "tRNS") alpha = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    o += 12 + len;
  }
  const ch = CHANNELS[type];
  if (!w || !h || ch === undefined) throw new Error(`png: colour type ${type}`);
  if (interlace) throw new Error("png: interlaced");
  if (depth !== 8 && !((type === 0 || type === 3) && (depth === 1 || depth === 2 || depth === 4))) throw new Error(`png: ${depth}-bit type ${type}`);
  if (type === 3 && !palette) throw new Error("png: no palette");

  const bpp = Math.max(1, (ch * depth) >> 3); // bytes per pixel for filtering (at least 1)
  const stride = Math.ceil((w * ch * depth) / 8);
  const raw = inflateSync(concat(idat));
  if (raw.length < (stride + 1) * h) throw new Error("png: short image data");
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error(`png: filter ${f}`);
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      let l: number;
      if (depth < 8) {
        const per = 8 / depth;
        const sample = (cur[Math.floor(x / per)] >> ((per - 1 - (x % per)) * depth)) & ((1 << depth) - 1);
        if (type === 3) l = paletteLuma(palette!, alpha, sample);
        else l = (sample * 255) / ((1 << depth) - 1);
      } else {
        const i = x * ch;
        if (type === 0) l = cur[i];
        else if (type === 2) l = luma(cur[i], cur[i + 1], cur[i + 2]);
        else if (type === 3) l = paletteLuma(palette!, alpha, cur[i]);
        else if (type === 4) l = (cur[i] * cur[i + 1]) / 255;
        else l = (luma(cur[i], cur[i + 1], cur[i + 2]) * cur[i + 3]) / 255;
      }
      out[y * w + x] = Math.round(l);
    }
    prev.set(cur);
  }
  return { w, h, px: out };
}

function paletteLuma(p: Uint8Array, alpha: Uint8Array | null, i: number): number {
  const l = luma(p[i * 3] ?? 0, p[i * 3 + 1] ?? 0, p[i * 3 + 2] ?? 0);
  return alpha && i < alpha.length ? (l * alpha[i]) / 255 : l;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

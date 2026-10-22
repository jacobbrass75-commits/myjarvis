// A 4-bit greyscale drawing surface (levels 0..15, 0 = black = see-through on the lens). Shared by the
// hub (the navigation map) and the glasses (image tiles), so it stays pure: no DOM, no Node APIs.

export class Raster {
  readonly w: number;
  readonly h: number;
  px: Uint8Array;

  constructor(w: number, h: number, px?: Uint8Array) {
    this.w = w;
    this.h = h;
    this.px = px ?? new Uint8Array(w * h);
    if (this.px.length !== w * h) throw new Error(`raster: ${this.px.length} px for ${w}x${h}`);
  }

  get(x: number, y: number): number {
    x = Math.floor(x);
    y = Math.floor(y);
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : this.px[y * this.w + x];
  }

  /** Overwrite one pixel (clipped; the level is clamped to 0..15). */
  set(x: number, y: number, v: number): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px[y * this.w + x] = v <= 0 ? 0 : v >= 15 ? 15 : v | 0;
  }

  clear(v = 0): void {
    this.px.fill(v);
  }

  fillRect(x: number, y: number, w: number, h: number, v: number): void {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.floor(x + w)), y1 = Math.min(this.h, Math.floor(y + h));
    const lv = v <= 0 ? 0 : v >= 15 ? 15 : v | 0;
    for (let yy = y0; yy < y1; yy++) this.px.fill(lv, yy * this.w + x0, yy * this.w + Math.max(x0, x1));
  }

  /** Outline of thickness t, drawn inside the rectangle. */
  rect(x: number, y: number, w: number, h: number, v: number, t = 1): void {
    this.fillRect(x, y, w, t, v);
    this.fillRect(x, y + h - t, w, t, v);
    this.fillRect(x, y + t, t, h - 2 * t, v);
    this.fillRect(x + w - t, y + t, t, h - 2 * t, v);
  }

  /** A straight line with a t x t square brush; dash = [on, off] in pixels along the line. */
  line(x0: number, y0: number, x1: number, y1: number, v: number, t = 1, dash?: [on: number, off: number]): void {
    this.stroke(x0, y0, x1, y1, v, t, dash, 0);
  }

  /** Connected lines; the dash pattern carries on across corners. */
  polyline(pts: [number, number][], v: number, t = 1, dash?: [number, number]): void {
    let phase = 0;
    for (let i = 1; i < pts.length; i++) phase = this.stroke(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], v, t, dash, phase);
  }

  /** Bresenham along the line; returns the dash phase at the end (in steps). */
  private stroke(x0: number, y0: number, x1: number, y1: number, v: number, t: number, dash: [number, number] | undefined, phase: number): number {
    // NaN never reaches its end point (an endless loop); a bad coordinate draws nothing instead.
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return phase;
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    const off = Math.floor((t - 1) / 2);
    const period = dash ? dash[0] + dash[1] : 0;
    let err = dx + dy;
    for (;;) {
      if (!dash || phase % period < dash[0]) {
        if (t <= 1) this.set(x0, y0, v);
        else this.fillRect(x0 - off, y0 - off, t, t, v);
      }
      phase++;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
    return phase - 1; // the shared corner pixel counts once
  }

  /** Filled polygon (scanline at pixel centres, even-odd rule). */
  fillPoly(pts: [number, number][], v: number): void {
    if (pts.length < 3) return;
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of pts) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(this.h - 1, Math.ceil(maxY));
    const xs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      xs.length = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        // pixels whose centre lies inside [xs[k], xs[k+1])
        const a = Math.ceil(xs[k] - 0.5), b = Math.ceil(xs[k + 1] - 0.5);
        if (b > a) this.fillRect(a, y, b - a, 1, v);
      }
    }
  }

  /** Copy src onto this raster at (dx, dy); skipZero leaves black source pixels see-through. */
  blit(src: Raster, dx: number, dy: number, opts?: { skipZero?: boolean }): void {
    dx = Math.floor(dx);
    dy = Math.floor(dy);
    for (let y = 0; y < src.h; y++) {
      const ty = y + dy;
      if (ty < 0 || ty >= this.h) continue;
      for (let x = 0; x < src.w; x++) {
        const tx = x + dx;
        if (tx < 0 || tx >= this.w) continue;
        const v = src.px[y * src.w + x];
        if (v || !opts?.skipZero) this.px[ty * this.w + tx] = v;
      }
    }
  }

  crop(x: number, y: number, w: number, h: number): Raster {
    const out = new Raster(w, h);
    out.blit(this, -x, -y);
    return out;
  }

  /** Fraction of pixels at level 2 or brighter (the lens budget is < 15% per tile). */
  lit(): number {
    let n = 0;
    for (let i = 0; i < this.px.length; i++) if (this.px[i] >= 2) n++;
    return n / this.px.length;
  }
}

/** 2 px per byte, high nibble first; each row starts on a byte. */
export function pack4(r: Raster): Uint8Array {
  const rb = (r.w + 1) >> 1;
  const out = new Uint8Array(rb * r.h);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x += 2) {
      const i = y * r.w + x;
      out[y * rb + (x >> 1)] = ((r.px[i] & 15) << 4) | (x + 1 < r.w ? r.px[i + 1] & 15 : 0);
    }
  return out;
}

export function unpack4(b: Uint8Array, w: number, h: number): Raster {
  const rb = (w + 1) >> 1;
  const r = new Raster(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const byte = b[y * rb + (x >> 1)] ?? 0;
      r.px[y * w + x] = x & 1 ? byte & 15 : byte >> 4;
    }
  return r;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

export function toB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
  }
  return s;
}

export function fromB64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = ((B64_INDEX.get(clean[i]) ?? 0) << 18) | ((B64_INDEX.get(clean[i + 1]) ?? 0) << 12) | ((B64_INDEX.get(clean[i + 2]) ?? 0) << 6) | (B64_INDEX.get(clean[i + 3]) ?? 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

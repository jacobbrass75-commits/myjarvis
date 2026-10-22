// A tiny SM64-ish test scene (no ROM): third-person box character on a checkered floor with pillars
// and spinning coins. Stick moves relative to the camera, A jumps, B dashes, Z crouches, C-left/right
// orbit the camera. Renders flat-shaded polygons on a 2D canvas so it runs anywhere.

import { BTN, type PadState } from "./wire";

type V3 = [number, number, number];
interface Face {
  pts: V3[];
  color: [number, number, number];
  /** Skip lighting (floor tiles, shadows). */
  flat?: boolean;
}

export class TestScene {
  readonly w: number;
  readonly h: number;
  private ctx: CanvasRenderingContext2D;
  private p = { x: 0, y: 0, z: 0, vy: 0, yaw: 0, dash: 0 };
  private camYaw = 0;
  private coins: { x: number; z: number; got: boolean }[] = [];
  private pillars: { x: number; z: number; s: number; h: number }[] = [
    { x: 6, z: 6, s: 1.2, h: 3 },
    { x: -7, z: 4, s: 1, h: 5 },
    { x: 3, z: -8, s: 1.5, h: 2 },
    { x: -5, z: -6, s: 0.8, h: 4 },
  ];
  private score = 0;
  private t = 0;
  private prevButtons = 0;
  /** When true the scene stops animating, to test that unchanged frames send nothing. */
  paused = false;

  constructor(public canvas: HTMLCanvasElement) {
    this.w = canvas.width;
    this.h = canvas.height;
    this.ctx = canvas.getContext("2d")!;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      this.coins.push({ x: Math.cos(a) * 9, z: Math.sin(a) * 9, got: false });
    }
  }

  step(dt: number, pad: PadState) {
    if (this.paused) return;
    this.t += dt;
    const pressed = pad.buttons & ~this.prevButtons;
    this.prevButtons = pad.buttons;
    const p = this.p;
    if (pad.buttons & BTN.CL) this.camYaw -= 2.2 * dt;
    if (pad.buttons & BTN.CR) this.camYaw += 2.2 * dt;
    const crouch = !!(pad.buttons & BTN.Z);
    const speed = (crouch ? 3 : 7) * (p.dash > 0 ? 2.2 : 1);
    const fx = Math.sin(this.camYaw);
    const fz = Math.cos(this.camYaw);
    const vx = (pad.y * fx + pad.x * fz) * speed;
    const vz = (pad.y * fz - pad.x * fx) * speed;
    if (Math.hypot(vx, vz) > 0.1) p.yaw = Math.atan2(vx, vz);
    p.x = clamp(p.x + vx * dt, -14, 14);
    p.z = clamp(p.z + vz * dt, -14, 14);
    const onGround = p.y <= 0;
    if (pressed & BTN.A && onGround) p.vy = 9;
    if (pressed & BTN.B && p.dash <= 0) p.dash = 0.35;
    p.dash -= dt;
    p.vy -= 25 * dt;
    p.y = Math.max(0, p.y + p.vy * dt);
    if (p.y === 0) p.vy = 0;
    for (const c of this.coins)
      if (!c.got && Math.hypot(c.x - p.x, c.z - p.z) < 1.2 && p.y < 2) {
        c.got = true;
        this.score++;
      }
    if (this.coins.every((c) => c.got)) this.coins.forEach((c) => (c.got = false));
    // Camera lazily swings behind the player.
    const want = p.yaw;
    if (Math.hypot(vx, vz) > 0.1 && !(pad.buttons & (BTN.CL | BTN.CR))) this.camYaw += angleDiff(want, this.camYaw) * Math.min(1, dt * 0.8);
  }

  render() {
    const { ctx, w, h, p } = this;
    const crouch = !!(this.prevButtons & BTN.Z);
    // Sky gradient (dark: micro-LED black is "off", keep backgrounds low).
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#202838");
    g.addColorStop(1, "#05070a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const cam: V3 = [p.x - Math.sin(this.camYaw) * 9, 5.5, p.z - Math.cos(this.camYaw) * 9];
    const faces: Face[] = [];
    // Floor: checker tiles.
    for (let i = -7; i < 7; i++)
      for (let j = -7; j < 7; j++) {
        const x0 = i * 2;
        const z0 = j * 2;
        const c = (i + j) & 1 ? 70 : 120;
        faces.push({ pts: [[x0, 0, z0], [x0 + 2, 0, z0], [x0 + 2, 0, z0 + 2], [x0, 0, z0 + 2]], color: [c, c + 20, c], flat: true });
      }
    // Shadow under the player.
    const sr = 0.9 - Math.min(0.5, p.y * 0.08);
    faces.push({ pts: Array.from({ length: 8 }, (_, k) => [p.x + Math.cos((k / 8) * Math.PI * 2) * sr, 0.01, p.z + Math.sin((k / 8) * Math.PI * 2) * sr] as V3), color: [20, 20, 20], flat: true });
    for (const q of this.pillars) faces.push(...box(q.x, 0, q.z, q.s, q.h, q.s, 0, [150, 140, 200]));
    for (const c of this.coins) if (!c.got) faces.push(...coin(c.x, 1 + Math.sin(this.t * 3 + c.x) * 0.2, c.z, this.t * 4));
    // Player: body + head, squashed when crouching.
    const bh = crouch ? 0.8 : 1.4;
    faces.push(...box(p.x, p.y, p.z, 0.9, bh, 0.9, p.yaw, [230, 60, 50]));
    faces.push(...box(p.x, p.y + bh, p.z, 0.7, 0.7, 0.7, p.yaw, [250, 210, 170]));
    faces.push(...box(p.x + Math.sin(p.yaw) * 0.35, p.y + bh + 0.35, p.z + Math.cos(p.yaw) * 0.35, 0.25, 0.2, 0.25, p.yaw, [40, 40, 40]));

    const light = norm([0.4, 1, -0.3]);
    const f = (h / 2) / Math.tan((55 * Math.PI) / 360);
    const cy = Math.cos(this.camYaw);
    const sy = Math.sin(this.camYaw);
    const pitch = 0.42;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const view = (v: V3): V3 => {
      const dx = v[0] - cam[0];
      const dy = v[1] - cam[1];
      const dz = v[2] - cam[2];
      const x = dx * cy - dz * sy;
      const z1 = dx * sy + dz * cy;
      return [x, dy * cp + z1 * sp, -dy * sp + z1 * cp];
    };
    const drawn: { d: number; pts: [number, number][]; fill: string }[] = [];
    for (const face of faces) {
      const vs = face.pts.map(view);
      if (vs.some((v) => v[2] < 0.3)) continue;
      const pts = vs.map((v) => [w / 2 + (v[0] * f) / v[2], h / 2 - (v[1] * f) / v[2]] as [number, number]);
      if (!face.flat && area(pts) >= 0) continue; // back-face
      let k = 1;
      if (!face.flat) {
        const n = norm(cross(sub(face.pts[1], face.pts[0]), sub(face.pts[2], face.pts[0])));
        k = 0.35 + 0.65 * Math.max(0, -dot(n, light));
      }
      const d = vs.reduce((s, v) => s + v[2], 0) / vs.length;
      const [r, gg, b] = face.color.map((c) => Math.round(c * k));
      drawn.push({ d: face.flat ? d + 1000 : d, pts, fill: `rgb(${r},${gg},${b})` });
    }
    drawn.sort((a, b) => b.d - a.d);
    for (const q of drawn) {
      ctx.beginPath();
      q.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = q.fill;
      ctx.fill();
    }
    // HUD, sized to survive a 192x144 downscale.
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(h / 9)}px system-ui, sans-serif`;
    ctx.fillText(`★ ${this.score}`, w * 0.04, h * 0.13);
  }
}

// ---------------- geometry helpers ----------------

function box(cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, yaw: number, color: [number, number, number]): Face[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const P = (x: number, y: number, z: number): V3 => [cx + x * c + z * s, y0 + y, cz - x * s + z * c];
  const hx = sx / 2;
  const hz = sz / 2;
  const v = [P(-hx, 0, -hz), P(hx, 0, -hz), P(hx, 0, hz), P(-hx, 0, hz), P(-hx, sy, -hz), P(hx, sy, -hz), P(hx, sy, hz), P(-hx, sy, hz)];
  // Counter-clockwise seen from outside.
  const idx = [
    [4, 5, 6, 7],
    [3, 2, 1, 0],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  return idx.map((q) => ({ pts: q.map((i) => v[i]), color }));
}

function coin(x: number, y: number, z: number, spin: number): Face[] {
  const r = 0.45;
  const c = Math.cos(spin) * r;
  const s = Math.sin(spin) * r;
  const front: V3[] = [
    [x, y + r, z],
    [x + c, y, z + s],
    [x, y - r, z],
    [x - c, y, z - s],
  ];
  return [
    { pts: front, color: [255, 220, 60] },
    { pts: [...front].reverse(), color: [255, 220, 60] },
  ];
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const m = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / m, a[1] / m, a[2] / m];
};
function area(p: [number, number][]) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    s += x1 * y2 - x2 * y1;
  }
  return s;
}

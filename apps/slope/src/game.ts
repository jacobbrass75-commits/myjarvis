// An original downhill-ball game drawn in wireframe perspective. The ball moves between 5 lanes;
// holes and blocks come at you faster and faster. Renders into a 144x72 grey-level buffer.

export const VW = 144;
export const VH = 72;
export const LANES = 5;

const HORIZON = 12;
const NEAR = 1; // depth of the bottom of the screen, in rows
const FAR = 16;
const BALL_Z = 1.35; // the ball sits this many rows in front of the camera (near the bottom of the screen)
const Y_SCALE = (VH - HORIZON) * NEAR;
const X_SCALE = 26; // lane width in px at depth 1

type Cell = 0 | 1 | 2; // hole, floor, block

export class Slope {
  buf = new Uint8Array(VW * VH);
  rows: Cell[][] = [];
  dist = 0; // rows travelled
  speed = 3; // rows per second
  lane = 2; // target lane
  bx = 2; // ball's lane position (smooth)
  state: "ready" | "play" | "over" | "paused" = "ready";
  t = 0;
  overT = 0;
  fallY = 0;
  best = 0;
  private safe = 2;

  constructor() {
    try {
      this.best = Number(localStorage.getItem("slope-best") || 0);
    } catch {}
    this.reset();
  }

  reset() {
    this.rows = [];
    this.dist = 0;
    this.speed = 3;
    this.lane = this.bx = 2;
    this.safe = 2;
    this.fallY = 0;
    for (let i = 0; i < 40; i++) this.rows.push(i < 8 ? [1, 1, 1, 1, 1] : this.genRow(i));
  }

  get score() {
    return Math.floor(this.dist);
  }

  /** New rows always keep one walkable lane that drifts at most one lane every few rows. */
  private genRow(i: number): Cell[] {
    if (i % 3 === 0 && Math.random() < 0.6) this.safe = Math.max(0, Math.min(LANES - 1, this.safe + (Math.random() < 0.5 ? -1 : 1)));
    const difficulty = Math.min(1, i / 400);
    const row: Cell[] = [];
    for (let l = 0; l < LANES; l++) {
      if (l === this.safe) row.push(1);
      else {
        const r = Math.random();
        row.push(r < 0.12 + 0.25 * difficulty ? 0 : r < 0.2 + 0.4 * difficulty ? 2 : 1);
      }
    }
    // breathing room: every 9th row is fully open
    return i % 9 === 0 ? [1, 1, 1, 1, 1] : row;
  }

  move(dir: -1 | 1) {
    if (this.state === "ready") this.state = "play";
    if (this.state !== "play") return;
    this.lane = Math.max(0, Math.min(LANES - 1, this.lane + dir));
  }

  tap() {
    if (this.state === "ready") this.state = "play";
    else if (this.state === "over" && this.overT > 0.6) {
      this.reset();
      this.state = "play";
    }
  }

  togglePause() {
    if (this.state === "play") this.state = "paused";
    else if (this.state === "paused") this.state = "play";
  }

  status() {
    switch (this.state) {
      case "ready": return "tap to start";
      case "paused": return "PAUSED";
      case "over": return "CRASH!\ntap to retry";
      default: return "";
    }
  }

  step(dt: number) {
    this.t += dt;
    if (this.state === "over") {
      this.overT += dt;
      this.fallY += dt * 40;
      return;
    }
    // ease toward the target lane (fast enough to dodge, slow enough to read on the glasses)
    const d = this.lane - this.bx;
    this.bx += Math.sign(d) * Math.min(Math.abs(d), dt * 7);
    if (this.state !== "play") return;

    this.speed = Math.min(9, 3 + this.dist / 60);
    this.dist += this.speed * dt;
    while (this.rows.length < Math.floor(this.dist) + 40) this.rows.push(this.genRow(this.rows.length));

    // collision: the cell under the ball, once it's mostly inside a lane
    const row = this.rows[Math.floor(this.dist + BALL_Z)];
    const l = Math.round(this.bx);
    if (row && Math.abs(this.bx - l) < 0.35 && row[l] !== 1) {
      this.state = "over";
      this.overT = 0;
      if (this.score > this.best) {
        this.best = this.score;
        try {
          localStorage.setItem("slope-best", String(this.best));
        } catch {}
      }
    }
  }

  // ---------------- render ----------------

  render(): Uint8Array {
    const b = this.buf;
    b.fill(0);
    const put = (x: number, y: number, v: number) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x >= 0 && x < VW && y >= 0 && y < VH && v > b[y * VW + x]) b[y * VW + x] = v;
    };
    const line = (x0: number, y0: number, x1: number, y1: number, v: number) => {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let i = 0; i <= n; i++) put(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, v);
    };
    const fillQuad = (xl0: number, xr0: number, y0: number, xl1: number, xr1: number, y1: number, v: number) => {
      // y0 is the far (top) edge, y1 the near (bottom) edge
      for (let y = Math.ceil(y0); y <= y1; y++) {
        const f = (y - y0) / Math.max(1e-3, y1 - y0);
        const a = xl0 + (xl1 - xl0) * f, c = xr0 + (xr1 - xr0) * f;
        for (let x = Math.ceil(a); x <= c; x++) put(x, y, v);
      }
    };

    const camLane = this.bx; // camera follows the ball sideways
    const bend = Math.sin(this.dist / 37) * 0.06 + Math.sin(this.dist / 13) * 0.03; // downhill curves
    const sy = (z: number) => HORIZON + Y_SCALE / z;
    const sx = (laneEdge: number, z: number) => VW / 2 + ((laneEdge - camLane - 0.5) * X_SCALE) / z + bend * z * z * 0.8;

    // starfield-ish horizon line
    for (let x = 0; x < VW; x += 3) put(x, HORIZON, 3);

    const frac = this.dist - Math.floor(this.dist);
    const base = Math.floor(this.dist);
    for (let k = FAR; k >= 0; k--) {
      const row = this.rows[base + k];
      if (!row) continue;
      const zFar = k + 1 - frac, zNear = Math.max(NEAR * 0.95, k - frac);
      if (zFar <= NEAR * 0.95) continue;
      const yFar = sy(zFar), yNear = sy(zNear);
      const fade = Math.max(2, Math.round(13 - zFar * 0.7));
      for (let l = 0; l < LANES; l++) {
        const xl0 = sx(l, zFar), xr0 = sx(l + 1, zFar), xl1 = sx(l, zNear), xr1 = sx(l + 1, zNear);
        if (row[l] === 0) continue; // hole
        fillQuad(xl0, xr0, yFar, xl1, xr1, yNear, 1);
        line(xl0, yFar, xr0, yFar, fade); // far edge
        if (l === 0 || row[l - 1] === 0) line(xl0, yFar, xl1, yNear, fade);
        else line(xl0, yFar, xl1, yNear, Math.min(4, fade)); // faint lane divider
        if (l === LANES - 1 || row[l + 1] === 0) line(xr0, yFar, xr1, yNear, fade);
        if (row[l] === 2) {
          // block: a box standing on the tile
          const h = (yNear - yFar) * 1.4 + 2;
          const inset = (xr1 - xl1) * 0.15;
          fillQuad(xl1 + inset, xr1 - inset, yNear - h, xl1 + inset, xr1 - inset, yNear, Math.min(15, fade + 2));
          line(xl1 + inset, yNear - h, xr1 - inset, yNear - h, 15);
        }
      }
    }

    // ball
    const by = sy(BALL_Z) - 4 + (this.state === "over" ? this.fallY : Math.abs(Math.sin(this.t * 9)) * -1);
    const bxs = sx(this.bx + 0.5, BALL_Z);
    if (this.state !== "over" || this.overT < 0.8) {
      for (let y = -4; y <= 4; y++)
        for (let x = -4; x <= 4; x++) {
          const r2 = x * x + y * y;
          if (r2 <= 18) put(bxs + x, by + y, r2 <= 3 && x < 1 && y < 1 ? 15 : r2 > 12 ? 9 : 12);
        }
    }
    return b;
  }
}

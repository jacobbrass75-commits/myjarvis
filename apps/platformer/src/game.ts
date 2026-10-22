// A small original side-scroller. The game renders into a 144x72 buffer of grey levels (0..15),
// which main.ts scales 2x to the glasses' 288x144 image container.

export const VW = 144;
export const VH = 72;
const T = 8; // tile size in px
const MAP_H = 9;

export interface Input {
  left: boolean;
  right: boolean;
  jump: boolean;
  run: boolean;
}

type Tile = " " | "=" | "B" | "?" | "b" | "P" | "o" | "F" | "|";
const SOLID = new Set<Tile>(["=", "B", "?", "b", "P"]);

interface Enemy {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dead: number; // frames since squashed, 0 = alive
}

// ---------------- level ----------------

function buildLevel() {
  const W = 200;
  const g: Tile[][] = Array.from({ length: MAP_H }, () => Array<Tile>(W).fill(" "));
  const enemies: Enemy[] = [];
  const set = (x: number, y: number, t: Tile) => x >= 0 && x < W && y >= 0 && y < MAP_H && (g[y][x] = t);
  const ground = (a: number, b: number) => { for (let x = a; x <= b; x++) { set(x, 7, "="); set(x, 8, "="); } };
  const gap = (a: number, b: number) => { for (let x = a; x <= b; x++) { set(x, 7, " "); set(x, 8, " "); } };
  const row = (x: number, y: number, s: string) => [...s].forEach((c, i) => c !== "." && set(x + i, y, c as Tile));
  const coins = (x: number, y: number, n: number) => { for (let i = 0; i < n; i++) set(x + i, y, "o"); };
  const pipe = (x: number, h: number) => { for (let y = 7 - h; y < 7; y++) { set(x, y, "P"); set(x + 1, y, "P"); } };
  const stairs = (x: number, n: number, down = false) => {
    for (let i = 0; i < n; i++) for (let y = 0; y <= i; y++) set(down ? x + n - 1 - i : x + i, 6 - y, "=");
  };
  const enemy = (x: number) => enemies.push({ x: x * T, y: 6 * T, vx: -0.4, vy: 0, dead: 0 });

  ground(0, W - 1);
  row(10, 4, "?B?B?");
  coins(11, 2, 3);
  enemy(16);
  pipe(22, 2);
  enemy(26);
  pipe(30, 3);
  gap(36, 38);
  coins(35, 4, 5);
  row(42, 4, "BBB?BBB");
  row(45, 1, "?");
  enemy(44);
  enemy(50);
  stairs(56, 3);
  gap(59, 61);
  stairs(62, 3, true);
  coins(66, 5, 4);
  row(70, 3, "B?B");
  enemy(72);
  enemy(75);
  pipe(80, 3);
  row(86, 4, "????");
  enemy(90);
  gap(95, 98);
  row(95, 4, "BBBB");
  coins(95, 3, 4);
  pipe(102, 2);
  enemy(106);
  enemy(109);
  row(112, 4, "B?B?B");
  coins(113, 2, 3);
  gap(118, 120);
  pipe(124, 3);
  enemy(128);
  row(132, 3, "BBBBBB");
  row(134, 0, "?");
  enemy(135);
  enemy(140);
  gap(146, 149);
  coins(146, 3, 4);
  enemy(154);
  enemy(158);
  stairs(166, 5);
  stairs(171, 1);
  for (let y = 0; y < 7; y++) set(184, y, "|");
  set(184, 0, "F");
  return { g, W, enemies };
}

// ---------------- sprites ----------------
// '.' transparent, digits/letters are grey levels: 'f' = 15, '8' = 8, '4' = 4.

const lv = (c: string) => (c === "." ? -1 : parseInt(c, 16));
const sprite = (rows: string[]) => rows.map((r) => [...r].map(lv));

const HERO = [
  sprite(["..fff...", ".fffff..", ".f8f8...", ".fffff..", "..888...", ".f888f..", "..8.8...", ".ff.ff.."]),
  sprite(["..fff...", ".fffff..", ".f8f8...", ".fffff..", "..888...", ".f888f..", ".8...8..", "ff...ff."]),
];
const HERO_JUMP = sprite(["..fff..f", ".fffff.f", ".f8f8..f", ".ffffff.", "..888...", ".f888...", ".8...8..", "ff....f."]);
const BLOB = [
  sprite(["..8888..", ".888888.", "8f88f888", "8f88f888", "88888888", ".888888.", "8.8..8.8", "........"]),
  sprite(["..8888..", ".888888.", "88f88f88", "88f88f88", "88888888", ".888888.", ".8.88.8.", "........"]),
];
const BLOB_FLAT = sprite(["........", "........", "........", "........", "........", "........", "8f8888f8", "88888888"]);

// ---------------- game ----------------

export class Game {
  level = buildLevel();
  x = 2 * T;
  y = 6 * T;
  vx = 0;
  vy = 0;
  onGround = false;
  facing = 1;
  coins = 0;
  lives = 3;
  frame = 0;
  camX = 0;
  state: "play" | "dead" | "over" | "clear" | "paused" = "play";
  stateT = 0;
  checkpoint = 2 * T;
  jumpHeld = 0;
  private prevJump = false;
  private pops: { x: number; y: number; t: number }[] = [];
  buf = new Uint8Array(VW * VH);

  restart(full: boolean) {
    const keep = { coins: this.coins, lives: this.lives, checkpoint: this.checkpoint };
    Object.assign(this, new Game());
    if (!full) Object.assign(this, keep, { x: keep.checkpoint });
  }

  /** A short press (ring tap): jump with a medium height. */
  tapJump() {
    this.jumpHeld = 10;
  }

  togglePause() {
    if (this.state === "play") this.state = "paused";
    else if (this.state === "paused") this.state = "play";
  }

  status(): string {
    switch (this.state) {
      case "over": return "GAME OVER\ntap to retry";
      case "clear": return "COURSE CLEAR!\ntap to replay";
      case "paused": return "PAUSED\ndouble tap to resume";
      case "dead": return "OUCH";
      default: return "";
    }
  }

  private tile(tx: number, ty: number): Tile {
    if (tx < 0 || tx >= this.level.W) return "=";
    if (ty < 0) return " ";
    if (ty >= MAP_H) return " ";
    return this.level.g[ty][tx];
  }
  private solidAt(px: number, py: number) {
    return SOLID.has(this.tile(Math.floor(px / T), Math.floor(py / T)));
  }

  step(inp: Input) {
    this.frame++;
    const jumpEdge = (inp.jump && !this.prevJump) || this.jumpHeld === 10;
    this.prevJump = inp.jump;

    if (this.state === "paused") return;
    if (this.state === "over" || this.state === "clear") {
      if (jumpEdge && this.stateT > 30) this.restart(true);
      this.stateT++;
      return;
    }
    if (this.state === "dead") {
      this.vy += 0.2;
      this.y += this.vy;
      if (++this.stateT > 70) {
        if (this.lives <= 0) {
          this.state = "over";
          this.stateT = 0;
        } else this.restart(false);
      }
      return;
    }

    // ---- hero ----
    const max = inp.run ? 2.0 : 1.25;
    const acc = this.onGround ? 0.09 : 0.06;
    if (inp.left) { this.vx = Math.max(this.vx - acc, -max); this.facing = -1; }
    else if (inp.right) { this.vx = Math.min(this.vx + acc, max); this.facing = 1; }
    else this.vx *= this.onGround ? 0.82 : 0.96;
    if (Math.abs(this.vx) < 0.02) this.vx = 0;

    const holding = inp.jump || this.jumpHeld > 0;
    if (jumpEdge && this.onGround) this.vy = -3.9;
    if (!holding && this.vy < -1.5) this.vy = -1.5; // release early = shorter jump
    if (this.jumpHeld > 0) this.jumpHeld--;
    this.vy = Math.min(this.vy + 0.2, 4);

    this.moveX();
    this.moveY();
    if (this.x > 96 * T) this.checkpoint = 96 * T;

    // coins
    for (const [cx, cy] of [[0, 0], [6, 0], [0, 7], [6, 7]]) {
      const tx = Math.floor((this.x + 1 + cx) / T), ty = Math.floor((this.y + cy) / T);
      if (this.tile(tx, ty) === "o") { this.level.g[ty][tx] = " "; this.coins++; }
    }
    // flag
    if (this.x + 6 >= 184 * T) {
      this.state = "clear";
      this.stateT = 0;
    }
    if (this.y > MAP_H * T) this.die();

    // ---- enemies ----
    for (const e of this.level.enemies) {
      if (e.dead) { e.dead++; continue; }
      if (Math.abs(e.x - this.x) > VW * 1.2) continue; // asleep until near
      e.vy = Math.min(e.vy + 0.2, 4);
      const nx = e.x + e.vx;
      const wallX = e.vx < 0 ? nx : nx + 7;
      if (this.solidAt(wallX, e.y + 2) || this.solidAt(wallX, e.y + 6)) e.vx = -e.vx;
      else e.x = nx;
      e.y += e.vy;
      if (this.solidAt(e.x + 1, e.y + 8) || this.solidAt(e.x + 6, e.y + 8)) {
        e.y = Math.floor((e.y + 8) / T) * T - 8;
        e.vy = 0;
      }
      if (e.y > MAP_H * T) e.dead = 999;
      // hero vs enemy
      if (this.x + 6 > e.x + 1 && this.x + 1 < e.x + 7 && this.y + 8 > e.y + 2 && this.y < e.y + 8) {
        if (this.vy > 0 && this.y + 8 - e.y < 6) {
          e.dead = 1;
          this.vy = inp.jump ? -3.6 : -2.6;
          this.coins += 0;
        } else this.die();
      }
    }

    this.pops = this.pops.filter((p) => ++p.t < 24);
    this.camX = Math.max(0, Math.min(this.level.W * T - VW, Math.max(this.camX, this.x - VW * 0.4)));
  }

  private die() {
    if (this.state !== "play") return;
    this.state = "dead";
    this.stateT = 0;
    this.lives--;
    this.vy = -3.5;
  }

  private moveX() {
    const nx = this.x + this.vx;
    const edge = this.vx > 0 ? nx + 6 : nx + 1;
    if (this.vx !== 0 && (this.solidAt(edge, this.y + 1) || this.solidAt(edge, this.y + 7))) {
      this.x = this.vx > 0 ? Math.floor((nx + 6) / T) * T - 6.01 : Math.floor((nx + 1) / T + 1) * T - 0.99;
      this.vx = 0;
    } else this.x = Math.max(this.camX, nx);
  }

  private moveY() {
    const ny = this.y + this.vy;
    this.onGround = false;
    if (this.vy >= 0) {
      if (this.solidAt(this.x + 1, ny + 8) || this.solidAt(this.x + 6, ny + 8)) {
        this.y = Math.floor((ny + 8) / T) * T - 8;
        this.vy = 0;
        this.onGround = true;
        return;
      }
    } else if (this.solidAt(this.x + 1, ny) || this.solidAt(this.x + 6, ny)) {
      const tx = Math.floor((this.x + 3.5) / T), ty = Math.floor(ny / T);
      if (this.tile(tx, ty) === "?") {
        this.level.g[ty][tx] = "b";
        this.coins++;
        this.pops.push({ x: tx * T, y: (ty - 1) * T, t: 0 });
      }
      this.y = Math.floor(ny / T + 1) * T;
      this.vy = 0;
      return;
    }
    this.y = ny;
  }

  // ---------------- render ----------------

  render(): Uint8Array {
    const b = this.buf;
    b.fill(0);
    const cam = Math.floor(this.camX);
    const px = (x: number, y: number, v: number) => {
      if (x >= 0 && x < VW && y >= 0 && y < VH && v > b[y * VW + x]) b[y * VW + x] = v;
    };
    const blit = (s: number[][], x: number, y: number, flip = false) => {
      for (let j = 0; j < s.length; j++)
        for (let i = 0; i < s[j].length; i++) {
          const v = s[j][flip ? s[j].length - 1 - i : i];
          if (v >= 0) px(x + i, y + j, v);
        }
    };

    // distant hills (parallax)
    for (let x = 0; x < VW; x++) {
      const wx = x + cam * 0.4;
      const h = 10 + Math.round(6 * Math.sin(wx / 23) + 3 * Math.sin(wx / 9));
      px(x, 56 - h, 3);
    }

    const t0 = Math.floor(cam / T);
    for (let ty = 0; ty < MAP_H; ty++)
      for (let tx = t0; tx <= t0 + VW / T + 1; tx++) {
        const t = this.tile(tx, ty);
        const ox = tx * T - cam, oy = ty * T;
        for (let j = 0; j < T; j++)
          for (let i = 0; i < T; i++) {
            let v = 0;
            const edge = i === 0 || j === 0 || i === T - 1 || j === T - 1;
            switch (t) {
              case "=": v = j === 0 ? 12 : (i + j) % 4 === 0 ? 5 : 2; break;
              case "B": v = j % 4 === 3 || (i === (j < 4 ? 3 : 7)) ? 4 : 9; break;
              case "?": {
                const glyph = ["..ff..", ".f..f.", "....f.", "...f..", "......", "...f.."];
                const on = i >= 1 && i < 7 && j >= 1 && j < 7 && glyph[j - 1][i - 1] === "f";
                v = edge ? 15 : on && this.frame % 40 < 30 ? 15 : 5;
                break;
              }
              case "b": v = edge ? 8 : 3; break;
              case "P": {
                const left = this.tile(tx - 1, ty) !== "P", top = this.tile(tx, ty - 1) !== "P";
                v = (left && i === 0) || (!left && i === T - 1) || (top && j < 2) ? 13 : i === (left ? 2 : 4) ? 9 : 5;
                break;
              }
              case "o": {
                const w = [1, 2, 3, 2][Math.floor(this.frame / 8) % 4];
                v = Math.abs(i - 3.5) <= w && j >= 1 && j <= 6 ? (Math.abs(i - 3.5) < w - 0.5 ? 15 : 10) : 0;
                break;
              }
              case "|": v = i === 3 ? 10 : 0; break;
              case "F": v = i === 3 ? 10 : i > 3 && j < 5 && i - 3 < 5 - j ? 15 : 0; break;
            }
            if (v) px(ox + i, oy + j, v);
          }
      }

    for (const p of this.pops) blit(sprite(["..ff..", ".ffff.", ".ffff.", "..ff.."]), p.x - cam + 1, p.y - Math.min(p.t, 12));

    for (const e of this.level.enemies) {
      if (e.dead > 30 || e.x - cam < -8 || e.x - cam > VW) continue;
      blit(e.dead ? BLOB_FLAT : BLOB[Math.floor(this.frame / 12) % 2], Math.round(e.x - cam), Math.round(e.y));
    }

    const hx = Math.round(this.x - cam), hy = Math.round(this.y);
    const blink = this.state === "dead" && this.frame % 6 < 3;
    if (!blink) {
      const s = !this.onGround ? HERO_JUMP : Math.abs(this.vx) > 0.1 ? HERO[Math.floor(this.frame / 6) % 2] : HERO[0];
      blit(s, hx, hy, this.facing < 0);
    }
    return b;
  }
}

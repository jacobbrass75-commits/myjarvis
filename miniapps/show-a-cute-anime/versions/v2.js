// Hitori "Bocchi" Gotoh: pixel-art sprite with blink, bob and tap-to-cycle expressions.
const W = 144, H = 72;
const EXPR = ["Shy", "Anxious", "Panic!!", "Happy"];
let api, t = 0, expr = 0, blinkT = 2.5, blinking = 0, buf;

function set(x, y, v) {
  x = Math.round(x); y = Math.round(y);
  if (x >= 0 && x < W && y >= 0 && y < H) buf[y * W + x] = v;
}

// Fill every pixel where pred is true; border pixels get `edge`.
function region(pred, fill, edge) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!pred(x, y)) continue;
    const border = !pred(x - 1, y) || !pred(x + 1, y) || !pred(x, y - 1) || !pred(x, y + 1);
    buf[y * W + x] = border ? edge : fill;
  }
}

function inEll(x, y, cx, cy, rx, ry) {
  const a = (x - cx) / rx, b = (y - cy) / ry;
  return a * a + b * b <= 1;
}

function segDist(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  let k = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  k = Math.max(0, Math.min(1, k));
  const ex = x - (x1 + k * dx), ey = y - (y1 + k * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

function rng(seed) {
  let s = seed * 9301 + 49297;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

// Eye styles
function normalEye(ex, ey, look) {
  region((x, y) => inEll(x, y, ex, ey, 3.5, 4.2), 11, 9);
  region((x, y) => inEll(x, y, ex + look, ey + 0.8, 1.8, 2.4), 3, 4);
  set(ex + look - 1, ey - 1, 15); set(ex + look - 1, ey, 15);
  set(ex + look + 1, ey + 2, 14);
}
function tinyPupilEye(ex, ey) {
  region((x, y) => inEll(x, y, ex, ey, 3.5, 4.2), 1, 12);
  set(ex, ey + 1, 15); set(ex + 1, ey + 1, 15); set(ex, ey + 2, 15); set(ex + 1, ey + 2, 15);
}
function blankEye(ex, ey) {
  region((x, y) => inEll(x, y, ex, ey, 4, 4.5), 0, 15);
}
function closedEye(ex, ey) {
  for (let dx = -4; dx <= 4; dx++) {
    const y = ey + 1 + Math.round((16 - dx * dx) / 9);
    set(ex + dx, y, 15); set(ex + dx, y - 1, 13);
  }
}
function happyEye(ex, ey) {
  for (let dx = -4; dx <= 4; dx++) {
    const y = ey - 1 + Math.round(dx * dx / 5);
    set(ex + dx, y, 15); set(ex + dx, y + 1, 15);
  }
}

function sweat(x, y) {
  region((px, py) => inEll(px, py, x, y, 1.6, 2.1), 4, 15);
  set(x, y - 3, 15);
}
function star(x, y, lv) {
  set(x, y, lv); set(x - 1, y, lv); set(x + 1, y, lv); set(x, y - 1, lv); set(x, y + 1, lv);
  if (lv > 10) { set(x - 2, y, lv - 4); set(x + 2, y, lv - 4); set(x, y - 2, lv - 4); set(x, y + 2, lv - 4); }
}
function cube(x, y) {
  // little 3D cube: front square + top/side faces
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++)
    set(x + i, y + j, i === 0 || j === 0 || i === 4 || j === 4 ? 15 : 9);
  for (let i = 1; i <= 2; i++) { set(x + i, y - i, 15); set(x + 4 + i, y - i, 15); set(x + 4 + i, y + 4 - i, 15); }
  for (let i = 1; i <= 6; i++) set(x + i, y - 2, 15);
  set(x + 6, y, 15); set(x + 6, y + 1, 15);
}

export default {
  title: "Bocchi",
  kind: "pixels",
  init(a) { api = a; const s = api.store.get("bocchiExpr"); if (s) expr = (+s || 0) % EXPR.length; },
  tick(dt) {
    t += dt;
    blinkT -= dt;
    if (blinking > 0) blinking -= dt;
    if (blinkT <= 0) { blinking = 0.22; blinkT = 2 + Math.random() * 3; }
  },
  header() { return "Bocchi · " + EXPR[expr] + " · tap"; },
  draw(px) {
    buf = px;
    const b = Math.round(Math.sin(t * 2.2) * 1.5);
    const jit = expr === 1 ? (Math.round(t * 12) % 2 ? 1 : -1) : 0;
    const cx = 72 + jit, cy = 23 + b;

    // Long hair (back), past the shoulders
    region((x, y) => {
      if (inEll(x, y, cx, cy - 2, 18, 17)) return true;
      if (y < cy - 2) return false;
      const tip = Math.abs(((x - cx + 40) % 7) - 3.5);
      return Math.abs(x - cx) <= 17 + (y - cy) / 6 && y <= cy + 42 - tip;
    }, 7, 13);

    // Neck
    region((x, y) => Math.abs(x - cx) <= 3 && y >= cy + 10 && y <= cy + 18, 2, 12);

    // Baggy track jacket
    const top = cy + 16;
    const jacket = (x, y) => y >= top && Math.abs(x - cx) <= 13 + (y - top) * 0.55 + (y < top + 3 ? -2 : 0);
    region(jacket, 5, 12);
    // High collar + zipper
    region((x, y) => y >= top - 1 && y <= top + 2 && Math.abs(x - cx) <= 6, 6, 13);
    for (let y = top + 3; y < H; y++) set(cx, y, (y % 2) ? 11 : 8);
    set(cx + 1, top + 4, 14); set(cx + 1, top + 5, 14);

    // Front hair locks over the shoulders
    region((x, y) => {
      if (y < cy + 6 || y > cy + 34 - Math.abs(((x + 20) % 5) - 2.5)) return false;
      const d = Math.abs(x - cx);
      const inner = 11 + (y - cy) / 10, outer = 16 + (y - cy) / 7;
      return d >= inner && d <= outer;
    }, 7, 13);

    // Guitar (body lower right, neck up to the left)
    const gx = cx + 5, gy = cy + 41;
    region((x, y) => segDist(x, y, gx - 6, gy - 4, cx - 32, cy + 22) <= 1.6, 10, 14);
    region((x, y) => Math.abs(x - (cx - 34)) <= 2.5 && Math.abs(y - (cy + 21)) <= 2, 12, 15);
    region((x, y) => inEll(x, y, gx, gy, 13, 8) || inEll(x, y, gx + 4, gy - 6, 8, 5.5), 10, 15);
    for (let i = -3; i <= 3; i++) { set(gx - 2 + i, gy - 1, 3); set(gx + 3 + i, gy + 2, 3); }
    for (let i = -6; i <= 6; i++) set(gx + i, gy + 4, 13); // bridge
    // Sleeves + hands
    region((x, y) => segDist(x, y, cx - 13, top + 3, cx - 22, cy + 28) <= 3.5, 5, 12);
    region((x, y) => inEll(x, y, cx - 23, cy + 27, 2.6, 2.2), 2, 12);
    region((x, y) => segDist(x, y, cx + 14, top + 3, cx + 9, gy - 2) <= 3.8, 5, 12);
    region((x, y) => inEll(x, y, cx + 8, gy, 2.6, 2.2), 2, 12);

    // Face
    const face = (x, y) => inEll(x, y, cx, cy + 1, y > cy + 1 ? 13 - (y - cy - 1) * 0.35 : 13, 12);
    region(face, 2, 12);

    // Eyes (under the bangs)
    const ey = cy + 5, lx = cx - 6, rx = cx + 6;
    const blink = blinking > 0 && expr < 2;
    if (blink) { closedEye(lx, ey); closedEye(rx, ey); }
    else if (expr === 0) { const lk = Math.round(Math.sin(t * 0.7) * 1.2) - 1; normalEye(lx, ey, lk); normalEye(rx, ey, lk); }
    else if (expr === 1) { tinyPupilEye(lx, ey); tinyPupilEye(rx, ey); }
    else if (expr === 2) { blankEye(lx, ey); blankEye(rx, ey); }
    else { happyEye(lx, ey + 1); happyEye(rx, ey + 1); }

    // Heavy bangs over the eyes + side locks
    region((x, y) => {
      if (!face(x, y)) return false;
      const spike = 3 - Math.abs(((x - cx + 33) % 6) - 3);
      if (y < cy + spike - (expr === 3 ? 1 : 0)) return true;
      return Math.abs(x - cx) >= 10 && y < cy + 11;
    }, 7, 13);
    // Ahoge
    [[1, -19], [2, -21], [3, -22], [4, -22], [5, -21], [5, -20]].forEach(([dx, dy]) => set(cx + dx, cy + dy, 13));
    // Cube hair clips on one side
    cube(cx + 11, cy - 11);
    cube(cx + 13, cy - 4);

    // Blush
    if (expr !== 2) for (const bx of [cx - 9, cx + 7]) for (const i of [0, 2]) { set(bx + i, cy + 11, 6); set(bx + i + 1, cy + 10, 6); }

    // Mouth
    const my = cy + 10;
    if (expr === 0) {
      [[-2, 0], [-1, 1], [0, 0], [1, 1], [2, 0]].forEach(([dx, dy]) => set(cx + dx, my + dy, 12));
    } else if (expr === 1) {
      for (let dx = -4; dx <= 4; dx++) set(cx + dx, my + ((dx + 10) % 2), 13);
    } else if (expr === 2) {
      for (let dx = -5; dx <= 5; dx++) { const dy = (dx + 10) % 2 ? 0 : 2; set(cx + dx, my + dy, 15); set(cx + dx, my + 1, 15); }
    } else {
      const hw = [3, 3, 2, 1];
      for (let dy = 0; dy < 4; dy++) for (let dx = -hw[dy]; dx <= hw[dy]; dx++)
        set(cx + dx, my + dy, dy === 0 ? 14 : (dy === 3 ? 12 : 9));
    }

    // Effects
    if (expr === 0) {
      // a little nervous "..." to the side
      const n = Math.floor(t * 2) % 4;
      for (let i = 0; i < n; i++) { set(cx - 28 + i * 3, cy - 8, 12); set(cx - 27 + i * 3, cy - 8, 12); }
    } else if (expr === 1) {
      for (let x = cx - 8; x <= cx + 6; x += 3) for (let y = cy - 9; y <= cy - 3; y++) set(x, y, 2); // gloom lines
      const s = (t * 8) % 10;
      sweat(cx + 16, cy - 1 + s); sweat(cx - 16, cy + 3 + ((s + 5) % 10));
    } else if (expr === 2) {
      // melting drips from the chin and face
      for (let i = 0; i < 6; i++) {
        const dx = -8 + i * 3, len = 3 + Math.floor((t * 9 + i * 5) % 9);
        for (let k = 0; k < len; k++) set(cx + dx, cy + 12 + k - Math.abs(dx) / 3, k === len - 1 ? 15 : 12);
      }
      // glitch: shift a few row bands sideways, add static
      const r = rng(Math.floor(t * 7));
      for (let n = 0; n < 4; n++) {
        const y0 = Math.floor(r() * 50), h = 1 + Math.floor(r() * 4), off = Math.round((r() - 0.5) * 14);
        for (let y = y0; y < Math.min(H, y0 + h); y++) {
          const row = px.slice(y * W, y * W + W);
          for (let x = 0; x < W; x++) px[y * W + x] = row[(x - off + W) % W];
        }
      }
      for (let n = 0; n < 40; n++) set(cx - 30 + r() * 60, r() * H, r() > 0.5 ? 15 : 0);
    } else {
      const p = Math.sin(t * 4);
      star(cx - 26, cy - 10, p > 0 ? 15 : 8);
      star(cx + 28, cy + 2, p > 0 ? 8 : 15);
      star(cx - 30, cy + 8, 11);
    }
  },
  input(g) {
    if (g === "tap" || g === "down") { expr = (expr + 1) % EXPR.length; api.store.set("bocchiExpr", String(expr)); return true; }
    if (g === "up") { expr = (expr + EXPR.length - 1) % EXPR.length; api.store.set("bocchiExpr", String(expr)); return true; }
    if (g === "hold") { blinking = 0.3; return true; }
    return false;
  },
};

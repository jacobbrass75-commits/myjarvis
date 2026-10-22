// Cute pixel-art anime girl with blinking, gentle bob and tap-to-change expressions.
const W = 144, H = 72;
const EXPR = ["Smile", "Happy", "Wink", "Surprised"];
let api, t = 0, expr = 0, blinkT = 2.5, blinking = 0, buf;

function set(x, y, v) {
  x = Math.round(x); y = Math.round(y);
  if (x >= 0 && x < W && y >= 0 && y < H) buf[y * W + x] = v;
}

// Fill every pixel where pred is true; pixels on the border get `edge`.
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

function openEye(ex, ey, side, big) {
  const rx = big ? 4 : 3.5, ry = big ? 5 : 4.5;
  region((x, y) => inEll(x, y, ex, ey, rx, ry), 11, 9);
  if (big) region((x, y) => inEll(x, y, ex, ey + 0.5, 1.3, 1.6), 3, 3);
  else region((x, y) => inEll(x, y, ex, ey + 0.8, 2, 2.6), 3, 4);
  // highlights
  set(ex - 1, ey - 2, 15); set(ex - 2, ey - 2, 15); set(ex - 1, ey - 1, 15); set(ex - 2, ey - 1, 15);
  set(ex + 1, ey + 2, 15);
  // lashes
  const top = Math.round(ey - ry);
  for (let x = Math.round(ex - rx - 1); x <= Math.round(ex + rx + 1); x++) { set(x, top, 15); set(x, top - 1, 15); }
  const ox = side < 0 ? Math.round(ex - rx - 2) : Math.round(ex + rx + 2);
  set(ox, top - 2, 15); set(ox, top - 1, 15);
}

function closedEye(ex, ey, side) {
  for (let dx = -4; dx <= 4; dx++) {
    const y = ey + 1 + Math.round((16 - dx * dx) / 9);
    set(ex + dx, y, 15); set(ex + dx, y - 1, 15);
  }
  set(ex + side * 5, ey, 15);
}

function happyEye(ex, ey) {
  for (let dx = -4; dx <= 4; dx++) {
    const y = ey - 1 + Math.round(dx * dx / 5);
    set(ex + dx, y, 15); set(ex + dx, y + 1, 15);
  }
}

function star(x, y, lv) {
  set(x, y, lv); set(x - 1, y, lv); set(x + 1, y, lv); set(x, y - 1, lv); set(x, y + 1, lv);
  if (lv > 10) { set(x - 2, y, lv - 4); set(x + 2, y, lv - 4); set(x, y - 2, lv - 4); set(x, y + 2, lv - 4); }
}

function heart(x, y, lv) {
  const rows = ["01010", "11111", "11111", "01110", "00100"];
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) if (rows[j][i] === "1") set(x + i - 2, y + j - 2, lv);
}

export default {
  title: "Anime Girl",
  kind: "pixels",
  init(a) { api = a; const s = api.store.get("expr"); if (s) expr = (+s || 0) % EXPR.length; },
  tick(dt) {
    t += dt;
    blinkT -= dt;
    if (blinking > 0) blinking -= dt;
    if (blinkT <= 0) { blinking = 0.22; blinkT = 2.5 + Math.random() * 3; }
  },
  header() { return "Anime Girl · " + EXPR[expr] + " · tap"; },
  draw(px) {
    buf = px;
    const b = Math.round(Math.sin(t * 2.2) * 1.5);
    const cx = 72, cy = 25 + b;
    const sway = Math.round(Math.sin(t * 1.3) * 0.8);

    // Long hair (back)
    region((x, y) => {
      if (inEll(x, y, cx, cy - 2, 18, 17)) return true;
      if (y < cy - 2) return false;
      const d = Math.abs(x - cx - (y > cy + 20 ? sway : 0));
      const half = 17 + (y - cy) / 8;
      const tip = Math.abs(((x - cx + 40) % 8) - 4);
      return d <= half && y <= cy + 36 - tip;
    }, 6, 13);

    // Neck
    region((x, y) => Math.abs(x - cx) <= 3 && y >= cy + 10 && y <= cy + 18, 2, 12);

    // Dress
    const top = cy + 16;
    const dress = (x, y) => y >= top && y <= 71 && Math.abs(x - cx) <= 9 + (y - top) * 0.45;
    region(dress, 8, 14);
    // Sailor collar
    region((x, y) => dress(x, y) && y <= top + 6 && Math.abs(x - cx) >= y - top - 1 && Math.abs(x - cx) <= 9 + (y - top) * 0.45 - 1, 13, 15);
    region((x, y) => y >= top && y < top + 6 && Math.abs(x - cx) < y - top - 1, 2, 2);
    // Bow
    const by = top + 6;
    for (let dx = -4; dx <= 4; dx++) for (let dy = -2; dy <= 2; dy++)
      if (Math.abs(dy) <= Math.abs(dx) * 0.7 + 0.3) set(cx + dx, by + dy, 15);
    set(cx, by + 3, 15); set(cx - 1, by + 4, 15); set(cx + 1, by + 3, 15); set(cx + 2, by + 4, 15);
    // Buttons
    set(cx, by + 9, 14); set(cx, by + 14, 14);

    // Face
    const face = (x, y) => {
      const rx = y > cy + 1 ? 13 - (y - cy - 1) * 0.35 : 13;
      return inEll(x, y, cx, cy + 1, rx, 12);
    };
    region(face, 2, 12);

    // Bangs + side locks
    region((x, y) => {
      if (!face(x, y)) return false;
      const spike = 3 - Math.abs(((x - cx + 33) % 6) - 3);
      if (y < cy - 4 + spike) return true;
      return Math.abs(x - cx) >= 10 && y < cy + 10;
    }, 6, 13);

    // Ahoge
    [[1, -19], [2, -21], [3, -22], [4, -22], [5, -21], [5, -20]].forEach(([dx, dy]) => set(cx + dx, cy + dy + 0, 13));

    // Eyes
    const ey = cy + 4, lx = cx - 6, rxe = cx + 6;
    const blink = blinking > 0;
    if (expr === 1) { happyEye(lx, ey); happyEye(rxe, ey); }
    else if (expr === 2) {
      if (blink) closedEye(lx, ey, -1); else openEye(lx, ey, -1, false);
      happyEye(rxe, ey);
    } else {
      const big = expr === 3;
      if (blink && !big) { closedEye(lx, ey, -1); closedEye(rxe, ey, 1); }
      else if (blink && big) { closedEye(lx, ey, -1); closedEye(rxe, ey, 1); }
      else { openEye(lx, ey, -1, big); openEye(rxe, ey, 1, big); }
    }

    // Blush
    for (const bx of [cx - 9, cx + 7]) for (const i of [0, 2]) { set(bx + i, cy + 10, 6); set(bx + i + 1, cy + 9, 6); }

    // Mouth
    const my = cy + 9;
    if (expr === 0) {
      [[-2, 0], [-1, 1], [0, 1], [1, 1], [2, 0]].forEach(([dx, dy]) => set(cx + dx, my + dy, 13));
    } else if (expr === 1) {
      const halves = [3, 3, 2, 1];
      for (let dy = 0; dy < 4; dy++) for (let dx = -halves[dy]; dx <= halves[dy]; dx++)
        set(cx + dx, my + dy, dy === 0 ? 14 : (dy === 3 ? 12 : 9));
    } else if (expr === 2) {
      [[-3, 0], [-2, 1], [-1, 1], [0, 0], [1, 1], [2, 1], [3, 0]].forEach(([dx, dy]) => set(cx + dx, my + dy, 13));
      set(cx + 1, my + 2, 10); set(cx + 2, my + 2, 10);
    } else {
      region((x, y) => inEll(x, y, cx, my + 1, 2, 2.6), 1, 14);
    }

    // Effects
    if (expr === 1) {
      const p = Math.sin(t * 4);
      star(cx - 26, cy - 10, p > 0 ? 15 : 8);
      star(cx + 27, cy - 4, p > 0 ? 8 : 15);
      star(cx + 22, cy - 16, 11);
    } else if (expr === 2) {
      const hy = Math.round(cy - 8 - ((t * 6) % 6));
      heart(cx + 25, hy, 14);
      heart(cx + 31, cy - 2, 9);
    } else if (expr === 3) {
      const sh = Math.round(t * 8) % 2;
      for (const [x0, y0] of [[cx - 26, cy - 14], [cx + 26, cy - 14]]) {
        for (let dy = 0; dy < 5; dy++) { set(x0 + sh, y0 + dy, 15); set(x0 + 1 + sh, y0 + dy, 15); }
        set(x0 + sh, y0 + 7, 15); set(x0 + 1 + sh, y0 + 7, 15);
      }
    }
  },
  input(g) {
    if (g === "tap" || g === "down") { expr = (expr + 1) % EXPR.length; api.store.set("expr", String(expr)); return true; }
    if (g === "up") { expr = (expr + EXPR.length - 1) % EXPR.length; api.store.set("expr", String(expr)); return true; }
    if (g === "hold") { blinking = 0.3; return true; }
    return false;
  },
};

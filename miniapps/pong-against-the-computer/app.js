// Pong vs the computer. Swipe up/down to move, tap to start/restart. First to 5 wins.
const W = 144, H = 72, PH = 18, PW = 3, BS = 5, WIN = 5;
let api, state = "title", me = 0, cpu = 0, wins = 0;
let py, pTarget, cy, bx, by, vx, vy, pause = 0, msg = "";

function resetPaddles() { py = pTarget = cy = (H - PH) / 2; }
function serve(dir) {
  bx = W / 2; by = H / 2;
  const sp = 42 + (me + cpu) * 2;
  vx = dir * sp; vy = (Math.random() * 2 - 1) * 22;
  pause = 0.8;
}
function newGame() { me = cpu = 0; resetPaddles(); serve(Math.random() < 0.5 ? -1 : 1); state = "play"; }

function hit(paddleY, dir) {
  const rel = (by + BS / 2 - (paddleY + PH / 2)) / (PH / 2); // -1..1
  const sp = Math.min(80, Math.hypot(vx, vy) * 1.05);
  vy = rel * sp * 0.7;
  vx = dir * Math.sqrt(Math.max(sp * sp - vy * vy, 400));
}

function point(mine) {
  if (mine) me++; else cpu++;
  if (me >= WIN || cpu >= WIN) {
    state = "over";
    msg = me >= WIN ? "YOU WIN!" : "CPU WINS";
    if (me >= WIN) { wins++; api.store.set("wins", String(wins)); }
    return;
  }
  serve(mine ? 1 : -1);
}

function rect(px, x, y, w, h, v) {
  x = Math.round(x); y = Math.round(y);
  for (let j = y; j < y + h; j++) {
    if (j < 0 || j >= H) continue;
    for (let i = x; i < x + w; i++) if (i >= 0 && i < W) px[j * W + i] = v;
  }
}

// 3x5 digit font
const F = ["111101101101111","010110010010111","111001111100111","111001111001111","101101111001001",
  "111100111001111","111100111101111","111001001001001","111101111101111","111101111001111"];
function digit(px, d, x, y, s, v) {
  const f = F[d];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++)
    if (f[r * 3 + c] === "1") rect(px, x + c * s, y + r * s, s, s, v);
}

export default {
  title: "Pong",
  kind: "pixels",
  init(a) {
    api = a; state = "title"; me = cpu = 0; resetPaddles();
    wins = parseInt(api.store.get("wins") || "0", 10) || 0;
    bx = W / 2; by = H / 2; vx = vy = 0;
  },
  tick(dt) {
    if (state !== "play") return;
    dt = Math.min(dt, 0.1);
    // player paddle glides toward target
    const pd = pTarget - py, ps = 110 * dt;
    py += Math.abs(pd) <= ps ? pd : Math.sign(pd) * ps;
    // CPU: limited speed, lazy when ball goes away, slight aim error
    const cs = (vx > 0 ? 22 : 10) * dt;
    const aim = (vx > 0 ? by + BS / 2 : H / 2) - PH / 2 + Math.sin(bx * 0.07) * 8;
    const cd = aim - cy;
    cy += Math.abs(cd) <= cs ? cd : Math.sign(cd) * cs;
    cy = Math.max(0, Math.min(H - PH, cy));
    if (pause > 0) { pause -= dt; return; }
    bx += vx * dt; by += vy * dt;
    if (by < 0) { by = 0; vy = Math.abs(vy); }
    if (by > H - BS) { by = H - BS; vy = -Math.abs(vy); }
    // player paddle at x=4..7
    if (vx < 0 && bx <= 4 + PW && bx >= 1 && by + BS >= py && by <= py + PH) { bx = 4 + PW; hit(py, 1); }
    if (vx > 0 && bx + BS >= W - 4 - PW && bx + BS <= W - 1 && by + BS >= cy && by <= cy + PH) { bx = W - 4 - PW - BS; hit(cy, -1); }
    if (bx < -BS) point(false);
    else if (bx > W) point(true);
  },
  header() {
    if (state === "title") return `PONG · tap to start · wins ${wins}`;
    if (state === "over") return `${msg} ${me}-${cpu} · tap to replay`;
    return `You ${me} - ${cpu} CPU · first to ${WIN}`;
  },
  draw(px) {
    for (let y = 0; y < H; y += 6) rect(px, W / 2 - 1, y, 1, 3, 4);
    digit(px, me, W / 2 - 18, 4, 3, 5);
    digit(px, cpu, W / 2 + 9, 4, 3, 5);
    rect(px, 4, py, PW, PH, 15);
    rect(px, W - 4 - PW, cy, PW, PH, 12);
    if (state === "play") rect(px, bx, by, BS, BS, pause > 0 ? 8 : 15);
    if (state !== "play") {
      rect(px, 34, 28, 76, 16, 0);
      rect(px, 34, 28, 76, 1, 9); rect(px, 34, 43, 76, 1, 9);
      rect(px, 34, 28, 1, 16, 9); rect(px, 109, 28, 1, 16, 9);
      // simple "play" triangle icon
      for (let i = 0; i < 9; i++) rect(px, 67 + i, 31 + i / 2, 1, 10 - i, 15);
    }
  },
  input(g) {
    if (g === "tap") {
      if (state !== "play") { newGame(); return true; }
      return true;
    }
    if (g === "up") { pTarget = Math.max(0, pTarget - 12); return true; }
    if (g === "down") { pTarget = Math.min(H - PH, pTarget + 12); return true; }
    return false;
  },
};

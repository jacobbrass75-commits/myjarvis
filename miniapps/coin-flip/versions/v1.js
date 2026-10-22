// Coin Flip: tap to flip, hold to reset tally.
let api, heads = 0, tails = 0, result = null, flipping = false, t = 0, pending = null;
const DUR = 1.0;

const F = {
  H: [17, 17, 17, 31, 17, 17, 17], E: [31, 16, 16, 30, 16, 16, 31], A: [14, 17, 17, 31, 17, 17, 17],
  D: [30, 17, 17, 17, 17, 17, 30], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  I: [14, 4, 4, 4, 4, 4, 14], L: [16, 16, 16, 16, 16, 16, 31], N: [17, 17, 25, 21, 19, 17, 17],
  P: [30, 17, 17, 30, 16, 16, 16], ":": [0, 12, 12, 0, 12, 12, 0], " ": [0, 0, 0, 0, 0, 0, 0],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14], "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
};

function put(px, x, y, v) {
  if (x >= 0 && x < 144 && y >= 0 && y < 72) px[y * 144 + x] = v;
}

function text(px, s, cx, y, scale, v) {
  const w = s.length * 6 * scale - scale;
  let x0 = Math.round(cx - w / 2);
  for (const ch of s) {
    const g = F[ch] || F[" "];
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 5; c++)
        if (g[r] & (16 >> c))
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) put(px, x0 + c * scale + dx, y + r * scale + dy, v);
    x0 += 6 * scale;
  }
}

function save() {
  api.store.set("h", String(heads));
  api.store.set("t", String(tails));
}

export default {
  title: "Coin Flip",
  kind: "pixels",
  init(a) {
    api = a;
    heads = parseInt(api.store.get("h") || "0", 10) || 0;
    tails = parseInt(api.store.get("t") || "0", 10) || 0;
    result = null; flipping = false;
  },
  tick(dt) {
    if (!flipping) return;
    t += dt;
    if (t >= DUR) {
      flipping = false;
      result = pending;
      if (result === "HEADS") heads++; else tails++;
      save();
    }
  },
  header() {
    if (flipping) return "Flipping...";
    return `Heads ${heads} · Tails ${tails} · ${heads + tails} flips`;
  },
  draw(px) {
    if (flipping) {
      // Spinning coin: horizontal radius follows |cos|, bounces up and down.
      const p = t / DUR;
      const phase = p * Math.PI * 7;
      const rx = Math.max(1, 22 * Math.abs(Math.cos(phase)));
      const ry = 22;
      const cy = 36 - Math.round(Math.sin(p * Math.PI) * 10);
      const face = Math.cos(phase) > 0 ? 15 : 8;
      for (let y = -ry; y <= ry; y++)
        for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x++) {
          const d = (x * x) / (rx * rx) + (y * y) / (ry * ry);
          if (d <= 1) put(px, 72 + x, cy + y, d > 0.75 ? 15 : face === 15 ? 6 : 3);
        }
      return;
    }
    if (result) {
      text(px, result, 72, 6, 4, 15);
      for (let x = 10; x < 134; x++) put(px, x, 42, 4);
    } else {
      text(px, "TAP", 72, 6, 4, 15);
    }
    text(px, `H:${heads} T:${tails} N:${heads + tails}`, 72, 52, 1, 12);
  },
  input(g) {
    if (g === "tap") {
      if (!flipping) {
        flipping = true; t = 0;
        pending = Math.random() < 0.5 ? "HEADS" : "TAILS";
      }
      return true;
    }
    if (g === "hold") {
      heads = 0; tails = 0; result = null; flipping = false; save();
      api.toast("Tally reset");
      return true;
    }
    return g === "up" || g === "down";
  },
};

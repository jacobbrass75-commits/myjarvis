// Snake for the G2 glasses. The snake moves by itself; swipe up turns left, swipe down turns right
// (from the snake's point of view). Tap pauses. Eat food to grow; it speeds up a little each time.

const CELL = 6; // 144x72 canvas → 24 x 12 grid
const COLS = 24;
const ROWS = 12;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // right, down, left, up (clockwise)

let api, snake, dir, food, timer, step, score, best, state, flash;

function reset() {
  snake = [[6, 6], [5, 6], [4, 6]];
  dir = 0;
  score = 0;
  step = 0.42; // seconds per move: slow enough for 6-8 fps glasses
  timer = 0;
  state = "ready";
  placeFood();
}

function placeFood() {
  do food = [Math.floor(Math.random() * COLS), Math.floor(Math.random() * ROWS)];
  while (snake.some(([x, y]) => x === food[0] && y === food[1]));
}

function move() {
  const [dx, dy] = DIRS[dir];
  const head = [(snake[0][0] + dx + COLS) % COLS, (snake[0][1] + dy + ROWS) % ROWS]; // walls wrap
  if (snake.slice(0, -1).some(([x, y]) => x === head[0] && y === head[1])) {
    state = "over";
    if (score > best) {
      best = score;
      api.store.set("best", String(best));
    }
    return;
  }
  snake.unshift(head);
  if (head[0] === food[0] && head[1] === food[1]) {
    score++;
    flash = 0.3;
    step = Math.max(0.22, step * 0.94);
    placeFood();
  } else snake.pop();
}

function rect(px, x, y, w, h, level) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && i < 144 && j >= 0 && j < 72) px[j * 144 + i] = level;
}

export default {
  title: "Snake",
  kind: "pixels",
  init(a) {
    api = a;
    best = Number(api.store.get("best") || 0);
    flash = 0;
    reset();
  },
  tick(dt) {
    if (flash > 0) flash -= dt;
    if (state !== "play") return;
    timer += dt;
    while (timer >= step && state === "play") {
      timer -= step;
      move();
    }
  },
  header() {
    if (state === "ready") return `Snake · tap to start · best ${best}`;
    if (state === "over") return `Game over: ${score} · best ${best} · tap`;
    if (state === "paused") return `Paused · ${score} · tap to resume`;
    return `Score ${score} · best ${best}`;
  },
  draw(px) {
    // border
    rect(px, 0, 0, 144, 1, 3);
    rect(px, 0, 71, 144, 1, 3);
    rect(px, 0, 0, 1, 72, 3);
    rect(px, 143, 0, 1, 72, 3);
    // food: a bright diamond
    const fx = food[0] * CELL + 3, fy = food[1] * CELL + 3;
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (Math.abs(i) + Math.abs(j) <= 2) rect(px, fx + i, fy + j, 1, 1, 15);
    // snake: bright head, dimmer body
    snake.forEach(([x, y], k) => rect(px, x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2, k === 0 ? 15 : flash > 0 ? 14 : 9));
    if (state === "over") for (let i = 0; i < 144 * 72; i += 2) if (px[i] === 0 && (Math.floor(i / 144) % 2 === 0)) px[i] = 2;
  },
  input(g) {
    if (g === "tap") {
      if (state === "over") reset();
      state = state === "play" ? "paused" : "play";
      return true;
    }
    if (state !== "play") return g !== "double";
    if (g === "up") dir = (dir + 3) % 4; // turn left
    else if (g === "down") dir = (dir + 1) % 4; // turn right
    else return false;
    return true;
  },
};

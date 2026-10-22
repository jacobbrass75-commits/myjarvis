// Reaction-time game: wait for GO, then tap as fast as you can.
let api;
let state = "idle"; // idle | wait | go | result | early
let waitLeft = 0;
let goAt = 0;
let last = 0;
let best = 0;
let tries = [];

const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

let validSum = 0; // all valid taps this session (false starts excluded)
let validCount = 0;

function avg() {
  if (!validCount) return 0;
  return Math.round(validSum / validCount);
}

function start() {
  state = "wait";
  waitLeft = 2 + Math.random() * 3;
}

export default {
  title: "Reaction",
  kind: "text",
  init(a) {
    api = a;
    best = parseInt(api.store.get("best") || "0", 10) || 0;
    state = "idle";
    tries = [];
    validSum = 0;
    validCount = 0;
  },
  tick(dt) {
    if (state === "wait") {
      waitLeft -= dt;
      if (waitLeft <= 0) {
        state = "go";
        goAt = now();
        api.refresh();
      }
    }
  },
  screen() {
    const bestTxt = best ? best + " ms" : "--";
    const avgTxt = validCount ? avg() + " ms" : "--";
    const header = "Reaction · best " + bestTxt + " · avg " + avgTxt;
    if (state === "idle") {
      return { header, body: "\n   Tap to start.\n\n   Wait for GO, then tap fast!\n   Tapping early = false start." };
    }
    if (state === "wait") {
      return { header, body: "\n\n          . . .  WAIT  . . .\n\n       (don't tap yet)" };
    }
    if (state === "go") {
      return { header, body: "\n\n   >>>>>>>>   G O !   <<<<<<<<\n\n            TAP NOW!" };
    }
    if (state === "early") {
      return { header, body: "\n\n        FALSE START!\n\n   Too early. Tap to try again." };
    }
    const isBest = last === best;
    const tag = last > 1000 ? "  Too slow!" : isBest ? "  NEW BEST!" : "";
    const last3 = tries.slice(-3).reverse().join(", ");
    return {
      header,
      body:
        "   Your time:  " + last + " ms" + tag +
        "\n   Best:       " + bestTxt +
        "\n   Average:    " + avgTxt + " (" + validCount + ")" +
        "\n   Last 3:     " + last3 +
        "\n\n   Tap to go again.",
    };
  },
  input(g) {
    if (g !== "tap") return false;
    if (state === "idle" || state === "result" || state === "early") {
      start();
    } else if (state === "wait") {
      state = "early";
    } else if (state === "go") {
      last = Math.max(1, Math.round(now() - goAt));
      tries.push(last);
      validSum += last;
      validCount++;
      if (tries.length > 20) tries.shift();
      if (!best || last < best) {
        best = last;
        api.store.set("best", String(best));
      }
      state = "result";
    }
    return true;
  },
};

import assert from "node:assert/strict";
import test from "node:test";
import { fromB64, pack4, Raster, toB64, unpack4 } from "../src/shared/raster.ts";
import { chevron, digits, digitsWidth, label, labelWidth } from "../src/shared/glyphs.ts";
import { checkLayout, colsFor, rowsFor } from "../glasses/src/ui/layout.ts";
import { clip, clockTile, fmtClock, fmtDate, frame, G, ladder, lr, LV, setGlyphMode, tile } from "../glasses/src/ui/kit.ts";
import { containers, core, render, rendered } from "../glasses/src/core.ts";
import { fakeBridge, settle } from "./lens-preview.mjs";

// The Lagonda style kit (pixel helpers, lettering, layout rules) and core's tile/box rendering.
// No glasses, hub or browser: the real glasses UI draws into a fake bridge.

const count = (r, f) => r.px.reduce((n, v) => n + (f(v) ? 1 : 0), 0);
const page = (b) => ({ textObject: b.page.text, listObject: b.page.list, imageObject: b.page.image });

// ---------------- raster ----------------

test("raster: set clips and clamps, rects and fills land where asked", () => {
  const r = new Raster(10, 6);
  r.set(-1, 0, 15);
  r.set(10, 0, 15);
  r.set(2, 2, 40);
  assert.equal(r.get(2, 2), 15);
  assert.equal(count(r, (v) => v > 0), 1);
  r.clear();
  r.rect(0, 0, 10, 6, 6);
  assert.equal(count(r, (v) => v === 6), 2 * 10 + 2 * 4);
  r.fillRect(-5, -5, 100, 100, 3);
  assert.equal(count(r, (v) => v === 3), 60);
  assert.throws(() => new Raster(4, 4, new Uint8Array(3)));
});

test("raster: lines hit both ends, dashes skip, thickness widens", () => {
  const r = new Raster(20, 20);
  r.line(1, 1, 18, 1, 15);
  assert.equal(r.get(1, 1), 15);
  assert.equal(r.get(18, 1), 15);
  assert.equal(count(r, (v) => v), 18);
  r.clear();
  r.line(0, 0, 19, 0, 15, 1, [2, 2]);
  assert.deepEqual([...r.px.subarray(0, 8)], [15, 15, 0, 0, 15, 15, 0, 0]);
  r.clear();
  r.line(5, 10, 15, 10, 9, 3);
  assert.equal(r.get(10, 9), 9);
  assert.equal(r.get(10, 11), 9);
  assert.equal(r.get(10, 12), 0);
  r.clear();
  r.polyline([[0, 0], [10, 0], [10, 10]], 5);
  assert.equal(r.get(10, 5), 5);
  assert.equal(count(r, (v) => v), 21);
});

test("raster: polygons fill by pixel centre, blit/crop/lit", () => {
  const r = new Raster(20, 20);
  r.fillPoly([[2, 2], [12, 2], [12, 12], [2, 12]], 7);
  assert.equal(count(r, (v) => v === 7), 100);
  r.clear();
  r.fillPoly([[0, 0], [10, 0], [0, 10]], 7); // right triangle: about half of 100
  const n = count(r, (v) => v);
  assert.ok(n >= 45 && n <= 55, `triangle ${n}`);
  const src = new Raster(3, 3);
  src.set(1, 1, 9);
  const dst = new Raster(5, 5);
  dst.fillRect(0, 0, 5, 5, 2);
  dst.blit(src, 1, 1, { skipZero: true });
  assert.equal(dst.get(1, 1), 2);
  assert.equal(dst.get(2, 2), 9);
  dst.blit(src, 1, 1);
  assert.equal(dst.get(1, 1), 0);
  assert.equal(dst.crop(2, 2, 2, 2).get(0, 0), 9);
  assert.equal(dst.crop(2, 2, 2, 2).w, 2);
  const l = new Raster(10, 10);
  l.fillRect(0, 0, 10, 2, 2);
  l.fillRect(0, 2, 10, 2, 1); // level 1 doesn't count as lit
  assert.equal(l.lit(), 0.2);
});

test("raster: pack4/unpack4 and base64 round trips", () => {
  for (const [w, h] of [[7, 3], [288, 144], [1, 1]]) {
    const r = new Raster(w, h);
    for (let i = 0; i < r.px.length; i++) r.px[i] = (i * 7 + 3) % 16;
    const packed = pack4(r);
    assert.equal(packed.length, ((w + 1) >> 1) * h);
    assert.deepEqual(unpack4(packed, w, h).px, r.px);
  }
  assert.equal(pack4(new Raster(2, 1, Uint8Array.from([0xa, 0x5])))[0], 0xa5);
  for (let n = 0; n < 12; n++) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 255);
    assert.equal(toB64(b), Buffer.from(b).toString("base64"));
    assert.deepEqual(fromB64(toB64(b)), b);
  }
});

// ---------------- lettering ----------------

test("digits: widths follow the spec", () => {
  assert.equal(digitsWidth("350", "XL"), 144);
  assert.equal(digitsWidth("990", "XL"), 144);
  assert.equal(digitsWidth("1.2", "XL"), 118);
  assert.equal(digitsWidth("8", "L"), 24);
  assert.equal(digitsWidth("88", "M"), 19 + 14);
  assert.equal(digitsWidth("12:45", "XL"), 4 * 52 + 26 - 12);
  assert.equal(digitsWidth("1x2", "M"), digitsWidth("12", "M")); // unsupported characters are skipped
  const r = tile();
  assert.equal(digits(r, 0, 0, "1.2", "XL"), 118);
});

test("digits: segments, ghosts, slant and joints", () => {
  const eight = new Raster(60, 80);
  digits(eight, 0, 0, "8", "XL", { level: 12 });
  const lit8 = count(eight, (v) => v === 12);
  const one = new Raster(60, 80);
  digits(one, 0, 0, "1", "XL", { level: 12, ghost: true });
  assert.ok(count(one, (v) => v === 12) < lit8 / 3, "a 1 lights two of seven segments");
  assert.ok(count(one, (v) => v === 2) > 0, "ghost segments at level 2");
  const plain = new Raster(60, 80);
  digits(plain, 0, 0, "1", "XL");
  assert.equal(count(plain, (v) => v === 2), 0);
  // XL leans right: the top of a 1 is further right than its bottom.
  const rows = (y) => [...Array(60).keys()].filter((x) => plain.get(x, y));
  assert.ok(Math.min(...rows(8)) > Math.min(...rows(64)));
  // M stands upright.
  const m = new Raster(20, 30);
  digits(m, 0, 0, "1", "M");
  const mrows = (y) => [...Array(20).keys()].filter((x) => m.get(x, y));
  assert.equal(Math.min(...mrows(5)), Math.min(...mrows(19)));
  // The joints show black: the corner where a, b and the middle of an 8 meet stays dark.
  const e = new Raster(60, 80);
  digits(e, 0, 0, "8", "XL", { slant: false });
  assert.equal(e.get(36, 4), 0);
  assert.equal(e.get(20, 4), 15);
});

test("label: widths, case, unknown characters", () => {
  assert.equal(labelWidth("A"), 12);
  assert.equal(labelWidth("AB"), 28);
  assert.equal(labelWidth("A A"), 36);
  assert.equal(labelWidth("I"), 2);
  assert.equal(labelWidth("AM", 1), 15);
  assert.equal(labelWidth("time"), labelWidth("TIME"));
  assert.equal(labelWidth("A~"), 12);
  const r = new Raster(40, 20);
  assert.equal(label(r, 0, 0, "E"), 12);
  assert.equal(r.get(0, 0), 9);
  assert.equal(r.get(11, 13), 9);
  assert.equal(count(r, (v) => v && v !== 9), 0);
});

test("chevron: filled delta with a knock-out ring", () => {
  const r = new Raster(40, 40);
  r.fillRect(0, 0, 40, 40, 6);
  chevron(r, 20, 20, 14, 16, { knockout: 2 });
  assert.equal(r.get(20, 18), 15);
  assert.equal(r.get(20, 11), 0); // just above the tip: knocked out
  assert.equal(r.get(2, 2), 6);
  const right = new Raster(40, 40);
  chevron(right, 20, 20, 14, 16, { angle: 90 });
  assert.equal(right.get(26, 20), 15); // points right
  assert.equal(right.get(20, 13), 0);
});

// ---------------- kit ----------------

test("frame: cut corners, notch gap, solid 2 px diagonals", () => {
  const r = tile();
  frame(r, 0, 0, 100, 60, { cut: 8 });
  assert.equal(r.get(0, 0), 0);
  assert.equal(r.get(8, 0), LV.frame);
  assert.equal(r.get(4, 4), LV.frame); // on the diagonal
  assert.equal(r.get(99, 30), LV.frame);
  const n = tile();
  frame(n, 0, 0, 200, 80, { cut: 8, notch: "TIME" });
  assert.equal(n.get(10, 7), LV.frame); // border before the notch
  assert.equal(n.get(13, 7), 0); // the 4 px gap
  assert.equal(n.get(16, 0), LV.label); // T
  assert.equal(n.get(16 + labelWidth("TIME") + 6, 7), LV.frame);
  const w2 = tile();
  frame(w2, 0, 0, 100, 60, { cut: 8, weight: 2, level: 12 });
  for (let k = 0; k < 8; k++) assert.equal(w2.get(100 - 1 - 8 + k, k + 1), 12, `inner diagonal ${k}`);
});

test("ladder: lit segments filled, the rest ghosted", () => {
  const r = tile();
  ladder(r, 0, 0, 10, 4);
  assert.equal(count(r, (v) => v === 15), 4 * 12 * 6);
  assert.ok(count(r, (v) => v === LV.ghost) > 0);
  const v = tile();
  ladder(v, 0, 0, 3, 1, { vertical: true, ghostLevel: 0 });
  assert.equal(v.get(0, 2 * 9), 15); // fills from the bottom
  assert.equal(v.get(0, 0), 0);
});

test("clock: 12/24 hour, date, under 15% lit, cached per minute", () => {
  assert.deepEqual(fmtClock(new Date(2026, 9, 21, 14, 32), true), { hm: "2:32", ampm: "PM" });
  assert.deepEqual(fmtClock(new Date(2026, 9, 21, 0, 5), true), { hm: "12:05", ampm: "AM" });
  assert.deepEqual(fmtClock(new Date(2026, 9, 21, 9, 5), false), { hm: "09:05" });
  assert.equal(fmtDate(new Date(2026, 9, 21)), "WED 21 OCT");
  for (const [h, m, h12] of [[14, 32, true], [10, 8, true], [9, 5, false], [12, 45, false]]) {
    const c = clockTile(new Date(2026, 9, 21, h, m), { hour12: h12 });
    assert.equal(c.w, 288);
    assert.equal(c.h, 144);
    assert.ok(c.lit() < 0.15, `${h}:${m} lit ${c.lit()}`);
  }
  const a = clockTile(new Date(2026, 9, 21, 9, 5, 1), { hour12: true });
  assert.equal(clockTile(new Date(2026, 9, 21, 9, 5, 59), { hour12: true }), a);
  assert.notEqual(clockTile(new Date(2026, 9, 21, 9, 6), { hour12: true }), a);
});

test("glyphs and text helpers", () => {
  setGlyphMode("ascii");
  assert.equal(G.dot, "*");
  assert.equal(G.toast, ">");
  setGlyphMode("unicode");
  assert.equal(G.deg, "°");
  setGlyphMode("");
  assert.equal(G.dot, "●"); // already in production
  assert.equal(G.deg, ""); // new: ASCII until LENS TEST says otherwise
  assert.equal(lr("ETA 14:47", "12 MIN", 20), "ETA 14:47     12 MIN");
  assert.equal(lr("A VERY LONG STREET NAME", "5", 10), "A VERY L 5");
  assert.equal(clip("ABCDEF", 3), "ABC");
  assert.equal(colsFor(552, 8, 1), 42);
  assert.equal(colsFor(288, 6, 1), 21);
  assert.equal(rowsFor(176, 8), 4);
  assert.equal(rowsFor(40, 4), 1);
});

// ---------------- layout ----------------

const T = (slot, x, y, w = 288, h = 144) => ({ slot, x, y, img: new Raster(w, h) });

test("layout: nav MAP and ESO fixtures pass", () => {
  const map = {
    header: "", noHeader: true,
    tiles: [T(0, 0, 0), T(1, 0, 144), T(2, 288, 0)],
    boxes: [{ slot: 0, x: 288, y: 148, w: 288, h: 140, border: 1, pad: 6, capture: true, text: "ONTO W 7TH ST\nTHEN: RIGHT PEARL ST" }],
    captionSlot: 0, toastSlot: 0,
  };
  checkLayout(containers(map));
  const eso = {
    header: "NAV  HOME  14:32",
    tiles: [T(0, 144, 48)],
    boxes: [{ slot: 0, x: 144, y: 204, w: 288, h: 80, capture: true, text: "ONTO W 7TH ST" }],
    captionSlot: 0,
  };
  checkLayout(containers(eso));
  // No body, list or capturing box: a blank full-lens text box takes input.
  const bare = containers({ header: "X", tiles: [T(0, 0, 48)] });
  checkLayout(bare);
  assert.equal(bare.textObject.find((t) => t.isEventCapture)?.content, " ");
});

test("layout: rejects overlap, a 5th image, two captures, bad names and sizes", () => {
  const ok = { header: "X", tiles: [T(0, 0, 48)], boxes: [{ slot: 0, x: 300, y: 48, w: 200, h: 80, text: "A" }] };
  checkLayout(containers(ok));
  assert.throws(() => checkLayout(containers({ ...ok, boxes: [{ slot: 0, x: 280, y: 48, w: 200, h: 80, text: "A" }] })), /overlaps/);
  assert.throws(() => checkLayout(containers({ header: "X", body: "B", main: { x: 0, y: 40, w: 576, h: 248 }, tiles: [T(0, 0, 48)] })), /overlaps/);
  const five = containers({ header: "X", tiles: [T(0, 0, 40, 100, 40), T(1, 100, 40, 100, 40), T(2, 200, 40, 100, 40), T(3, 300, 40, 100, 40)] });
  five.imageObject.push({ ...five.imageObject[0], containerID: 12, containerName: "tile4", xPosition: 400 });
  five.containerTotalNum++;
  assert.throws(() => checkLayout(five), /5 images/);
  const two = containers({ header: "X", body: "B", main: { x: 0, y: 40, w: 300, h: 100 }, boxes: [{ slot: 0, x: 300, y: 40, w: 200, h: 80, text: "A" }] });
  two.textObject[2].isEventCapture = 1;
  assert.throws(() => checkLayout(two), /2 containers capture/);
  const named = containers({ header: "X", body: "B", main: { x: 0, y: 40, w: 300, h: 100 } });
  named.textObject[1].containerName = "a-very-long-name";
  assert.throws(() => checkLayout(named), /longer than 14/);
  assert.throws(() => checkLayout(containers({ header: "X", body: "B", main: { x: 300, y: 40, w: 300, h: 100 } })), /outside/);
  assert.throws(() => checkLayout(containers({ header: "X", tiles: [T(0, 0, 48, 300, 100)] })), /images are 20..288/);
  const empty = containers({ header: "X", body: "B" });
  empty.textObject[1].content = "";
  assert.throws(() => checkLayout(empty), /empty text/);
});

// ---------------- screens through core ----------------

const STATE = () => ({
  agents: [{ id: "a1", name: "refactor", nodeId: "mac", status: "running" }, { id: "a2", name: "docs", nodeId: "mac", status: "idle" }],
  approvals: [], nodes: [{ id: "mac", name: "mac", online: true }], apps: [], voice: { listening: false, lastHeard: "", lastReply: "" },
});
const DASH = { time: "", date: "", weather: "Austin 18°C Partly cloudy · 22/9", agenda: ["15:00 Standup"], headlines: ["One"], agents: "", at: 0 };

test("screens: launcher, Today, approval card, takeover and toast lay out legally", async () => {
  const { launcher } = await import("../glasses/src/modes/launcher.ts");
  const { dashboard, parseWeather } = await import("../glasses/src/modes/dashboard.ts");
  const b = fakeBridge();
  core.bridge = b;
  core.ws = { readyState: 1, send() {} };
  dashboard.onHub({ t: "dashboard", dashboard: DASH });
  launcher.onHub({ t: "dashboard", dashboard: DASH });
  const show = async (stack, state = STATE()) => {
    core.stack = stack;
    core.state = state;
    render();
    await settle();
    checkLayout(page(b));
    return b.page;
  };
  let p = await show([launcher]);
  assert.equal(p.list[0].xPosition, 300);
  assert.equal(p.list[0].itemContainer.itemWidth, 252);
  assert.equal(p.list[0].borderWidth, 1);
  assert.ok(p.list[0].itemContainer.itemName.every((n) => n.length <= 20 && n === n.toUpperCase()));
  assert.ok(p.list[0].itemContainer.itemName.includes("LENS TEST"));
  assert.equal(p.image.length, 1);
  assert.ok(b.images.get(4), "clock tile pushed");
  assert.match(p.text.find((t) => t.containerName === "box0").content, /AGENTS 1\/2 RUN\n18C PARTLY CLOUDY/);

  p = await show([launcher, dashboard]);
  assert.deepEqual(p.image.map((i) => [i.containerName, i.xPosition, i.yPosition]), [["tile0", 0, 48], ["tile1", 288, 48]]);
  assert.match(p.text.find((t) => t.containerName === "body").content, /^> 15:00 Standup/);
  assert.deepEqual(parseWeather(DASH.weather), { temp: 18, unit: "C", cond: "PARTLY CLOUDY", hi: 22, lo: 9 });
  assert.deepEqual(parseWeather("Sunny"), { temp: undefined, unit: undefined, cond: "SUNNY", hi: undefined, lo: undefined });

  const approvals = [{ id: "p1", agentId: "a1", agentName: "refactor", nodeId: "mac", tool: "Bash", summary: "rm -rf build", createdAt: 0 }];
  p = await show([launcher], { ...STATE(), approvals });
  const body = p.text.find((t) => t.containerName === "body");
  assert.equal(body.borderWidth, 2);
  assert.equal(body.borderColor, 15);
  assert.ok(body.isEventCapture);
  assert.match(body.content, /^TOOL: Bash\n\nrm -rf build/);
  assert.match(p.text.find((t) => t.containerName === "header").content, /^APPROVE\?  REFACTOR @ MAC/);
  assert.equal(p.text.find((t) => t.containerName === "box0").content, "TAP: YES   DOUBLE: NO   SWIPE: NEXT");

  core.talking = true; // push-to-talk while an approval card is up: the takeover shows, Bocchi beside it
  p = await show([launcher, dashboard], { ...STATE(), approvals });
  assert.deepEqual(p.image.map((i) => [i.containerName, i.width, i.height]), [["tile0", 160, 144]]);
  assert.match(p.text.find((t) => t.containerName === "header").content, /MIC \[\.+\]  RELEASE TO SEND/);
  assert.equal(p.text.find((t) => t.isEventCapture).containerName, "box0");
  assert.equal(p.text.find((t) => t.containerName === "box1").textColor, 2);
  core.talking = false;

  core.toast = "Approved";
  p = await show([launcher]);
  assert.equal(p.text.find((t) => t.containerName === "header").content, `${G.toast} Approved`);
  core.toast = "";
  await new Promise((r) => setTimeout(r, 300)); // her last animation frame has fired
});

test("core: text before images, one tile per draw, first tile twice, unchanged tiles stay put, renders coalesce", async () => {
  const b = fakeBridge();
  core.bridge = b;
  core.state = STATE();
  const imgs = [tile(), tile(), tile()];
  imgs.forEach((r, i) => r.set(i, 0, 15));
  let text = "one";
  let draws = 0;
  const mode = {
    id: "t", title: "", gesture: () => false,
    screen: () => {
      draws++;
      return {
        header: "T",
        tiles: [{ slot: 0, x: 0, y: 0, img: imgs[0] }, { slot: 1, x: 288, y: 0, img: imgs[1], prio: -1 }, { slot: 2, x: 0, y: 144, img: imgs[2] }],
        boxes: [{ slot: 0, x: 300, y: 150, w: 200, h: 100, text, capture: true }],
        noHeader: true,
      };
    },
  };
  core.stack = [mode];
  render();
  await settle();
  // tile1 first (prio -1), then by slot, then the first one again.
  assert.deepEqual(b.log.filter((x) => x !== "create" && x !== "rebuild"), ["image:tile1", "image:tile0", "image:tile2", "image:tile1"]);
  b.log.length = 0;
  imgs[2].set(5, 5, 9);
  text = "two";
  render();
  await settle();
  assert.deepEqual(b.log, ["text:box0", "image:tile2"]);
  b.log.length = 0;
  draws = 0;
  for (let i = 0; i < 50; i++) render();
  await rendered();
  assert.equal(draws, 1);
  assert.deepEqual(b.log, []);
});

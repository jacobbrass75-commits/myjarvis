// Lens previews without glasses or a browser: runs the real glasses UI (core.ts + modes) against a fake
// bridge, then draws what the bridge was sent into a green 576x288 PNG (shown at 2x).
//   node --import tsx scripts/lens-preview.mjs <out dir> [scenario …]
// Image tiles are the exact pushed bytes. Firmware text is approximated with the kit's capitals at
// ~12.5 px per character and 30 px per line, so it shows layout and clipping, not the real font.
// Also exports lensPng(bridge) for tests and other harnesses.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { core, rendered, render } from "../glasses/src/core.ts";
import { hasLabelGlyph, label, Raster } from "../glasses/src/ui/kit.ts";

/** A bridge that keeps what the glasses would show: the page, upgraded text and pushed images. */
export function fakeBridge() {
  const b = {
    page: { text: [], list: [], image: [] },
    images: new Map(),
    log: [],
    async createStartUpPageContainer(c) {
      b.log.push("create");
      b.set(c);
      return 0;
    },
    async rebuildPageContainer(c) {
      b.log.push("rebuild");
      b.set(c);
      return true;
    },
    set(c) {
      const copy = (xs) => (xs ?? []).map((x) => ({ ...x, itemContainer: x.itemContainer ? { ...x.itemContainer } : undefined }));
      b.page = { text: copy(c.textObject), list: copy(c.listObject), image: copy(c.imageObject) };
      b.images.clear();
    },
    async textContainerUpgrade(u) {
      b.log.push(`text:${u.containerName}`);
      const t = b.page.text.find((x) => x.containerID === u.containerID);
      if (!t) return false;
      t.content = u.content;
      if (u.textColor !== undefined) t.textColor = u.textColor;
      return true;
    },
    async updateImageRawData(u) {
      b.log.push(`image:${u.containerName}`);
      b.images.set(u.containerID, decodeGray4(Uint8Array.from(u.imageData)));
      return "success";
    },
    async audioControl() {
      return true;
    },
    onEvenHubEvent() {},
    async getLocalStorage() {
      return "";
    },
    async setLocalStorage() {
      return true;
    },
  };
  return b;
}

/** encodeGrayPng's output back to levels (4-bit grey, filter 0 on every row). */
export function decodeGray4(png) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8, w = 0, h = 0;
  const idat = [];
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    if (type === "IHDR") {
      w = dv.getUint32(o + 8);
      h = dv.getUint32(o + 12);
    } else if (type === "IDAT") idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rb = (w + 1) >> 1;
  const r = new Raster(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const byte = raw[y * (rb + 1) + 1 + (x >> 1)];
      r.px[y * w + x] = x & 1 ? byte & 15 : byte >> 4;
    }
  return r;
}

// Stand-ins for glyphs the label font lacks.
const SUB = { "●": "*", "»": ">>", "›": ">", "…": "...", "·": ".", "•": "*", "▸": ">", "—": "-", "–": "-", "’": "'", "“": '"', "”": '"' };

/** Approximate firmware text: capitals 9x14 on a 12.5 px pitch, lowercase smaller, unknown glyphs as boxes. */
function drawText(lens, x0, y0, w, h, text, level) {
  const clipR = new Raster(w, h);
  let y = 2;
  for (const line of String(text).split("\n")) {
    let x = 0;
    for (const ch0 of line) {
      const ch = SUB[ch0] ?? ch0;
      for (const c of ch) {
        if (c !== " ") {
          const g = new Raster(14, 14);
          if (hasLabelGlyph(c)) label(g, 0, 0, c, { scale: 2, level });
          else g.rect(1, 2, 10, 12, level);
          const lower = c !== c.toUpperCase();
          // squeeze 12 px capitals into 9 (lowercase also to 10 px tall)
          for (let gy = 0; gy < 14; gy++)
            for (let gx = 0; gx < 9; gx++) {
              const sy = lower ? Math.floor((gy * 14) / 10) : gy;
              if (lower && gy >= 10) continue;
              const v = g.get(Math.floor((gx * 12) / 9), sy);
              if (v) clipR.set(Math.round(x) + gx, y + gy + (lower ? 4 : 0), v);
            }
        }
        x += 12.5 / ch.length;
      }
    }
    y += 30;
  }
  lens.blit(clipR, x0, y0, { skipZero: true });
}

function border(lens, c) {
  const bw = c.borderWidth ?? 0;
  if (bw) lens.rect(c.xPosition ?? 0, c.yPosition ?? 0, c.width ?? 576, c.height ?? 288, c.borderColor ?? 15, bw);
}

/** The lens as the fake bridge holds it, as a Raster (576x288). */
export function lensRaster(b) {
  const lens = new Raster(576, 288);
  for (const im of b.page.image) {
    const r = b.images.get(im.containerID);
    if (r) lens.blit(r, im.xPosition ?? 0, im.yPosition ?? 0);
  }
  for (const t of b.page.text) {
    border(lens, t);
    const inset = (t.paddingLength ?? 0) + (t.borderWidth ?? 0);
    const level = t.textColor === undefined ? 15 : 3 + t.textColor * 3;
    drawText(lens, (t.xPosition ?? 0) + inset, (t.yPosition ?? 0) + inset, (t.width ?? 576) - 2 * inset, (t.height ?? 288) - 2 * inset, t.content ?? "", level);
  }
  for (const l of b.page.list) {
    border(lens, l);
    const inset = (l.paddingLength ?? 0) + (l.borderWidth ?? 0);
    const names = l.itemContainer?.itemName ?? [];
    const rowH = 34;
    const per = Math.max(1, Math.floor(((l.height ?? 288) - 2 * inset) / rowH));
    const sel = Math.min(core.selected, names.length - 1);
    const first = Math.max(0, Math.min(sel - per + 1, names.length - per));
    names.slice(first, first + per).forEach((n, i) => {
      const x = (l.xPosition ?? 0) + inset, y = (l.yPosition ?? 0) + inset + i * rowH;
      const iw = l.itemContainer?.itemWidth || (l.width ?? 576) - 2 * inset;
      if (first + i === sel && l.itemContainer?.isItemSelectBorderEn) lens.rect(x, y, iw, rowH - 2, 15, 1);
      drawText(lens, x + 8, y + 6, iw - 12, rowH - 6, n, 15);
    });
  }
  return lens;
}

/** Green RGB PNG of a Raster, scaled up. */
export function greenPng(r, scale = 2) {
  const W = r.w * scale, H = r.h * scale;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = r.px[Math.floor(y / scale) * r.w + Math.floor(x / scale)] * 17;
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = v * 0.3;
      raw[o + 1] = v;
      raw[o + 2] = v * 0.57;
    }
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (t, d) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(W, 0);
  ih.writeUInt32BE(H, 4);
  ih[8] = 8;
  ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Render until no more draws are queued (tiles go out one per draw). */
export async function settle() {
  for (let i = 0; i < 12; i++) {
    await rendered();
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------- scenarios ----------------

const DASH = {
  time: "", date: "", weather: "Austin 72°F Clear · 80/61",
  agenda: ["15:00 Standup with design", "17:30 Gym"], headlines: ["Example headline one", "Example headline two"],
  agents: "2 running · 0 waiting · 2 devices", at: Date.now(),
};
const AGENTS = [
  { id: "a1", name: "refactor", nodeId: "mac", status: "running" },
  { id: "a2", name: "tests", nodeId: "mac", status: "running" },
  { id: "a3", name: "docs", nodeId: "mac", status: "idle" },
];
const APPROVALS = [
  { id: "p1", agentId: "a1", agentName: "refactor", nodeId: "mac", tool: "Bash", summary: "npm run build && npm --prefix glasses run build, then restart the hub with launchctl kickstart", createdAt: Date.now() },
  { id: "p2", agentId: "a2", agentName: "tests", nodeId: "mac", tool: "Edit", summary: "src/hub/nav.ts", createdAt: Date.now() },
];

async function scenarios() {
  const { launcher } = await import("../glasses/src/modes/launcher.ts");
  const { dashboard } = await import("../glasses/src/modes/dashboard.ts");
  const { lenstest } = await import("../glasses/src/modes/lenstest.ts");
  const { agents } = await import("../glasses/src/modes/agents.ts");
  const ui = await import("../glasses/src/ui/caption.ts");
  /** Bocchi's push-to-talk takeover: "said" heard, then the phase set up by `then`. */
  const ptt = (said, then) => () => {
    go([launcher]);
    ui.captionStart("ptt", 99);
    ui.onCaptionHub({ t: "caption", text: said, stable: said.length, final: true, source: "ptt", at: Date.now(), clip: 99 });
    ui.captionRelease();
    then?.(said);
  };
  const base = () => ({ agents: AGENTS, approvals: [], nodes: [{ id: "mac", name: "mac", online: true }], apps: [], voice: { listening: false, lastHeard: "", lastReply: "" } });
  const go = (stack, state = base()) => {
    core.stack = stack;
    core.state = state;
    core.toast = "";
    core.talking = false;
    core.selected = 0;
    ui.captionStop();
  };
  core.ws = { readyState: 1, send() {} }; // "connected", so send() is a no-op and no HUB OFFLINE
  launcher.onHub({ t: "dashboard", dashboard: DASH });
  dashboard.onHub({ t: "dashboard", dashboard: DASH });
  return {
    launcher: () => go([launcher]),
    "launcher-toast": () => {
      go([launcher]);
      core.toast = "Approved";
    },
    today: () => go([launcher, dashboard]),
    "today-news": () => {
      go([launcher, dashboard]);
      dashboard.gesture("down", 0);
    },
    approval: () => go([launcher], { ...base(), approvals: APPROVALS }),
    takeover: () => {
      go([launcher, dashboard]);
      core.talking = true;
    },
    "bocchi-thinking": ptt("what's the weather like tomorrow"),
    "bocchi-working": ptt("search the news for the rocket launch", (said) => ui.onCaptionHub({ t: "voice_working", heard: said, tool: "web search" })),
    "bocchi-reply": ptt("search the news for the rocket launch", (said) => ui.captionReply(said, "U-um, it launched on time and the booster landed. Everyone is cheering, which is a little scary.")),
    "bocchi-agents": () => {
      go([launcher, agents]);
      agents.onHub({ t: "voice_reply", heard: "Jarvis, what's on today?", reply: "U-um, you have standup with design at three, then the gym at five thirty. Nothing else, so you can rest a bit." });
    },
    "lenstest-1": () => {
      go([launcher, lenstest]);
      lenstest.enter();
    },
    "lenstest-2": () => {
      go([launcher, lenstest]);
      lenstest.enter();
      lenstest.gesture("down", 0);
    },
    "lenstest-3": () => {
      go([launcher, lenstest]);
      lenstest.enter();
      lenstest.gesture("up", 0);
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: lens-preview.mjs <out dir> [scenario …]");
  mkdirSync(out, { recursive: true });
  const b = fakeBridge();
  core.bridge = b;
  const all = await scenarios();
  const names = process.argv.length > 3 ? process.argv.slice(3) : Object.keys(all);
  for (const n of names) {
    all[n]();
    b.log.length = 0;
    render();
    await settle();
    const lens = lensRaster(b);
    writeFileSync(join(out, `${n}.png`), greenPng(lens));
    console.log(`${n}.png  ${b.log.join(" ")}`);
  }
  process.exit(0);
}

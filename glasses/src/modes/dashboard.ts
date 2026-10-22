import type { Dashboard, HubMsg } from "../../../src/shared/protocol";
import { core, render, send, wrap, type Mode } from "../core";
import { clockTile, digits, digitsWidth, fmtDate, frame, G, label, labelWidth, LV, tile, type Raster } from "../ui/kit";

// "Today": the clock and outside temperature as Lagonda readouts, what's next on your calendar under
// them. Swipe for headlines (text only).

let data: Dashboard | null = null;
let page = 0;
let timer: ReturnType<typeof setInterval> | undefined;

export const dashboard: Mode = {
  id: "dashboard",
  title: "Today",
  enter() {
    page = 0;
    send({ t: "dashboard_get" });
    timer = setInterval(() => {
      send({ t: "dashboard_get" });
      render();
    }, 60_000);
  },
  exit() {
    clearInterval(timer);
  },
  onHub(m: HubMsg) {
    if (m.t === "dashboard") data = m.dashboard;
  },
  screen() {
    const now = new Date();
    const header = `TODAY  ${fmtDate(now)}`;
    if (page === 1)
      return { header: `${header}  NEWS`, body: data ? data.headlines.flatMap((h) => wrap("• " + h).slice(0, 2)).slice(0, 7).join("\n") || "No headlines." : `LOADING${G.ell}` };
    const agenda = data?.agenda.length ? data.agenda.slice(0, 2).map((a) => "> " + a) : [data ? "NO MORE EVENTS TODAY" : `LOADING${G.ell}`];
    const approvals = core.state.approvals.length;
    const busy = core.state.agents.filter((a) => a.status === "running").length;
    const last = approvals ? `${approvals} WAITING FOR YOU` : core.state.agents.length ? `AGENTS ${busy}/${core.state.agents.length} RUN` : "";
    return {
      header,
      tiles: [
        { slot: 0, x: 0, y: 48, img: clockTile(now) },
        { slot: 1, x: 288, y: 48, img: weatherTile(data?.weather) },
      ],
      main: { x: 12, y: 204, w: 552, h: 84, pad: 6 },
      body: [...agenda, last].filter(Boolean).join("\n"),
      captionSlot: "takeover",
    };
  },
  gesture(g) {
    if (g === "down" || g === "up") page = g === "down" ? 1 : 0;
    else if (g === "tap") send({ t: "dashboard_get" });
    else return false;
    return true;
  },
};

let weatherCache: { key: string; r: Raster } | null = null;

/**
 * The OUTSIDE readout (a nod to the Lagonda's outside-temperature display): temperature in L digits
 * with its unit, the condition in capitals, today's high/low in M digits.
 */
export function weatherTile(w: string | undefined): Raster {
  const key = w ?? "";
  if (weatherCache?.key === key) return weatherCache.r;
  const r = tile();
  frame(r, 0, 0, 288, 144, { cut: 8, notch: "OUTSIDE" });
  const p = parseWeather(w);
  const temp = p?.temp !== undefined ? String(p.temp) : "--";
  const unit = `°${p?.unit ?? ""}`;
  const tw = digitsWidth(temp, "L");
  const lean = 6; // L's slant overhang
  const x = Math.round((288 - tw - lean - 6 - labelWidth(unit)) / 2);
  digits(r, x, 28, temp, "L", { level: LV.value });
  label(r, x + tw + lean + 6, 28 + 44 - 14, unit, { level: LV.label }); // unit on the digits' baseline
  const cond = (p?.cond || (w ? "" : "NO DATA")).slice(0, 16);
  if (cond) label(r, Math.round((288 - labelWidth(cond)) / 2), 84, cond, { level: LV.label });
  if (p?.hi !== undefined && p.lo !== undefined) {
    // "HI 22  LO 9": scale-1 captions on the M digits' baseline
    const hiW = digitsWidth(String(p.hi), "M"), loW = digitsWidth(String(p.lo), "M");
    const total = labelWidth("HI", 1) + 4 + hiW + 16 + labelWidth("LO", 1) + 4 + loW;
    let hx = Math.round((288 - total) / 2);
    hx += label(r, hx, 125, "HI", { scale: 1, level: LV.label }) + 4;
    hx += digits(r, hx, 108, String(p.hi), "M", { level: LV.accent }) + 16;
    hx += label(r, hx, 125, "LO", { scale: 1, level: LV.label }) + 4;
    digits(r, hx, 108, String(p.lo), "M", { level: LV.accent });
  }
  weatherCache = { key, r };
  return r;
}

export function shortWeather(w: string | undefined): string {
  const t = parseWeather(w);
  if (!t) return "";
  return [t.temp !== undefined ? `${t.temp}${G.deg}${t.unit ?? ""}` : "", t.cond].filter(Boolean).join(" ").slice(0, 20);
}

/** The first "<n>°<C|F>" is the temperature; the words after it, up to "·", the condition; then "hi/lo". */
export function parseWeather(w: string | undefined): { temp?: number; unit?: "C" | "F"; cond: string; hi?: number; lo?: number } | null {
  if (!w) return null;
  const m = /(-?\d+)\s*°\s*([CF])?/.exec(w);
  const [main, rest = ""] = (m ? w.slice(m.index + m[0].length) : w).split("·");
  const hl = /(-?\d+)\s*\/\s*(-?\d+)/.exec(rest);
  return {
    temp: m ? Number(m[1]) : undefined,
    unit: (m?.[2] as "C" | "F" | undefined) ?? undefined,
    cond: main.trim().toUpperCase(),
    hi: hl ? Number(hl[1]) : undefined,
    lo: hl ? Number(hl[2]) : undefined,
  };
}

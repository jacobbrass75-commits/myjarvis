import type { HubMsg } from "../../../src/shared/protocol";
import { core, openMode, send, type Mode, setDark } from "../core";
import { clockTile } from "../ui/kit";
import { shortWeather } from "./dashboard";
import { lenstest } from "./lenstest";

// Home: pick a mode. Double tap anywhere else comes back here.
// Lagonda layout: clock tile top left, two status lines under it, the mode list framed on the right.
// Swipes only move the firmware highlight (no image traffic); the clock tile changes once a minute.

const ITEMS: [id: string, label: string][] = [
  ["dashboard", "TODAY"],
  ["apps", "APPS"],
  ["copilot", "COPILOT"],
  ["translate", "TRANSLATE"],
  ["navigate", "NAVIGATE"],
  ["weather", "WEATHER"],
  ["sky", "SKY"],
  ["agents", "AGENTS"],
  ["messages", "MESSAGES"],
  ["notes", "NOTES"],
  ["teleprompter", "TELEPROMPTER"],
  ["lenstest", "LENS TEST"],
  ["lensoff", "LENS OFF"],
];

/** "18°F CLEAR" from the dashboard's weather line ("Austin 18°F Clear · 22/9"). */
let weather = "";
let weatherAsked = 0;

export const launcher: Mode = {
  id: "launcher",
  title: "Jarvis",
  onHub(m: HubMsg) {
    if (m.t === "dashboard") weather = shortWeather(m.dashboard.weather);
    // The weather line comes with the Today data; ask now and then while home is up.
    if (m.t === "state" && core.stack.length === 1 && Date.now() - weatherAsked > 10 * 60_000) {
      weatherAsked = Date.now();
      send({ t: "dashboard_get" });
    }
  },
  screen() {
    const s = core.state;
    const busy = s.agents.filter((a) => a.status === "running").length;
    const head = ["JARVIS"];
    if (s.agents.length) head.push(`${busy}/${s.agents.length} AGENTS`);
    if (s.approvals.length) head.push(`${s.approvals.length} APPROVE`);
    head.push("HOLD: TALK");
    const status = [
      s.agents.length ? `AGENTS ${busy}/${s.agents.length} RUN` : "NO AGENTS",
      core.ws ? weather || " " : "HUB OFFLINE",
    ];
    return {
      header: head.join("   "),
      tiles: [{ slot: 0, x: 0, y: 48, img: clockTile() }],
      boxes: [{ slot: 0, x: 12, y: 204, w: 264, h: 80, border: 0, text: status.join("\n") }],
      main: { x: 300, y: 48, w: 264, h: 228, border: 1, pad: 4 },
      // Fixed rows: list text is part of the page shape, so live counts here would rebuild the page
      // (highlight back to row 1, clock re-pushed) on every agent change. Counts live in the header/status.
      list: ITEMS.map(([, label]) => label),
      captionSlot: "takeover",
    };
  },
  gesture(g, i) {
    if (g === "tap") {
      const id = ITEMS[i]?.[0] ?? "dashboard";
      if (id === "lensoff") {
        setDark(true); // a tap anywhere wakes it
        return true;
      }
      if (id === "lenstest" && !core.modes.has(id)) core.modes.set(id, lenstest); // not in app.ts's list
      openMode(id);
      return true;
    }
    if (g === "double") {
      setDark(true); // nowhere further back to go: double tap at home turns the screen off
      return true;
    }
    return false;
  },
};

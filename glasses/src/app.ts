import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { HubMsg } from "../../src/shared/protocol";
import { back, connect, core, current, flash, log, onBridgeEvent, openMode, render, send, setDark } from "./core";
import { agents } from "./modes/agents";
import { appsMode, openApp } from "./modes/apps";
import { copilot } from "./modes/copilot";
import { dashboard } from "./modes/dashboard";
import { launcher } from "./modes/launcher";
import { navigate } from "./modes/navigate";
import { messagesMode } from "./modes/messages";
import { notesMode } from "./modes/notes";
import { teleprompter } from "./modes/teleprompter";
import { translate, translateTo } from "./modes/translate";
import { weather, weatherTo } from "./modes/weather";
import { sky, skyTo } from "./modes/sky";
import { captionOwns, captionReply, captionStop, onCaptionHub } from "./ui/caption";

// Jarvis for Even G2: a launcher of modes on the glasses, all talking to your hub.
// Ring / temple: swipe = move, tap = select, double tap = back, hold = talk to Jarvis.
// Runs with any bridge: the Even App's, the in-page emulator, or the native BLE driver (native/).

let openedByVoice = 0;

// Live words (ui/caption.ts): runs before the modes and the router, so they see its state.
const captions = { id: "_captions", title: "", screen: () => ({ header: "" }), gesture: () => false, onHub: onCaptionHub };

// Cross-mode reactions to hub messages.
const router = {
  id: "_router",
  title: "",
  screen: () => ({ header: "" }),
  gesture: () => false,
  onHub(m: HubMsg) {
    if (m.t === "screen") setDark(!m.on);
    // "Jarvis, start translating Spanish" / "copilot on" / "open my notes".
    if (m.t === "open") {
      while (core.stack.length > 1) back();
      if (m.mode !== "launcher") openMode(m.mode);
      if (m.mode === "translate" && m.lang) translateTo(m.lang);
      if (m.mode === "apps" && m.app) openApp(m.app);
      if (m.mode === "weather" && m.wx) weatherTo(m.wx);
      if (m.mode === "sky" && m.sky) skyTo(m.sky);
      openedByVoice = Date.now();
    }
    // Directions started by voice: jump to the Navigate screen.
    if (m.t === "nav" && m.nav && current()?.id !== "navigate") openMode("navigate");
    if (m.t === "voice_reply") {
      const byVoice = Date.now() - openedByVoice < 15_000;
      const mode = current();
      const brief = byVoice || mode?.id === "navigate" || mode?.id === "apps" || mode?.id === "messages" || mode?.quiet;
      // Your push-to-talk on a screen with its own content: the caption shows the answer under what
      // you said (Navigate only once it has a caption box; until then the one-line flash).
      const inPlace = brief && !byVoice && (mode?.id !== "navigate" || typeof mode.screen().captionSlot === "number");
      if (inPlace && captionReply(m.heard, m.reply)) return;
      // A reply to some other press (or the phone) leaves the caption on the lens alone.
      if (captionOwns(m.heard)) captionStop("sent");
      // Just switched screens by voice, or on a screen with its own content: show the reply briefly.
      if (brief) flash(m.reply.slice(0, 44), 5000);
      else if (mode?.id !== "agents") {
        openMode("agents");
        agents.onHub?.(m); // enter() reset the view; show the reply
      }
    }
  },
};

export async function startJarvis(bridge: EvenAppBridge, hubs: string[], token: string) {
  for (const m of [captions, launcher, appsMode, dashboard, copilot, translate, navigate, weather, sky, agents, notesMode, messagesMode, teleprompter, router]) core.modes.set(m.id, m);
  core.stack.push(launcher);
  core.bridge = bridge;
  bridge.onEvenHubEvent(onBridgeEvent);
  connect(hubs, token);
  setTimeout(shareLocation, 2500); // after the hub connection is up
  render();
  setInterval(render, 30_000); // keep clocks fresh
  log("Jarvis ready");
}

/** Phone GPS → hub, for navigation and "near me" questions. Only works when installed from Even Hub. */
async function shareLocation() {
  const b: any = core.bridge;
  if (!b?.startAppLocationUpdates) return;
  try {
    const fix = await b.getAppLocation?.({ accuracy: "high", timeoutMs: 8000 });
    if (fix) send({ t: "location", lat: fix.latitude, lon: fix.longitude, accuracy: fix.accuracy });
    b.onAppLocationChanged((l: any) => send({ t: "location", lat: l.latitude, lon: l.longitude, accuracy: l.accuracy }));
    await b.startAppLocationUpdates({ intervalMs: 3000, distanceFilter: 5 });
  } catch (e: any) {
    log(`location: ${e?.message ?? e}`);
  }
}

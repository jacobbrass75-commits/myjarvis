import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import { startJarvis } from "./app";
import { core, log, openMode, report } from "./core";
import { openApp } from "./modes/apps";
import { createEmulatorBridge } from "./emulator";

// Browser / Even App entry. (The Mac-native entry is native/jarvis.ts.)

const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);

// Loaded from the hub (QR / dev): talk to that hub. Installed as a package: try each address baked
// in at build time (VITE_HUB_URLS, e.g. Wi-Fi then Tailscale) until one answers.
const fromHub = location.protocol.startsWith("http") && !import.meta.env.VITE_HUB_URLS;
const HUBS: string[] = params.get("hub")
  ? [params.get("hub")!]
  : fromHub
    ? [location.origin]
    : String(import.meta.env.VITE_HUB_URLS || location.origin).split(",").map((u: string) => u.trim()).filter(Boolean);

// Page errors go to the hub log too: on the glasses there is no console to look at.
window.addEventListener("error", (e) => report(`page error: ${e.message} at ${e.filename?.split("/").pop()}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => report(`unhandled rejection: ${(e.reason as any)?.stack ?? e.reason}`));

async function main() {
  $("hub").textContent = HUBS[0];
  let token = params.get("token") || import.meta.env.VITE_HUB_TOKEN || "";
  // Outside the Even App (any desktop/phone browser, or ?emulate=1) draw the lens in the page.
  const inEvenApp = !!(window as any).flutter_inappwebview && !params.has("emulate");
  let bridge;
  if (inEvenApp) bridge = await waitForEvenAppBridge();
  else {
    document.body.classList.add("emulated");
    bridge = createEmulatorBridge($("emu"));
  }
  if (!token) token = (await bridge.getLocalStorage("hubToken")) || "";
  else await bridge.setLocalStorage("hubToken", token);
  await startJarvis(bridge, HUBS, token);
  // Studio preview: /glasses/?emulate=1&open=<app id>. It shows only that app, so it ignores the
  // hub's "open …" commands and voice replies, which are meant for the real glasses.
  const open = params.get("open");
  if (open) {
    core.modes.delete("_router");
    openMode("apps");
    openApp(open);
  }
}

main().catch((e) => log(`boot failed: ${e?.message ?? e}`));

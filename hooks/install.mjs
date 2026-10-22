#!/usr/bin/env node
// Adds the G2 hub hooks to ~/.claude/settings.json (user-wide), keeping existing hooks.
// Run on every machine whose Claude Code sessions you want on the glasses:
//   G2_HUB_URL=http://<hub-tailscale-ip>:8787 G2_HUB_TOKEN=... node hooks/install.mjs
// Pass --uninstall to remove them.

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const settingsPath = join(homedir(), ".claude", "settings.json");
const hookPath = resolve(import.meta.dirname, "cc-hook.mjs");
const uninstall = process.argv.includes("--uninstall");
const url = process.env.G2_HUB_URL || "http://127.0.0.1:8787";
const token = process.env.G2_HUB_TOKEN || "";

const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
if (existsSync(settingsPath)) copyFileSync(settingsPath, settingsPath + ".bak-g2");

const command = `G2_HUB_URL=${url} G2_HUB_TOKEN=${token} node ${JSON.stringify(hookPath)}`;
const MARK = "cc-hook.mjs";
const events = { PermissionRequest: 660, Notification: 5, Stop: 5, UserPromptSubmit: 5, SessionEnd: 5 };

settings.hooks ??= {};
for (const [event, timeout] of Object.entries(events)) {
  const groups = (settings.hooks[event] ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? "").includes(MARK)) }))
    .filter((g) => g.hooks.length);
  if (!uninstall) groups.push({ matcher: "", hooks: [{ type: "command", command, timeout }] });
  if (groups.length) settings.hooks[event] = groups;
  else delete settings.hooks[event];
}

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`${uninstall ? "Removed" : "Installed"} G2 hooks in ${settingsPath} (backup at settings.json.bak-g2)`);

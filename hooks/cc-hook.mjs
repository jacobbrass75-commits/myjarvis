#!/usr/bin/env node
// Claude Code hook -> G2 hub bridge. Zero dependencies; install with hooks/install.mjs.
//
// For PermissionRequest it blocks until you answer on the glasses/ring/phone, then prints
// the decision. If the hub is unreachable or times out it prints nothing, so Claude Code
// falls back to its normal terminal prompt. Every other event is fire-and-forget status.

import { hostname } from "node:os";

// Sessions started by the hub/daemon already report directly.
if (process.env.G2_HOOK_DISABLE) process.exit(0);

const HUB = process.env.G2_HUB_URL || "http://127.0.0.1:8787";
const TOKEN = process.env.G2_HUB_TOKEN || process.env.HUB_TOKEN || "";
const HOST = process.env.G2_NODE_NAME || hostname().replace(/\.local$/, "");

let raw = "";
for await (const c of process.stdin) raw += c;
let body;
try {
  body = JSON.parse(raw);
} catch {
  process.exit(0);
}
body.__host = HOST;

const event = body.hook_event_name;
const blocking = event === "PermissionRequest";

try {
  const res = await fetch(`${HUB}/api/hook/${event}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-token": TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(blocking ? 10 * 60_000 : 3_000),
  });
  if (blocking && res.ok) {
    const d = await res.json();
    if (d.decision === "allow" || d.decision === "deny") {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision:
              d.decision === "allow"
                ? { behavior: "allow" }
                : { behavior: "deny", message: d.message || "Denied from G2 glasses." },
          },
        }),
      );
    }
  }
} catch {
  // Hub down: stay out of the way.
}
process.exit(0);

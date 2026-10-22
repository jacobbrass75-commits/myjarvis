// Connect your Google account (Calendar + Gmail) to the hub, on the Mac that runs it:
//   npm run google:connect                 opens Google's consent page, waits for the redirect
//   npm run google:connect -- --status     who is connected
//   npm run google:connect -- --disconnect revoke access and delete the local token
// The refresh token goes to ~/.g2-orchestrator/google-token.json (mode 600). The running hub picks
// it up on its next Google call; no restart needed.

import { execFile } from "node:child_process";
import { GoogleAuth, GOOGLE_SCOPES } from "../src/hub/google/auth.js";

const auth = new GoogleAuth();
const arg = process.argv[2] ?? "";

if (arg === "--status") {
  const s = auth.status();
  console.log(!s.configured ? "Not set up: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET missing in .env." : s.connected ? `Connected as ${s.email ?? "(unknown address)"}. Token: ${auth.tokenFile}` : "Not connected.");
  process.exit(0);
}

if (arg === "--disconnect") {
  await auth.disconnect();
  console.log("Disconnected: access revoked at Google and the local token deleted.");
  process.exit(0);
}

try {
  const { url, done } = await auth.beginConnect();
  console.log(`Asking for: ${GOOGLE_SCOPES.map((s) => s.split("/").pop()).join(", ")}`);
  console.log("Opening Google's consent page in your browser. If it doesn't open, paste this into a browser on THIS Mac:\n");
  console.log(url + "\n");
  if (process.platform === "darwin") execFile("open", [url], () => {});
  console.log("Waiting for you to finish (5 minutes)…");
  const email = await done;
  console.log(`Connected as ${email}. Token saved to ${auth.tokenFile} (mode 600).`);
  process.exit(0);
} catch (e: any) {
  console.error(String(e?.message ?? e));
  process.exit(1);
}

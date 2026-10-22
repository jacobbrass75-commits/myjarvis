/**
 * Run Jarvis on the glasses straight from this Mac, without the Even App:
 *   1. iPhone: turn Bluetooth off in Settings and force-quit the Even App (frees the glasses).
 *   2. npm --prefix native install @abandonware/noble   (once)
 *   3. npm run jarvis:native            (from the repo root, with the hub running)
 * Flags: --mock (simulated lenses, for testing without hardware), --prelude, --role 2 (see README).
 */
import { startJarvis } from "../glasses/src/app.ts";
import { G2Driver } from "./driver/src/driver.ts";
import { nativeBridge } from "./jarvis-bridge.ts";
import { createLc3Decoder } from "./lc3.ts";

const args = process.argv.slice(2);
const HUB = process.env.G2_HUB_URL || "http://127.0.0.1:8787";
const TOKEN = process.env.G2_HUB_TOKEN || process.env.HUB_TOKEN || "";

async function main() {
  let g2: G2Driver;
  if (args.includes("--mock")) {
    const { MockPeripheral } = await import("./driver/src/transports/mock.ts");
    g2 = await G2Driver.attach(new MockPeripheral("L", "Even G2_00_L_MOCK"), new MockPeripheral("R", "Even G2_00_R_MOCK"), { stepDelayMs: 0, heartbeatMs: 0, lc3: createLc3Decoder() });
    console.log("Attached to simulated lenses (--mock).");
  } else {
    const { createNobleCentral } = await import("./driver/src/transports/noble.ts");
    console.log("Scanning for G2 glasses for up to 10 min… turn off the iPhone's Bluetooth (Settings) now.");
    const role = args.includes("--role") ? Number(args[args.indexOf("--role") + 1]) : undefined;
    g2 = await G2Driver.connect(await createNobleCentral(), {
      pipeRole: role,
      scanTimeoutMs: 10 * 60_000, // keep looking: start this, then turn off the iPhone's Bluetooth
      dashboardPrelude: args.includes("--prelude"),
      lc3: createLc3Decoder(), // the glasses send LC3; the hub wants PCM
      log: args.includes("--verbose") ? (m: string) => console.log(`[g2] ${m}`) : undefined,
    });
    console.log("Connected to the glasses.");
  }
  await startJarvis(nativeBridge(g2) as any, [HUB], TOKEN);
  process.on("SIGINT", async () => {
    await g2.shutdown().catch(() => {});
    await g2.close().catch(() => {});
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});

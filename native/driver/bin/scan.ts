// Passive BLE scan: lists G2 lenses and R1 rings that are advertising. Connects to nothing.
// Usage: node native/driver/bin/scan.ts [seconds=15]
import { createNobleCentral } from "../src/transports/noble.ts";
import { parseG2Manufacturer, sideFromName } from "../src/transport.ts";
import { ringIdFromName } from "../src/r1.ts";

const seconds = Number(process.argv[2] ?? 15);
const central = await createNobleCentral();
const seen = new Set<string>();
const ac = new AbortController();
setTimeout(() => ac.abort(), seconds * 1000);
console.log(`scanning ${seconds}s for "Even G2_*" and "EVEN R1_*" ...`);
await central.scan(
  (a) => {
    if (seen.has(a.id)) return;
    const side = sideFromName(a.name);
    const ring = ringIdFromName(a.name);
    if (!side && !(ring && a.name.toUpperCase().includes("R1"))) return;
    seen.add(a.id);
    const { serial, mac } = parseG2Manufacturer(a.manufacturerData);
    console.log(side ? `G2 ${side.padEnd(5)} ${a.name}  id=${a.id} rssi=${a.rssi} serial=${serial ?? "?"} mac=${mac ?? "?"}` : `R1 ring  ${a.name}  id=${a.id} rssi=${a.rssi}`);
  },
  { signal: ac.signal },
);
if (seen.size === 0) console.log("nothing found. Glasses only advertise when no phone is connected: turn off the iPhone's Bluetooth.");
process.exit(0);

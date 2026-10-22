// First hardware test: connect, show text, print gestures (temple + ring), optional mic byte count.
// Usage: node native/driver/bin/hello.ts [--serial XYZ] [--mic] [--prelude] [--role 2]
import { G2Driver } from "../src/driver.ts";
import { createNobleCentral } from "../src/transports/noble.ts";

const args = process.argv.slice(2);
const serial = args.includes("--serial") ? args[args.indexOf("--serial") + 1] : undefined;
const wantMic = args.includes("--mic");
const dashboardPrelude = args.includes("--prelude");
const pipeRole = args.includes("--role") ? Number(args[args.indexOf("--role") + 1]) : undefined;

const central = await createNobleCentral();
const g2 = await G2Driver.connect(central, { serial, dashboardPrelude, pipeRole, log: (m) => console.log(`[g2] ${m}`) });
console.log("auth:", g2.authenticated);

await g2.createPage({
  text: [{ id: 1, name: "main", x: 0, y: 0, width: 576, height: 288, captureEvents: true, content: "Hello from native/ driver\nTap, swipe or use the ring" }],
});

let n = 0;
g2.onInput(async (gesture, source) => {
  console.log(`input: ${gesture} from ${source}`);
  if (gesture === "double_tap") {
    await g2.shutdown(0);
    await g2.close();
    process.exit(0);
  }
  await g2.setText(1, `#${++n}: ${gesture}\nfrom ${source}\n\ndouble tap to quit`);
});
g2.onEvent((e) => {
  if (e.kind !== "input" && e.kind !== "heartbeat_ack") console.log("event:", JSON.stringify(e, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v)));
});

console.log("device:", await g2.requestDeviceInfo());

if (wantMic) {
  let bytes = 0;
  await g2.startMic(({ lc3Frames }) => {
    bytes += lc3Frames.length * 40;
  });
  setInterval(() => console.log(`mic: ${bytes} LC3 bytes so far`), 2000);
}

process.on("SIGINT", async () => {
  await g2.close();
  process.exit(0);
});

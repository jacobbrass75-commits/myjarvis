# native/: drive the G2 glasses without the Even App

This is a prototype that talks to Even Realities G2 glasses (and, through them, the R1 ring) straight
over BLE from a Mac. Its API mirrors the Even Hub SDK bridge, so the glasses app logic can move
across later. It also holds the plan for an iPhone app that replaces the Even App.

**Status: written from the community's protocol research and unit-tested, but never run on real
glasses** (they were paired to the iPhone). Expect a few rounds of fixes at the first hardware test.

| File | What |
|---|---|
| `PROTOCOL.md` | Everything known about the protocol, with sources and a confidence level per section |
| `driver/src/` | The TypeScript driver. Protocol encoding has no dependencies and is kept separate from the transport. |
| `driver/src/constants.ts, crc.ts, protobuf.ts, framing.ts` | UUIDs, service and command IDs, CRC-16/CCITT-FALSE, protobuf codec, packet framing and reassembly |
| `driver/src/messages/evenhub.ts` | Pages and containers, text, images, mic, IMU, heartbeat, event decoding |
| `driver/src/messages/device.ts` | Auth, pipe role, time sync, dev heartbeat, ring binding, battery/firmware, brightness |
| `driver/src/bmp.ts, audio.ts, r1.ts` | 4-bit BMP, LC3 packet split and optional liblc3-wasm decoder, R1 ring helpers |
| `driver/src/transport.ts` | The `BleCentral` / `BlePeripheral` interfaces (swap in noble, CoreBluetooth, bleak, Web Bluetooth); finding the L/R pair |
| `driver/src/transports/noble.ts, mock.ts` | The macOS/Linux transport (optional peer dependency `@abandonware/noble`) and an in-memory mock |
| `driver/src/driver.ts` | `G2Driver`: `connect`, `createPage`/`rebuildPage`, `setText`, `setImage`, `startMic`/`stopMic`, `setImu`, `shutdown`, `onInput(gesture, source)`, `onAudioData`, `requestDeviceInfo`, `bindRing` |
| `driver/bin/scan.ts, hello.ts` | Hardware smoke tests |
| `driver/test/*.test.ts` | 53 `node:test` tests |
| `ios/README.md` | The iPhone app plan |

```bash
cd native
npm test            # node --test, no install needed (Node >= 22.18 runs .ts natively)
npm run typecheck   # uses the repo root's TypeScript
```

## API sketch

```ts
import { G2Driver, createNobleCentral } from "./driver/src/index.ts";

const g2 = await G2Driver.connect(await createNobleCentral());
await g2.createPage({ text: [{ id: 1, name: "main", x: 0, y: 0, width: 576, height: 288, captureEvents: true, content: "hi" }] });
await g2.setText(1, "updated");
await g2.setImage(2, { width: 200, height: 100, pixels /* 8-bit grey */ });   // needs an image container
g2.onInput((gesture, source) => console.log(gesture, source));               // "tap" | "double_tap" | "scroll_up" | ... , "ring" | "glasses_right" | ...
await g2.startMic(({ lc3Frames, pcm }) => {/* pcm only if you pass { lc3: decoder } */});
```

## What is verified and what is not

**Verified offline (tests):**
- The CRC algorithm (check value 0x29B1), and that MentraOS's byte-wise formula is the same CRC.
- A **real Even App packet** (captured by g2-kit-unofficial): its CRC checks out, and our framer
  reproduces it byte for byte.
- Our AUTH and PIPE_ROLE packets match the Even App handshake bytes published by
  i-soxi/even-g2-protocol, including the CRC.
- Framing: fragmentation, a constant sync id, serials, the extra CRC-only packet, reassembly with
  L/R kept separate, result-code rejection.
- Every message builder and parser against the field layouts in MentraOS (and the payload hex
  strings G2.kt matches on real traffic, e.g. the heartbeat ACK `080C7A02100C` and the text ACK
  `080652020808`).
- Driver behaviour with mock lenses: handshake order and which lens gets what, CREATE followed by
  REBUILD, no interleaving of multi-packet writes, per-fragment image ACK gating with retries,
  removal of duplicate gestures and audio packets, heartbeats.

**Not verified (needs hardware):** that the glasses accept this exact handshake from a Mac, bonding
behaviour on macOS, the noble transport itself, list containers, the IMU field number, LC3
decoding (`loadLiblc3Wasm` is untested and no decoder is bundled), and anything about the R1
ring's own protocol. `PROTOCOL.md` §14 lists the open questions.

## Run the full Jarvis app without the Even App

`native/jarvis.ts` runs the same Jarvis glasses app (glasses/src/app.ts: launcher, Copilot,
Translate, Navigate, Agents, Notes, Teleprompter, Today) on the Mac, talking to the glasses through
this driver. `jarvis-bridge.ts` maps the Even Hub SDK bridge calls onto `G2Driver`, and `lc3.ts`
decodes the glasses' LC3 mic audio to PCM with lc3codec (BSD-3-Clause, pure JS; round-trip
test in driver/test/lc3.test.ts).

```bash
npm run hub                          # repo root, in one terminal
npm run jarvis:native -- --mock      # simulated lenses: checks the whole path without hardware
npm run jarvis:native                # real glasses (iPhone Bluetooth off, Even App quit)
npm run jarvis:native -- --verbose --prelude --role 2   # if the first try shows nothing
```

Verified with simulated lenses: the launcher is sent as a real G2 page, ring swipe + tap open
Copilot with live cards from the hub, double tap goes back, Today loads. Not yet verified on the
real glasses (see "Testing on hardware").

## Testing on hardware (next steps)

1. Install the BLE library (it builds a native addon; needs Xcode Command Line Tools):
   `npm --prefix native install @abandonware/noble`
2. **Free the glasses from the phone:** on the iPhone, turn Bluetooth off in **Settings**
   (the Control Center toggle can leave the phone reconnecting) and force-quit the Even App. You do not
   need to unpair them. Take the glasses out of the case.
3. Scan without connecting: `node native/driver/bin/scan.ts`. You should see two `G2 left/right`
   lines with the same serial. On first run macOS asks to give your terminal Bluetooth access; allow
   it.
4. Connect and test: `node native/driver/bin/hello.ts`. If macOS shows a pairing dialog,
   **accept it** (the gateway README says the link otherwise drops). You should see "Hello from
   native/ driver". Tap or swipe the temples and the ring; each gesture prints and shows on the
   lens. Double-tap quits.
   - No text appears? Retry with `--prelude` (sends the Even App's dashboard prelude) and/or
     `--role 2` (the alternative pipe role). Check the `event:` lines for result codes (§7 of
     `PROTOCOL.md`).
   - Mic: add `--mic`; you should see the LC3 byte count grow by about 4 kB/s (40 bytes every 10 ms).
5. When done, turn the iPhone's Bluetooth back on and open the Even App. It reconnects normally.

The step after that: wire `G2Driver` to the hub as the `glasses` role (see `ios/README.md`,
"Talking to the hub"), first as a Mac-side bridge that mirrors what `glasses/src` does.

## Safety rules this code follows

- It never flashes firmware or touches DFU/OTA services (0xC4/0xC5 file transfer is not implemented).
- It sends only messages with known shapes on service 0x80 (dev_config), which is known to
  soft-brick when misused.
- `bin/scan.ts` is passive. `bin/hello.ts` is the only script that connects.

## Licenses and credits

This is an independent TypeScript implementation written from documentation and from reading
these projects. No source file was copied. Protocol facts (UUIDs, field numbers, byte layouts)
come from:

- **MentraOS** (Mentra Labs, **Apache-2.0**): `G2.kt`, `G2.swift`, `R1.kt` are the primary
  reference for session behaviour, field layouts and the image ACK and audio handling.
- **men-g2-ble-gateway** (gpsnmeajp, **MIT**): a Python port of G2.kt tested on fw 2.2.20. Used for
  the init sequence, the BMP layout, advertisement parsing and the hardware test procedure.
- **g2-kit-unofficial** (Shahara, **MIT**): the captured prelude packet used as a test fixture, the
  EvenHub protobuf descriptor (list containers, event fields), the gotchas, and R1 ring notes.
- **i-soxi/even-g2-protocol** (no license file): the captured handshake bytes used as test fixtures,
  and the teleprompter notes. Only facts were used.
- **Even Hub SDK** type definitions (`glasses/node_modules/@evenrealities/even_hub_sdk`): enum values
  (`EventSourceType`, `OsEventTypeList`) and model names.

If code is later ported verbatim from MentraOS (for example into the Swift app), keep the Apache-2.0
license and NOTICE alongside it.

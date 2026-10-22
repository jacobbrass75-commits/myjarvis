# Super Mario 64 on the Even G2: feasibility and prototype

*Researched and prototyped 2026-10-14. Hardware numbers come from community measurements, not from our glasses.*

## Verdict

**It's feasible as a tech demo, but not as a good way to play Mario.** The official path is the Even App WebView calling `updateImageRawData` over BLE. Each call costs about 105–185 ms no matter how small the image is, and calls cannot overlap. That caps the glasses at roughly **4–7 fps for a single 192x144 or smaller image**, and about **1.3–2 fps for the full 576x288 screen**, which needs four serial container updates. The image has 16 levels of green.

At 192x144 and about 5 fps, with about 250–350 ms from input to photon, you can walk around Castle Grounds, read menus and get a few stars. Precise platforming like Bowser stages or wall-kicks will feel like playing over a bad video call.

Nothing found suggests stock firmware goes meaningfully faster. The only claimed big speedups need custom firmware (see below).

## Expected frame rate

| Image on glasses | Calls/frame | Predicted (cost model) | Reported on hardware |
|---|---|---|---|
| 160x120 (4:3) | 1 | ~7.1 fps | – |
| **192x144 (4:3), recommended** | 1 | **~6.3 fps** | – |
| 200x100 | 1 | – | 7.0 fps [1] |
| 288x144 (one max container) | 1 | ~5.4 fps | 5.4 fps [1]; ~1.5–2 fps for a detailed PNG coin [3] |
| 384x288 (4 x 192x144) | 4 | ~1.6 fps | – |
| 576x288 full screen (4 x 288x144) | 4 | ~1.35 fps | 4 x 58px containers: 2.3 fps [1] |
| 30x30 / 50x50 PNG | 1 | – | 9.3 / 4.0 fps, judged visually [2] |

The cost model comes from [1], measured on firmware 2.2.7.14 with SDK 0.0.13: **ms ≈ 104 + 0.0039 × (w·h/2)** per call. The fixed overhead dominates. A 10.5x larger image costs only 1.6x more time, so **fewer calls beats smaller images**. That is why the recommendation is one container, not a 2x2 grid with dirty-tile diffing. For a 3D game every tile changes every frame anyway.

[1] also notes these are host call rates and the visible on-glass rate may be lower. [3] reports about 150 ms per update plus extra time for image detail, and its simulator runs show 19–30 fps, so **the simulator is not representative**. Treat 4–6 fps as the planning number until we measure on our glasses.

### Is there anything faster?

- **Raw BLE from the Mac, without the Even App.** [men-g2-ble-gateway](https://github.com/gpsnmeajp/men-g2-ble-gateway/) (Python/Bleak, ported from MentraOS `G2.kt`) drives stock firmware directly: 4-bit BMP tiles, unchanged tiles skipped. [OpenEvenSdk](https://github.com/Thepizzapie/OpenEvenSdk), [MentraOS](https://github.com/Mentra-Community/MentraOS) and [i-soxi/even-g2-protocol](https://github.com/i-soxi/even-g2-protocol) are similar. They still render through the same EvenHub image containers on the glasses, and the gateway's own defaults (`image_fragment_interval_ms: 200`) do not suggest a faster path. Nobody publishes an fps figure. The glasses must also be disconnected from the phone. Worth one benchmark later, but not a plan.
- **Custom firmware.** [g2flash](https://github.com/jimrandomh/g2flash) (used with Faceclaw) claims much faster radio transfer, compressed images, full-screen 640x480 output and display lists. It gives no numbers, warns it "can brick the glasses", and voids the warranty. **Not recommended.** (g2fast is an empty repo.)
- **Prior art.** [WAD Player for Even G2](https://github.com/jpneagle/WAD-Player-for-Even-G2) runs PureDOOM (WASM) in the phone-side WebView with an on-phone controller. It streams the latest acked 192x120 frame and drops stale ones, which is the same design as ours. It has not published an fps figure either. [awesome-even-realities-g2](https://github.com/pangoleen/awesome-even-realities-g2) lists no emulators.

## Recommended architecture

```
iPhone Safari: controller.html ──pad JSON (Wi-Fi, ~5-20 ms)──▶ Mac: hub/relay ──▶ Mac browser: SM64 web build (sm64ex TARGET_WEB=1)
                                                                                  │ canvas, 30 fps, full speed
                                                                                  ▼ stream.ts: downscale 192x144, Bayer → 16 levels, diff
iPhone, Even App WebView: glasses page ◀──4-bit tile (13.8 KB, binary ws)── hub/relay ◀┘
   └─ updateImageRawData (PNG) ──BLE ~160 ms──▶ G2.  Ack → next frame (one in flight, latest frame wins)
```

**Where the game runs: (a) the SM64 web build in a browser on the Mac.**

- **(a) Mac browser, sm64ex `make TARGET_WEB=1`** ([sm64ex build options](https://github.com/sm64pc/sm64ex/wiki/Build-options), [web build](https://github.com/sm64pc/sm64ex/wiki/Compiling-for-the-web)). Recommended. The game runs at full speed, independent of the BLE rate. The canvas is directly readable, and you get DevTools. The extra network hop costs a few ms against about 160 ms of BLE, so it is free in fps terms. Input arrives through `navigator.getGamepads()`, which we patch, so the game source needs no changes.
- **(b) In the Even App WebView on the iPhone.** This is proven for Doom by WAD Player, and it removes the Mac: the touch controls could live on the same page that drives the glasses. The costs are WebGL plus WASM plus the BLE bridge all on one JS thread, phone thermals, and the Even App having to stay foreground. It's a good second step: `stream.ts` and the controller work unchanged there, with no relay.
- **(c) Native sm64ex or sm64coopdx on the Mac plus screen capture.** This works, but needs ScreenCaptureKit, a separate encoder process and a virtual HID or keyboard injection for input. It has more moving parts for the same output, so keep it as the fallback if the web build fails. sm64coopdx has no web target.

**ROM.** The decomp ([n64decomp/sm64](https://github.com/n64decomp/sm64)) and its ports extract assets from a ROM the user supplies (`baserom.us.z64`). The user builds with their own legally obtained copy. This repo never downloads, links to or commits a ROM or ROM-derived build output; `apps/mario64/.gitignore` excludes `*.z64` and `sm64/`.

**Controller.** Use the phone web page (built) as the default: it works anywhere and needs no pairing. The latency path is phone → Wi-Fi → Mac relay → page; localhost round trip measured 1–2 ms, and a LAN typically adds 5–20 ms. That is noise next to the display path. A **real Bluetooth gamepad on the Mac** (any MFi, Xbox or DualSense controller) is the better-feeling alternative and already works through the same Gamepad API, with no code changes. The R1 ring and temple gestures are forwarded (`sink_input`) and could map to Start or pause.

**Image format.** The host converts any input with `imageToGray4` [4]. `imageData` accepts PNG bytes (confirmed by [2], [3] and WAD Player) or, per [4], raw one-byte-per-pixel grey. We pre-quantise to exactly 16 levels as `level*17`, so the host conversion should be lossless, and send **8-bit grey PNG by default**. Raw grey (`gray8`) and 4-bit PNG (`png4`) are switchable for testing. We use Bayer (ordered) dithering because it is temporally stable: no shimmer, and identical regions stay byte-identical for diffing. [4] suggests not dithering to 1-bit, and we don't; we dither to 16 levels.

## What was built (`apps/mario64/`)

This is a standalone package (Vite + `ws` relay) that touches nothing outside `apps/mario64/`. It typechecks and builds, and `npm test` passes. The test checks dither levels, 4-bit pack/unpack, the tile wire format, and that our PNGs decode back to the exact levels in Pillow.

- `src/stream.ts`, `src/gray.ts`: canvas → downscale (contain/cover) → tone (gamma/contrast/brightness) → Bayer or Floyd–Steinberg to 16 levels → split into up to 4 containers (≤288x144) → per-tile diff → packed 4-bit binary frames. Frames are ack-paced with one in flight, a 4 s timeout and resend of failed tiles. Stats cover acked fps, bridge ms per tile, tiles per frame and bytes, next to the cost-model prediction. `forcePreserveDrawingBuffer()` handles WebGL games.
- `glasses.html` / `src/sink.ts`: the Even App page. It builds the page (image containers plus a full-screen event-capture text container behind them), serialises `updateImageRawData` calls and acks with timings. In a desktop browser it renders locally with the cost-model delay.
- `controller.html` / `src/controller.ts`: landscape N64 pad with a floating analog stick, A/B/Z/L/R/Start and C-buttons. It supports multi-touch and sliding between buttons, has a 1 s failsafe, and shows round-trip time. `src/pad.ts` exposes it as a virtual standard Gamepad.
- `index.html` / `src/scene.ts`: a ROM-free third-person 3D test scene (move, jump, dash, crouch, camera, coins) with a 576x288 preview of the glasses output.
- `relay.ts`: a token-protected ws relay on :8790; Vite proxies `/ws` to it.

Verified in a desktop browser: the scene, the stream to the browser sink (1-tile and 4-tile layouts, with diffing skipping unchanged tiles and sending nothing while paused), the controller → game virtual gamepad path, and the pad echo round trip.

## Unverified (needs the real glasses)

1. The actual fps on our G2, firmware and Even App version. Run `glasses.html` in the Even App and read the stats on the Mac page.
2. Whether the `gray8` raw path works and how the host interprets it (0–255 vs 0–15, row order), and whether it is faster than PNG. The 4-bit PNG path is also untested on hardware.
3. Whether a full-screen text container behind image containers (`zOrderIndex`) is accepted and still captures taps.
4. Visible tearing or lag between serial tile updates in the 4-tile layouts.
5. Sustained streaming: [1] warns about glasses memory and possibly thermal limits.
6. The SM64 web build itself: build health with current emsdk, SDL2 picking up the virtual gamepad, and the default button mapping (B→X, Z→LT are assumptions).
7. Whether the Even App WebView can reach the Mac on the LAN with the `network` permission's empty whitelist (the orchestrator glasses app already does this, so it is likely fine).

## Hub integration (not done: hub files are off-limits for this task)

The prototype uses its own relay. To move it onto `src/hub/server.ts` on :8787:

- `src/shared/protocol.ts`: add `"game"` to `Role`. The controller can keep `"phone"`, but it needs to be distinguishable from the agent-phone UI, so it is cleaner to also add `"pad"`. Add these `ClientMsg` variants, all relayed by the hub without interpretation:
  - `{ t: "m64_sync" }`: game → glasses.
  - `{ t: "m64_layout"; tiles: {id,name,x,y,w,h}[]; bridgeFormat }`: game → glasses.
  - `{ t: "m64_ready"; inEvenApp; simulatedDelay }`: glasses → game.
  - `{ t: "m64_ack"; seq; tiles; totalMs }`: glasses → game.
  - `{ t: "m64_input"; event }`: glasses → game.
  - `{ t: "m64_pad"; seq; sentAt; state:{x,y,buttons} }`: pad → game.
  - `{ t: "m64_pad_echo"; seq; sentAt }`: game → pad.
  - Mirror them in `HubMsg`.
- `src/hub/server.ts`, in `ws.on("message")`: binary is currently treated as microphone audio (`if (role === "glasses" || role === "phone") audio?.push(...)`). Add a branch before it: `if (role === "game") { for each glasses client: c.ws.send(data, { binary: true }); return; }`. Tile frames also start with magic byte `0x47` if a content check is preferred. Route the JSON `m64_*` messages by role as listed. Peer counts can go in `state` or a small `m64_peers` message.
- Optionally serve `apps/mario64/dist` at `/mario64/` like `/glasses/`. Then rename the `t` values in `apps/mario64/src/wire.ts` (one file) and point `relayUrl()` at the hub.

## Next steps

1. Put the glasses page on the real G2, record fps for `s192`, `s160`, `s288` and `q576` with `png8` versus `gray8`, and replace the predictions in this doc.
2. Build sm64ex `TARGET_WEB=1` with your own ROM outside the repo, and wire it in per `apps/mario64/README.md` "Plugging in SM64".
3. Tune gamma and contrast for SM64's bright palette on the green micro-LED. Black is "off", so dark scenes read better. Consider a high-contrast edge-enhance pass before dithering.
4. If fps is acceptable, fold into the hub (above), and try option (b) with the game in the Even App WebView.
5. Optional: benchmark raw BLE from the Mac via men-g2-ble-gateway to see whether bypassing the Even App changes the ~104 ms per-call floor.

## Sources

1. nickustinov/even-g2-notes, Performance: https://github.com/nickustinov/even-g2-notes/blob/main/docs/performance.md
2. bigdra, "Even G2 Development: SDK Feature Verification Notes" (zenn.dev): https://zenn.dev/bigdra/articles/eveng2-sdk-features?locale=en
3. Jadoking/g2-engine: https://github.com/Jadoking/g2-engine
4. nickustinov/even-g2-notes, Display and UI: https://github.com/nickustinov/even-g2-notes/blob/main/docs/display.md
5. pangoleen/awesome-even-realities-g2: https://github.com/pangoleen/awesome-even-realities-g2
6. WAD Player for Even G2: https://github.com/jpneagle/WAD-Player-for-Even-G2
7. gpsnmeajp/men-g2-ble-gateway: https://github.com/gpsnmeajp/men-g2-ble-gateway/
8. jimrandomh/g2flash: https://github.com/jimrandomh/g2flash
9. sm64ex build options and web build: https://github.com/sm64pc/sm64ex/wiki/Build-options, https://github.com/sm64pc/sm64ex/wiki/Compiling-for-the-web
10. n64decomp/sm64: https://github.com/n64decomp/sm64
11. Even Realities SDK typings: `glasses/node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts` (container limits 20–288 x 20–144, max 4 images / 12 containers, `ImageRawDataUpdateResult` codes, `imageToGray4Failed`)

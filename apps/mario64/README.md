# G2 stream prototype (groundwork for SM64 on the glasses)

This is a game-agnostic pipeline. It streams any `<canvas>` to Even Realities G2 glasses and measures the frame rate the glasses actually accept, and it includes a phone touch controller. You can exercise the whole loop without a ROM by using a small built-in 3D test scene.

Feasibility, numbers and sources are in [`../../docs/mario64.md`](../../docs/mario64.md).

```
 Mac browser: index.html                  relay.ts (:8790, via Vite /ws)       iPhone, Even App WebView: glasses.html
 game canvas -> stream.ts  --- 4-bit tiles (binary ws) --->  --->  sink.ts -> bridge.updateImageRawData -> BLE -> G2
             <------------------------------- ack (per frame) ------------------
 pad.ts (virtual Gamepad) <--- pad state (JSON) ---------  <---  controller.html (iPhone Safari, landscape)
```

## Run

```bash
cd apps/mario64
npm install
M64_TOKEN=pick-something npm run relay      # terminal 1: ws relay on :8790
npm run dev                                 # terminal 2: Vite on :5174 (proxies /ws to the relay)
```

- **Game page (Mac):** `http://localhost:5174/?token=pick-something`. Keep this tab visible, because background tabs throttle `requestAnimationFrame`.
- **Controller (iPhone Safari):** `http://<mac-lan-ip>:5174/controller.html?token=pick-something`. Hold the phone in landscape. "Add to Home Screen" gives you full screen.
- **Glasses:** load `http://<mac-lan-ip>:5174/glasses.html?token=pick-something` in the Even App. `npm run qr` (evenhub CLI) prints a QR for port 5174; add the `?token=` query if your QR flow allows it. Otherwise run the relay without `M64_TOKEN` on a trusted network.
- **No glasses?** Open `glasses.html` in any browser. It renders the tiles locally and waits `104 ms + 3.9 ms/KB` per tile, the community-measured cost of `updateImageRawData`, so the FPS readout approximates hardware. Add `?simdelay=0` to see the raw pipeline speed.

On the game page you can switch the layout (1 tile 192x144 up to 4 tiles 576x288), the dither (Bayer / Floyd-Steinberg / none), the format handed to the SDK (8-bit grey PNG, 4-bit grey PNG, or raw grey bytes) and the tone (gamma / contrast / brightness). The stats table shows the acked FPS, bridge ms per tile, tiles per frame, bytes, and the hardware prediction. Ticking "pause scene" checks that diffing drops sends to zero.

Checks:

```bash
npm run typecheck
npm test          # dithering, 4-bit pack/unpack, tile wire format, PNG decode via Pillow
```

## Files

| File | What |
|---|---|
| `src/gray.ts` | RGBA → tone-mapped luma → 16 levels (Bayer / Floyd-Steinberg) → packed 4-bit; grey PNG encoder; hardware cost model |
| `src/stream.ts` | Layouts (≤4 image containers, each ≤288x144), `CanvasStreamer` (downscale, dither, per-tile diff), `startStreaming` (one frame in flight, ack-paced), `forcePreserveDrawingBuffer` for WebGL games |
| `src/sink.ts`, `glasses.html` | Glasses app: builds the container page and serialises `updateImageRawData`. It acks with timings, forwards temple/ring gestures, and falls back to a browser preview |
| `src/controller.ts`, `controller.html` | Phone pad: floating analog stick, A/B/Z/L/R/Start, C-buttons, multi-touch, slide between buttons, 1 s failsafe, RTT readout |
| `src/pad.ts` | Exposes the phone pad as a virtual standard-mapping **Gamepad** (`navigator.getGamepads()`), merged with real pads and the keyboard |
| `src/scene.ts`, `src/source.ts`, `index.html` | ROM-free test scene and game page with stats and a 576x288 preview |
| `src/wire.ts`, `relay.ts` | Message types and binary tile format; the standalone relay (until the hub learns these messages) |

## Plugging in SM64

The real game replaces only `TestScene`. Everything else stays the same.

1. You need your own legally obtained SM64 ROM. Never commit a ROM or anything built from one; `.gitignore` here already excludes `*.z64` and `sm64/`. Build the sm64ex web target (`make TARGET_WEB=1` with emsdk, per the sm64ex wiki) outside this repo, or in an ignored `sm64/` folder. The build extracts assets from the ROM you place at `baserom.us.z64`.
2. Serve the emscripten output next to a small page that does, **before the game's script loads**:
   ```ts
   import { forcePreserveDrawingBuffer, startStreaming } from "./src/stream";
   import { installVirtualGamepad, setPhonePad } from "./src/pad";
   import { connectRelay } from "./src/wire";
   forcePreserveDrawingBuffer();          // so drawImage(webglCanvas) is not black
   installVirtualGamepad();               // phone shows up as gamepad 0 to SDL2
   const link = connectRelay("source", { onMsg: (m) => { if (m.t === "pad") setPhonePad(m.state); s.onMsg(m); },
                                         onStatus: (st) => st === "connected" && link.send({ t: "sync" }) });
   const canvas = document.getElementById("canvas") as HTMLCanvasElement; // emscripten's canvas
   const s = startStreaming(() => ({ src: canvas, w: canvas.width, h: canvas.height }), link);
   ```
3. Button mapping is A→A, B→X, Z→LT, R→RB, Start→Start, C→right stick. This matches sm64ex's SDL defaults as far as we know but is **unverified**. Remap in `sm64config.txt` or the in-game controls menu if needed.

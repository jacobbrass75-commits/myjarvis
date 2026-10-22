# Jarvis G2: a native iPhone app that replaces the Even App

Status: **builds, signs, installs and launches on a physical iPhone; native direct BLE has not yet
been tried on real glasses.** Developer Mode and developer verification are complete. The app's
saved hub address matches the main Mac's private Tailscale address. It also runs in the iOS Simulator.
Separately, the Jarvis glasses app itself was tested on physical G2 glasses through the official Even
Realities QR route (Even App hosting), with ring swipe, tap and double-tap confirmed; that test did not
exercise this native app's Bluetooth path.
It connects to the two G2 lenses over Bluetooth LE itself (protocol: `../PROTOCOL.md`), hosts the
unchanged glasses web app (`glasses/`, served by the hub at `/glasses/`) in a WKWebView, and plays
the Even App's part for it. Ring gestures arrive through the glasses, so the R1 needs no pairing.

## What is here

```
ios/
  G2Kit/                 Swift package: the protocol, ported from ../driver/src
    Sources/G2Kit/       CRC, framing + reassembly, protobuf, EvenHub + device messages, 4-bit BMP,
                         audio split/dedupe, R1 helpers, G2Driver (handshake, pipe role, time sync,
                         5 s heartbeats, create/rebuild pages, text, image fragments gated on ACKs
                         with retries, mic, IMU, input events with source, device info),
                         CoreBluetoothTransport (scan, pair L+R by serial, connect, notify, restore id)
    Sources/CLiblc3/     Google liblc3 v1.1.3 (Apache-2.0), vendored unmodified: LC3 -> 16 kHz PCM
    Tests/G2KitTests/    57 tests: every case from ../driver/test plus LC3 encode/decode, pairing, timeouts
  JarvisApp/             iOS app (SwiftUI, iOS 17+)
    JarvisApp.xcodeproj  hand-written project; G2Kit is a local package dependency; shared scheme
    Info.plist           Bluetooth / mic / location / local-network strings, bluetooth-central background mode, ATS
    Sources/
      EvenHubHost.swift  the Even App stand-in: injects window.flutter_inappwebview and serves the SDK's calls
      GlassesLink.swift  scan, connect both arms, driver session, battery, auto-reconnect
      SDKModels.swift    SDK JSON -> PageSpec (same mapping as ../jarvis-bridge.ts); PNG/JPEG -> 4-bit BMP
      PhoneServices.swift GPS for the page; phone mic (16 kHz s16le) as a fallback
      Settings.swift     hub URL (UserDefaults), token (Keychain), options, in-app log
      Views.swift        tabs: Glasses (connect), Jarvis (page + lens preview + gesture pad), Settings, Log
  test-g2kit.sh          runs the G2Kit tests with only the Command Line Tools installed
```

### How the bridge works

The Even Hub SDK finds its host through `window.flutter_inappwebview.callHandler('evenAppMessage', json)`
and awaits the return value; the host pushes events with `window._listenEvenAppMessage(msg)`. The app
injects a `flutter_inappwebview` object at document start whose `callHandler` posts to a
`WKScriptMessageHandlerWithReply`, so the JS promise resolves with the Swift result. **No change to
`glasses/src/main.ts` is needed:** it already takes the Even App path when `flutter_inappwebview` exists.

Envelopes, confirmed by running SDK 0.0.16 against a stub host in Node:

- call: `{"type":"call_even_app_method","method":"createStartUpPageContainer","data":{containerTotalNum,textObject:[…],listObject:[…]}}`;
  `audioControl` data is `{isOpen, source}`, storage is `{key, value}`, location `{accuracy, timeoutMs}` /
  `{intervalMs, distanceFilter}`, `imuControl` `{iMUReportEn, reportFrq}`, images `{containerID, containerName, imageData:number[]}`.
- returns: create -> `0` (success), rebuild/text/audio/storage -> `true`, images -> `"success"`/`"sendFailed"`, location -> `{latitude, longitude, accuracy}` or null.
- push: `{type:"listen_even_app_data", method:"evenHubEvent", data:{type:"sysEvent"|"listEvent"|"textEvent"|"audioEvent", jsonData:{…}}}`.
  A click is sent without `eventType` (the SDK reports CLICK as undefined). `audioPcm` may be a base64
  string, which the SDK turns into a Uint8Array. Also `appLocationChanged` and `deviceStatusChanged`.

Implemented calls: createStartUpPageContainer, rebuildPageContainer, textContainerUpgrade,
updateImageRawData, audioControl, imuControl, shutDownPageContainer, get/setLocalStorage (`hubToken`
maps to the Keychain token), getAppLocation, start/stopAppLocationUpdates, getUserInfo, getGlassesInfo.

The app keeps a mirror of the current page, so it can redraw it after a reconnect, re-create it when
the firmware closed it (double-tap exit), and draw it in the **lens preview**: a rough green-on-black
rendering with buttons that send ring gestures to the page. This is how you test without glasses,
including in the Simulator (verified: the launcher list renders there from the live hub).

## Tabs

- **Glasses**: scan, connect, battery. **Jarvis**: the glasses app running here, with a lens preview.
- **Studio**: vibe-code apps and games for the glasses with Claude (the hub's /studio.html). Describe
  an idea (or tap the mic), Claude writes and test-runs it, and it appears under Apps on the glasses.
- **Agents**: your Claude Code and Codex agents across devices, approvals, Copilot, notes (the hub's
  phone page).
- **Settings**, **Log**.

On **Agents → Copilot**, tap **Listen with phone mic** and allow the iPhone microphone prompt.
The native app supplies 16 kHz PCM to the page, so this works with a private HTTP hub address too;
Safari requires HTTPS for its browser microphone path. Capture stops when the page closes, the
app enters the background, or the hub disconnects. Another Jarvis page must release the microphone
before this page can use it. The current Copilot still uses Claude and local speech recognition;
OpenAI voice is a separate integration awaiting secure API-key setup.

`npm run phone:mic:test` from the repository root checks capture permission races, session cleanup
and PCM forwarding with fake hardware. These checks do not prove recording on a physical iPhone.

## Build and run

You need full Xcode (16 or later) and, once, to accept its license and select it:

```bash
sudo xcodebuild -license accept     # or open Xcode once and accept
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

Protocol tests (Mac, no simulator): `cd native/ios/G2Kit && swift test` (or `../test-g2kit.sh`).

Simulator:

```bash
cd native/ios/JarvisApp
xcrun simctl list devices available          # pick an iPhone
xcodebuild -scheme JarvisApp -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build test
```

or open `JarvisApp.xcodeproj`, pick a simulator, press Run. In the app: Settings -> hub URL
(`http://localhost:8787` works from the Simulator; on a phone use the Mac's LAN or Tailscale address)
and the hub token -> "Save and reload". The Jarvis tab shows the page and the lens preview.
Launch arguments for quick tests: `-hubURL http://localhost:8787 -startTab 1`.
Bluetooth LE does not exist in the Simulator; the Glasses tab says so.

## Put it on your iPhone

1. Connect the iPhone by cable (or same Wi-Fi after the first time), unlock it, trust the Mac.
2. Xcode -> Settings -> Accounts -> add your Apple ID (a free one works).
3. Select the JarvisApp target -> Signing & Capabilities -> Team = your Personal Team. If Xcode says
   the bundle id is taken, change `com.myjarvis.JarvisG2` to something unique to you.
4. Choose your iPhone as the run destination and press Run.
5. First time only: on the phone, Settings -> Privacy & Security -> Developer Mode -> on (restart), then
   Settings -> General -> VPN & Device Management -> select your Apple Development profile -> Trust.
   Until you do, tapping Jarvis (or a launch from Xcode/`devicectl`) fails with an "Untrusted Developer"
   message even though the install succeeded. After trusting, launch Jarvis from the home screen.
6. Force-quit the Even app (the glasses accept one phone at a time; keep it closed while using Jarvis).
   Open Jarvis -> allow Bluetooth -> Glasses tab -> Scan and connect. The pair is remembered and
   reconnected automatically.

Scanning also retrieves G2 arms already connected through iOS, including service-cache entries
under Nordic UART, and preserves each arm's previously observed manufacturer data. Automatic
matching uses a shared serial (or the existing unambiguous shared name suffix). If iOS omits that
identity, **Connect listed arms** is offered only for one left and one right arm with no conflicting
known serials; confirm that both listed names belong to your glasses before using it. Failed or
canceled connection attempts release both acquired arms. A retry waits for iOS to acknowledge the
old disconnect; if that acknowledgement never arrives, close and reopen Jarvis as the error directs.
The Log tab records recovery counts and connection failures for diagnosis.

Free Apple ID: the build expires after **7 days** (press Run again to renew; AltStore/SideStore can
automate it), max 3 sideloaded apps. Paid Developer Program ($99/yr): 1-year signing and TestFlight.
To update firmware or use Even's own features, quit Jarvis and use the Even app.

## Untested / stubbed

- **A complete native BLE session is not yet verified on real glasses.** (The glasses web app and ring
  gestures were confirmed on hardware only through the official Even App QR route, not through this
  app.) Open questions from PROTOCOL.md §14 apply: pipe role
  1 vs 2 and the dashboard prelude are switches in Settings; OS pairing prompt; whether the first
  image after a create is dropped; list-container layout; 200 vs 205-byte audio packets.
- Background: heartbeats, ACKs and LC3 decoding are in Swift and the bluetooth-central mode is set, but
  the page and its hub WebSocket live in the WKWebView, which iOS suspends in the background. Expect
  the glasses UI and mic to work only while Jarvis is in the foreground (screen on). Moving the hub
  socket into Swift is the next step (see "Background" below).
- No direct R1 connection (battery, raw gestures, re-binding); the ring is used through the glasses.
- Image conversion (PNG/JPEG -> 4-bit BMP) is implemented but the Jarvis page does not send images.
- Device build: on this Mac Xcode 27 is installed, its license accepted and the full Developer
  directory selected. Automatic Apple Development signing succeeded, strict `codesign` verification
  passed, and JarvisApp was installed and launched on a physical iPhone with `devicectl` after
  developer verification. The app remains running and its saved hub address matches the main Mac's
  current private Tailscale address. Native hub-page interaction, microphone input and direct BLE
  still need physical acceptance checks. Earlier Simulator runs (Xcode 27 toolchain,
  `arm64-apple-ios17.0-simulator`, iPhone 17 Pro
  against the live hub) still stand. If the hand-written project file ever gives trouble, create a new
  iOS App project named JarvisApp in this folder, delete its generated sources, drag in `Sources/` and
  `Info.plist` (set Info.plist File, untick "Generate Info.plist"), and add `../G2Kit` as a local package.

---

# Background: the original plan

## What the Even App does for us today

```
G2 lenses ──BLE──► Even App (Flutter)
                     ├─ BLE + protocol (pages, text, images, LC3 → PCM, gestures, heartbeat)
                     └─ WKWebView running glasses/ (our app, Even Hub SDK)
                            └─ WebSocket ──► hub  ws://<mac>:8787/ws
```

A replacement must take over both halves: the BLE protocol work and hosting our UI logic.

## Three ways to build it

### A. Host shim (recommended first): reuse `glasses/` unchanged

A small Swift app that:

1. Loads the existing glasses web app (the `glasses/dist` bundle or the hub-served URL) in a
   `WKWebView`.
2. Injects a user script that defines `window.flutter_inappwebview.callHandler(name, msg)`. This is
   the entry point the Even Hub SDK uses. Its `postMessage` calls `callHandler('evenAppMessage',
   {type: 'call_even_app_method', method, data})` and awaits the return value (see the comments in
   `glasses/node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`). Back it with a
   `WKScriptMessageHandlerWithReply` so the JS promise resolves with the Swift result.
3. Maps the methods to the Swift driver: `createStartUpPageContainer`, `rebuildPageContainer`,
   `textContainerUpgrade`, `updateImageRawData`, `audioControl`, `imuControl`,
   `shutDownPageContainer`, `getLocalStorage`/`setLocalStorage` (UserDefaults), `getGlassesInfo`.
4. Pushes events (gestures, PCM audio, device status) to the page through
   `window._listenEvenAppMessage(msg)`, which the SDK installs. **To verify:** the exact push
   envelope (`{type: 'listen_even_app_data', method: 'evenHubEvent', data: {type, jsonData}}` is a
   guess). Read the SDK's obfuscated `index.js` or log what arrives.

Advantages: no change to the hub or the glasses app, and the SDK simulator still works for UI work.
Cost: the SDK's JSON container models need converting to protobuf. The field names match
`PageSpec` in `driver/src/messages/evenhub.ts`.

### B. Fully native client of the hub

Swift renders hub state straight onto the glasses, which means re-implementing `glasses/src`
(modes, paging, approval cards) in Swift. More work. Only worth it if the WebView turns out to be
unreliable in the background (see below).

### C. Use MentraOS's Swift SDK

[mentra-bluetooth-sdk-ios](https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios)
(Apache-2.0, Swift Package) already contains `G2.swift` (about 5.6 k lines, production use) and
`R1.swift`. It could be the BLE layer for A or B. We have not evaluated its public API; it is built
around MentraOS's display model (text walls, bitmaps) rather than Even Hub pages.

**Recommendation:** A, with our own small Swift port of `driver/src`, written the same way as the
TypeScript (framing, CRC, protobuf builders, image ACK gating, write queue). Read MOS `G2.swift`
for the CoreBluetooth details. Cherry-pick from it with attribution if needed: Apache-2.0 allows
this with the NOTICE kept.

## CoreBluetooth specifics

- `Info.plist`: `NSBluetoothAlwaysUsageDescription`, and `UIBackgroundModes = [bluetooth-central]`.
  Add `audio` only if we play sound.
- Create `CBCentralManager` with `CBCentralManagerOptionRestoreIdentifierKey` so iOS relaunches
  the app for BLE events after it is killed in the background. Implement `willRestoreState`.
- Reconnecting: store both lens `identifier`s, then use `retrievePeripherals(withIdentifiers:)` and
  `retrieveConnectedPeripherals(withServices: [00002760-…0000])`. The latter reclaims a lens that
  iOS still holds after a process restart, as MOS does.
- No MACs on iOS: read the lens MAC from manufacturer data (bytes 14..19, reversed). That MAC is
  needed for ring binding.
- Writes: `.withoutResponse` with about 6 ms between packets. **Do not** strictly gate on
  `canSendWriteWithoutResponse` / `peripheralIsReady(toSendWriteWithoutResponse:)`. MOS found that
  iOS does not deliver that callback to a backgrounded central, so a gated queue deadlocks and later
  floods the glasses. Image packets (92 per 288x144 tile) are the exception: they wait for the write
  buffer instead of the gap, but at most 40 ms, and after one such timeout the rest of that image
  goes back to the 6 ms gap. Up to 2 image fragments are in flight per ACK; a failed image steps the
  session down to MentraOS pacing (Settings → Fast image transfer turns it off). Every image push is
  logged as an `img:` line (rate-limited) with its encode, bridge, decode and BLE times. Check that `maximumWriteValueLength(for: .withoutResponse) >= 244`; iOS
  negotiates the MTU itself.
- **Background:** the heartbeats (every 5 s), the image ACK loop and LC3 decoding must run in
  Swift, because JS in a WKWebView is suspended in the background. BLE notifications keep waking
  the app. The hub WebSocket (`URLSessionWebSocketTask`) should also live in Swift, so mic audio
  keeps flowing while the phone is locked. The page then acts only as the UI brain while in the
  foreground. Alternatively, accept that the glasses UI only updates while the app is in the
  foreground. **Decide this after a hardware test.**
- LC3: compile google/liblc3 (Apache-2.0, plain C) into a SwiftPM C target and decode 40-byte
  frames at 16 kHz with 10 ms frames into s16le.

## Talking to the hub (`src/shared/protocol.ts`)

The app acts as the `glasses` role, exactly as the WebView does today:

```
connect ws://<mac>:8787/ws
→ {"t":"hello","role":"glasses","token":"<HUB_TOKEN>"}
← {"t":"welcome","role":"glasses"} then {"t":"state","state":{agents, approvals, nodes, apps, voice}}
push-to-talk:   → {"t":"audio_start","sampleRate":16000,"purpose":"command"}  → binary s16le frames  → {"t":"audio_end"}
listening:      → {"t":"listen_start","purpose":"copilot"|"translate"|"teleprompter","sampleRate":16000}  … {"t":"listen_stop"}
approvals:      → {"t":"approve","id":"…","decision":"allow"|"deny"}
← toast / voice_reply / transcript / copilot / translation / notes / script / dashboard / listening
```

The hub is plain `ws://` on the LAN, so add `NSAppTransportSecurity > NSAllowsLocalNetworking = YES`
and `NSLocalNetworkUsageDescription` (iOS asks for local-network permission). Find the Mac by IP, or
advertise it with Bonjour (`_g2hub._tcp`) and use `NWBrowser`. The token goes in the Keychain.

## Signing and distribution

| Route | Cost | Limits | Fit |
|---|---|---|---|
| **Free Apple ID** (Xcode "Personal Team") | $0 | Profiles expire after **7 days** (reinstall from Xcode, or use AltStore/SideStore to refresh); max 3 sideloaded apps per device; no push, iCloud or App Groups. Background modes, Bluetooth and local network are believed to work. | Prototyping now |
| **Paid Developer Program** | $99/yr | 1-year profiles; ad-hoc install on up to 100 registered devices; TestFlight (builds last 90 days) | Daily personal use |
| **App Store** | $99/yr + review | Review risk: a reverse-engineered protocol for third-party hardware, plus Even Realities' terms. It needs a real privacy story because the mic streams to a server. | Not a goal; only consider it if Even blesses a public BLE API |

On iOS 17+ sideloaded builds also need **Developer Mode** turned on (Settings > Privacy & Security).

## Milestones

1. **Swift package `G2Kit`**: a port of `driver/src` (CRC, framing, protobuf, messages) with the
   same fixture tests (`../driver/test/*.test.ts`), run with `swift test` on the Mac. About 1 day.
2. **CoreBluetooth transport and a one-screen debug app**: connect, handshake, show text, log
   gestures, battery. Verify with the phone's Even App force-quit. About 1 day.
3. **Mic**: liblc3, PCM to a WAV file, then to the hub `audio_start`. About 0.5 day.
4. **Host shim**: WKWebView with `flutter_inappwebview` emulation, then run `glasses/` unchanged.
   About 1-2 days, mostly confirming the SDK message envelopes.
5. **Background**: state restoration, Swift-side heartbeat and WebSocket, a reconnect loop.
   About 1-2 days.
6. Optional: R1 direct connection (battery, raw gestures) and ring re-binding. This is risky
   because new-ring pairing needs Even's server key.

Risk to keep in mind: while our app is connected, the Even App cannot be. Firmware updates and
Even's own features (Even AI, notifications, navigation) need the official app, so switch back to
it when updating firmware. **Never flash firmware from our code.**

# Architecture

How MyJarvis is put together: the components, the main flows, the wire protocol, where state lives,
the security model, the performance budget and how to extend it. Paths are relative to the repository root.
Where code and older docs disagree, this document follows the code (October 2026).

Contents

1. [System overview](#1-system-overview)
2. [Components](#2-components)
3. [Flows](#3-flows)
4. [Protocol message families](#4-protocol-message-families)
5. [Persistence](#5-persistence)
6. [Security model](#6-security-model)
7. [Performance budget and known limits](#7-performance-budget-and-known-limits)
8. [Extending](#8-extending)

## 1. System overview

```
  Even G2 glasses (L arm + R arm)            R1 ring
   576x288, 16 green levels                   gestures go to the glasses,
   mic: LC3 on 6402                           which forward them as eventSource 2
        │  BLE: one peripheral per arm             │
        │  control 5401/5402 under …5450           │  (direct ring link only for
        │  mic 6402 under …6450                    │   Find / Link / handoff)
        ▼                                          ▼
 ┌──────────────────────────── iPhone: JarvisApp (native/ios) ───────────────────────────┐
 │  G2Kit (Swift package)                       EvenHubHost (WKWebView bridge)            │
 │   CoreBluetoothTransport: scan, pair L+R,     injects window.flutter_inappwebview,     │
 │   retrieve held arms, GATT merge              serves Even Hub SDK calls, jarvisImage   │
 │   G2Driver: AUTH, pipe role, time sync,  ◄──► LensMirror (redraw, replay, preview)     │
 │   heartbeats, pages, text, image frags,        │                                       │
 │   mic (liblc3 → PCM), input, ring              ▼                                       │
 │                                         glasses web app (glasses/dist, loaded from hub)│
 │  GlassesLink: session, reconnect, ring  core.ts render + input · modes/* · sandbox.ts  │
 │  PhoneServices: GPS, phone mic          Studio / Agents tabs: hub pages in WebViews    │
 └───────────────────────────────────────────────┬────────────────────────────────────────┘
                                                 │ WebSocket /ws (JSON + binary PCM), HTTP
                                                 │ LAN or Tailscale, HUB_TOKEN
 phone browser / home-screen page ───────────────┤  role "phone"  (phone/index.html, studio.html)
                                                 ▼
 ┌────────────────────────────── HUB on the Mac (src/hub, :8787) ─────────────────────────┐
 │ server.ts  HTTP routes, WS switch, push-to-talk, hooks endpoint, pairing              │
 │ hub.ts     agents, nodes, approvals (humanOnly), broadcast     store.ts  notes, people │
 │ router.ts  voice router: Claude Agent SDK warm session + MCP "hub" tools               │
 │ listen.ts / stt.ts / src/stt  Apple · whisper.cpp · Soniox · Wispr · OpenRouter · Deepgram │
 │ jarvis.ts  listening sessions, copilot.ts ("alpha" cards), translate.ts (pinyin)       │
 │ nav.ts + map/   weather/   sky/   dashboard.ts   messages/   google/   studio.ts       │
 │ workers.ts  pairing codes, g2w_ tokens          safe-fetch.ts  public-only fetch       │
 └───────┬───────────────────────────┬──────────────────────────────┬─────────────────────┘
         │ WS role "node"            │ HTTP /api/hook/*             │ HTTPS
         ▼                           ▼                              ▼
 device daemons (src/node)    Claude Code in a terminal      Google Calendar/Gmail (OAuth),
  one per machine:             (hooks/cc-hook.mjs)            Places, Routes, Static Maps,
  SDK agents, Codex,                                          OSRM, Nominatim, Overpass,
  computer use (g2input)                                      Open-Meteo, RainViewer, CelesTrak,
                                                              Soniox / Wispr / OpenRouter STT,
 the Mac itself: Messages chat.db + osascript,               ip-api, Hacker News
 macOS Calendar fallback, tools/speech g2speech
```

Everything that needs a model runs through the Claude Agent SDK on the user's Claude Code login,
whether in the hub (router, copilot, translator, Studio, mini-app `ask`) or in a daemon (agents,
computer use). The glasses web app is a thin screen, input and mic client. The iPhone app is a radio
plus an Even App stand-in.

## 2. Components

### 2.1 Hub (`src/hub/`)

The hub is one Node process (`npm run hub`, or launchd `com.g2.hub` via `scripts/autostart.sh`).

| File | Responsibility |
|---|---|
| `server.ts` | Startup sequence, HTTP routes, the `/ws` upgrade, the WS message `switch (m.t)`, push-to-talk clips, `handleUtterance`, the Claude Code hook endpoint, the token check |
| `hub.ts` | In-memory state: clients (role, nodeId, workerId, watched agent), agents, nodes, pending approvals with timers and the `humanOnly` flag, voice state, computer-use thumbnails. `changed()` sends one coalesced `state` snapshot per 50 ms |
| `store.ts` | Notes, the teleprompter script and people memory as JSON files in `DATA_DIR` |
| `router.ts` | The voice router: a warm `ClaudeWorker` plus the MCP server `hub` (`hubServer()`) holding all voice tools. `stateBrief()` prefixes each utterance with the time, devices, agents and approvals |
| `claude-worker.ts` | A warm-session wrapper around Agent SDK `query()`: one streaming prompt generator, a FIFO of asks, a restart after `maxTurns`, and a session closed on `setModel` |
| `models.ts` | Assistant and copilot model tier (haiku/sonnet/opus). Precedence: `DATA_DIR/models.json` > `ROUTER_MODEL`/`COPILOT_MODEL` > default |
| `listen.ts`, `stt.ts` | Push-to-talk `startClip()` (live stream plus an optional clip engine for the final), batch `transcribe()` fallbacks |
| `jarvis.ts` | Glue: one continuous listening session (copilot, translate, teleprompter), notes, timers, greeting new clients, `nav_map` to glasses, mini-app `ask`/`fetch` |
| `copilot.ts` | The conversation copilot (`COPILOT_STYLE` = `alpha`, the default, or `coach`), summaries, the conversation log |
| `translate.ts` | Two-way translator worker, deterministic pinyin (`pinyin-pro`) |
| `dashboard.ts` | The *Today* data: Open-Meteo, Google agenda (or macOS Calendar via osascript), Hacker News, the agents line, `where()` location fallback |
| `nav.ts`, `map/` | Places search, routing, progress tracking, the map renderer |
| `weather/`, `sky/` | Weather map and star chart renderers and services |
| `messages/` | macOS Messages: read `chat.db`, contacts, send via osascript, voice tools |
| `google/` | OAuth (`auth.ts`), Calendar, Gmail, voice tools, `confirm.ts` (`glassesConfirm`) |
| `studio.ts`, `studio-models.ts` | Studio: build, check and publish mini-apps; the model catalog and child environment |
| `workers.ts` | Worker pairing codes, `g2w_` tokens, `helloAuth()` |
| `safe-fetch.ts` | `fetchPublic()`: public-internet-only GET for mini-apps |
| `apps.ts` | `apps.json` HTTP actions become `app_<app>_<action>` tools |

HTTP routes (`server.ts`, in match order):

| Path | Auth | Serves |
|---|---|---|
| `POST /api/pair` | none; the one-time code is the credential | Redeems a worker pairing code. 4 KB body limit; 10 failures in 5 min locks it (429) |
| `/api/workers/code`, `/api/workers`, `/api/workers/<id>/revoke` | hub token | Pairing codes, the worker list, revoking a worker |
| `POST /api/hook/<event>` | hub token | Claude Code hooks (`handleHook`) |
| `/api/state`, `/api/voice` | hub token | `hub.snapshot()`; a typed utterance `{text}` → `{reply}` |
| `/api/google/{status,connect,disconnect}`, `/google/connect` | hub token | Google account (`google/index.ts`) |
| `/glasses/*` | none (static) | `glasses/dist` |
| `/miniapps/<id>/app.js?v=N` | `?token=` | The published version `versions/vN.js` |
| `/apps/<name>/…` | none (static) | `apps/<name>/dist` (streamed games) |
| everything else | none (static) | `phone/` (`index.html`, `studio.html`, manifest) |

The token comes from the `x-hub-token` header or `?token=` and is compared with `timingSafeEqual`.
An empty `HUB_TOKEN` disables the check (the hub warns at startup). WebSocket upgrades happen only on `/ws`
(`maxPayload` 8 MB). The first frame must be `hello`.

### 2.2 Device daemons (`src/node/`)

`daemon.ts` runs on every machine with agents (`npm run node`, or launchd `com.g2.node`). It dials out to
`G2_HUB_URL` as `role: "node"` using `G2_HUB_TOKEN`: the hub token on the hub's own Mac, a `g2w_` worker
token elsewhere. Every 60 s it reports capabilities (engine readiness from `engines.ts`, projects
from `projects.ts`, `permissionMode`, OS, `computer` capability), sending them only when they change.

- **Claude agents** use `query()` with a persistent prompt generator, so follow-ups land in the same
  session. Options: `cwd` = the project, `settingSources: ["user","project","local"]`,
  `env.G2_HOOK_DISABLE=1`, and a `canUseTool` callback. That callback auto-allows the tools in
  `G2_AUTO_ALLOW` (default `Read,Glob,Grep,LS,TodoWrite,WebSearch`); every other tool becomes an
  `approval_request`. `G2_BYPASS_PERMISSIONS=1` switches to `bypassPermissions`.
- **Codex** (`codex.ts`) runs `codex exec --json --sandbox workspace-write` (or the bypass flag), then
  `resume <thread>` for later turns, with the prompt on stdin. Codex has no per-tool approval callback,
  so its sandbox is the guard.
- **Computer use** (`computer.ts`, opt-in with `G2_COMPUTER_USE=1`, macOS only) is an Agent SDK session whose only
  tools are an in-process MCP server `computer`. It drives the Swift helper `tools/computer/bin/g2input`
  (CoreGraphics, Accessibility, ImageIO). See §3.7.

### 2.3 Claude Code hooks (`hooks/`)

`node hooks/install.mjs` writes these hooks into `~/.claude/settings.json`, keeping a backup:
`PermissionRequest` (660 s), `Notification`, `Stop`, `UserPromptSubmit` and `SessionEnd`.
`cc-hook.mjs` POSTs each event to `/api/hook/<event>`.
- **Permission requests** long-poll for a decision. If the hub returns `{}` (timeout after
  `HOOK_APPROVAL_TIMEOUT_S`, default 120 s) or is unreachable, the normal terminal prompt appears.
- **Other events** keep a `cc-<session8>` agent of kind `claude-code` up to date.
- **Recursion guard.** `G2_HOOK_DISABLE` stops agents the system itself starts from reporting twice.

### 2.4 Glasses web app (`glasses/`)

The glasses app is a Vite/TypeScript page built with `@evenrealities/even_hub_sdk`.

**Hosts.** The same build runs in three places:
- inside JarvisApp, where `EvenHubHost` fakes the Even App;
- inside the official Even App, by QR;
- in any browser, using the emulator (`emulator.ts`, also forced with `?emulate=1`).

**Finding the hub.** The hub URL is `?hub=`, else `location.origin`, else `VITE_HUB_URLS`. The token is
`?token=`, else `VITE_HUB_TOKEN`, else SDK local storage `hubToken`.

**Files:**
- `core.ts`: the mode stack, `render()`, page layout (`containers()`), rebuild vs. text upgrade, tile and
  picture pushes, input (`onBridgeEvent`, `handle`), approval cards, captions, toasts, screen off,
  push-to-talk.
- `app.ts`: the mode list (`startJarvis`): `captions, launcher, apps, dashboard, copilot, translate,
  navigate, weather, sky, agents, notes, messages, teleprompter, router`. Their `onHub` handlers run in
  that order. `lenstest` is registered lazily by the launcher.
- `modes/*.ts`: one file per mode. `router` (inside `app.ts`) handles `open`, `voice_reply`, `screen`
  and similar messages.
- `ui/`:
  - `kit.ts`: the Lagonda Digital kit, and the style spec in its header;
  - `layout.ts`: `checkLayout`, which mirrors G2Kit `EvenHub.validatePage`;
  - `caption.ts`: live captions;
  - `maneuver.ts`: turn arrows;
  - `bocchi.ts` and `bocchi-frames.ts`: the avatar.
- `sandbox.ts`: the mini-app sandbox (§3.6).
- `png.ts`: 4-bit grey PNG and BMP encoders.

### 2.5 Phone pages (`phone/`)

`phone/index.html` connects as `role: "phone"`. It has these sections: waiting approvals, agents
(output, follow-ups, stop), copilot, location sharing, notes, teleprompter script, start an agent,
devices and apps (pairing, revoke), and Google. `phone/studio.html` is the Studio page, with a model
picker, the job list and a preview iframe of `/glasses/?emulate=1&open=<id>`. JarvisApp shows both pages
in its Agents and Studio tabs. The native `jarvisPhoneMic` bridge supplies 16 kHz PCM there, because
Safari's microphone path needs HTTPS.

### 2.6 iPhone app (`native/ios/JarvisApp`) and G2Kit (`native/ios/G2Kit`)

| File | Responsibility |
|---|---|
| `G2Kit/Sources/G2Kit/CoreBluetoothTransport.swift` | `G2Central`: scan, `retrieveConnectedLenses()`, GATT discovery and `GattCatalog`, ring scan/connect, state restoration (`jarvis.g2.central`) |
| `Transport.swift`, `Connection.swift` | `PairFinder` (L+R by serial or name suffix), `connectG2Pair` (both arms concurrently, release on failure) |
| `G2Driver.swift` | Handshake, heartbeats, pages, text, `setImage` (fragments, ACKs, window, pacing, step-down), mic, IMU, input events, device info, ring bind |
| `Device.swift`, `EvenHub.swift`, `Framing.swift`, `Protobuf.swift`, `CRC.swift` | Message builders and parsers, 0xAA framing and reassembly, CRC-16/CCITT-FALSE, page validation |
| `R1.swift` | Ring notifications, `RingAdvert`/`RingNameCheck`, workbench-style ring frames, `R1Handoff` |
| `ImageFormats.swift` | Image encodings: `standard` plus the experiments `rle4`, `rle8`, `1bit`, `lz4`, `lz4-frag` (`compressMode` 2 for LZ4) |
| `BMP.swift`, `Audio.swift`, `LC3.swift`, `Sources/CLiblc3` | 4-bit BMP, audio split and dedupe, Google liblc3 v1.1.3 decoder |
| `JarvisApp/Sources/GlassesLink.swift` | Owns the BLE session: connect, auto-reconnect (3 s retry), battery every 60 s, ring search/link/rebind |
| `EvenHubHost.swift` | WKWebView host: injected script, SDK method handlers, `jarvisImage`, pushes, `LensMirror` |
| `SDKModels.swift` | SDK JSON → `PageSpec`; PNG/JPEG → 4-bit BMP (`ImageConvert.bmp4`) |
| `PhoneServices.swift` | GPS for the page; phone mic (AVAudioEngine → 16 kHz s16le) |
| `Settings.swift` | Hub URL (UserDefaults), token (Keychain), protocol and image options, the log (`Documents/jarvis.log`, rotated at 5 MB) |
| `Views.swift` | Tabs: Glasses, Jarvis (page, lens preview, gesture pad), Studio, Agents, Settings, Log |

`native/driver/` is the older TypeScript and noble driver that G2Kit was ported from. `native/jarvis.ts`
and `jarvis-bridge.ts` run the glasses app on a Mac straight to the glasses.

### 2.7 Speech-to-text (`src/stt/`, `tools/speech/`)

`createStreamingSTT()` (`index.ts`) picks a live engine. `STT_ENGINE` is `auto` (soniox if keyed → apple →
whisper), a comma list that sets the order, or a single name that forces one engine. On a cloud
failure, `fallbackFrom` replays the audio that wasn't finalized into the next engine.

| Engine | File | Notes |
|---|---|---|
| Apple | `apple.ts` → `tools/speech/bin/g2speech` | SpeechAnalyzer (or SFSpeech) on-device. NDJSON over stdio. One language per stream |
| whisper.cpp | `whisper.ts` | Shared `whisper-server` per model, energy VAD (`vad.ts`), partials every 700 ms, junk filter |
| Soniox | `soniox.ts` | `stt-rt-v5` WebSocket. Language hints plus `alsoLangs` (mixed zh/en). Idle close after 120 s. Bench on a bad key or billing error |
| Wispr Flow | `wispr.ts` | REST. Used mainly as the push-to-talk clip engine (cleaned-up dictation) |
| OpenRouter | `openrouter.ts` | Transcription models (e.g. `deepgram/nova-3`) for clips only (`STT_BATCH_ENGINE=openrouter:<m>`) |
| Deepgram, whisper-cli | `src/hub/stt.ts` | Batch `transcribe()` fallbacks (`STT_PROVIDER`) |

### 2.8 Studio and mini-apps

`studio.ts` turns a prompt into `miniapps/<id>/app.js`, following the contract in `src/shared/miniapp.ts`.
Each new version is copied to `versions/vN.js`, alongside `meta.json`. The glasses list apps in *Apps*
(`glasses/src/modes/apps.ts`) and run them in `sandbox.ts`. See §3.6.

## 3. Flows

### 3.1 Connect and handshake

```
JarvisApp                      G2Kit                                  glasses (L, R)
 GlassesLink.startScan ──► G2Central.startScan (names; mfr data minus company id)
                           + pollConnectedLenses every 2 s: retrieveConnectedPeripherals
                             on 5450 / 6450 / 0000 / Nordic UART (arms iOS already holds)
                     PairFinder: same serial (strong) or name suffix → L+R pair
                             (else "Connect listed arms" after the user confirms)
 connectG2Pair ─────────► connect both arms concurrently (15 s each, 30 s total)
                           discoverServices(nil) → all characteristics → GattCatalog
                           (5401/5402 required; 6402 optional = "no mic")
 G2Driver.start ─────────► subscribe 5402 (+6402) on each arm
                           0x80 AUTH → L, 200 ms, AUTH → R         ◄── reply w/o verdict (logged, keep waiting)
                                                                   ◄── reply with secAuth = verdict
                           0x80 PIPE_ROLE_CHANGE → R (role 1; Settings 1|2)
                           0x80 TIME_SYNC → L and R (local seconds, tz 0)
                           sessionInit: 0x10 skip onboarding, 0x0D gesture init → R
                           (optional dashboardPrelude on 0x01)
                           heartbeats every 5 s: EvenHub {cmd 12} once a page exists,
                           dev-settings {cmd 14} → R and L
 EvenHubHost.replay ─────► CREATE the mirrored page (or wait for the page to draw one)
```

- **Saved pairs.** Identity per arm is kept in UserDefaults (`g2.mfr.<uuid>`, `lens.left/right`), so a held
  arm that doesn't advertise keeps its serial. With `autoConnect` on, a saved pair reconnects when
  Bluetooth turns on, and again 3 s after any drop.
- **Contention.** During the first 30 s, extra 0x80 replies are logged as "another app is driving this link
  (Even app?)". The Even App must be force-quit, because the glasses accept one central.
- **Page loss.** If the firmware closes the page (system or abnormal exit, cmd 9/10, or text result 9),
  `pageAlive`/`micOn` drop. The next text upgrade or mic start rebuilds the page from `LensMirror`.
- **The web side** opens `ws://<hub>/ws`, sends `hello {role:"glasses", token}` and receives `welcome`, then
  `state`. Then come the greeting messages (`miniapps`, `notes`, `script`, the last copilot update,
  `listening`, `translate_options`) and the current nav state (`greetNav`).

### 3.2 Render pipeline

```
mode.screen()  ──►  core.screen()                         ──►  containers(s)          ──► draw()
 Screen {header,      dark? → blank page (approval/PTT          pixels | composed |       first: createStartUpPage
 body|list|pixels,    still show)                               legacy list | text        shape change: rebuildPage
 tiles, boxes, main,  approval card (unless mode.quiet)         ids: 1 header, 2 list,    same shape: textContainerUpgrade
 captionSlot, ...}    + badges, + caption, + toast              3 body, 4-7 tiles,        per changed text  ─┐
                                                                8-11 boxes; 1 captures   then pushTiles /    │
                                                                checkLayout()            pushFrame          │
                                                                                                             ▼
 sendImageNow ── native (JarvisApp): encodeGray4Bmp → base64 → callHandler("jarvisImage")
             └─ SDK (Even App, emulator): encodeGrayPng → updateImageRawData(number[])
                                            │
 EvenHubHost.nativeImage / updateImage → ImageConvert.bmp4 → G2Driver.setImage
   4096-byte fragments, one session id; ACK per fragment (cmd 4/field 6: 4 ok, 5 fail; ~400 ms each;
   timeout 2 s); window 2 in flight; image packets wait for the write buffer (≤40 ms) else 6 ms gap;
   3 attempts with fresh session ids; on failure step down: format → standard, window → 1, flow → gap
   → BLE 5401 (0xAA frames, ≤236 payload bytes, serialised per lens)
```

**Coalescing.** `render()` folds repeated calls into one `draw()` on a promise chain. Every hub
message ends with `render()`, a 30 s timer keeps clocks fresh, and the mic meter redraws at most every 250 ms.

**Page shape.** `shapeOf()` keys a page on container geometry, borders, padding, capture, text colour
and list items, but not on text content. A text change is therefore a cheap upgrade, while a layout
change is a rebuild, which resets the selection and the tile cache.

**Text first.** Text upgrades go out before any image, so words never wait behind a ~1.5 s tile.

**Tiles** (`pushTiles`):
- At most one tile per draw.
- Diffed: a tile is pushed only if its bytes differ from the last send.
- A never-sent all-black tile is skipped, because a fresh container is already black.
- Fairness: dirty tiles are sorted by the age of their last send (never-sent first), then by `prio`/slot,
  so an animated tile 0 can't starve tiles 1-3.
- The first tile after a rebuild is resent once, because the glasses may drop the first image after a create.
- A failed push is retried with a 500·n ms backoff (n < 4), then counted as sent.
- If more tiles are dirty, `render()` is scheduled again.

**Pictures** (`pushFrame`). The 144x72 mini-app pictures are scaled 2x to one 288x144 image. A picture
pump (`render(); await chain; 15 ms`) drives pixel apps as fast as BLE allows.

**Encoding.** `Raster` levels run 0..15, where 0 is see-through. The BMP is 4-bit grey with a
BITMAPINFOHEADER, a 16-entry palette and bottom-up rows. The high nibble is the left pixel.

**Hub-drawn images.** Maps, weather and sky are rendered on the hub as `Raster`, packed with
`pack4` and base64. The glasses cut them into 288x144 tiles and push them as above.

**Lens test.** LENS TEST (`modes/lenstest.ts`) shows the per-container image results and timings,
and can force an image format per push.

### 3.3 Input

**Event path.** Gestures arrive as SDK `listEvent`, `textEvent` or `sysEvent` (G2Kit `forwardInput`;
a tap is sent with no `eventType`). `gestureOf` maps them to `tap | double | up | down | hold | release`.
The same gesture within 200 ms is dropped, because both arms and both event kinds can report one press.
G2Kit also drops echoes from the other lens within 250 ms. The glasses app currently ignores
`eventSource`, so ring and temple behave the same.

**`core.handle(g)`** works in this order:
1. Dark screen: wake it.
2. Hold/release: `mode.hold?.()` first, else push-to-talk.
3. Caption visible: close it.
4. Approval card: tap = allow, double = deny, swipe = next/previous card.
5. List selection: follow the highlight.
6. `mode.gesture()`. An unhandled double calls `back()`. A double at the launcher turns the lens off.

**Approval cards.** Cards read `APPROVE? n/N TOOL @ NODE`, or `CONFIRM?` for hub-local confirms. They pop over
every mode except `quiet` ones (copilot, translate, teleprompter), which show a `[N!]` badge instead.

### 3.4 Push-to-talk, captions and the router

```
glasses hold ─► audio_start {16000, purpose, clip} (+ voice_context agentId in Agents)
            ─► bridge.audioControl(true) → G2Driver.startMic (EvenHub cmd 15)
               6402 LC3 (5x40 B frames / 50 ms) → liblc3 → s16le 16 kHz → audioEvent → binary WS frames
hub         ─► startClip: openSpeechStream (live engine) → caption {text, stable, final:false}
               throttled 120 ms, to the pressing screen only → ui/caption.ts live lines
glasses release ─► audioControl(false) first (catch the tail) → audio_end
hub         ─► clip.finish: clip engine (Wispr / OpenRouter) if configured and ≥0.3 s, else streamed
               words, else batch transcribe() → final caption
            ─► purpose "note" → addNote; else handleUtterance(text, agent context)
               stripWakeName → "stop the computer" regex fast path (no model) → route()
router      ─► ClaudeWorker "router" (warm Agent SDK session, effort low, maxTurns 20)
               prompt = stateBrief(hub) + utterance; tools: WebSearch, WebFetch, mcp__hub__*
               each tool call → voice_working {tool label} (caption shows WORKING: …)
            ─► voice_reply {heard, reply} → caption reply phase (BOCCHI > …), or flash / Agents view
```

**The router session.** `router.ts` keeps one warm session (`permissionMode: "dontAsk"`, `settingSources: []`,
`persistSession: false`). The model is `modelFor("assistant")`, Sonnet by default. The system prompt
is the `SYSTEM` constant: the Bocchi persona, with replies of at most two sentences for the lens.

**Hub tools** (`hubServer()`):
- **Agents:** `start_agent` (claude|codex), `message_agent`, `stop_agent`, `agent_output`, `resolve_approval`.
- **Computer:** `use_computer`, `stop_computer`.
- **Notes, memory, copilot:** `add_note`, `list_notes`, `recall_conversation`, `remember_person`,
  `about_person`, `copilot_now`.
- **Mini-apps:** `make_app`, `change_app`, `list_apps`, `open_app`.
- **Glasses:** `open_mode`, `screen_power`, `set_model`.
- **Timers:** `set_timer`, `list_timers`, `cancel_timers`.
- **Navigation and weather:** `navigate`, `navigate_transit`, `find_places`, `stop_navigation`, `show_weather_map`.
- **From feature modules:**
  - Messages (`messages/tools.ts`): `read_messages`, `send_message`, `messages_do_not_disturb`.
  - Sky (`sky/tools.ts`): `show_sky`, `sky_find`, `iss_passes`.
  - Google (`google/tools.ts`): `calendar_events`, `calendar_add_event`, `gmail_important`,
    `gmail_search`, `gmail_read_thread`, `gmail_draft`, `gmail_send_draft`.
- **Your apps:** `app_<app>_<action>` from `apps.json`.

### 3.5 Listening modes: copilot, translate, teleprompter

These modes stream continuously: `listen_start {purpose, sampleRate, lang?, target?}` … binary PCM … `listen_stop`.
`jarvis.ts` runs one session at a time, owned by the socket that started it. Partials go out as
`transcript {final:false}` and finals go to `heard()`. Speaker tags (`speaker self|other`) label the
lines `YOU >` and `THEM >`. Typed lines can be injected with `listen_text`/`heard`.

**Copilot** (`copilot.ts`):
- **Transcript and cadence.** It keeps 10 minutes of transcript. After a 1.8 s settle it runs if there are
  ≥25 new words and more than 8 s since the last run, or ≥8 words and more than 20 s. Only one run is in
  flight, with a rerun flag.
- **`alpha`** (the default) is a quiet "insider intel" feed. Each run adds at most 2 cards of kind
  `fact`/`check`/`answer`; the feed keeps the newest 6 and adds nothing when there is nothing new.
- **`coach`** gives up to 3 cards (`term`/`ask`/`say`/`next`, …) and replaces the set each time.
- **Prompt contents.** The last 12k characters of transcript, people facts mentioned (`store.mentioned`),
  cards already given, the current meeting from `google/index.ts` `watchMeetings`, and the local time.
  It uses web search.
- **On demand.** A ring hold or `copilot_ask` forces a card.
- **Leaving copilot** after ≥80 words calls `summarize()`, which saves a note (summary, to-dos, people)
  and adds people facts to `people.json`. Every line and card is appended to `DATA_DIR/conversations/<date>.jsonl`,
  which is what `recall_conversation` searches.

**Translate** (`translate.ts`, `glasses/src/modes/translate.ts`):
- STT opens in the other person's language with `alsoLangs: [mine]`.
- The translator worker answers with labelled lines (`zh:` and `<lang>:`, spoken language first), and
  that label order is the language detection.
- **Pinyin** is computed in code by `pinyinOf` (pinyin-pro: polyphones, 一/不 sandhi, erhua). It is never
  produced by the model. Tones are `TRANSLATE_PINYIN_TONES=marks|numbers`. `TRANSLATE_GLASSES_HANZI`
  hides the characters on the lens; the phone sends overrides with `translate_options`.
- Simplified vs. traditional characters follow the locale (`-tw/-hk/-mo/-hant`).
- **One-language limit.** Apple STT hears one language at a time, so without Soniox the wearer's own speech
  is only partly heard. The phone page can type it instead.

**Teleprompter.** The hub stores the script (`script_set` → `script.json` → `script`). Scrolling as you speak
("follow me") happens in `glasses/src/modes/teleprompter.ts`.

### 3.6 Studio: build, check, publish, hot reload, sandbox

```
phone studio.html / voice make_app ─► studio_make {prompt, id?, model?} ─► Studio.make (queue, one at a time)
  build(): up to 3 attempts, each ≤ STUDIO_TIMEOUT_S (300 s)
    runClaude: Agent SDK query, cwd = miniapps/<id>, systemPrompt = miniapp.ts contract + example,
               tools Read/Write/Edit/Glob/Grep/WebSearch/WebFetch, acceptEdits, canUseTool denies paths
               outside the folder, env = claudeCodeEnv(model) (secrets stripped; DeepSeek/OpenRouter via
               ANTHROPIC_BASE_URL)
    or runCodex: codex exec --ignore-user-config --ignore-rules --json, workspace-only profile, no network
    check(app.js): node --permission child, read only app.js, env PATH only, 120 ticks of scripted input,
                   pixel levels ≤15, < 3 s, result line carries a nonce the app cannot see
    fail → feed the error back as the next request
  success → version++, copy to versions/vN.js, meta.json builds[], broadcast `miniapps`
  all attempts fail → delete a brand-new app, or restore the last good vN.js (reverted)
glasses Apps ─► fetch /miniapps/<id>/app.js?v=N&token=… (page side) ─► sandbox load {source, store}
  new version in `miniapps` while open → "updated", restart (hot reload)
  crash → app_error (token scrubbed) → Studio.crashed: one automatic fix per version
```

**The sandbox** (`glasses/src/sandbox.ts`):
- **In a browser,** each app runs in a module Web Worker created from a blob. Before the app loads, the
  worker deletes `fetch`, XHR, WebSocket, WebTransport, EventSource, IndexedDB, caches, BroadcastChannel,
  `importScripts`, nested workers and `postMessage` from the global scope and prototypes. It also removes
  `navigator.storage`, `locks`, `serviceWorker` and `sendBeacon`.
- **Under Node,** it is a child process with `--permission`, `PATH`-only env, and IPC.
- **The API.** The app sees only `MiniAppApi`: a 144x72 picture or text screen, `store` (64 KB, kept in SDK
  local storage `miniapp:<id>`), `ask` (the hub's `miniapp-ask` Claude worker), `fetchJson` (the hub's
  `fetchPublic`), `toast`, `refresh` and `exit`.
- **Limits.** At most 8 requests in flight, each with a 60 s timeout. An app that stays silent for 5 s while
  it owes a frame counts as hung.
- **Known gap.** Dynamic `import()` cannot be removed, which the code acknowledges. The worker holds no secrets.

`studio-models.ts` builds the model catalog:

| Model | What it is | Needs |
|---|---|---|
| `fast` | Sonnet at low effort | |
| `balanced` | Sonnet | |
| `best` | Opus | |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` |
| `openrouter:<slug>` | OpenRouter models | `OPENROUTER_API_KEY` (list: `OPENROUTER_MODELS`) |
| `codex` | Codex CLI | a Codex binary |

`STUDIO_MODEL` sets the default.

### 3.7 Agents and approvals

```
start: voice start_agent / phone "Start an agent" / glasses ─► agent_start {nodeId, cwd, prompt, engine}
        hub → toNode → daemon startAgent (claude) | CodexAgent | computer session
        daemon → agent_upsert (status, lastText) → hub.changed() → state to glasses + phone

approval (SDK agent):  canUseTool → approval_request {approval, detail, humanOnly?} → hub.addApproval
                       (timeout APPROVAL_TIMEOUT_S = 600 s → deny) → card on glasses / phone
                       approve {id, decision} → Hub.resolve(id, decision, msg, by=role) → approval_result → daemon
approval (terminal claude): hook PermissionRequest → addApproval with resolveHook (120 s → {} = terminal prompt)
confirm (hub-local):   glassesConfirm(hub, timeout) → approval {nodeId:"", humanOnly:true} → true only on allow
```

**Who may answer.** The voice router can answer ordinary coding-agent approvals (`resolve_approval`,
`by = "router"`). It never sees or answers `humanOnly` ones: `stateBrief` hides them,
`resolve_approval` refuses them, and `Hub.resolve` rejects any `by` other than `glasses` or `phone`.

**Which actions are `humanOnly`:**

| Action | Timeout |
|---|---|
| `calendar_add_event` | `GOOGLE_CONFIRM_TIMEOUT_S`, 60 s |
| `gmail_send_draft` (the card shows what Gmail will actually send) | `GOOGLE_CONFIRM_TIMEOUT_S`, 60 s |
| text sends | `MESSAGES_CONFIRM_TIMEOUT_S`, 45 s |
| every computer-use action batch (`daemon.ts` `askWearer`) | `APPROVAL_TIMEOUT_S` |

An unanswered card counts as no.

**Dropped connections.** When a daemon disconnects, the hub cancels its approvals and marks its agents
`error`. On the daemon side, pending approvals resolve to deny.

**Agents mode on the glasses.** It lists agents across devices. Tap opens one; holding while one is open
talks to that agent only, via `voice_context`. With `G2_COMPUTER_THUMBNAIL=1`, a computer agent's latest
screen arrives as a 288x144 `agent_screen` tile, at most every 1.5 s and only for watching glasses.

### 3.8 Workers, pairing and computer use

**Pairing:**
1. Phone *Devices & apps* > Pair, or `npm run worker:pair`, calls `POST /api/workers/code`. The code is
   8 characters (`ABCD-EFGH`, no ambiguous letters), valid for 10 min (`G2_PAIR_CODE_TTL_S`), kept as a
   hash in memory only, and at most 5 are outstanding.
2. On the new Mac, `scripts/join-worker.sh --hub <url> --code <code> [--computer]` checks Node and
   Tailscale, runs `npm ci`, and redeems the code (`POST /api/pair`) for a `g2w_` token. The token is
   written to its `.env` with mode 600 and never printed. The script then builds `g2input` if
   `--computer` is given and installs launchd `com.g2.node`.
3. The hub stores only `sha256(token)` in `~/.g2-orchestrator/workers.json` (mode 600).

**What a worker token can do.** It authenticates only `role: "node"`, pinned to its nodeId, and can never
pass as the hub token. A node socket may only send `NODE_MSGS` (`node_capabilities`, `agent_upsert`,
`agent_remove`, `approval_request`, `agent_screen`). Revoking closes the socket (4003). The daemon then
backs off to 60 s retries.

**Computer use** (`src/node/computer.ts`):
- **Readiness** (`computerReadiness`): macOS, no kill file, and a passing `g2input selftest`
  (Screen Recording + Accessibility).
- **Tools** (on the in-process MCP server `computer`): `screenshot`, `list_windows`, `click`, `double_click`,
  `move`, `drag`, `scroll`, `type_text`, `key`, `open`, and `actions` (1-20 steps under one approval).
- **Each batch:**
  1. Validate the steps, requiring a fresh screenshot whenever coordinates are used, and bounds-check them.
  2. Write a summary that includes the frontmost app.
  3. Check sensitivity: secure text field focus, deny-listed apps or bundles (System Settings, Keychain,
     password managers, Terminal, … plus `G2_COMPUTER_DENY_APPS`), sign-in/payment/banking window titles
     or URLs.
  4. Ask `ComputerGate.allow()`. In `step` mode (default) it asks every batch. In `task` mode it asks once,
     but a sensitive screen always asks again.
  5. Run the steps, re-checking the stop state between them and re-reading focus before typing.
- **Screenshots** come from `screencapture`, shrunk to a JPEG (1280 px by default). They go only to the model
  and are never stored.
- **Stopping.** The kill file `~/.g2-orchestrator/computer-stop` stops everything within 1 s, polled by the
  daemon. The voice phrase "stop the computer" is caught by a regex before the router, and the router also
  has a `stop_computer` tool.

### 3.9 Navigation

```
voice navigate / navigate_transit / find_places, phone nav_start (walk)
  └► Places.search (map/places.ts)
       GOOGLE_MAPS_API_KEY → Places API (New) searchNearby / searchText, 5 km, "best" = rating score
       no key or failure   → Nominatim, widening viewbox, sorted by distance
  └► route (map/routes.ts)
       walk / bike → OSRM routing.openstreetmap.de      drive → Google Routes (traffic) | OSRM
       transit     → Google Routes TRANSIT (falls back to walking without a key)
  └► Navigator (nav.ts): position from `location` messages
       (glasses SDK location every 3 s / 5 m, or phone watchPosition; else G2_LAT/LON or ip-api city fix)
       snapToLine within 30 m (looking ≤120 m ahead), next step at <15 m, arrival at <20 m on the last step
       → `nav` NavState to all UIs; the glasses open Navigate on the first one
  └► MapPolicy.due → renderNavMap (map/render.ts) → `nav_map` (glasses only, ~55 KB)
       base: GoogleBase (Maps Static 640x640 styled roads, decoded by map/png-decode.ts, inverse-rotated)
             or OsmBase (Overpass highway ways, one query/min)
       overlays: walked route (4), route ahead (casing + 15), range ring, destination, chevron, north tick
       ≤15% lit per 288x144 tile (base redrawn dimmer if over)
```

- **Off route.** There is no reroute. Distance falls back to a straight line to the next step, and the map
  turns to the direction of travel.
- **Zoom.** Automatic: walk/bike by distance to the next turn, drive by speed, with 20% hysteresis.
  Swiping zooms manually for 20 s.
- **Redraws** happen when you move max(8, min(25, accuracy)) m, turn ≥15°, reach a new step, or the
  zoom or view changes. They are spaced at least 2 s apart, 3 s for the full view.
- **View cycle** (`glasses/src/modes/navigate.ts`). Tap cycles `map` → `full` → `eso`:
  - **map:** a 288 map in 2 tiles, plus a readout tile (`ui/maneuver.ts` arrow, XL distance, ladder)
    and a text box;
  - **full:** a 576 map in 4 tiles with a slim readout;
  - **eso:** the readout and text only.
- **Gestures.** Swipe zooms. Double tap returns to map; on map it asks END ROUTE?, and a tap sends
  `nav_stop`. The glasses report their view with `nav_view`, and the hub only draws for `map`/`full`.

### 3.10 Weather and sky

**Weather** (`src/hub/weather/`):
- **Data.** `service.ts` makes one Open-Meteo request (GFS) for a 20x13 grid plus 5 cities, with
  26 forecast hours. The result is cached for 20 min, capped at 24 fetches a day, and persisted to
  `DATA_DIR/weather-forecast.json` (reused for up to 6 h after a restart). Radar comes from RainViewer
  tiles (`radar.ts`), used for the `sky`/`precip` layers at step 0.
- **Rendering.** `render.ts` `renderWx` draws a `detail` view (576x288, 4 tiles) or a `fast` view
  (288x288, 2 tiles). Layers: sky, pressure, temp, precip, clouds, wind. Steps: 0/6/12/24 h. Techniques:
  dithered shading, marching-squares contours, H/L centres, streamlines, Natural Earth outlines
  (`outline.ts`), and the same 15% lit budget. `tileOrder` sends the most important tiles first.
- **Exchange.** The glasses send `wx_get {layer, step, view}` and get back `wx_map`. Voice uses
  `show_weather_map`, which sends `open` mode weather. On the glasses, swipe changes layer and tap changes step.

**Sky** (`src/hub/sky/`):
- **Catalogue.** `catalog.ts` holds 917 stars from the Yale Bright Star Catalogue, generated by
  `npm run sky:catalog`. `figures.ts` has 35 constellation figures and star names.
- **Astronomy.** `astro.ts` uses astronomy-engine for the Sun, Moon, planets, stars, rise/set and showers.
  `iss.ts` takes the TLE from CelesTrak (refreshed every 12 h, saved to `DATA_DIR/sky/iss-tle.txt`) and
  runs satellite.js SGP4 for passes and visibility.
- **Rendering and exchange.** `render.ts` draws a 288x288 azimuthal disc. `service.ts` answers `sky_get`
  with `sky {now|tonight}`. Voice tools: `show_sky`, `sky_find`, `iss_passes`. On the glasses, swipe
  switches NOW/TONIGHT and tap steps +1 h (up to 6).

**Shared drawing code.** All hub renderers use `src/shared/raster.ts` and `glyphs.ts`, the same code
the glasses use. Previews (`npm run nav:preview|weather:preview|sky:preview|lens:preview`) write lens PNGs.

### 3.11 Messages

`src/hub/messages/` (macOS, needs Full Disk Access for the node binary running the hub):
- **Reading.** `chatdb.ts` opens `~/Library/Messages/chat.db` read-only (`node:sqlite`). It decodes
  `attributedBody` (`attributed.ts`), resolves names from the AddressBook databases (`contacts.ts`), and
  polls every 2 s.
- **Memory.** The last 50 messages are held in memory only. Bodies and names are never logged.
- **Popups.** New messages arrive as `message_new` (popup or badge). They are suppressed in quiet modes and
  while listening, and reduced to a flash in apps or navigation. Do-not-disturb is `messages_dnd`.
- **Sending.** `send_message` never sends by itself. `requestSend` resolves the recipient (focused chat →
  group → contact → recent sender), shows a `TEXT <name>` humanOnly card, and only then calls `send.ts`.
  That runs `osascript`, with the recipient and text passed as argv, never spliced into the script.

### 3.12 Google OAuth, Calendar and Gmail

**Connecting.** Run `npm run google:connect` (`scripts/google-connect.ts`), or tap Connect on the phone page
(`/google/connect`, which opens the consent page in the Mac's browser).
- `GoogleAuth.beginConnect` (`google/auth.ts`) uses a Desktop-app client, PKCE S256 and a random `state`.
  It waits on a one-shot loopback server at `127.0.0.1:<random>/oauth2callback` for up to 5 min.
- Scopes: `calendar.readonly`, `calendar.events`, `gmail.readonly`, `gmail.compose`, `gmail.send`.
- The refresh token goes to `~/.g2-orchestrator/google-token.json`: the directory is 0700 and the file
  is written atomically with mode 0600. Access tokens stay in memory.
- `invalid_grant` means the token expired; the 7-day expiry applies while the app is in Testing.
- `--status` shows the connection; `--disconnect` revokes the token and deletes the file.

**What uses it:**
- *Today*'s agenda.
- `watchMeetings`, which tells the copilot who is in a meeting starting within 10 min.
- The voice tools listed in §3.4. Events are created with `sendUpdates=none`, so invitees are never emailed.

### 3.13 Screen off

`core.dark` blanks the page to `header " "`/`body " "`, which is see-through. Ways to set it:
- the launcher item LENS OFF;
- a double tap at the launcher;
- the voice tool `screen_power` (→ `{t:"screen", on}`);
- the phone's `screen_set`.

While dark, approval cards and push-to-talk still show. Any gesture wakes it; a hold wakes it and talks.

### 3.14 Dashboard (Today)

`dashboard.ts` is cached for 10 min, with a 6 s timeout per source. It returns Open-Meteo current
conditions plus the daily high/low (`G2_TEMP_UNIT`), the rest of today's agenda (Google first, else macOS
Calendar unless `G2_CALENDAR=0`), the top Hacker News stories, and an agents line. Location comes from
`G2_LAT`/`G2_LON`/`G2_CITY` or ip-api. The glasses ask with `dashboard_get` and receive `dashboard`.

## 4. Protocol message families

All messages are typed in `src/shared/protocol.ts`: `ClientMsg` goes client → hub and `HubMsg` goes hub → client.
Each text frame is one JSON object with a `t` discriminator. Mic audio travels as binary s16le 16 kHz mono
frames between `audio_start`/`audio_end`, or between `listen_start`/`listen_stop`. Roles are `glasses`,
`phone` and `node`.

| Family | Client → hub | Hub → client |
|---|---|---|
| Session | `hello` | `welcome`, `state` (HubState snapshot), `toast`, `error` |
| Approvals | `approve` (UIs), `approval_request` (node; `humanOnly?`) | `approval_result` (to node) |
| Agents | `agent_start`, `agent_send`, `agent_stop`, `agent_watch`, `voice_context` (UIs); `node_capabilities`, `agent_upsert`, `agent_remove`, `agent_screen` (node) | `agent_start`, `agent_send`, `agent_stop` (to node), `agent_screen` (to watching glasses) |
| Push-to-talk | `audio_start`, binary, `audio_end`, `audio_cancel`, `voice_text` | `caption`, `voice_working`, `voice_reply` |
| Listening | `listen_start`, `listen_stop`, `listen_text`, `heard`, `speaker`, `copilot_ask`, `translate_options`, `subscribe` | `listening`, `transcript`, `copilot`, `translation`, `translate_options` |
| Notes, script | `note_add`, `note_delete`, `script_set` | `notes`, `script` |
| Today | `dashboard_get` | `dashboard` |
| Navigation | `location`, `nav_start`, `nav_stop`, `nav_view`, `nav_zoom` | `nav`, `nav_map` |
| Weather, sky | `wx_get`, `sky_get` | `wx_map`, `sky` |
| Mini-apps, Studio | `miniapps_get`, `miniapp_open`, `studio_make`, `studio_models_get`, `studio_delete`, `app_error`, `app_ask`, `app_fetch` | `miniapps`, `studio`, `studio_models`, `app_answer` |
| Messages | `messages_get`, `messages_focus`, `messages_dnd`, `messages_seen` | `messages`, `message_new` |
| Glasses control | `screen_set`, `models_set`, `models_get`, `glasses_log` | `screen`, `open` (mode + options), `models` |

**Rules.**
- Node sockets may send only `NODE_MSGS` (`server.ts`).
- `state` is coalesced to one snapshot per 50 ms and goes to every non-node client.
- `caption` goes only to the socket that is talking. `nav_map` goes to glasses only.

**The other two protocols:**
- **Page ↔ host** (Even Hub SDK). Calls are `{type:"call_even_app_method", method, data}` through
  `flutter_inappwebview.callHandler`. Pushes are `{type:"listen_even_app_data", method:"evenHubEvent", data:{type, jsonData}}`
  through `window._listenEvenAppMessage`. JarvisApp adds a `jarvisImage` handler for BMP tiles. The full
  list is in `native/ios/README.md`.
- **App ↔ glasses** (BLE). Frames are `0xAA`, route, sync, len, total, serial, service, flag, then protobuf,
  with a CRC-16 on the last fragment. Services are 0x80 dev_config, 0xE0 EvenHub, 0x09 settings, and others.
  See `native/PROTOCOL.md`.

## 5. Persistence

On the hub, state lives in memory: agents, nodes, approvals, the voice state, the last 50 messages,
computer-use thumbnails and pairing codes. Daemons re-register their agents when they reconnect.
Everything that persists is listed below. `DATA_DIR` = `G2_DATA_DIR`, or `~/.g2-orchestrator/data`.

| Path | Written by | Contents |
|---|---|---|
| `DATA_DIR/notes.json` | `store.ts` | Notes `[{id,text,at}]`, newest first |
| `DATA_DIR/script.json` | `store.ts` | Teleprompter `{title,text}` |
| `DATA_DIR/people.json` | `store.ts` | People memory: up to 40 facts per name |
| `DATA_DIR/models.json` | `models.ts` | Assistant and copilot model tier |
| `DATA_DIR/conversations/YYYY-MM-DD.jsonl` | `copilot.ts` | Heard lines and copilot updates (used by `recall_conversation`) |
| `DATA_DIR/weather-forecast.json` | `weather/service.ts` | The last forecast (reused for 6 h or less) |
| `DATA_DIR/sky/iss-tle.txt` | `sky/iss.ts` | ISS orbital elements |
| `~/.g2-orchestrator/workers.json` (`G2_WORKERS_FILE`) | `workers.ts` | Paired workers with token hashes (mode 600) |
| `~/.g2-orchestrator/google-token.json` (`G2_GOOGLE_TOKEN_FILE`) | `google/auth.ts` | Google refresh token (mode 600) |
| `~/.g2-orchestrator/workers/<name>/` | `claude-worker.ts` | Working folders for the warm sessions (router, copilot, translate, miniapp-ask) |
| `~/.g2-orchestrator/computer/`, `computer-stop` | `computer.ts` | The computer agent's working folder; the kill-switch file |
| `~/.g2-orchestrator/projects.json` (`G2_PROJECTS_FILE`) | user | Project catalog for each daemon |
| `~/.g2-orchestrator/models/ggml-*.bin` | user | whisper.cpp models |
| `~/.g2-orchestrator/publish-private.json` | user | Replacement and forbid lists for publishing (outside the repo) |
| `miniapps/<id>/` (`G2_MINIAPPS_DIR`) | `studio.ts` | `app.js`, `meta.json` (versions, builds, prompts, session), `versions/vN.js` |
| `.env` (repo root) | user | Configuration and secrets; gitignored. A worker's `.env` holds its `g2w_` token |
| `~/.claude/settings.json` | `hooks/install.mjs` | Hook entries (backup `settings.json.bak-g2`) |
| `~/Library/LaunchAgents/com.g2.{hub,node}.plist`, `~/Library/Logs/g2-{hub,node}.log` | `scripts/autostart.sh` | Services and logs |

On the iPhone:
- **UserDefaults:** `hubURL`, protocol and image options, `lens.left/right`, `g2.mfr.<uuid>`,
  `ring.mac/name/uuid`, and page storage `page.<key>`.
- **Keychain:** the hub token.
- **Documents:** `jarvis.log` and `jarvis-previous.log`.

On the glasses page, SDK local storage holds `hubToken` and each mini-app's store (`miniapp:<id>`).

## 6. Security model

- **Network.** The hub listens on plain HTTP/WS on port 8787. Keep it on localhost, the LAN or Tailscale,
  never on the open internet. Every `/api/*` route and every WebSocket needs `HUB_TOKEN`, compared
  timing-safe. Static pages are public, but they hold no data without the token.
- **Workers.** Each worker gets its own revocable `g2w_` token, and only its hash is stored. The token works
  only as `role:"node"` for its paired nodeId. A node can send only agent and approval-request messages,
  so it can't approve, listen, talk or call `/api/*`. Pairing codes are single-use, last 10 min and are
  rate limited.
- **Approvals.**
  - Agent tools outside `G2_AUTO_ALLOW` wait for the ring or the phone.
  - Timeouts: daemon approvals are denied at 600 s. A hook approval falls back to the terminal prompt.
  - `G2_BYPASS_PERMISSIONS` turns approvals off for Claude and Codex. The phone shows it as "unrestricted".
  - Codex has no per-tool approvals; its `workspace-write` sandbox is the guard.
- **Confirm cards for outbound actions.** Email, calendar events, texts and computer-use batches are
  `humanOnly`: only a `glasses` or `phone` client can answer them, and a timeout counts as no. Note that
  "human" means a client authenticated with the hub token in one of those roles. Anything holding
  `HUB_TOKEN` can claim them, so the hub token is the root credential.
- **Computer use.** It is off by default and macOS only. It needs the OS permissions and a passing self-test.
  - Sensitive screens always ask again.
  - Its system prompt forbids passwords, payment, accepting terms and changing system settings.
  - The kill file stops it within 1 s.
  - Screenshots go only to the model.
- **Mini-apps.** They get no token, no socket and no network globals, and run in a Worker or a
  permissioned child process. They reach the hub only through validated `ask`/`fetch` messages, with
  bounded sizes and counts.
  - `fetchPublic` (`safe-fetch.ts`): http(s) only, no credentials in URLs, and every hop and redirect
    resolved. Private, loopback, link-local, CGNAT (which includes Tailscale), multicast and embedded-IPv4
    IPv6 ranges are refused. The socket is pinned to the checked address. Limits: 1 MB, 10 s, GET only.
  - Navigation, weather and sky use plain `fetch`, but only to fixed public hosts.
- **Studio.**
  - Builds run inside the app folder, and `canUseTool` denies other paths.
  - `claudeCodeEnv()` strips `HUB_TOKEN`, `G2_HUB_TOKEN` and provider keys from the child environment.
    For DeepSeek or OpenRouter it also strips all Claude credentials.
  - Codex builds have no network and a workspace-only profile.
  - The check runs under `node --permission` with only `app.js` readable and no secrets in its environment.
- **Model access.** No API keys are needed for models: the Agent SDK uses the Claude Code login
  (`claude auth login`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`). Warm hub sessions run with
  `settingSources: []` and fixed tool lists.
- **Google.** The OAuth client is the user's own. Login uses PKCE on a loopback redirect. The refresh token
  is mode 600 outside the repo. Drafts are never sent without a confirm card, and invitees are never emailed.
- **Messages.** Reading is read-only SQLite. Bodies and names are never logged. A send needs a confirm card,
  and its arguments are passed to AppleScript as argv.
- **iOS app.** The token is in the Keychain. Bridge calls are accepted only from the main frame whose origin
  matches the configured hub page. Logs leave out audio payloads.
- **BLE.** The app sends only message shapes known to be good. Experimenting on 0x80 risks a soft brick.
  Firmware is never flashed. A ring MAC is used only once it is verified against the ring's name.
- **Publishing** (`scripts/publish-public.sh`):
  1. Take a detached worktree of committed HEAD (no untracked files, no `.env`).
  2. Apply the private replacement list from `~/.g2-orchestrator/publish-private.json` (hardware ids,
     team id, bundle ids).
  3. Swap in the licensed avatar sheet if needed.
  4. Refuse if any `.env` value (12 characters or longer) or a forbidden string remains.
  5. Run the G2Kit tests (`SKIP_TESTS=1` skips them).
  6. Commit a single tree on top of public `main` (private history is never pushed), confirm, and push.

## 7. Performance budget and known limits

| Item | Budget / figure | Source |
|---|---|---|
| Text container update | Fast (one small EvenHub message); always sent before images | `core.ts` `draw()` |
| Image tile 288x144 | ~21 KB 4-bit BMP = 6 fragments of 4096 B (~92 BLE packets), ACK ~400 ms per fragment, so **~1.5 s per tile** | `ImageFormats.swift`, `core.ts` comments |
| Full-lens picture | 4 tiles → ~6 s on a cold page; diffing means only changed tiles move | `pushTiles` |
| Tiles per draw | 1, rotated fairly by age | `pushTiles` |
| Lit pixels | < 15% per tile (power, legibility) | `ui/kit.ts`, `map/render.ts`, `weather/render.ts` |
| Packet pacing | 6 ms gap; image packets wait for the write buffer (≤40 ms), 2 fragments in flight | `G2Driver.swift` |
| Heartbeat | Every 5 s, or the page and mic die after ~10 s | `G2Driver.beat()` |
| Mic | 5 × 40 B LC3 frames per notification = 50 ms; PCM 16 kHz s16le | `Audio.swift`, `LC3.swift` |
| Nav map redraw | ≥2 s apart (3 s full view); Google base refetch ≤ every 10 s | `nav.ts`, `map/google.ts` |
| Weather / sky | Forecast every 20 min (≤24/day); sky chart cached 5 min (30 s with the ISS up) | `weather/service.ts`, `sky/service.ts` |
| Voice | ~2 s for simple commands and ~4 s for web lookups (warm sessions, measured on the Mac); push-to-talk end-to-end ~5.7 s with local STT | `docs/JARVIS.md` |
| Studio build | ≤300 s per attempt, 3 attempts; check ≤8 s | `studio.ts` |

Known limits:
- **Background.** The glasses UI, the hub WebSocket and page logic live in the WKWebView, which iOS suspends
  in the background. Expect the lens and mic to work while Jarvis is in the foreground. Heartbeats,
  ACKs and LC3 decoding are already in Swift.
- **Images.** Images are slow (see above). The LZ4 and RLE formats are experiments. The first image
  after a page create may be dropped, so `core.ts` resends it.
- **Ring vs. temple.** The glasses app does not yet tell the ring from a temple (`eventSource` is
  forwarded but ignored in `core.ts`).
- **No allowlist.** G2Kit has no allowlist of BLE commands; safety rests on the builders.
- **Mixed languages.** Apple STT hears one language per stream. Mixed zh/en needs Soniox.
- **Navigation** has no reroute or off-route notice. The phone's `nav_start` is walking only.
- **Approvals.** The hook approval ceiling is about 10 min: `cc-hook.mjs` aborts at 10 min, whatever
  `HOOK_APPROVAL_TIMEOUT_S` says.
- **Mini-app sandbox.** Dynamic `import()` cannot be removed from the worker.
- **Sessions.** The router has no explicit timeout per call, and warm sessions restart every
  `maxTurns` turns (router 20).
- **Single hub.** One hub serves one user; there is no multi-user model.

## 8. Extending

- **A glasses mode.**
  1. Create `glasses/src/modes/<id>.ts` exporting a `Mode` (`core.ts`): `screen()` returns a `Screen`,
     `gesture(g, index)` returns true when handled, and `enter`, `exit`, `hold`, `onHub`, `quiet` and
     `resume` are optional.
  2. Add it to the array in `glasses/src/app.ts`, before `router`.
  3. Add `[id, LABEL]` to `ITEMS` in `modes/launcher.ts`. Labels are fixed text, because the launcher's list
     is part of the page shape.
  4. To open it by voice, extend `open.mode` in `protocol.ts` and `open_mode` in `router.ts`.
  5. If it streams the mic, set `quiet: true` and implement `resume()`.
  6. Draw pictures with `ui/kit.ts`, following its level rules. Keep tiles at 288x144 or smaller, with
     at most 4 on the page.
  7. Check it in the emulator (`/glasses/?emulate=1`) and with `checkLayout`.
- **A hub-rendered picture** (like maps):
  1. Draw a `Raster` on the hub (`src/shared/raster.ts`, `glyphs.ts`).
  2. Keep each 288x144 tile under 15% lit.
  3. Send `pack4` + `toB64` in a new `HubMsg`.
  4. Cut it into `tiles` in the mode, ordering by importance with `prio`.
  5. Add a `*-preview.mjs` script to look at it as a PNG.
- **A voice tool.**
  1. Add `tool(name, description, zodShape, handler)` to `hubServer()` in `router.ts`, or to a feature
     `tools.ts` spread into it.
  2. Return short text, because the reply goes on the lens.
  3. Route anything outbound through `glassesConfirm()`, with `humanOnly`, and never let it complete
     without the tap.
  4. Add a `toolLabel` in `src/shared/assistant.ts` for the WORKING line.
- **A hub message.**
  1. Add the variant to `ClientMsg` or `HubMsg` in `src/shared/protocol.ts`.
  2. Handle it in the `server.ts` `switch (m.t)`, and in a mode's `onHub` on the glasses.
  3. If nodes must send it, consider whether it belongs in `NODE_MSGS`. Usually it doesn't.
- **An HTTP app.** Add actions to `apps.json` (template `apps.example.json`). Each becomes
  `app_<app>_<action>`. Restart the hub afterwards.
- **A speech engine.** Implement the stream interface in `src/stt/types.ts`. Register it in
  `src/stt/index.ts` (availability, language support, order and fallback), and add an offline mock test
  in the style of `scripts/stt-soniox-test.ts`.
- **A mini-app.** Describe it in Studio, or write `miniapps/<id>/app.js` against `src/shared/miniapp.ts`.
  Test it with `npm run miniapp:test` and the Studio preview.
- **A BLE message.** Find it in at least one hardware-verified source (see `native/PROTOCOL.md`
  confidence levels). Then:
  1. Add a builder and parser in `Device.swift` or `EvenHub.swift`.
  2. Add tests with fake ids in `G2KitTests`.
  3. Leave it off by default behind a Settings switch until it has been seen working on hardware.
  4. Never write unknown fields to 0x80.
- **Tests.** `scripts/<area>-test.ts` with `node:test`, offline (inject fetchers, use fixtures such as
  `scripts/wx-fixture.ts` and `sky-fixture.ts`), plus an npm script. Then `npm run typecheck`,
  `npm --prefix glasses run build`, and `swift test` for G2Kit changes.


# CLAUDE.md: working in g2-orchestrator (MyJarvis)

Your own assistant for Even G2 glasses and the R1 ring. A native iPhone app talks BLE to both glasses arms
and hosts the glasses web app. A hub on the Mac runs everything smart on the user's Claude Code login:
voice, agents, copilot, translation, navigation, weather/sky maps, Google, Messages and Studio mini-apps.
The full map is in `docs/ARCHITECTURE.md`. Read the section you are touching before you change it.

## Component map

| Part | Path | What it is |
|---|---|---|
| Hub | `src/hub/` (`server.ts` HTTP+WS, `hub.ts` state/approvals, `jarvis.ts` listening + nav glue, `router.ts` voice router) | One Node process on the Mac, port 8787 (`HUB_PORT`) |
| Hub features | `src/hub/{copilot,translate,listen,stt,dashboard,studio,studio-models,workers,safe-fetch,apps,models,claude-worker,store}.ts`, `src/hub/{google,messages,map,weather,sky}/` | |
| Device daemon | `src/node/daemon.ts` (+ `codex.ts`, `computer.ts`, `engines.ts`, `projects.ts`) | One per machine. It runs Claude Agent SDK, Codex and computer-use agents, and its approvals go to the glasses |
| Claude Code hooks | `hooks/cc-hook.mjs`, `hooks/install.mjs` | Forward terminal `claude` permission prompts to the hub |
| Shared | `src/shared/protocol.ts` (wire types), `raster.ts`, `glyphs.ts`, `miniapp.ts`, `assistant.ts` | Used by the hub and by the glasses (`glasses/tsconfig.json` includes `../src/shared`) |
| STT | `src/stt/` (`index.ts` engine picker; `apple`, `whisper`, `soniox`, `wispr`, `openrouter`, `vad`) and `tools/speech/` (Swift `g2speech` helper) | |
| Glasses web app | `glasses/src/` (`core.ts` renderer + input, `app.ts` mode list, `modes/*`, `ui/kit.ts`, `sandbox.ts`, `emulator.ts`) | Vite build to `glasses/dist`, served by the hub at `/glasses/` |
| Phone pages | `phone/index.html` (agents, approvals, copilot, notes, devices, Google), `phone/studio.html` | Static files served by the hub at `/` |
| iOS app | `native/ios/JarvisApp/Sources/` (`GlassesLink.swift` BLE session, `EvenHubHost.swift` WKWebView bridge, `Views.swift`, `Settings.swift`) | Replaces the Even App |
| G2Kit | `native/ios/G2Kit/` (Swift package: framing, protobuf, `G2Driver`, `CoreBluetoothTransport`, `R1`, `ImageFormats`, vendored liblc3) | The protocol is documented in `native/PROTOCOL.md` |
| TS driver (older) | `native/driver/`, `native/jarvis.ts` | Mac/noble prototype that G2Kit was ported from |
| Mini-apps | `miniapps/<id>/{app.js,meta.json,versions/vN.js}` | Written by Studio and run sandboxed on the glasses |
| Streamed games | `apps/{platformer,slope,mario64}` | Served at `/apps/<name>/` |

## Run, build, test

```bash
npm install && npm --prefix glasses install
npm run hub                       # hub in the foreground (reads .env)
npm run node                      # this machine's device daemon
npm run glasses                   # vite dev server :5173 (point it at a hub with ?hub=http://localhost:8787)
npm --prefix glasses run build    # tsc --noEmit + vite build -> glasses/dist (the hub serves this)
npm run typecheck                 # tsc --noEmit over src/ and scripts/ (glasses are checked by their build)
```

Browser emulator: `http://localhost:8787/glasses/?token=<HUB_TOKEN>` (add `&emulate=1` to force it).
Keys: up/down arrows swipe, Enter taps, Backspace double-taps, hold Space to talk.
`npm run fake-agent` adds a fake device whose agent keeps asking for approval.

Offline test suites (`node:test`, no network or keys; tests live in `scripts/*-test.*`):
`agents:test`, `phone:mic:test`, `translate:test`, `kit:test`, `caption:test`, `bocchi:test`, `navmap:test`,
`navgoogle:test`, `messages:test`, `studio:test`, `worker:test`, `computer:test`, `google:test`, `miniapp:test`,
`image:test`, `weather:test`, `sky:test`. Run each with `npm run <name>`.
Not wired to npm: `node --import tsx --test scripts/stt-soniox-test.ts` (and `stt-wispr-test.ts`).
Live or paid: `npm run jarvis-test` (its own throwaway hub, needs the Claude login), `scripts/stt-live-test.mjs`.
Lens PNG previews: `lens:preview`, `nav:preview`, `nav:full:preview`, `weather:preview`, `sky:preview`.
Old TS driver: `npm --prefix native test`.

iOS:
```bash
(cd native/ios/G2Kit && swift test)          # or native/ios/test-g2kit.sh (Command Line Tools only)
native/ios/build-sim.sh [--no-run]            # swiftc build + simulator install/launch, no xcodebuild
                                              # env: SIM, HUB_URL, HUB_TOKEN, START_TAB
# Device build. Outputs go to the gitignored native/ios/build/device{,-obj}:
cd native/ios/JarvisApp && xcodebuild -project JarvisApp.xcodeproj -scheme JarvisApp -configuration Debug \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates \
  SYMROOT="$PWD/../build/device" OBJROOT="$PWD/../build/device-obj" COMPILER_INDEX_STORE_ENABLE=NO build
xcrun devicectl device install app --device <DEVICE_ID> ../build/device/Debug-iphoneos/JarvisApp.app
xcrun devicectl device process launch --device <DEVICE_ID> --terminate-existing <BUNDLE_ID> -- -startTab 1
xcrun devicectl device copy from --device <DEVICE_ID> --domain-type appDataContainer \
  --domain-identifier <BUNDLE_ID> --source Documents/jarvis.log --destination ./jarvis.log
```
Put `--` before app arguments (`-hubURL`, `-hubToken`, `-startTab N`, `-autoScan YES`, `-imageFormat <f>`).
Without it, devicectl tries to parse them as its own options. `<BUNDLE_ID>` is `PRODUCT_BUNDLE_IDENTIFIER` in
`JarvisApp.xcodeproj`. App log prefixes: `g2:`, `ble:`, `ring:`, `pair:`, `input:`, `img:`.

The always-on hub runs under launchd (`scripts/autostart.sh install|install-worker|uninstall|status`, labels
`com.g2.hub` and `com.g2.node`). After editing hub code or `.env`, restart it:
`launchctl kickstart -k gui/$(id -u)/com.g2.hub`. Logs go to `~/Library/Logs/g2-hub.log` (`g2-node.log` for the daemon).
Glasses changes need `npm --prefix glasses run build`, then a reload of the page (Jarvis tab, or the browser).

## Hard rules

- **Secrets.** Never print, log, echo or commit values from `.env`, tokens (`HUB_TOKEN`, `g2w_…` worker
  tokens, `CLAUDE_CODE_OAUTH_TOKEN`, API keys), `~/.g2-orchestrator/google-token.json`, `workers.json`
  or `publish-private.json`. When you inspect `.env`, check only whether a key is set (`grep -c '^KEY=.' .env`).
  Docs and tests use placeholders, never real IPs, device UUIDs, serials, MACs, team ids or emails.
- **LLM calls go through the Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` `query()`, usually through
  `src/hub/claude-worker.ts`) on the user's Claude Code login. Make no direct model API calls (no
  `api.anthropic.com`, no OpenAI chat APIs). DeepSeek and OpenRouter are alternate backends for that same
  harness only, through `ANTHROPIC_BASE_URL` in `studio-models.ts` `claudeCodeEnv()`. Codex (`codex` CLI,
  its own login) is a separate opt-in engine. The OpenRouter call in `src/stt/openrouter.ts` is speech-to-text.
- **Human confirms.** Every outbound action needs a human tap on the glasses or the phone: sending email
  (`gmail_send_draft`), creating calendar events (`calendar_add_event`), sending texts (`messages/index.ts`
  `requestSend`) and every computer-use action batch (`daemon.ts` `askWearer`). Use `humanOnly: true`
  approvals (`google/confirm.ts` `glassesConfirm`). `Hub.resolve()` rejects them unless `by` is `glasses`
  or `phone`, and `stateBrief`/`resolve_approval` keep them away from the voice router. Never weaken that
  check. Never add a path where the router, a node or a voice "yes" answers one. Drafts never send on their own.
- **BLE safety.** Never send command ids, services or fields to the glasses that are not already built in
  G2Kit (`Device.swift`, `EvenHub.swift`). An unknown `dev_config` (0x80) field once soft-bricked a pair
  until a power cycle. G2Kit has no allowlist: `G2Driver.sendTo` is public, so the discipline is yours.
  Never touch firmware, DFU or OTA (0xC4/0xC5).
- **Ring MAC.** Never send an unverified ring MAC. `RING_CONNECT_INFO` goes out only from *Link ring to
  glasses*, *Find ring* (a newly verified MAC replacing the old one), the connStatus-22 rebind (rate limited,
  max 3) and the handoff fallback. Never send it at connect: `scheduleSessionRingBind` only logs.
  A MAC is kept only if `RingNameCheck.verified` passes against the `EVEN R1_xxxxxx` name.
- **Mini-apps stay sandboxed.** They get no hub token, no socket and no fetch. They have only the `MiniAppApi`
  messages (`src/shared/miniapp.ts`, `glasses/src/sandbox.ts`), and network access goes through the hub's
  `fetchPublic` (`safe-fetch.ts`). Studio builds run in a confined folder with secrets stripped from the
  environment. Keep it that way.
- **Publishing.** The public repo is updated only by `scripts/publish-public.sh`. It snapshots committed HEAD,
  applies the private replacement list `~/.g2-orchestrator/publish-private.json` (kept outside the repo),
  refuses if any `.env` value or forbidden string remains, and runs the G2Kit tests. Never push the
  private history or add a remote. Don't commit unless asked.

## Hardware facts (expensive to rediscover)

- **Display.** The lens is 576x288 with 16 grey levels, shown green. Black (0) is see-through, not black.
- **Text vs images.** Text containers update fast (`textContainerUpgrade`). Images are the bottleneck:
  each tile is at most 288x144 (minimum 20x20) and a page holds at most 4. A tile is a ~21 KB 4-bit BMP
  in 4096-byte fragments, and the glasses ACK each fragment in about 400 ms, so one tile takes ~1.5 s.
  `core.ts` therefore pushes at most one tile per draw, diffs tile bytes, and rotates fairly by the age
  of the last send.
- **Page limits.** A page holds at most 12 containers (≤8 text/list and ≤4 image). Names are ≤14 characters,
  text is ≤1000 bytes and never empty, and exactly one container captures input. `glasses/src/ui/layout.ts`
  `checkLayout` mirrors G2Kit `EvenHub.validatePage`. The first image after a create may be dropped (it is resent).
- **LZ4.** `compressMode = 2` is an experiment (`ImageFormats.swift`, Settings → Image format, LENS TEST).
  `standard` is the default; the others fall back to it after a failure.
- **Two arms.** Each arm is its own peripheral, and they pair up by the serial in their manufacturer data.
  Each arm connects separately. GATT lives under the `…5450` (control 5401/5402) and `…6450` (mic 6402)
  services, not the advertised `…0000` UUID: discover all services. Arms that iOS already holds don't
  advertise; recover them with `retrieveConnectedPeripherals` on 5450/6450/0000/Nordic UART.
- **AUTH.** AUTH goes to L, then R. A lens may first answer without a `secAuth` verdict; wait for the verdict
  and don't treat that first reply as a rejection. Heartbeats run every 5 s, or the page and mic die.
- **Ring.** Ring gestures reach the app through the glasses as EvenHub input with `eventSource 2`; the
  ring needs no pairing to the phone. Current R1 firmware puts its MAC right after the company id in the
  manufacturer data (`RingAdvert.macRaw`), and it is trusted only if it matches the name suffix.
- **Language.** Apple on-device STT hears one language at a time. Only Soniox mixes zh/en in one stream.
- **Background.** WKWebView JS is suspended in the background, so the glasses UI only updates while Jarvis
  is in the foreground.

## Conventions

- **Style.** Match the surrounding file: TypeScript ESM, 2-space indent, double quotes, semicolons, no
  formatter config. `src/` imports use `.js` extensions (NodeNext); `glasses/` imports have none (Bundler).
  Comments are plain English and say *why* (hardware findings, limits, dates). Keep that density, and
  update the comment when you change the behaviour it describes. Swift tests use swift-testing `@Test`.
- **Visual language ("Lagonda Digital").** The spec is the header of `glasses/src/ui/kit.ts`: levels `LV`, never 1,
  nothing meaningful below 4, outlines not fills, under 15% of each tile lit. The primitives are in
  `src/shared/glyphs.ts` (seven-segment digits, square caps) and `src/shared/raster.ts`, and turn arrows
  in `glasses/src/ui/maneuver.ts`. Firmware text uses the `G` glyph table, which has ASCII fallbacks.
- **New glasses mode.** Add `glasses/src/modes/foo.ts` exporting a `Mode` (`core.ts`: `screen()`, `gesture()`,
  optional `enter/exit/hold/onHub/quiet/resume`). Add it to the array in `app.ts` before `router`, and add
  `["foo","FOO"]` to `ITEMS` in `modes/launcher.ts`. To open it by voice, extend the `open` message's `mode`
  union in `protocol.ts` and the `open_mode` tool in `router.ts`. A mode that streams the mic sets
  `quiet: true` and implements `resume()`.
- **New router tool.** Add `tool(name, description, zodShape, handler)` in `router.ts` `hubServer()`, or in a
  feature's `tools.ts` spread into it (`messageTools`, `skyTools`, `googleTools`). Outbound actions go
  through `glassesConfirm`. Add a label in `src/shared/assistant.ts` `toolLabel` if needed.
- **New hub message.** Add it to `ClientMsg` or `HubMsg` in `src/shared/protocol.ts`, handle it in the `switch (m.t)`
  in `server.ts` (and on glasses in a mode's `onHub`). Node sockets may only send `NODE_MSGS`.
- **Tests.** Add or extend `scripts/<area>-test.ts` (node:test, offline, injectable fetchers and fixtures)
  and an npm script. G2Kit tests go in `native/ios/G2Kit/Tests/G2KitTests/`. Use fake hardware ids.
- **Targeted edits.** Several agents may be editing this tree at once. Don't reformat or revert files you
  didn't touch, don't `git stash`, `git checkout --` or `git reset` others' work, and check `git status` first.
- **Bocchi.** The assistant's persona is "Bocchi" (`ASSISTANT_NAME`; "Jarvis" still works as a wake word). The
  avatar in `assets/bocchi/` (with `CREDITS.md`, `pet.json`) and `glasses/src/ui/bocchi*.ts` is intended.
  `bocchi-frames.ts` is generated by `scripts/build-bocchi-sprite.py`. Publishing swaps in the licensed sheet.

## More docs

`docs/ARCHITECTURE.md` (system, flows, protocol, security, limits) · `docs/PLAYBOOK.md` (daily use, setup of
Google, Soniox, home computer) · `docs/JARVIS.md` (features and roadmap; partly stale) · `native/PROTOCOL.md`
(BLE protocol with confidence levels) · `native/ios/README.md` (iOS app) · `src/stt/README.md`.

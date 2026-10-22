# MyJarvis: your own Jarvis for Even G2 glasses + R1 ring

Your own iPhone app talks to the G2 glasses and R1 ring directly (no Even app), and a hub on your Mac
runs everything smart on **your Claude Code login**: a voice assistant, Claude Code / Codex agents you
approve with the ring, a conversation copilot that whispers "alpha", live translation (Chinese with
pinyin), navigation with a green map, weather and star maps, Google Calendar/Gmail, texts, and
mini-apps you vibe-code from your phone. Everything is drawn in a 1980s "Lagonda" digital-dash style.

**How to use it day to day: [docs/PLAYBOOK.md](docs/PLAYBOOK.md).** Architecture and reference: [docs/JARVIS.md](docs/JARVIS.md).

## Quick start (about 30 minutes)

You need: Even G2 glasses (+ optional R1 ring), an iPhone, a Mac that stays on (the hub), a Claude
subscription with Claude Code, and Xcode. Free Tailscale is recommended so the phone reaches the hub anywhere.

1. **Hub on the Mac**
   ```bash
   git clone https://github.com/jacobbrass75-commits/myjarvis.git && cd myjarvis
   npm install && npm --prefix glasses install && npm --prefix glasses run build
   cp .env.example .env
   ```
   In `.env` set `HUB_TOKEN` to a long random string (`openssl rand -hex 24`) and run
   `claude setup-token` to fill `CLAUDE_CODE_OAUTH_TOKEN`. Then start it for good:
   `scripts/autostart.sh install --keep-awake` (logs: `~/Library/Logs/g2-hub.log`).
2. **Tailscale** on the Mac and the iPhone (same account). Note the Mac's `100.x.y.z` address.
3. **iPhone app**: open `native/ios/JarvisApp/JarvisApp.xcodeproj` in Xcode, pick your Team under
   Signing & Capabilities, change the bundle id (`com.myjarvis.JarvisG2`) to something unique, and run
   it on your phone (details: [native/ios/README.md](native/ios/README.md)). In the app's Settings enter
   the hub address `http://<mac tailscale ip>:8787` and your `HUB_TOKEN`.
4. **Glasses**: force-quit the Even app, open Jarvis → Glasses → Connect. Both arms connect; a ring
   already paired to the glasses works through them.
5. **Optional keys** in `.env` (see `.env.example` for where to get each): Soniox or OpenRouter for
   better speech, `GOOGLE_MAPS_API_KEY` for Places/Routes/maps, a Google OAuth client for Calendar and
   Gmail (`npm run google:connect`), Full Disk Access for the hub's node to read Messages.

Ring: swipe = move, tap = select / yes, double tap = back / no, hold = talk.

---

**Start here: [docs/JARVIS.md](docs/JARVIS.md)** for the conversation copilot, live translation, navigation, notes, teleprompter, dashboard, people memory and the roadmap to your own app.

## Agent orchestration

Control every Claude agent you run, on every machine, from your Even G2 glasses, the R1 ring and your phone.

- **Ring**: tap = approve, double tap = deny, swipe = next / scroll, hold = talk.
- **Voice**: hold the ring, speak, release. Claude routes what you said to the right agent, device or app.
- **Phone**: a web page with the same approvals, agent output, follow-ups and a "start agent" form.
- **Many devices**: run a small daemon on each machine. Everything connects out to one hub.
- **Your apps**: declare HTTP actions in `apps.json` and the voice router can call them.

```
 G2 glasses ──BLE── iPhone (Even App WebView: glasses/)
                         │  WebSocket: state, ring gestures, mic PCM
                         ▼
 phone browser ───►  HUB (src/hub)  ◄─── Claude Code hooks (hooks/cc-hook.mjs), via HTTP
                     approvals · agents · voice → STT → Claude router → tools · apps.json
                         ▲
        WebSocket ───────┴──────── device daemons (src/node), one per machine
                                   run Claude Agent SDK sessions; permission prompts go to the ring
```

Two kinds of agents show up on the glasses:

| Kind | How | What you can do from the glasses |
|---|---|---|
| **SDK agents** | Started from the glasses, phone or voice; run by a device daemon | Approve/deny, read output, send follow-ups, stop |
| **Claude Code sessions** | Your normal terminal `claude`, with the hooks installed | Approve/deny permission prompts, see status and last message |

## Setup

```bash
npm install && npm --prefix glasses install
cp .env.example .env     # set HUB_TOKEN (long random)
claude auth login        # once per machine: everything runs on your Claude Code login, no API key
npm run hub
```

1. **Phone**: open `http://<hub-ip>:8787/?token=<HUB_TOKEN>` once (the token is then remembered) and add it to your home screen.
2. **Each machine that runs agents**: set `G2_HUB_URL` and `G2_HUB_TOKEN` in its `.env`, then run `npm run node`.
3. **Existing Claude Code sessions** (per machine):
   `G2_HUB_URL=http://<hub-ip>:8787 G2_HUB_TOKEN=<token> node hooks/install.mjs`
   Permission prompts then show on the glasses too. If you don't answer within `HOOK_APPROVAL_TIMEOUT_S`, or the hub is down, the normal terminal prompt appears. `--uninstall` removes the hooks.
4. **Glasses**: `npm --prefix glasses run build` (the hub serves it at `/glasses/`), then
   `npx --prefix glasses evenhub qr --url "http://<hub-ip>:8787/glasses/?token=<HUB_TOKEN>"`
   and scan the code from the Even App's developer mode.
5. **Voice from the glasses** needs speech-to-text on the hub (the Even SDK has none). Free and local: `brew install whisper-cpp`, download a model (e.g. `ggml-base.en.bin`) and set `WHISPER_MODEL` to its path. Or set `DEEPGRAM_API_KEY`.

Use [Tailscale](https://tailscale.com) (already installed on this Mac) so your phone and other machines reach the hub from anywhere: use the hub's `100.x.y.z` address everywhere above.

## Developing the glasses UI without glasses

Open `http://localhost:8787/glasses/?token=<HUB_TOKEN>` in any browser. Outside the Even App, the page draws a 576×288 lens and gives you ring buttons. Keys: ↑/↓ swipe, Enter tap, Backspace double tap, hold Space to talk (uses your computer's mic). For hot reload, use `npm run glasses` with `VITE_HUB_URL=http://localhost:8787` and open port 5173. Add `?emulate=1` to force the emulator.

`npm run fake-agent` adds a pretend device whose agent keeps asking for approval, so you can exercise the whole loop without running Claude.

## Your apps

Copy `apps.example.json` to `apps.json`. Each action becomes a tool named `app_<app>_<action>`; `params` is a JSON Schema. Header values can use `${ENV_VAR}`. Restart the hub after editing.

## Security

The hub can start agents that run shell commands on your machines. Keep `HUB_TOKEN` long and secret, and keep the hub on localhost or Tailscale, never on the open internet. `G2_AUTO_ALLOW` lists the tools agents may use without asking (read-only ones by default).

## Not verified on real hardware yet

- Text layout constants (`COLS`, `ROWS` in `glasses/src/main.ts`) are estimates for the G2 font.
- Whether a press arrives as a container event, a `sysEvent`, or both. The app handles all three cases.
- Long press may be reserved by the firmware in some contexts; if it is, use the phone mic button instead.

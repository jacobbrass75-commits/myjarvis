# Jarvis for Even G2: what's built and where it's going

Your own assistant on the G2 glasses and R1 ring, running on your Claude Code login (no API keys).
Everything heavy runs on the hub (your Mac); the glasses app is a thin screen + input + mic.

The current conversation Copilot still uses Claude and local speech recognition. OpenAI voice has
not been connected; that integration is waiting for completion of secure OpenAI API-key setup.

```
 G2 glasses + R1 ring ──BLE── iPhone (Even App WebView: glasses/)        ← today
                         └─── your own app / Mac driver (native/)        ← in progress
                                   │ WebSocket: screens, gestures, mic PCM
                                   ▼
 HUB (src/hub) ── speech-to-text (src/stt: Apple on-device / whisper.cpp, local, free)
     ├─ Jarvis voice router (Claude): agents, notes, timers, web lookups, recall, your apps
     ├─ Copilot (Claude, warm session + web search): live cards about the conversation
     ├─ Translator (Claude, warm session): two-way live translation
     ├─ Notes, teleprompter scripts, conversation logs (~/.g2-orchestrator/data)
     ├─ Dashboard: Open-Meteo weather, macOS Calendar, Hacker News, agent status
     └─ Agents on every device (src/node daemons) + Claude Code hooks
```

## On the glasses

Ring / temple: **swipe** = move, **tap** = select, **double tap** = back, **hold** = talk to Jarvis.

| Mode | What it does | Ring |
|---|---|---|
| **Today** | Time, weather, rest of today's calendar, agents, headlines | swipe: headlines |
| **Copilot** | Listens to the conversation. Every few sentences: topic, where it's heading, and up to 3 cards: CHECK (myth or mistake just said), TERM, FACT (web-searched), ASK (question to keep it going), SAY, NEXT | swipe: pick card · tap: more · hold: "help me now" |
| **Translate** | Pick their language; they're shown in yours, you're shown in theirs | swipe: history · double: change language |
| **Navigate** | Turn-by-turn: arrow, distance, street, "then…", ETA. Opens itself when you ask for directions | tap: stop |
| **Agents** | Your Claude agents on all devices; approval cards pop up anywhere | tap: open · hold while open: talk to that agent |
| **Notes** | Hold to dictate a note; conversation summaries land here too | hold: record |
| **Teleprompter** | Script from the phone page; "follow me" scrolls as you speak | tap: follow me |

When you leave Copilot after a real conversation, a summary with action items and names is saved
to Notes, and the full transcript is logged so you can later ask "what did she say about the lease?".

## Voice ("hold to talk", from any mode)

Jarvis can: start / message / stop agents on any device; approve or deny; take and read notes;
set timers and reminders ("remind me at 3 to call mom"); give walking/biking/driving directions
("walk me to the nearest pharmacy"); search and fetch the web; recall past conversations; remember
people ("remember that Sam's daughter is Ava") and tell you what you know about someone; ask the
copilot for fresh cards; call any action in `apps.json`.

**People memory:** when a conversation ends, durable facts about anyone named are saved
(`people.json`). Next time that name comes up, the copilot can surface it, e.g. "How's your mom
doing? I heard she was in the hospital last week".

Tested (Claude Code login, warm sessions): simple commands about 2 s and follow-ups remember
context ("and what about 20 percent?"); web lookups about 4 s; translation 1.6–2 s per sentence;
copilot cards 6–9 s after the conversation; voice directions about 6 s (OpenStreetMap / OSRM, free).
With real audio: a spoken reminder took 9 s end to end (local Apple speech recognition + Claude), and
live Copilot transcribed two speakers 2–3 s behind real time.

`npm run jarvis-test` runs the whole suite against its own throwaway hub (your data is untouched).

Location comes from the phone: the glasses app sends GPS when installed from Even Hub, or tap
"Share location" on the phone page. Without either, it falls back to the Mac's city-level location.

## Speech-to-text (local, free, no keys)

`src/stt` (see its README): Apple's on-device SpeechAnalyzer through a small Swift helper
(`tools/speech/bin/g2speech`, 30 locales, no permission prompt) with whisper.cpp as the fallback
for other languages. First words appear about 0.5 s after speech, final lines 1.5–2 s after a
pause. Hold-to-talk measured 5.7 s from the end of the question to the answer on the glasses.
Rebuild the helper with `tools/speech/build.sh`; self-test with `npx tsx src/stt/selftest.ts`.

## Always on

`scripts/autostart.sh install` makes macOS start the hub and this Mac's agent daemon at login and
restart them if they crash (`uninstall` removes it, `status` checks). Logs: `~/Library/Logs/g2-hub.log`.

### One main computer, projects on that computer

Use the main computer as the hub and run its device daemon there too. Your glasses connect through
the Even app on your phone; the phone and glasses send tasks to the hub. The daemon starts either
Claude Code or Codex in the project folder you select. Files remain in their existing folders on
that computer. The phone page shows each engine's local login readiness and the available projects.
Login readiness and the project catalog refresh once a minute without restarting running agents.

Create `~/.g2-orchestrator/projects.json` as an array of local folders, for example:

```json
[{"name":"My app","path":"/Users/me/projects/my-app"}]
```

`G2_PROJECTS_FILE` selects a different catalog. Set `G2_DEFAULT_CWD` to your main project, then run
`scripts/autostart.sh install --keep-awake`. Both services start at login and restart on failure;
the hub prevents system sleep while plugged into AC power. On a laptop, keep the lid open. This is
a per-user service, so sign in after restarting the Mac. `scripts/autostart.sh status` checks it.

On the phone, open Jarvis, choose the computer, project, and **Claude Code** or **Codex**, and enter
your task. Follow-ups go to the same session. By default, Claude tool approvals appear on the phone
and glasses and Codex uses its project sandbox. `G2_BYPASS_PERMISSIONS=1` enables unrestricted
access for both engines; the phone shows when this is enabled. Codex uses `codex login`, including an existing ChatGPT login;
Claude Code uses its own login or the configured Claude token. Neither coding engine needs a new
OpenAI API key for this setup.

Other computers can join later by running the same daemon with their own catalog and `G2_HUB_URL`
pointing to the main hub over your private network: `scripts/join-worker.sh` does it in one command
with a one-time pairing code from the phone page, and gives that computer its own revocable token. A
worker can also offer computer use (agents that drive its screen, every step approved on the ring);
see "Home computer" in docs/PLAYBOOK.md. A selected path always belongs to the selected
computer. Joining a worker does not copy, synchronize, or relocate projects. Keep authoritative
project folders on the main computer unless a task explicitly needs a worker's local checkout.

### Use the phone away from the Mac's Wi-Fi

Connect Tailscale on the main Mac and the iPhone, then use the Mac's private Tailscale address for
the hub (`http://<private-address>:8787`). That address stays usable when the Mac's local Wi-Fi
address changes. The hub token is still required; keep connection QR codes private. The native
app saves its configured hub address and keeps the token in the iPhone Keychain.

The private network must be connected on both devices. To verify access away from home, turn off
Wi-Fi on the phone, leave cellular data and Tailscale enabled, then open Jarvis and send a harmless
task to the main Mac. A successful Mac-side ping alone does not verify that complete phone flow.

## Privacy

Copilot and Translate record and transcribe the people around you. Transcripts and notes stay on
your Mac (`~/.g2-orchestrator/data`; set `G2_DATA_DIR` to use another folder, e.g. for tests). Recording laws differ by place, and some require everyone's
consent. Tell people when it's on.

## Roadmap

**Now / next**
- Measure latency end to end on the real glasses (everything so far was measured with synthesized
  speech on the Mac).
- Copilot polish: speaker separation (glasses report "self" vs "other"), pinning a topic, a
  "quiet" level, and per-person memory ("last time you met Sam he mentioned…").
- Speed: smaller/faster model for translation (`TRANSLATE_MODEL`), streaming partial translations.

**Own app instead of the Even App** (see `native/`)
- Done (untested on hardware): a BLE driver written from the reverse-engineered protocol
  (native/driver, 54 offline tests), an LC3 mic decoder, and `npm run jarvis:native`, which runs
  this exact Jarvis app on the Mac straight to the glasses. Verified end to end with simulated lenses.
- Next: the first hardware test (iPhone Bluetooth off; see native/README.md).
- Done (untested on hardware): **your own iPhone app**, `native/ios/JarvisApp` (SwiftUI), with
  G2Kit, a Swift port of the driver plus Google's liblc3 (57 tests pass). It pretends to be the
  Even App host, so this same Jarvis glasses app runs inside it unchanged. It runs in the iOS
  Simulator against the hub. A signed build is now installed and running on the physical iPhone,
  and its saved hub address matches the main Mac's private Tailscale address. Native microphone
  input and direct BLE still need physical acceptance checks (native/ios/README.md).
- Next: iOS notifications to the glasses (ANCS), and keeping BLE and the mic alive in the background.
- The ring may pair with the glasses or the phone; native/PROTOCOL.md tracks what's known.

**More apps**
- Stocks and sports glance, flashcards,
  meeting mode (Calendar-aware: auto-start Copilot, push the summary to the event).
- Games: Pixel Run and Downhill (apps/), streamed frames, about 6–8 fps on the glasses.

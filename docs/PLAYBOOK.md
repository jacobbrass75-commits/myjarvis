# How to actually use Jarvis day to day

The short version: **the Mac is the brain, the phone is the radio, the glasses are the screen, the
ring is the remote.** Leave the Mac on, keep the Jarvis app on the phone, and drive everything from the ring
and your voice.

## One-time setup (10 minutes)

1. **Mac (the hub):** `scripts/autostart.sh install --keep-awake` once. The hub and agent daemon
   then start at login and restart on crash. Keep it on power; logs are in `~/Library/Logs/g2-hub.log`.
2. **Tailscale** on the Mac and the iPhone, so the phone reaches the hub from anywhere (the app
   already points at the Mac's Tailscale address).
3. **iPhone:** open **Jarvis**, then **force-quit the Even app** (swipe it away). The Even app fights
   for the two arms; when it's closed, Jarvis grabs both arms in about a second. The ring needs nothing:
   it stays paired to the glasses and its taps arrive through them.
4. **Allow Location** for Jarvis (Settings → Jarvis → Location → While Using). It's currently denied,
   so navigation and local weather fall back to the Mac's city.
5. **Better hearing (recommended):** a Soniox key in `.env` (see "Speech" below). Without one,
   Apple's on-device recognizer is used (free, private, decent).

## The remote (ring or temple)

| Do | Means |
|---|---|
| swipe | move / scroll |
| tap | select · **YES** on an approval card |
| double tap | back · **NO** on an approval card |
| hold | talk to Jarvis (release when done) |

Approval cards pop up over everything except conversations, so you can approve agents mid-walk without looking at the phone.

## Daily loops that get the most out of it

**Morning glance:** Launcher → *Today*: time, weather, the rest of today's calendar, which agents are busy, headlines.

**Coding while away from the desk:** this is the killer use.
- Hold: *"Start a Claude agent on my-app to add dark mode."* or *"Use Codex to fix the failing tests in g2-orchestrator."*
- Walk. When it needs permission, a card appears: tap = yes, double tap = no.
- *Agents* mode: tap an agent to read its latest output; hold while it's open to reply to that agent only.
- Long diffs/output: the phone's **Agents** tab. Follow-ups go to the same session.
- Projects come from `~/.g2-orchestrator/projects.json`; the phone shows which computers and engines are ready.

**Conversations (meetings, dinners, networking):** *Copilot*.
- It listens and every few sentences shows the topic, where it's heading, and up to 3 cards:
  CHECK (a myth or mistake just said), TERM, FACT (web-searched), ASK (a question to keep it going).
- When you leave Copilot, a summary with action items and names goes to *Notes*, and the transcript is kept,
  so later you can hold and ask *"what did Sam say about the lease?"*
- It remembers people: *"remember that Sam's daughter is Ava"*. Next time Sam comes up, it reminds you.
- Tell people it's on; recording laws differ by place.

**Chinese (and other languages):** *Translate* → pick the language.
- Their Chinese shows as characters + pinyin + English.
- What you say in English shows as Chinese characters + pinyin, so you can read it out loud.
- Doubles as a Mandarin tutor: leave it on while watching a show or ordering food.

**Getting somewhere:** hold, *"walk me to the nearest coffee shop"*. *Navigate* opens with an arrow, distance, street and ETA. Tap stops it.

**Talks and videos:** paste a script on the phone page → *Teleprompter*; tap "follow me" and it scrolls as you speak.

**Quick capture:** hold, *"note: call the landlord about the heater"*, or *"remind me at 3 to call mom"*.

**Vibe-coding apps and games on the go:**
- Phone **Studio** tab: describe it (*"a reaction-time game: wait for GO, tap fast, show ms"*). Claude
  writes it, a sandbox tests it, and it shows up in *Apps* on the glasses within about a minute.
- Or by voice: hold, *"make an app that…"*, then *"change it so…"* to iterate. The glasses hot-reload it.
- Apps live in `miniapps/`. Snake, Pong, Reaction and Coin Flip are already there. Use Preview on the Studio page before wearing them; if one crashes on the glasses, Studio fixes it once automatically and the glasses reload it.

## Speech

Even's own app ships three cloud recognizers (Soniox, Microsoft Azure, Tencent) and its server picks
one; Soniox's long-session code points to it running Conversate and Translate. Jarvis uses the same one.

| Engine | When it's used | Notes |
|---|---|---|
| **Soniox** stt-rt-v5 | when `SONIOX_API_KEY` is in `.env` | Chinese+English in one sentence, speaker labels, about $0.12 per hour while listening; closes itself after 2 min of silence |
| Apple on-device | no key, or Soniox is down | free, private, about 0.5 s to first words |
| whisper.cpp | languages Apple doesn't cover | local, slower |

Turn Soniox on: get a key at console.soniox.com, add `SONIOX_API_KEY=…` to `.env`, then
`launchctl kickstart -k gui/$(id -u)/com.g2.hub`. The hub log says `[stt] soniox: key OK`.
`STT_ENGINE=apple` forces local; `SONIOX_DIARIZATION=1` adds speaker labels.

## Chinese settings

The G2 lenses draw Chinese characters and tone-marked pinyin (checked on the real glasses), so the
defaults are characters + tone marks + English. The phone page (Translate, Chinese) can switch to tone
numbers (ni3 hao3) or hide the characters on the glasses; `.env` defaults:
`TRANSLATE_PINYIN_TONES=marks|numbers`, `TRANSLATE_GLASSES_HANZI=1|0`.

Without a Soniox key, Translate listens only for the other person's language (Apple's recognizer
does one language at a time), so to show your English in Chinese, type it on the phone page. With
Soniox, both languages are heard in the same stream, mixed sentences included.

## Google account

Your own Google account powers *Today*'s agenda (instead of the Mac's Calendar app) and these voice
commands: *"what's my day"*, *"when's my next meeting"*, *"add lunch with Sam Friday at 1"*,
*"anything important?"* (unread mail from the last 12 hours as a few *Sender: gist* lines),
*"read Sam's email"*, *"reply to Sam that Friday works"*, *"send it"*. Adding an event and sending an
email always show a **CONFIRM?** card on the glasses: tap = yes, double tap = no, no answer in 60 s = no.
Drafts never go out on their own. Before a meeting with other people, Copilot already knows who's in it.

One-time setup (about 10 minutes, on the Mac):
1. [console.cloud.google.com](https://console.cloud.google.com) → create a project (e.g. "Jarvis").
2. **APIs & Services → Library**: enable **Google Calendar API** and **Gmail API**.
3. **OAuth consent screen** (Google Auth Platform → Branding): user type **External**, app name, your
   address as support and developer contact. Leave the publishing status on **Testing**.
4. **Audience → Test users → Add users**: your own Gmail address.
5. **Clients → Create client → OAuth client ID → Desktop app**. Put its ID and secret in `.env` as
   `GOOGLE_OAUTH_CLIENT_ID=` and `GOOGLE_OAUTH_CLIENT_SECRET=`, then
   `launchctl kickstart -k gui/$(id -u)/com.g2.hub`.
6. `npm run google:connect` (or **Connect** under Google on the phone page; the sign-in page opens in
   the Mac's browser either way, because Google sends you back to `127.0.0.1` on the Mac). Choose your
   account, click past "Google hasn't verified this app" (it's your own), and tick every permission.

The refresh token is stored in `~/.g2-orchestrator/google-token.json` (only your user can read it),
never in the repo. `npm run google:connect -- --status` shows who's connected; `-- --disconnect`
revokes access and deletes it. While the app is in Testing, Google expires the sign-in after 7 days:
the hub then says so, and `npm run google:connect` again fixes it.

## Home computer (agents that use a Mac's screen)

An always-on Mac at home that agents can drive like a person (look at the screen, click, type, open
apps and pages), reached over Tailscale from anywhere. It joins the hub as a **worker**: only its agent
daemon runs there, with its own token. Computer use is off until you switch it on for that Mac, and
every step that changes anything waits for your ring.

**1. Choose the computer.** Any Mac that can stay on: a Mac mini (any Apple silicon one is plenty) or
an old MacBook with the lid open. Plug it in (Ethernet if you can). A Mac mini without a monitor needs
an HDMI dummy plug, or the "screen" it sees is tiny or blank. Best: a separate macOS user just for the
agent, with no saved passwords and no banking sessions in its browser. In System Settings: *Energy* >
"Prevent automatic sleeping when the display is off" and "Start up automatically after a power
failure"; *Lock Screen* > never turn the display off or lock while that user is logged in (computer use
can't see a locked screen). With FileVault on, someone has to log in once after each restart.

**2. Install the basics on it:** Tailscale (App Store or tailscale.com/download; sign in with the same
account as the hub and the phone; nothing needs to reach the worker, it connects out), the Xcode
command line tools (`xcode-select --install`), Node 20+ (`brew install node`), and Claude Code (run
`claude` once and sign in; for an always-on box, `claude setup-token` and put `CLAUDE_CODE_OAUTH_TOKEN=`
in its `.env`). Then `git clone` this repo there.

**3. Pair it.** On the phone page, *Devices & apps* > **Pair a computer** (or `npm run worker:pair` on
the hub Mac). You get a code that works once for 10 minutes and the exact command. On the home Mac, in
the repo folder:

```
scripts/join-worker.sh --hub http://100.64.0.1:8787 --code ABCD-EFGH --computer
```

It checks Node and Tailscale, installs dependencies, trades the code for this Mac's own token (saved in
its `.env`, mode 600, never printed; the hub's own token never leaves the hub), builds and self-tests
the small Swift helper (`tools/computer/bin/g2input`, macOS built-ins only), and installs the daemon in
launchd (starts at login, restarts on crash, keeps the Mac awake on power). Leave out `--computer` for
a plain coding worker; add it later with `scripts/join-worker.sh --computer`.

**4. Grant two permissions** (the script prints both paths). System Settings > Privacy & Security >
**Screen Recording** (macOS 15+: "Screen & System Audio Recording") and **Accessibility**: click +,
press Cmd+Shift+G, add the `node` binary it printed (e.g. `/opt/homebrew/Cellar/node/…/bin/node`) and
`tools/computer/bin/g2input`. Then `launchctl kickstart -k gui/$(id -u)/com.g2.node`. The phone's
*Devices* list should say **computer use ready**; otherwise it says what's missing. After a Node
upgrade the path changes: grant the new one.

**5. Choose how often to approve** in the home Mac's `.env` (restart the daemon after a change):
`G2_COMPUTER_APPROVAL=step` (the default: a card before every action batch) or `task` (one card for
the first step, then the task runs; sensitive screens still ask every time). `G2_COMPUTER_THUMBNAIL=1`
shows its latest screen as a small tile in *Agents* (off by default; about one tile per 1.5 s, only
while you're looking at that agent).

**Asking for things.** Hold and say *"on the home computer, find a flight to Denver next Friday under
$300 and leave the best one open in a tab"*, or type the same into the phone page's command box.
Cards look like **APPROVE? COMPUTER @ HOME-MAC**, with what it's about to do (*click 640,320 in Safari:
United Airlines*). Tap = yes, double tap = no (it then asks what you want instead). A voice "yes" never
approves a computer step; only a tap on the glasses or the phone does.

**Its safety rails:**
- **Sensitive screens pause for a fresh tap, every time,** whatever the approval mode: a password field
  selected, System Settings, Keychain, password managers, Terminal, and windows or links that look like
  sign-in, checkout, payment or banking pages (`G2_COMPUTER_DENY_APPS` adds apps). It is told never to
  type passwords or card numbers, pay, or accept terms: at those steps it stops and asks you to finish.
- **Hard stop:** hold and say *"stop the computer"* (handled at once, without the assistant), or open it
  in *Agents* and **tap**, or Stop on the phone. A stopped agent does nothing more, mid-batch included.
- **Kill switch:** while `~/.g2-orchestrator/computer-stop` exists on the home Mac, nothing runs and
  running tasks stop within a second (`touch` it, e.g. over `ssh` via Tailscale; delete it to allow again).
- Screenshots stay on the home Mac and go only to Claude; they are never saved, logged or sent to the
  phone (the optional thumbnail goes to the glasses only).

**Revoking.** Phone page > *Devices & apps* > **Revoke** next to it (or `npm run worker:pair -- list`
and `npm run worker:pair -- revoke <id>` on the hub). Its token stops working at once and it is
disconnected. On the home Mac, `scripts/autostart.sh uninstall` removes the daemon; remove the two
grants in Privacy & Security. To keep it as a worker but switch computer use off:
`node --import tsx scripts/worker-pair.ts computer off`, then restart its daemon.

## When something's off

- **One arm missing:** Glasses tab → *Connect listed arms*. Make sure the Even app is force-quit.
- **Ring does nothing:** tap it once to wake it. It works through the glasses; Jarvis never needs to pair it.
- **Nothing on the glasses:** check the Jarvis tab says *page loaded*, and that the hub's up (`scripts/autostart.sh status`).
- **Logs:** the phone's Log tab, or the app's `Documents/jarvis.log` (Files app → On My iPhone → Jarvis).

#!/bin/zsh
# Join this Mac to your Jarvis hub as a worker: its agent daemon runs here (always on, restarted on
# crash) and connects out to the hub over Tailscale. Run it from this computer's g2-orchestrator clone:
#
#   scripts/join-worker.sh --hub http://<hub tailscale ip>:8787 --code ABCD-EFGH [--computer] [--name home-mac]
#
# The pairing code comes from the phone page (Devices > Pair a computer) or `npm run worker:pair` on
# the hub; it works once, for 10 minutes. This computer gets its own token (saved in .env, mode 600,
# never printed); the hub's own token never comes here. --computer switches on computer use (the
# hub can then drive this screen, with every step approved on your glasses). Run it again any time:
# without --code it keeps the existing pairing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
HUB="" CODE="${G2_PAIR_CODE:-}" NAME="" COMPUTER=0 LAUNCHD=1
while (( $# )); do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --code) CODE="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --computer) COMPUTER=1; shift ;;
    --no-launchd) LAUNCHD=0; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done

ok() { print -P "%F{green}✓%f $1"; }
warn() { print -P "%F{yellow}!%f $1"; }
die() { print -P "%F{red}✗%f $1" >&2; exit 1; }
envval() { [[ -f .env ]] && sed -n "s/^$1=//p" .env | tail -1 || true; }

[[ "$(uname -s)" == "Darwin" ]] || die "This installer is for macOS."
[[ -n "$HUB" ]] || HUB="$(envval G2_HUB_URL)"
[[ -n "$HUB" ]] || die "Give the hub address: --hub http://<hub tailscale ip>:8787"
HUB="${HUB%/}"

# ---- Node ----
command -v node >/dev/null || die "Node.js 20+ is needed: brew install node (or nodejs.org), then run this again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "Node.js $(node -v) is too old; 20+ is needed (brew upgrade node)."
ok "Node $(node -v)"

# ---- Tailscale ----
TS="$(command -v tailscale || true)"
[[ -z "$TS" && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
if [[ -z "$TS" ]]; then
  [[ "$HUB" == *://100.* ]] && die "Tailscale isn't installed: get it from the Mac App Store or tailscale.com/download, sign in with the same account as the hub, then run this again."
  warn "Tailscale not found; using $HUB directly."
elif ! "$TS" status >/dev/null 2>&1; then
  die "Tailscale is installed but not connected: open Tailscale and sign in (same account as the hub)."
else
  ok "Tailscale connected ($("$TS" ip -4 2>/dev/null | head -1))"
fi

# ---- the hub ----
HTTP="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "$HUB/manifest.webmanifest" || true)"
[[ "$HTTP" == "200" ]] || die "Can't reach the hub at $HUB (got ${HTTP:-nothing}). Is it running, and is Tailscale on at both ends?"
ok "Hub reachable at $HUB"

# ---- dependencies ----
npm ci --no-audit --no-fund --loglevel=error >/dev/null || npm install --no-audit --no-fund --loglevel=error >/dev/null
ok "Dependencies installed"

# ---- coding agents (optional for computer use) ----
if command -v claude >/dev/null && claude auth status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s||"{}").loggedIn?0:1))'; then
  ok "Claude Code signed in"
else
  warn "Claude Code isn't installed or signed in here. Agents (and computer use) run on it: install Claude Code, run \`claude\` once and sign in."
fi

# ---- pairing ----
JOIN=(--hub "$HUB")
[[ -n "$NAME" ]] && JOIN+=(--name "$NAME")
(( COMPUTER )) && JOIN+=(--computer)
if [[ -n "$CODE" ]]; then
  G2_PAIR_CODE="$CODE" node --import tsx scripts/worker-pair.ts join "${JOIN[@]}"
  ok "Paired"
elif [[ "$(envval G2_HUB_TOKEN)" == g2w_* ]]; then
  ok "Already paired (pass --code to pair again)"
  (( COMPUTER )) && node --import tsx scripts/worker-pair.ts computer on
else
  print "Pairing code (phone page: Devices > Pair a computer, or \`npm run worker:pair\` on the hub):"
  read -r CODE
  [[ -n "$CODE" ]] || die "No code given."
  G2_PAIR_CODE="$CODE" node --import tsx scripts/worker-pair.ts join "${JOIN[@]}"
  ok "Paired"
fi

# ---- computer use ----
HELPER="$ROOT/tools/computer/bin/g2input"
if [[ "$(envval G2_COMPUTER_USE)" == 1 ]]; then
  xcrun --find swiftc >/dev/null 2>&1 || die "Computer use needs the Xcode command line tools: xcode-select --install, then run this again."
  tools/computer/build.sh >/dev/null || die "Building the computer-use helper failed (tools/computer/build.sh)."
  ok "Computer-use helper built and self-tested ($HELPER)"
fi

# ---- always on ----
if (( LAUNCHD )); then
  zsh scripts/autostart.sh install-worker --keep-awake >/dev/null
  ok "Agent daemon installed in launchd (com.g2.node, starts at login, stays awake on power)"
fi

NODE_REAL="$(node -p 'require("fs").realpathSync(process.execPath)')"
cat <<EOF

Next, on this Mac:
EOF
if [[ "$(envval G2_COMPUTER_USE)" == 1 ]]; then
  cat <<EOF
  1. System Settings > Privacy & Security > Screen Recording (macOS 15+: "Screen & System Audio
     Recording"): click +, press Cmd+Shift+G and add BOTH
        $NODE_REAL
        $HELPER
  2. Privacy & Security > Accessibility: add the same two.
     (open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
      open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
  3. Restart the daemon so it picks the grants up:
        launchctl kickstart -k gui/\$(id -u)/com.g2.node
  4. Check: tail ~/Library/Logs/g2-node.log  (the phone's Devices list shows "computer use ready").
EOF
else
  cat <<EOF
  - Check: tail ~/Library/Logs/g2-node.log, then look for this computer under Devices on the phone page.
  - Computer use is off. To switch it on: scripts/join-worker.sh --computer
EOF
fi
cat <<EOF
  To stop all computer use here at once: touch ~/.g2-orchestrator/computer-stop (delete it to allow again).
  To leave the hub: revoke it on the phone page (Devices) or \`npm run worker:pair -- revoke <id>\` on the hub,
  then scripts/autostart.sh uninstall here.
EOF

#!/bin/zsh
# Start the Jarvis hub (and this Mac's agent daemon) automatically at login, and keep them running.
#   scripts/autostart.sh install --keep-awake  # main hub: stay awake while on AC power
#   scripts/autostart.sh install     # set up and start now
#   scripts/autostart.sh install-worker --keep-awake  # another computer (scripts/join-worker.sh): its agent daemon only
#   scripts/autostart.sh uninstall   # stop and remove
#   scripts/autostart.sh status
# Logs: ~/Library/Logs/g2-hub.log and g2-node.log
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
NODE="$(command -v node)"
KEEP_AWAKE="${2:-}"
# Which service keeps the computer awake (caffeinate -s: no system sleep on AC power).
AWAKE_LABEL="com.g2.hub"

plist() { # label, script
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>ProgramArguments</key><array>
    $([[ "$1" == "$AWAKE_LABEL" && "$KEEP_AWAKE" == "--keep-awake" ]] && printf '<string>/usr/bin/caffeinate</string><string>-s</string>' || true)
    <string>$NODE</string><string>--import</string><string>tsx</string><string>--env-file-if-exists=.env</string><string>$2</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/$3.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$3.log</string>
</dict></plist>
EOF
}

case "${1:-status}" in
  install)
    mkdir -p "$AGENTS"
    plist com.g2.hub src/hub/server.ts g2-hub > "$AGENTS/com.g2.hub.plist"
    plist com.g2.node src/node/daemon.ts g2-node > "$AGENTS/com.g2.node.plist"
    for l in com.g2.hub com.g2.node; do
      launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$AGENTS/$l.plist"
    done
    echo "Installed. Hub: http://localhost:8787  Logs: ~/Library/Logs/g2-hub.log"
    ;;
  install-worker)
    # A worker runs no hub: only the daemon, which connects out to G2_HUB_URL from .env.
    AWAKE_LABEL="com.g2.node"
    mkdir -p "$AGENTS"
    plist com.g2.node src/node/daemon.ts g2-node > "$AGENTS/com.g2.node.plist"
    launchctl bootout "gui/$(id -u)/com.g2.node" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.g2.node.plist"
    echo "Installed the agent daemon. Logs: ~/Library/Logs/g2-node.log"
    ;;
  uninstall)
    for l in com.g2.hub com.g2.node; do
      launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
      rm -f "$AGENTS/$l.plist"
    done
    echo "Removed."
    ;;
  status)
    launchctl print "gui/$(id -u)/com.g2.hub" 2>/dev/null | grep -E "state|pid" || echo "hub: not installed"
    launchctl print "gui/$(id -u)/com.g2.node" 2>/dev/null | grep -E "state|pid" || echo "node: not installed"
    ;;
esac

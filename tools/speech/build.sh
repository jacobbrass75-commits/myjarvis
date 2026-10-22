#!/usr/bin/env bash
# Builds tools/speech (g2speech) and installs the binary at tools/speech/bin/g2speech.
# The binary has Info.plist (NSSpeechRecognitionUsageDescription) embedded in __TEXT,__info_plist
# and is ad-hoc signed with a stable identifier so TCC can remember a grant.
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/g2speech"
[ -x "$BIN" ] || { echo "build failed" >&2; exit 1; }
mkdir -p bin
cp "$BIN" bin/g2speech
codesign --force --sign - --identifier com.g2orchestrator.g2speech bin/g2speech
echo "built $(pwd)/bin/g2speech"

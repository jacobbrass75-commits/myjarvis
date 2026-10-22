#!/usr/bin/env bash
# Builds the computer-use helper (g2input.swift) to tools/computer/bin/g2input with the Xcode
# command line tools (xcode-select --install), ad-hoc signed with a stable identifier so the
# Screen Recording / Accessibility grants stick across rebuilds. Then runs its self-test, which
# never moves the mouse or presses a key.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
xcrun swiftc -O -swift-version 5 -o bin/g2input g2input.swift
codesign --force --sign - --identifier com.g2orchestrator.g2input bin/g2input
echo "built $(pwd)/bin/g2input"
bin/g2input selftest || { echo "self-test failed" >&2; exit 1; }

#!/bin/bash
# Run the G2Kit unit tests on the Mac. With full Xcode selected (xcode-select -s
# /Applications/Xcode.app/Contents/Developer) plain `swift test` works; with only the Command Line
# Tools selected, swift-testing needs its framework paths spelled out, which this script does.
set -e
cd "$(dirname "$0")/G2Kit"
F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
U=/Library/Developer/CommandLineTools/Library/Developer/usr/lib
if [[ "$(xcode-select -p)" == /Library/Developer/CommandLineTools* && -d $F ]]; then
  exec swift test -Xswiftc -F$F -Xlinker -F$F -Xlinker -rpath -Xlinker $F -Xlinker -rpath -Xlinker $U "$@"
fi
exec swift test "$@"

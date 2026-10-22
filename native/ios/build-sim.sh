#!/bin/zsh
# Build JarvisApp for the iOS Simulator with the Xcode toolchain directly (works even before the
# Xcode license is accepted, since it skips xcodebuild/xcrun), then install and launch it.
#   native/ios/build-sim.sh            # build + install + launch on "iPhone 17 Pro"
#   native/ios/build-sim.sh --no-run   # just build → native/ios/build/JarvisApp.app
#   SIM="iPhone 17" native/ios/build-sim.sh
set -euo pipefail
cd "$(dirname "$0")"

X=/Applications/Xcode.app/Contents/Developer
SDK=$X/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator.sdk
TC=$X/Toolchains/XcodeDefault.xctoolchain/usr/bin
TARGET=arm64-apple-ios17.0-simulator
OUT=build
APP=$OUT/JarvisApp.app
SIM=${SIM:-iPhone 17 Pro}
mkdir -p $OUT/obj "$APP"

echo "• liblc3 (C)"
for c in G2Kit/Sources/CLiblc3/*.c; do
  $TC/clang -c -O2 -target $TARGET -isysroot $SDK -I G2Kit/Sources/CLiblc3/include -w "$c" -o "$OUT/obj/$(basename "$c" .c).o"
done

echo "• G2Kit (Swift)"
$TC/swiftc -parse-as-library -swift-version 5 -O -target $TARGET -sdk $SDK -module-name G2Kit \
  -I G2Kit/Sources/CLiblc3/include -Xcc -I -Xcc G2Kit/Sources/CLiblc3/include \
  -emit-module -emit-module-path $OUT/G2Kit.swiftmodule -emit-library -static -o $OUT/libG2Kit.a \
  G2Kit/Sources/G2Kit/*.swift

echo "• JarvisApp (Swift)"
$TC/swiftc -parse-as-library -swift-version 5 -O -target $TARGET -sdk $SDK -module-name JarvisApp \
  -I $OUT -I G2Kit/Sources/CLiblc3/include -Xcc -I -Xcc G2Kit/Sources/CLiblc3/include \
  -L $OUT -lG2Kit $OUT/obj/*.o \
  JarvisApp/Sources/*.swift -o "$APP/JarvisApp"

# Fill in the build-setting placeholders Xcode would normally substitute.
BUNDLE_ID=${BUNDLE_ID:-com.myjarvis.JarvisG2}
sed -e "s/\$(PRODUCT_BUNDLE_IDENTIFIER)/$BUNDLE_ID/g" -e 's/\$(EXECUTABLE_NAME)/JarvisApp/g' -e 's/\$(PRODUCT_NAME)/Jarvis/g' \
    -e 's/\$(DEVELOPMENT_LANGUAGE)/en/g' -e 's/\$(PRODUCT_BUNDLE_PACKAGE_TYPE)/APPL/g' \
    -e 's/\$(MARKETING_VERSION)/0.2/g' -e 's/\$(CURRENT_PROJECT_VERSION)/1/g' JarvisApp/Info.plist > "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable JarvisApp" "$APP/Info.plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string JarvisApp" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Info.plist" >/dev/null 2>&1 || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$APP/Info.plist"
codesign --force --sign - "$APP" >/dev/null
echo "Built $APP"

[[ "${1:-}" == "--no-run" ]] && exit 0
SIMCTL=$X/usr/bin/simctl
UDID=$($SIMCTL list devices available | grep -F "    $SIM (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
[[ -z "$UDID" ]] && { echo "No simulator named '$SIM'"; exit 1; }
$SIMCTL boot "$UDID" 2>/dev/null || true
open "$X/Applications/Simulator.app" --args -CurrentDeviceUDID "$UDID" 2>/dev/null || true
$SIMCTL install "$UDID" "$APP"
BID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Info.plist")
# HUB_URL / HUB_TOKEN (e.g. from ../../.env) point the app at your hub without typing them in.
$SIMCTL terminate "$UDID" "$BID" 2>/dev/null || true
ARGS=()
[[ -n "${HUB_URL:-}" ]] && ARGS+=(-hubURL "$HUB_URL")
[[ -n "${HUB_TOKEN:-}" ]] && ARGS+=(-hubToken "$HUB_TOKEN")
[[ -n "${START_TAB:-}" ]] && ARGS+=(-startTab "$START_TAB")
$SIMCTL launch "$UDID" "$BID" "${ARGS[@]}" >/dev/null
echo "Launched $BID on $SIM"

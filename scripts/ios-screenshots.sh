#!/usr/bin/env bash
# iOS App Store screenshot capture — runs on Mac Mini.
# Builds PearCal for the iOS Simulator, then loops scenes × appearances
# on each configured device, launching with -screenshotScene N and
# capturing PNGs via xcrun simctl io screenshot.
#
# Usage (on Mac Mini):
#   cd ~/peerloomllc/pearcal-native && SKIP_BUILD=1 ./scripts/ios-screenshots.sh
#   SKIP_BUILD=1 skips xcodebuild (useful when iterating on fixtures only)
#
# Output: /tmp/pearcal-screenshots/<device-name>/<appearance>/scene-N.png

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/metadata/ios/screenshots}"
BUNDLE_ID="com.pearcal"
SCENES=(1 2 3 4 5)
APPEARANCES=(light dark)

# Space-separated list of "DeviceName|UDID" pairs — edit as needed.
# iPhone 17 Pro Max = 6.9" App Store required size.
DEVICES=(
  "iPhone-17-Pro-Max|BB87E9B2-1A75-4118-B03E-9FBADD5A97F4"
)

# ── Build ──
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> Building for iOS Simulator..."
  cd "$REPO_ROOT"
  xcodebuild -workspace ios/PearCal.xcworkspace -scheme PearCal \
    -configuration Release \
    -destination "generic/platform=iOS Simulator" \
    -sdk iphonesimulator \
    CODE_SIGNING_ALLOWED=NO 2>&1 | tail -3
fi

APP_PATH=$(ls -d ~/Library/Developer/Xcode/DerivedData/PearCal-*/Build/Products/Release-iphonesimulator/PearCal.app 2>/dev/null | head -1)
if [ -z "$APP_PATH" ]; then
  echo "Error: PearCal.app not found in DerivedData" >&2
  exit 1
fi
echo "    App: $APP_PATH"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

for dev in "${DEVICES[@]}"; do
  NAME="${dev%%|*}"
  UDID="${dev##*|}"
  echo ""
  echo "==> Device: $NAME ($UDID)"

  # Boot (idempotent)
  xcrun simctl boot "$UDID" 2>/dev/null || true
  xcrun simctl bootstatus "$UDID" -b >/dev/null
  xcrun simctl install "$UDID" "$APP_PATH"

  # Pretty status bar: 9:41, full signal + battery
  xcrun simctl status_bar "$UDID" override \
    --time "9:41" \
    --dataNetwork wifi \
    --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 \
    --batteryState charged --batteryLevel 100

  for appearance in "${APPEARANCES[@]}"; do
    xcrun simctl ui "$UDID" appearance "$appearance"
    DARK=0; [ "$appearance" = "dark" ] && DARK=1
    mkdir -p "$OUT_DIR/$NAME/$appearance"
    for scene in "${SCENES[@]}"; do
      echo "    → $appearance scene $scene"
      xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
      xcrun simctl launch "$UDID" "$BUNDLE_ID" -screenshotScene "$scene" -screenshotDark "$DARK" >/dev/null
      sleep 5
      xcrun simctl io "$UDID" screenshot "$OUT_DIR/$NAME/$appearance/scene-$scene.png" >/dev/null 2>&1
    done
  done

  xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl status_bar "$UDID" clear
done

echo ""
echo "==> Done. PNGs in $OUT_DIR"
find "$OUT_DIR" -name "*.png" | sort

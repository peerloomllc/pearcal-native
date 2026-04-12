#!/usr/bin/env bash
# Android Play Store screenshot capture — runs on Linux.
# Boots each configured AVD, installs the debug APK, loops scenes ×
# appearances launching MainActivity with intent extras, and captures
# PNGs via adb exec-out screencap.
#
# Usage:
#   ./scripts/android-screenshots.sh              # full rebuild
#   SKIP_BUILD=1 ./scripts/android-screenshots.sh # skip gradle (fixtures-only)
#
# Output: metadata/android/screenshots/<avd>/<light|dark>/scene-N.png

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$REPO_ROOT/scripts/app.conf" ]; then
  set -a; source "$REPO_ROOT/scripts/app.conf"; set +a
fi
APP_ID="${ANDROID_APP_ID:-com.pearcal.debug}"
MAIN_ACTIVITY="${ANDROID_MAIN_ACTIVITY:-$APP_ID/com.pearcal.MainActivity}"
APK_PATH="${APK_PATH:-$REPO_ROOT/android/app/build/outputs/apk/debug/app-debug.apk}"

OUT_DIR="${OUT_DIR:-$REPO_ROOT/metadata/android/screenshots}"
SCENES=(1 2 3 4 5)
APPEARANCES=(light dark)

# AVDs from ANDROID_SCREENSHOT_AVDS (space-separated, set in scripts/app.conf)
# or fall back to a single phone. Play Store requires at least one phone.
read -ra AVDS <<<"${ANDROID_SCREENSHOT_AVDS:-Pixel_9_Pro}"

SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
EMULATOR="$SDK_ROOT/emulator/emulator"
ADB="$SDK_ROOT/platform-tools/adb"

# ── Build ──
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> Bundling UI"
  cd "$REPO_ROOT"
  npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
    --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle 2>&1 | tail -2

  echo "==> Building debug APK"
  (cd android && ./gradlew assembleDebug) 2>&1 | tail -3
fi

[ -f "$APK_PATH" ] || { echo "Error: APK not found at $APK_PATH" >&2; exit 1; }
echo "    APK: $APK_PATH"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

wait_for_boot() {
  local serial="$1"
  "$ADB" -s "$serial" wait-for-device
  local i=0
  until [ "$("$ADB" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    sleep 2; i=$((i+1)); [ $i -gt 90 ] && { echo "boot timeout" >&2; return 1; }
  done
  # Unlock and dismiss keyguard
  "$ADB" -s "$serial" shell input keyevent 82 >/dev/null 2>&1 || true
  "$ADB" -s "$serial" shell wm dismiss-keyguard >/dev/null 2>&1 || true
}

enable_demo_mode() {
  local serial="$1"
  "$ADB" -s "$serial" shell settings put global sysui_demo_allowed 1 >/dev/null
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command enter >/dev/null
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941 >/dev/null
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false >/dev/null
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 >/dev/null
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command network -e mobile show -e datatype none -e level 4 >/dev/null
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false >/dev/null
}

disable_demo_mode() {
  local serial="$1"
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command exit >/dev/null 2>&1 || true
}

for avd in "${AVDS[@]}"; do
  echo ""
  echo "==> AVD: $avd"

  # Kill any existing emulator instances to avoid AVD-in-use conflicts
  for s in $("$ADB" devices | awk '/^emulator-[0-9]+/ {print $1}'); do
    "$ADB" -s "$s" emu kill >/dev/null 2>&1 || true
  done
  sleep 3
  existing_serials=$("$ADB" devices | awk '/^emulator-[0-9]+/ {print $1}')
  "$EMULATOR" -avd "$avd" -no-snapshot -no-audio -no-boot-anim \
    -wipe-data -partition-size 4096 \
    -netdelay none -netspeed full >/tmp/emu-$avd.log 2>&1 &
  EMU_PID=$!

  # Find the new serial
  SERIAL=""
  for i in $(seq 1 60); do
    sleep 2
    current=$("$ADB" devices | awk '/^emulator-[0-9]+/ {print $1}')
    for s in $current; do
      if ! grep -qx "$s" <<<"$existing_serials"; then SERIAL="$s"; break; fi
    done
    [ -n "$SERIAL" ] && break
  done
  [ -n "$SERIAL" ] || { echo "emulator did not appear" >&2; kill $EMU_PID 2>/dev/null || true; exit 1; }
  echo "    Serial: $SERIAL"

  wait_for_boot "$SERIAL"
  sleep 3
  "$ADB" -s "$SERIAL" install -r "$APK_PATH" >/dev/null
  # Pre-grant runtime permissions so the app doesn't show system dialogs
  for perm in \
    android.permission.POST_NOTIFICATIONS \
    android.permission.CAMERA \
    android.permission.READ_MEDIA_IMAGES \
    android.permission.READ_EXTERNAL_STORAGE; do
    "$ADB" -s "$SERIAL" shell pm grant "$APP_ID" "$perm" >/dev/null 2>&1 || true
  done
  enable_demo_mode "$SERIAL"

  # Warm up: first cold launch is slow (Bare worklet bundle load). Run once
  # and wait so subsequent scene launches start from a warm filesystem cache.
  "$ADB" -s "$SERIAL" shell am start -n "$MAIN_ACTIVITY" >/dev/null
  sleep 20
  "$ADB" -s "$SERIAL" shell am force-stop "$APP_ID" >/dev/null

  for appearance in "${APPEARANCES[@]}"; do
    DARK_BOOL=false; DARK=0
    [ "$appearance" = "dark" ] && { DARK_BOOL=true; DARK=1; }
    if [ "$appearance" = "dark" ]; then
      "$ADB" -s "$SERIAL" shell cmd uimode night yes >/dev/null
    else
      "$ADB" -s "$SERIAL" shell cmd uimode night no >/dev/null
    fi
    # Let the uimode change settle, then warm-up launch in the new mode so
    # the first real capture below isn't racing an activity recreate.
    sleep 3
    "$ADB" -s "$SERIAL" shell am force-stop "$APP_ID" >/dev/null
    "$ADB" -s "$SERIAL" shell am start -n "$MAIN_ACTIVITY" >/dev/null
    sleep 15
    "$ADB" -s "$SERIAL" shell am force-stop "$APP_ID" >/dev/null
    mkdir -p "$OUT_DIR/$avd/$appearance"
    for scene in "${SCENES[@]}"; do
      echo "    → $appearance scene $scene"
      attempt=0
      while :; do
        attempt=$((attempt+1))
        "$ADB" -s "$SERIAL" shell am force-stop "$APP_ID" >/dev/null
        sleep 1
        "$ADB" -s "$SERIAL" shell am start -n "$MAIN_ACTIVITY" \
          --ei screenshotScene "$scene" --ez screenshotDark "$DARK_BOOL" >/dev/null
        sleep 20
        # Verify our activity is actually in the foreground. If not, retry
        # (launcher-home instead of app indicates a crash or race).
        top=$("$ADB" -s "$SERIAL" shell dumpsys activity activities \
              | tr -d '\r' | grep -E "ResumedActivity|mResumedActivity" | head -1)
        if echo "$top" | grep -q "$APP_ID/"; then break; fi
        if [ $attempt -ge 3 ]; then
          echo "      ! foreground check failed after $attempt attempts; capturing anyway"
          break
        fi
        echo "      ! not foreground (got: $top) — retrying"
      done
      "$ADB" -s "$SERIAL" exec-out screencap -p > "$OUT_DIR/$avd/$appearance/scene-$scene.png"
    done
  done

  "$ADB" -s "$SERIAL" shell am force-stop "$APP_ID" >/dev/null || true
  disable_demo_mode "$SERIAL"
  "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true
  wait $EMU_PID 2>/dev/null || true
done

echo ""
echo "==> Framing screenshots"
"$REPO_ROOT/scripts/frame-android-screenshots.sh"

echo ""
echo "==> Done. PNGs in $OUT_DIR"
find "$OUT_DIR" -name "*.png" | sort

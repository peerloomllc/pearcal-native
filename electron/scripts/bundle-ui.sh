#!/usr/bin/env bash
set -euo pipefail

# Bundles src/ui-desktop/main.jsx → electron/src/renderer/app-ui-electron.js for
# the Electron renderer. iife format matches the mobile bundle so the preload's
# window.ReactNativeWebView shim is in place before the UI bundle inits.
#
# NOTE the source: src/ui-DESKTOP, not src/ui. This comment said src/ui/main.jsx
# for a long time and was simply wrong, which mattered - it reads as "desktop
# runs the mobile UI" and so as "a mobile fix reaches desktop for free". It does
# not. The two are separate implementations of the calendar screens and have
# drifted; see proposals/2026-08-08-desktop-ui-parity.md (#163) for what the
# desktop is missing and what to do about each piece. The ENGINE is shared for
# real - electron/vendor/src/bare.js is byte-identical to src/bare.js via
# prepack.js - as is src/ui-shared/ and src/lib/.

cd "$(dirname "$0")/.."

# Read version from electron/package.json so SettingsModal + AboutModal
# render the actual ship version without a manual edit each release.
VERSION=$(node -p "require('./package.json').version")

../node_modules/.bin/esbuild ../src/ui-desktop/main.jsx \
  --bundle \
  --format=iife \
  --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" \
  --define:process.env.PEARCAL_VERSION=\"$VERSION\" \
  --outfile=src/renderer/app-ui-electron.js

echo "Built electron/src/renderer/app-ui-electron.js ($(du -h src/renderer/app-ui-electron.js | cut -f1))"

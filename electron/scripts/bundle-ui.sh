#!/usr/bin/env bash
set -euo pipefail

# Bundles src/ui/main.jsx → electron/src/renderer/app-ui-electron.js for the
# Electron renderer. iife format matches the mobile bundle so the preload's
# window.ReactNativeWebView shim is in place before the UI bundle inits.

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

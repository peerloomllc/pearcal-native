#!/usr/bin/env bash
# Build PearCal Desktop for Linux (AppImage + .deb + .rpm) on this Fedora
# box natively. Output goes to electron/dist/.
#
# Usage:  cd electron && npm run build:linux

set -euo pipefail

cd "$(dirname "$0")/.."

# Re-vendor src/bare.js + helpers into electron/vendor/src/ so the asar
# packed below contains current source. Without this, electron-builder
# uses whatever vendor/ was last refreshed by `npm install`'s postinstall
# hook — easy to ship a build with weeks-old bare.js.
node scripts/prepack.js

# Bundle the React UI before electron-builder packs it into the asar.
bash scripts/bundle-ui.sh

# electron-builder reads electron/package.json#build for config. --linux
# without arch defaults to current host arch (x64 here). Add --ia32 or
# --arm64 if cross-builds are ever needed.
./node_modules/.bin/electron-builder --linux --x64 --publish never

echo
echo "Built artifacts in electron/dist/:"
ls -lh dist/ 2>&1 | grep -E '\.(AppImage|deb|rpm)$' || true

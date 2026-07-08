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
#
# --publish never: electron-builder only emits the in-place auto-update
# manifest (latest-linux.yml — #105) during a real publish run, which needs a
# GH_TOKEN. We don't have one here, and the release flow (scripts/release.sh)
# generates latest-linux.yml itself from the final renamed AppImage and uploads
# it — so don't even try to publish (that only produced GH_TOKEN error noise
# and a stale latest-linux.yml that masked failures). Guard on the AppImage,
# the real build output, instead of the manifest.
./node_modules/.bin/electron-builder --linux --x64 --publish never
if ! ls dist/*.AppImage >/dev/null 2>&1; then
  echo "ERROR: no AppImage was produced — Linux build failed" >&2
  exit 1
fi

echo
echo "Built artifacts in electron/dist/:"
ls -lh dist/ 2>&1 | grep -E '\.(AppImage|deb|rpm)$' || true
echo
echo "Note: latest-linux.yml (auto-update manifest, #105) is generated and"
echo "uploaded by scripts/release.sh from the final renamed AppImage."

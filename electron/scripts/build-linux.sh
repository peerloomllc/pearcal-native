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
# --publish always (not never): electron-builder only writes the in-place
# auto-update manifest (latest-linux.yml — #105) during a publish run. Without
# a GH_TOKEN it generates the artifacts + manifest locally and then fails the
# upload step; we tolerate that and verify the manifest exists below so a real
# build failure still surfaces. Set GH_TOKEN to actually upload to the release.
./node_modules/.bin/electron-builder --linux --x64 --publish always || true
if [ ! -f dist/latest-linux.yml ]; then
  echo "ERROR: latest-linux.yml was not generated — auto-update would break" >&2
  exit 1
fi

echo
echo "Built artifacts in electron/dist/:"
ls -lh dist/ 2>&1 | grep -E '\.(AppImage|deb|rpm)$' || true
echo
echo "Auto-update manifest (UPLOAD THIS to the GitHub release too — #105):"
ls -lh dist/latest-linux.yml 2>&1 || true

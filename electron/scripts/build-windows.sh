#!/usr/bin/env bash
# Build PearCal Desktop for Windows (.exe NSIS installer) on this Linux box
# natively - no Windows VM. Output goes to electron/dist/.
#
# electron-builder cross-builds the Windows target from Linux: it downloads the
# win32-x64 Electron dist, packs the app (the holepunch native deps ship
# cross-platform prebuilds, so no win32 compile is needed), and compiles the
# NSIS installer with its bundled makensis. rcedit/signing steps run under wine.
# The installer is unsigned (Authenticode not yet wired; matches build-mac.sh's
# and the seeder's stance). Install-test the result on a real Windows box.
#
# Usage:  cd electron && npm run build:windows
#
# Requires locally: electron-builder (dev dep, installed), wine (Fedora:
#   sudo dnf install wine), and `npm install` already run in electron/.

set -euo pipefail

cd "$(dirname "$0")/.."

# Re-vendor src/bare.js + helpers into electron/vendor/src/ so the asar packed
# below contains current source (npm install's postinstall does this too, but
# an edit since then would otherwise ship stale). Mirrors build-linux.sh.
node scripts/prepack.js

# Re-apply the Autobase patches from the repo-root patches/ directory.
# These carry the #154 drain-spin repairs. They used to reach the phone build
# only: patch-package ran from the repo root against the ROOT node_modules,
# while electron/ keeps its own independent install that nothing patched. Both
# package.json files said "^7.25.1", so the two installs silently resolved to
# different Autobase versions and the desktop shipped 7.27.3 with none of the
# fixes. Both are pinned exact now, and this runs on every build so a stale
# node_modules cannot ship unpatched again.
npm run patch


# Bundle the React UI before electron-builder packs it into the asar.
bash scripts/bundle-ui.sh

# electron-builder reads electron/package.json#build for config.
#
# --publish never: electron-builder only emits the in-place auto-update
# manifest (latest.yml - #105) during a real publish run, which needs a
# GH_TOKEN. The release flow (scripts/release.sh) generates latest.yml itself
# from the final renamed .exe and uploads it, so don't publish from here (it
# only produced GH_TOKEN error noise). Guard on the .exe - the real build
# output - instead of the manifest.
./node_modules/.bin/electron-builder --win --x64 --publish never
if ! ls dist/*Setup*.exe >/dev/null 2>&1; then
  echo "ERROR: no NSIS installer was produced - Windows build failed" >&2
  exit 1
fi

echo
echo "Built artifacts in electron/dist/:"
ls -lh dist/ 2>&1 | grep -E 'Setup.*\.exe$' || true
echo
echo "Note: latest.yml (auto-update manifest, #105) is generated and uploaded"
echo "by scripts/release.sh from the final renamed .exe."

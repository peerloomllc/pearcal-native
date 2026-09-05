#!/usr/bin/env bash
# Build PearCal Desktop for Linux (AppImage + .deb + .rpm) on this Fedora
# box natively. Output goes to electron/dist/.
#
# Usage:  cd electron && npm run build:linux

set -euo pipefail

cd "$(dirname "$0")/.."

# Shared local prep: re-vendor, re-patch, re-bundle the UI. All three desktop
# build scripts need it and all three used to do it themselves, which meant
# three concurrent writes to electron/node_modules, electron/vendor/ and
# src/renderer/app-ui-electron.js when release.sh ran them at the same time.
# release.sh now does it once up front and sets SKIP_ELECTRON_PREP=1; running
# this script on its own still does it here.
if [ "${SKIP_ELECTRON_PREP:-0}" != "1" ]; then
  # Re-vendor src/bare.js + helpers into electron/vendor/src/ so the asar
  # packed below contains current source. Without this, electron-builder
  # uses whatever vendor/ was last refreshed by `npm install`'s postinstall
  # hook — easy to ship a build with weeks-old bare.js.
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
fi

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

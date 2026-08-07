#!/usr/bin/env bash
# Build PearCal Desktop for macOS (.dmg, signed but NOT notarized) by:
#   1. rsync source to Mac Mini
#   2. SSH there, unlock keychain, run electron-builder --mac (signs the .app
#      and packages a .dmg using the Developer ID Application identity)
#   3. rsync the .dmg back to electron/dist/
#
# Notarization is intentionally skipped: macOS Sequoia silently blocks
# outbound LAN connections from hardened-runtime apps that use raw sockets
# (Hyperswarm's bare-tcp/udp), and Apple's notary service requires hardened
# runtime. We trade notarization (first-launch "unidentified developer"
# warning, right-click → Open works around) for working LAN pairing on
# Mac. See feedback_macos_lan_gate_hardened_runtime.md for the full story.
#
# Usage:  cd electron && npm run build:mac
#
# Prerequisites (one-time, on the Mac Mini):
#   - Keychain `~/Library/Keychains/buildkey.keychain` provisioned with the
#     Developer ID Application cert (already done — Phase 0).

set -euo pipefail

cd "$(dirname "$0")/.."

MAC_HOST="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
REMOTE_DIR="~/peerloomllc/pearcal-native"

# Re-vendor src/bare.js + helpers into electron/vendor/src/ so the rsync
# below carries current source. Without this, the Mac packs whatever
# vendor/ was last refreshed by `npm install`'s postinstall hook.
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


# Bundle UI locally first so the source rsync up to the Mac is the
# deployable shape.
bash scripts/bundle-ui.sh

echo ">> Syncing source to $MAC_HOST:$REMOTE_DIR"
# --checksum guards against mtime-based skips of files we just rebuilt.
# Excludes mirror what mobile uses; add electron/dist/ explicitly so we
# don't push stale local builds up.
rsync -az --checksum \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='android' \
  --exclude='ios/build' \
  --exclude='electron/dist' \
  --exclude='electron/node_modules' \
  --exclude='desktop/node_modules' \
  ../ \
  "$MAC_HOST:$REMOTE_DIR/"

echo ">> Building signed .dmg on $MAC_HOST"
# set -o pipefail so the chained tail doesn't swallow electron-builder's
# non-zero exit code (same trap that bit the iOS build before).
ssh "$MAC_HOST" '
  set -euo pipefail
  export PATH="/opt/homebrew/bin:$PATH"
  export LANG=en_US.UTF-8
  # NOTE: this whole remote script is wrapped in single quotes by the ssh call
  # above, so these comments must contain NO apostrophes — an apostrophe would
  # terminate the quoted string and mangle the rest of the script.
  #
  # electron-builder dmg-builder shells out to "python" (dmgbuild) while laying
  # out the .dmg. Two traps here:
  #   1. Modern macOS (12+) removed the unversioned /usr/bin/python, so a bare
  #      "python" probe fails outright.
  #   2. The Homebrew python@3.14 build ships a pyexpat linked against a newer
  #      libexpat than the macOS system /usr/lib/libexpat.1.dylib, so the
  #      dmgbuild "import plistlib" step dies with
  #      "Symbol not found: _XML_SetAllocTrackerActivationThreshold" — which
  #      cascades into the misleading "unable to execute hdiutil" retry loop
  #      and kills the build.
  # The Apple /usr/bin/python3 has a working pyexpat, so prefer it and shim BOTH
  # python and python3 to it (ahead of Homebrew on PATH) for this build session
  # only. Fall back to whatever python3 is on PATH if the system one is gone.
  PY3="/usr/bin/python3"
  [ -x "$PY3" ] || PY3="$(command -v python3 || true)"
  if [ -n "$PY3" ]; then
    SHIM_DIR="$(mktemp -d)"
    ln -sf "$PY3" "$SHIM_DIR/python"
    ln -sf "$PY3" "$SHIM_DIR/python3"
    export PATH="$SHIM_DIR:$PATH"
  fi
  security unlock-keychain -p "" ~/Library/Keychains/buildkey.keychain
  cd ~/peerloomllc/pearcal-native/electron
  # Mac Mini keeps node_modules inside the project dir. Always run npm install:
  # it is near-instant when deps are already satisfied, and a plain
  # "[ -d node_modules ] || npm install" guard silently ships a stale tree when
  # package.json gains a new dep (e.g. electron-updater for #105 auto-update),
  # producing a packaged app that throws "Cannot find module" at launch.
  npm install --no-audit --no-fund
  # --mac without --arm64/--x64 builds for the current arch only; force a
  # universal-ish dual-arch dmg. electron-builder packs both into one .dmg.
  ./node_modules/.bin/electron-builder --mac --arm64 --x64 --publish never 2>&1 | tail -60
  # Explicitly verify the .dmg exists — guards against electron-builder
  # exiting 0 with no artifact.
  setopt nullglob 2>/dev/null || true
  dmgs=(dist/*.dmg)
  [ ${#dmgs[@]} -gt 0 ] || { echo "ERROR: electron-builder produced no .dmg"; exit 1; }
  ls -lh dist/*.dmg
'

# Notarization is intentionally skipped: macOS Sequoia silently blocks
# outbound LAN connections from hardened-runtime apps that use raw sockets
# (Hyperswarm's bare-tcp/udp), and Apple's notary service requires hardened
# runtime. We trade notarization (first-launch "unidentified developer"
# warning, right-click → Open works around) for working LAN pairing on
# Mac. Revisit when Hyperswarm's macOS path uses Network.framework, or
# when we route everything through a public-IP relay.
echo ">> Skipping notarization (hardenedRuntime is off — required for LAN pairing)"

echo ">> Pulling unstapled .dmg back to electron/dist/"
mkdir -p dist
rsync -az "$MAC_HOST:$REMOTE_DIR/electron/dist/*.dmg" dist/

echo
echo "Done. Artifacts in electron/dist/:"
ls -lh dist/*.dmg 2>&1

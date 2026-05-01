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
  security unlock-keychain -p "" ~/Library/Keychains/buildkey.keychain
  cd ~/peerloomllc/pearcal-native/electron
  # Mac Mini keeps node_modules inside the project dir; reinstall if missing
  # but otherwise reuse to keep iterations fast.
  [ -d node_modules ] || npm install --no-audit --no-fund
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

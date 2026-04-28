#!/usr/bin/env bash
# Build PearCal Desktop for macOS (.dmg, signed + notarized) by:
#   1. rsync source to Mac Mini
#   2. SSH there, unlock keychain, run electron-builder --mac (signs the .app
#      and packages a .dmg using the Developer ID Application identity)
#   3. SSH there, run xcrun notarytool submit + stapler staple
#   4. rsync the stapled .dmg back to electron/dist/
#
# Mirrors the pattern in scripts/release.sh / scripts/ios-appstore.sh — same
# Mac Mini host, same buildkey.keychain unlock dance, same pearcal-notary
# notarytool keychain profile. See:
#   reference_macos_signing.md     — Developer ID Application identity SHA1
#   reference_macos_notarization.md — pearcal-notary keychain profile setup
#
# Usage:  cd electron && npm run build:mac
#
# Prerequisites (one-time, on the Mac Mini):
#   - Keychain `~/Library/Keychains/buildkey.keychain` provisioned with the
#     Developer ID Application cert (already done — Phase 0).
#   - notarytool keychain profile `pearcal-notary` stored in the keychain
#     (already done — Phase 0).

set -euo pipefail

cd "$(dirname "$0")/.."

MAC_HOST="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
REMOTE_DIR="~/peerloomllc/pearcal-native"

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
  set -o pipefail
  export PATH="/opt/homebrew/bin:$PATH"
  export LANG=en_US.UTF-8
  security unlock-keychain -p "" ~/Library/Keychains/buildkey.keychain
  cd ~/peerloomllc/pearcal-native/electron
  # Mac Mini keeps node_modules inside the project dir; reinstall if missing
  # but otherwise reuse to keep iterations fast.
  [ -d node_modules ] || npm install --no-audit --no-fund
  # --mac without --arm64/--x64 builds for the current arch only; force a
  # universal-ish dual-arch dmg. electron-builder packs both into one .dmg.
  ./node_modules/.bin/electron-builder --mac --arm64 --x64 --publish never 2>&1 | tail -40
  ls -lh dist/*.dmg
'

echo ">> Notarizing the .dmg"
ssh "$MAC_HOST" '
  set -o pipefail
  cd ~/peerloomllc/pearcal-native/electron
  DMG=$(ls -t dist/*.dmg | head -1)
  echo "Submitting $DMG to notarytool..."
  xcrun notarytool submit "$DMG" \
    --keychain-profile pearcal-notary \
    --keychain ~/Library/Keychains/buildkey.keychain \
    --wait
  echo "Stapling notarization ticket..."
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
'

echo ">> Pulling stapled .dmg back to electron/dist/"
mkdir -p dist
rsync -az "$MAC_HOST:$REMOTE_DIR/electron/dist/*.dmg" dist/

echo
echo "Done. Artifacts in electron/dist/:"
ls -lh dist/*.dmg 2>&1

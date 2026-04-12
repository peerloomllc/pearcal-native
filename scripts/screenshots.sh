#!/usr/bin/env bash
# Orchestrator — run from Linux. Bundles UI, syncs repo to Mac Mini,
# runs the simulator screenshot driver, and pulls PNGs back into
# metadata/ios/screenshots/.
#
# Usage:
#   ./scripts/screenshots.sh            # full rebuild
#   SKIP_BUILD=1 ./scripts/screenshots.sh  # skip xcodebuild (fixtures-only changes)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAC_MINI="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
MAC_REPO="peerloomllc/pearcal-native"  # relative to remote $HOME
OUT_DIR="$REPO_ROOT/metadata/ios/screenshots"

echo "==> Bundling UI"
cd "$REPO_ROOT"
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle 2>&1 | tail -2

echo "==> Syncing to $MAC_MINI"
rsync -az --checksum --exclude='.git' --exclude='node_modules' --exclude='android' \
  "$REPO_ROOT/" "$MAC_MINI:$MAC_REPO/"

echo "==> Running driver on $MAC_MINI"
ssh "$MAC_MINI" "cd $MAC_REPO && ${SKIP_BUILD:+SKIP_BUILD=1 }./scripts/ios-screenshots.sh"

echo "==> Pulling PNGs into $OUT_DIR"
mkdir -p "$OUT_DIR"
rsync -az --delete "$MAC_MINI:$MAC_REPO/metadata/ios/screenshots/" "$OUT_DIR/"

echo ""
echo "==> Done. Screenshots in $OUT_DIR"
find "$OUT_DIR" -name "*.png" | sort

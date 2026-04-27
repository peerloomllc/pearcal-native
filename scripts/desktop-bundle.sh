#!/usr/bin/env bash
# Build the desktop UI bundle (ESM) from src/ui/main.jsx.
# Output: desktop/app-ui-desktop.mjs (gitignored — build artifact).
#
# Mobile builds use --format=iife to a different path (assets/app-ui.bundle).
# Both bundle from the same React source; only the output format differs.
set -euo pipefail

cd "$(dirname "$0")/.."

npx esbuild src/ui/main.jsx \
  --bundle \
  --format=esm \
  --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" \
  --outfile=desktop/app-ui-desktop.mjs

echo "Built desktop/app-ui-desktop.mjs ($(du -h desktop/app-ui-desktop.mjs | cut -f1))"

# Bundle src/bare.js for Pear's bare worker.
#
# Embed native addon prebuilds for every desktop host in the bundle so the
# same artifact runs on macOS, Linux, and Windows. (Mobile uses --linked and
# resolves prebuilds from the platform shell; Pear's dev mode has no host-side
# linked-addon registry, so prebuilds must be self-contained inside the bundle.)
node_modules/.bin/bare-pack --preset desktop src/bare.js -o desktop/bare-desktop.bundle

echo "Built desktop/bare-desktop.bundle ($(du -h desktop/bare-desktop.bundle | cut -f1))"

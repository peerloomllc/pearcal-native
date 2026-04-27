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

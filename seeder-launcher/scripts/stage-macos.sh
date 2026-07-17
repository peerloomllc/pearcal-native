#!/usr/bin/env bash
# Stage a macOS PearCal blind-seeder payload. Thin wrapper over the arch-generic
# scripts/stage-payload.sh — defaults BARE_HOST to darwin-arm64. Cross-stages
# from Linux (every native addon ships darwin prebuilds; bare-runtime-darwin-*
# is npm-packable), so no Mac is needed to produce a launchd payload — only the
# signed .pkg build (Phase C) runs on a Mac.
#
# Usage:
#   BARE_HOST=darwin-arm64 OUT_DIR=/abs/payload  bash scripts/stage-macos.sh
#   BARE_HOST=darwin-x64 …
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
export BARE_HOST="${BARE_HOST:-darwin-arm64}"
case "$BARE_HOST" in
  darwin-arm64|darwin-x64) ;;
  *) echo "stage-macos: BARE_HOST must be darwin-arm64|darwin-x64 (got '$BARE_HOST'); use stage-linux.sh for linux" >&2; exit 1 ;;
esac
exec bash "$HERE/stage-payload.sh"

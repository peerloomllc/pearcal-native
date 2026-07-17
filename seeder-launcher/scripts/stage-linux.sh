#!/usr/bin/env bash
# Stage a Linux PearCal blind-seeder payload. Thin wrapper over the arch-generic
# scripts/stage-payload.sh — defaults BARE_HOST to linux-x64. Kept as a named
# entry point so deploy-linux-ssh.sh / deploy-user-ssh.sh call it unchanged
# (same BARE_HOST/OUT_DIR env interface).
#
# Usage:
#   BARE_HOST=linux-x64  OUT_DIR=/abs/payload  bash scripts/stage-linux.sh
#   BARE_HOST=linux-arm64 …
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
export BARE_HOST="${BARE_HOST:-linux-x64}"
case "$BARE_HOST" in
  linux-x64|linux-arm64) ;;
  *) echo "stage-linux: BARE_HOST must be linux-x64|linux-arm64 (got '$BARE_HOST'); use stage-macos.sh for darwin" >&2; exit 1 ;;
esac
exec bash "$HERE/stage-payload.sh"

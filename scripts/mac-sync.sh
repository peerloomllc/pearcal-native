#!/usr/bin/env bash
# Sync this repo's SOURCE to the Mac Mini. The one way to do it (TODO #168).
#
# Usage: ./scripts/mac-sync.sh [--no-checksum] [--rsync-path PATH]
#
# Env:
#   MAC_MINI_HOST       default Tims-Mac-mini.local
#   MAC_MINI_REPO_PATH  default peerloomllc/pearcal-native (relative to ~)
#   MAX_SYNC_MB         default 250, the pre-flight ceiling
#
# Why this exists: four call sites (screenshots.sh, release.sh, build-mac.sh and
# the block in CLAUDE.md) each kept their own hand-written exclude list. The repo
# then grew electron/dist, seeder-launcher/dist and 4.4 GB of loose installers,
# which none of the four knew about, so every one of them would walk 18 GB to
# deliver 18 MB. Excludes now live in ONE file and a pre-flight refuses to start
# a sync that has gone wrong rather than hanging for half an hour.
#
# --checksum is ON by default and should stay that way: rsync's default
# size+mtime check once skipped a rebuilt bundle and shipped a stale IPA. It is
# only affordable because the exclude list keeps the candidate set small, which
# is exactly what the pre-flight enforces.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MAC_HOST="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
MAC_REPO="${MAC_MINI_REPO_PATH:-peerloomllc/pearcal-native}"
MAX_SYNC_MB="${MAX_SYNC_MB:-250}"

CHECKSUM="--checksum"
RSYNC_PATH_ARG=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-checksum) CHECKSUM=""; shift ;;
    # release.sh needs this: the Mac's Homebrew rsync is not on the default
    # non-interactive PATH.
    --rsync-path) RSYNC_PATH_ARG=(--rsync-path="$2"); shift 2 ;;
    *) echo "mac-sync: unknown argument: $1" >&2; exit 2 ;;
  esac
done

node "$SCRIPT_DIR/lib/sync-preflight.js" "$REPO_ROOT" --max-mb "$MAX_SYNC_MB"

echo "    Syncing source to $MAC_HOST:$MAC_REPO"
rsync -az $CHECKSUM "${RSYNC_PATH_ARG[@]}" \
  --exclude-from="$SCRIPT_DIR/mac-sync-excludes.txt" \
  "$REPO_ROOT/" "$MAC_HOST:$MAC_REPO/"
echo "    Sync complete."

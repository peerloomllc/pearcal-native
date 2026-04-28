#!/usr/bin/env bash
# Build PearCal Desktop for Windows (.exe NSIS installer) by SSH-ing into
# the Windows VM (same VM PearGuard uses for its Windows build pipeline).
#
# NOT YET IMPLEMENTED — placeholder so the script exists alongside
# build-linux.sh and build-mac.sh. Wire up when we're ready to ship Win.
#
# Implementation sketch (when ready):
#   1. rsync source to Windows VM via SSH (same pattern as build-mac.sh)
#   2. SSH there, run `npm install` if needed
#   3. Run `electron-builder --win --x64 --publish never` natively in the
#      VM (electron-builder generates an unsigned NSIS .exe by default;
#      add code-signing with a Windows Authenticode cert when we have one)
#   4. rsync the .exe back to electron/dist/
#
# Cross-build from Linux via Wine is possible (electron-builder supports
# it) but Authenticode signing requires the Windows VM, so we standardize
# on the VM path to keep the signing story single-track.

set -euo pipefail

echo "build-windows.sh: not yet implemented" >&2
echo "See script header for the planned implementation." >&2
exit 1

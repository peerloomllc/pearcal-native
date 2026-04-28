#!/usr/bin/env bash
# Build PearCal Desktop for Windows (.exe NSIS installer) by SSH-ing into
# the Windows 11 VM (same VM PearGuard uses for its Windows build pipeline).
#
# Usage:  cd electron && npm run build:windows
#
# Output: electron/dist/PearCal Setup <version>.exe
#         (unsigned — Authenticode signing not yet wired; matches PearGuard)
#
# Requirements:
#   - Key-based SSH to the VM (defaults to ben@192.168.50.157; override via
#     WINDOWS_VM_HOST / WINDOWS_VM_REPO_PATH env vars).
#   - iconv + base64 locally; tar + powershell + npm on the VM.

set -euo pipefail

cd "$(dirname "$0")/.."

WIN_HOST="${WINDOWS_VM_HOST:-ben@192.168.50.157}"
WIN_PATH="${WINDOWS_VM_REPO_PATH:-pearcal-release-windows}"

echo "==> Preflight: ssh $WIN_HOST"
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$WIN_HOST" exit 2>/dev/null; then
  echo "    ERROR: cannot reach $WIN_HOST via key-based SSH." >&2
  exit 1
fi
echo "    OK"

# Bundle the React UI before electron-builder packs it into the asar.
bash scripts/bundle-ui.sh

# Pack only what the Windows build needs. The repo also contains
# android/, ios/, .git/, docs/, AAB/APK artifacts etc. that the Windows
# build doesn't need (and can blow the tarball up to gigabytes).
RELEASE_TAR=$(mktemp --suffix=.tar.gz)
trap 'rm -f "$RELEASE_TAR"' EXIT
echo "==> Packing source tree..."
(
  cd ..
  tar -czf "$RELEASE_TAR" \
    --exclude='electron/node_modules' \
    --exclude='electron/dist' \
    --exclude='electron/vendor' \
    src \
    electron
)
TAR_SIZE=$(du -sh "$RELEASE_TAR" | cut -f1)
echo "    Tarball: $TAR_SIZE"

echo "==> Copying to ${WIN_HOST}:${WIN_PATH}.tar.gz ..."
scp -q "$RELEASE_TAR" "${WIN_HOST}:${WIN_PATH}.tar.gz"

echo "==> Running remote build (this takes a few minutes)..."
# The wipe uses robocopy /MIR against an empty dir: plain Remove-Item -Recurse
# fails when prior runs left paths longer than Windows' MAX_PATH (260 chars),
# e.g. electron-builder NSIS staging dirs.
PS_BLOCK=$(cat <<PSEOF
\$ErrorActionPreference = 'Stop'
\$target = Join-Path \$HOME '$WIN_PATH'
\$tarball = Join-Path \$HOME '$WIN_PATH.tar.gz'
if (Test-Path -LiteralPath \$target) {
  \$empty = New-Item -ItemType Directory -Force -Path (Join-Path \$env:TEMP ("wipe-" + [guid]::NewGuid()))
  try {
    & robocopy \$empty.FullName \$target /MIR /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    Remove-Item -LiteralPath \$target -Force -Recurse
  } finally {
    Remove-Item -LiteralPath \$empty.FullName -Force -Recurse -ErrorAction SilentlyContinue
  }
}
New-Item -ItemType Directory -Path \$target | Out-Null
tar -xzf \$tarball -C \$target
Remove-Item -LiteralPath \$tarball
& (Join-Path \$target 'electron\\scripts\\windows-remote-build.ps1') -RepoPath \$target
PSEOF
)
PS_B64=$(printf '%s' "$PS_BLOCK" | iconv -t UTF-16LE | base64 -w0)
ssh "$WIN_HOST" "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $PS_B64"

echo "==> Retrieving installer to electron/dist/ ..."
mkdir -p dist
scp -q "${WIN_HOST}:${WIN_PATH}/electron/dist/PearCal*Setup*.exe" "dist/"

echo
echo "Done. Artifacts in electron/dist/:"
ls -lh dist/*Setup*.exe 2>&1

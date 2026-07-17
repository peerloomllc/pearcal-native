#!/usr/bin/env bash
# Build the Windows installer for the PearCal seeder-launcher — ON LINUX.
#
# Cross-stages the win32-x64 payload (bare.exe via npm pack, win32 addon
# prebuilds, bare-packed worklet, the flat Node host) + a bundled Node.js, then
# compiles the NSIS installer with makensis. No Windows build host needed (the
# .exe is unsigned); this mirrors how the macOS payload is cross-built on Linux.
# Install-test the result on a real Windows box.
#
# Usage:   scripts/build-windows.sh            (VERSION env, default 0.1.0)
# Env:     VERSION       package version stamped into the service + installer
#          NODE_VERSION  bundled Node.js (default 22.20.0)
#          MAKENSIS      path to makensis (default: autodetect)
#
# Requires locally: makensis (Fedora: sudo dnf install mingw32-nsis), curl,
# python3 (zip extract), magick/convert (icon), and `npm install` already run.
set -euo pipefail

cd "$(dirname "$0")/.."
LAUNCHER=$(pwd)
REPO=$(cd "$LAUNCHER/.." && pwd)
SCRIPT_DIR="$LAUNCHER/scripts"
WINDIR="$LAUNCHER/installer/windows"

VERSION="${VERSION:-0.1.0}"; VERSION="${VERSION#v}"
NODE_VERSION="${NODE_VERSION:-22.20.0}"
BARE_HOST=win32-x64

MAKENSIS="${MAKENSIS:-$(command -v makensis || command -v mingw32-makensis || true)}"
if [ -z "$MAKENSIS" ]; then
  echo "build-windows: makensis not found. Install NSIS (Fedora: sudo dnf install mingw32-nsis)." >&2
  exit 1
fi

echo "=== building Windows installer  version=$VERSION  (makensis: $MAKENSIS) ==="

STAGE="$LAUNCHER/dist/windows/stage"
PAYLOAD="$STAGE/payload"
rm -rf "$STAGE"
mkdir -p "$PAYLOAD"

# 1. Core payload (bare.exe + worklet bundle + win32 prebuilds + flat host +
#    qrcode + brand + fonts) via the shared arch-generic staging engine.
BARE_HOST="$BARE_HOST" OUT_DIR="$PAYLOAD" bash "$SCRIPT_DIR/stage-payload.sh"
rm -f "$PAYLOAD/run.sh"  # bash convenience runner; unused on Windows (the service runs node.exe)

# 2. Bundled Node.js for Windows — official build from nodejs.org, cached.
NODE_PKG="node-v${NODE_VERSION}-win-x64"
NODE_CACHE="$LAUNCHER/dist/cache/$NODE_PKG"
if [ ! -f "$NODE_CACHE/node.exe" ]; then
  mkdir -p "$LAUNCHER/dist/cache"
  URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PKG}.zip"
  echo "--> downloading $URL"
  curl -fsSL "$URL" -o "$LAUNCHER/dist/cache/${NODE_PKG}.zip"
  python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" \
    "$LAUNCHER/dist/cache/${NODE_PKG}.zip" "$LAUNCHER/dist/cache"
  rm -f "$LAUNCHER/dist/cache/${NODE_PKG}.zip"
fi
[ -f "$NODE_CACHE/node.exe" ] || { echo "build-windows: node.exe missing after extract" >&2; exit 1; }
cp "$NODE_CACHE/node.exe" "$PAYLOAD/node.exe"

# 3. Windows installer resources: the service wrapper + dashboard opener + icon.
cp "$WINDIR/nssm.exe"    "$PAYLOAD/nssm.exe"
cp "$WINDIR/open-ui.vbs" "$PAYLOAD/open-ui.vbs"
ICON_SRC="$REPO/assets/images/icon.png"
if command -v magick >/dev/null 2>&1; then
  magick "$ICON_SRC" -define icon:auto-resize=256,128,64,48,32,16 "$PAYLOAD/AppIcon.ico"
elif command -v convert >/dev/null 2>&1; then
  convert "$ICON_SRC" -define icon:auto-resize=256,128,64,48,32,16 "$PAYLOAD/AppIcon.ico"
else
  echo "build-windows: no imagemagick to build AppIcon.ico" >&2; exit 1
fi

# 4. Compile the NSIS installer. installer.nsi expects payload/ beside it.
cp "$WINDIR/installer.nsi" "$STAGE/installer.nsi"
( cd "$STAGE" && "$MAKENSIS" "-DVERSION=$VERSION" installer.nsi )

# 5. Collect the output + sha256 sidecar.
OUT_DIR="$LAUNCHER/dist/windows"
EXE_NAME="PearCalSeeder-Setup-${VERSION}.exe"
mv -f "$STAGE/$EXE_NAME" "$OUT_DIR/$EXE_NAME"
( cd "$OUT_DIR" && sha256sum "$EXE_NAME" > "${EXE_NAME}.sha256" )

echo "=== built  $OUT_DIR/$EXE_NAME  ($(du -sh "$OUT_DIR/$EXE_NAME" | cut -f1)) ==="
echo "    sha256  $(cut -d' ' -f1 < "$OUT_DIR/$EXE_NAME.sha256")"

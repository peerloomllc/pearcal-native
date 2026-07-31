#!/usr/bin/env bash
# Build an AppImage for the PearCal seeder-launcher.
#
# The AppImage is a single portable file. Run it directly to start the seeder in
# the foreground (CLI / debugging), double-click it to set up a background
# systemd user service + open the dashboard, or pass --install-service /
# --uninstall-service (see installer/linux/AppRun).
#
# Usage:   scripts/build-appimage-linux.sh
# Env:     ARCH      x86_64 | aarch64   (default x86_64)
#          VERSION   version embedded in AppImage + wrapper (default 0.1.0)
#
# appimagetool and the per-arch AppImage runtimes are downloaded once and cached
# under dist/cache. appimagetool is run with --appimage-extract-and-run so the
# build host needs no FUSE.
set -euo pipefail

cd "$(dirname "$0")/.."
LAUNCHER=$(pwd)
REPO=$(cd "$LAUNCHER/.." && pwd)
SCRIPT_DIR="$LAUNCHER/scripts"
INSTALLER="$LAUNCHER/installer/linux"
CACHE="$LAUNCHER/dist/cache"

ARCH="${ARCH:-x86_64}"
VERSION="${VERSION:-0.1.0}"; VERSION="${VERSION#v}"

case "$ARCH" in
  x86_64)  BARE_HOST=linux-x64 ;;
  aarch64) BARE_HOST=linux-arm64 ;;
  *) echo "build-appimage: ARCH must be x86_64 or aarch64 (got '$ARCH')" >&2; exit 1 ;;
esac

echo "=== building AppImage  arch=$ARCH  version=$VERSION ==="

# --- fetch appimagetool + the target-arch runtime --------------------------
mkdir -p "$CACHE"
APPIMAGETOOL="$CACHE/appimagetool-x86_64.AppImage"
if [ ! -x "$APPIMAGETOOL" ]; then
  URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
  echo "--> downloading appimagetool"
  curl -fSL "$URL" -o "$APPIMAGETOOL"
  chmod +x "$APPIMAGETOOL"
fi
RUNTIME="$CACHE/runtime-$ARCH"
if [ ! -f "$RUNTIME" ]; then
  URL="https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-$ARCH"
  echo "--> downloading AppImage runtime ($ARCH)"
  curl -fSL "$URL" -o "$RUNTIME"
fi

# --- assemble the AppDir ----------------------------------------------------
APPDIR="$LAUNCHER/dist/linux/AppDir-$ARCH"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/lib/pearcal-seeder"

# Stage the flat payload (bundled node + wrapper) into usr/lib/pearcal-seeder.
VERSION="$VERSION" BARE_HOST="$BARE_HOST" OUT_DIR="$APPDIR/usr/lib/pearcal-seeder" \
  bash "$SCRIPT_DIR/stage-linux-bundled.sh"

cp "$INSTALLER/AppRun"                  "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"
cp "$INSTALLER/pearcal-seeder.service"  "$APPDIR/pearcal-seeder.service"
cp "$INSTALLER/pearcal-seeder.desktop"  "$APPDIR/pearcal-seeder.desktop"

# Icon: AppImage wants <Icon>.png at the AppDir root (+ .DirIcon) and, for clean
# desktop integration, a copy under usr/share/icons.
ICON_SRC="$REPO/assets/images/icon.png"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$APPDIR/pearcal-seeder.png"
  cp "$ICON_SRC" "$APPDIR/.DirIcon"
  mkdir -p "$APPDIR/usr/share/icons/hicolor/256x256/apps"
  cp "$ICON_SRC" "$APPDIR/usr/share/icons/hicolor/256x256/apps/pearcal-seeder.png"
else
  echo "warning: $ICON_SRC missing; AppImage will have a generic icon"
fi

# --- pack -------------------------------------------------------------------
OUT_DIR="$LAUNCHER/dist/linux"
# The version belongs IN the name, like every other seeder installer. The update
# check reads a candidate installer's version out of its filename (a release may
# carry a seeder older than its own tag when nothing under the seeder changed),
# and an unversioned AppImage would fall back to the tag and re-offer itself
# forever. It also stops a failed build's leftover from being re-shipped under a
# later tag, which release.sh previously had to guard against by hand.
APPIMAGE="$OUT_DIR/PearCalSeeder-$VERSION-$ARCH.AppImage"
mkdir -p "$OUT_DIR"
rm -f "$APPIMAGE"
echo "--> appimagetool"
ARCH="$ARCH" VERSION="$VERSION" "$APPIMAGETOOL" --appimage-extract-and-run \
  --runtime-file "$RUNTIME" "$APPDIR" "$APPIMAGE"
chmod +x "$APPIMAGE"
( cd "$OUT_DIR" && sha256sum "$(basename "$APPIMAGE")" > "$(basename "$APPIMAGE").sha256" )

echo "=== built  $APPIMAGE  ($(du -sh "$APPIMAGE" | cut -f1)) ==="
echo "    sha256  $(cut -d' ' -f1 < "$APPIMAGE.sha256")"

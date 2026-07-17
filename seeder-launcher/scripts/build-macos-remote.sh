#!/usr/bin/env bash
# Build the macOS seeder .pkg(s) from a non-Mac host by driving the Mac mini over
# SSH. The Mac-only steps (npm install for darwin prebuilds, pkgbuild,
# productbuild, sips/iconutil, codesign) all run remotely via build-pkg-macos.sh;
# this wrapper ships the source, runs that per arch, and retrieves the .pkgs.
#
# Builds BOTH arm64 and x64 by default (an arm64 Mac cross-builds x64 — every
# native addon ships both darwin prebuilds). Set SEEDER_PKG_ARCHES to override.
#
# Usage:   scripts/build-macos-remote.sh [version]      (default 0.1.0)
# Env:
#   MAC_MINI_HOST        ssh target (default Tims-Mac-mini.local)
#   MAC_SEEDER_BUILD_DIR build dir name on the Mac (default pearcal-seeder-macos)
#   SEEDER_PKG_ARCHES    space-separated arches (default "arm64 x64")
#   APP_SIGN_ID PKG_SIGN_ID   forwarded to build-pkg-macos.sh (unsigned if unset)
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LAUNCHER_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$LAUNCHER_DIR/.." && pwd)

VERSION="${1:-0.1.0}"; VERSION="${VERSION#v}"
MAC_HOST="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
MAC_DIR="${MAC_SEEDER_BUILD_DIR:-pearcal-seeder-macos}"
ARCHES="${SEEDER_PKG_ARCHES:-arm64 x64}"

echo "==> Preflight: ssh $MAC_HOST"
ssh -o ConnectTimeout=6 -o BatchMode=yes "$MAC_HOST" exit 2>/dev/null || { echo "    ERROR: cannot reach $MAC_HOST via key-based SSH." >&2; exit 1; }

# Pack the source the build needs (no node_modules — the Mac runs npm install).
RELEASE_TAR=$(mktemp --suffix=.tar.gz)
trap 'rm -f "$RELEASE_TAR"' EXIT
echo "==> Packing source tree..."
tar -czf "$RELEASE_TAR" -C "$REPO_ROOT" \
  --exclude='seeder-launcher/node_modules' \
  --exclude='seeder-launcher/dist' \
  package.json package-lock.json src assets seeder-launcher
echo "    Tarball: $(du -sh "$RELEASE_TAR" | cut -f1)"

echo "==> Copying to ${MAC_HOST}:${MAC_DIR}.tar.gz ..."
scp -q "$RELEASE_TAR" "${MAC_HOST}:${MAC_DIR}.tar.gz"

echo "==> Remote build on $MAC_HOST for arches: $ARCHES (several minutes)..."
ssh "$MAC_HOST" "bash -lc 'cat > /tmp/${MAC_DIR}-build.sh && bash /tmp/${MAC_DIR}-build.sh'" <<REMOTE
set -euo pipefail
target="\$HOME/${MAC_DIR}"
rm -rf "\$target"; mkdir -p "\$target"
tar -xzf "\$HOME/${MAC_DIR}.tar.gz" -C "\$target"
rm -f "\$HOME/${MAC_DIR}.tar.gz"
cd "\$target"
npm install --no-audit --no-fund --loglevel=error
# npm can leave the bare-runtime binaries without the exec bit.
for _b in node_modules/bare-runtime-darwin-*/bin/bare; do [ -f "\$_b" ] && chmod +x "\$_b"; done
for A in ${ARCHES}; do
  echo "--- build-pkg-macos.sh arch=\$A ---"
  VERSION='${VERSION}' SEEDER_PKG_ARCH="\$A" \
  APP_SIGN_ID='${APP_SIGN_ID:-}' PKG_SIGN_ID='${PKG_SIGN_ID:-}' \
    bash seeder-launcher/scripts/build-pkg-macos.sh
done
REMOTE

OUT_DIR="${LAUNCHER_DIR}/dist/macos"
mkdir -p "$OUT_DIR"
for A in $ARCHES; do
  PKG="PearCalSeeder-${VERSION}-${A}.pkg"
  echo "==> Retrieving ${PKG} ..."
  scp -q "${MAC_HOST}:${MAC_DIR}/seeder-launcher/dist/macos-${A}/${PKG}" "${OUT_DIR}/${PKG}"
  ( cd "$OUT_DIR" && sha256sum "$PKG" > "${PKG}.sha256" )
  echo "    ${OUT_DIR}/${PKG}  ($(du -sh "${OUT_DIR}/${PKG}" | cut -f1))  sha256 $(cut -d' ' -f1 < "${OUT_DIR}/${PKG}.sha256")"
done

echo ""
echo "==> Done. Install (unsigned) on a Mac with:"
echo "    sudo installer -allowUntrusted -pkg <pkg> -target /"

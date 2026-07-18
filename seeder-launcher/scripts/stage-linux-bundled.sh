#!/usr/bin/env bash
# Stage a self-contained Linux seeder payload for the AppImage / .deb builders.
#
# Layers a BUNDLED Node.js + a launch wrapper on top of scripts/stage-linux.sh,
# so the payload runs on any glibc Linux box with no system `node` (the SSH
# deploys can assume node; a distributed AppImage/.deb cannot — same reason the
# macOS .pkg bundles Node). Produces the flat layout the wrapper + host expect:
#   <OUT>/bare                   Bare runtime (target arch)
#   <OUT>/node                   bundled Node.js (target arch)
#   <OUT>/worklet/seed.bundle    bare-packed src/seed.js + addon prebuilds
#   <OUT>/host/…                 the Node launcher host
#   <OUT>/pearcal-seeder         launch wrapper (bundled node; bakes port+version)
#
# Env:
#   BARE_HOST      linux-x64 | linux-arm64   (default linux-x64)
#   OUT_DIR        absolute payload path      (required)
#   VERSION        baked into the wrapper's PEARCAL_SEEDER_VERSION (default 0.1.0)
#   NODE_VERSION   bundled Node.js            (default 22.20.0)
set -euo pipefail

cd "$(dirname "$0")/.."
LAUNCHER=$(pwd)
SCRIPT_DIR="$LAUNCHER/scripts"

BARE_HOST="${BARE_HOST:-linux-x64}"
OUT_DIR="${OUT_DIR:?OUT_DIR must be an absolute payload path}"
VERSION="${VERSION:-0.1.0}"; VERSION="${VERSION#v}"
NODE_VERSION="${NODE_VERSION:-22.20.0}"

case "$BARE_HOST" in
  linux-x64)   NODE_ARCH=x64 ;;
  linux-arm64) NODE_ARCH=arm64 ;;
  *) echo "stage-linux-bundled: BARE_HOST must be linux-x64|linux-arm64 (got '$BARE_HOST')" >&2; exit 1 ;;
esac

# 1. Stage the flat worklet + host payload via the shared arch-generic engine.
BARE_HOST="$BARE_HOST" OUT_DIR="$OUT_DIR" bash "$SCRIPT_DIR/stage-linux.sh"
# The bundled-node wrapper below replaces run.sh (which assumes a system node).
rm -f "$OUT_DIR/run.sh"

# 2. Bundled Node.js — official static build from nodejs.org, cached across builds.
NODE_PKG="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_CACHE="$LAUNCHER/dist/cache/$NODE_PKG"
if [ ! -x "$NODE_CACHE/bin/node" ]; then
  mkdir -p "$LAUNCHER/dist/cache"
  URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PKG}.tar.xz"
  echo "--> downloading $URL"
  curl -fsSL "$URL" -o "$LAUNCHER/dist/cache/${NODE_PKG}.tar.xz"
  tar -xJf "$LAUNCHER/dist/cache/${NODE_PKG}.tar.xz" -C "$LAUNCHER/dist/cache"
  rm -f "$LAUNCHER/dist/cache/${NODE_PKG}.tar.xz"
fi
cp "$NODE_CACHE/bin/node" "$OUT_DIR/node"; chmod +x "$OUT_DIR/node"

# 3. Launch wrapper: the AppImage AppRun / the .deb systemd unit run this. It
#    uses the BUNDLED node and bakes in the dashboard port + build version so
#    every launch surface (CLI, service) serves the dashboard identically.
cat > "$OUT_DIR/pearcal-seeder" <<WRAP
#!/bin/bash
DIR=\$(cd -- "\$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)
DATA="\${PEARCAL_SEED_DATA:-\$HOME/.pearcal-seed}"
export PEARCAL_SEEDER_VERSION="\${PEARCAL_SEEDER_VERSION:-$VERSION}"
exec "\$DIR/node" "\$DIR/host/index.js" \\
  --bare "\$DIR/bare" --bundle "\$DIR/worklet/seed.bundle" --data "\$DATA" \\
  --port "\${SEEDER_PORT:-8731}" "\$@"
WRAP
chmod +x "$OUT_DIR/pearcal-seeder"

echo "==> bundled Linux payload staged  host=$BARE_HOST  node=$NODE_VERSION  ($(du -sh "$OUT_DIR" | cut -f1))"

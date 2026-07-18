#!/usr/bin/env bash
# Build + push the multi-arch PearCal seeder Docker image (used by BOTH the Umbrel
# app and the Start9 s9pk), version-stamped, then pin the in-repo umbrel manifest
# to the new version + manifest-list digest.
#
# Usage:   scripts/build-umbrel-image.sh [version]
#
# Version resolution: arg > release git tag (vX.Y.Z) > seeder-launcher package.json.
# The version is passed as the SEEDER_VERSION build-arg so the container reports
# its real version (dashboard pill + seeder:status).
#
# Env:
#   IMAGE       image repo (default ghcr.io/peerloomllc/pearcal-seeder)
#   PLATFORMS   build platforms (default linux/amd64,linux/arm64)
#   PUSH        1 = build + push (default); 0 = build only (local, no creds)
#   GHCR_TOKEN  classic PAT with write:packages, to log in before pushing (skipped
#               if already logged in). Put it in scripts/.env.
#   GHCR_USER   registry login user (default peerloomllc)
#
# arm64 on an amd64 host needs qemu-user-static (binfmt) for the runtime apt step;
# the heavy builder stage runs natively (see the Dockerfile).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

IMAGE="${IMAGE:-ghcr.io/peerloomllc/pearcal-seeder}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-1}"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION="$( (git describe --tags --abbrev=0 2>/dev/null || true) | sed 's/^v//' )"
fi
if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('./seeder-launcher/package.json').version" 2>/dev/null || echo 0.0.0)"
fi
VERSION="${VERSION#v}"
TAG="${IMAGE}:${VERSION}"

# Prefer podman (its --manifest builds a list in one shot); fall back to docker buildx.
if command -v podman >/dev/null 2>&1; then ENGINE=podman
elif command -v docker >/dev/null 2>&1; then ENGINE=docker
else echo "build-umbrel-image: need podman or docker" >&2; exit 1
fi

# Authenticate to the registry BEFORE the (multi-arch, multi-minute) build so a
# missing credential fails fast instead of 403-ing at the very end.
GHCR_USER="${GHCR_USER:-peerloomllc}"
ensure_registry_login () {
  local host="${IMAGE%%/*}"   # ghcr.io
  if [ "$ENGINE" = podman ] && podman login --get-login "$host" >/dev/null 2>&1; then
    echo "==> $host: using existing login ($(podman login --get-login "$host" 2>/dev/null))"; return 0
  fi
  if [ -n "${GHCR_TOKEN:-}" ]; then
    printf '%s' "$GHCR_TOKEN" | "$ENGINE" login "$host" -u "$GHCR_USER" --password-stdin >/dev/null \
      && echo "==> $host: logged in as $GHCR_USER (GHCR_TOKEN)"; return 0
  fi
  if [ "$ENGINE" = docker ]; then echo "==> $host: assuming an existing docker login (set GHCR_TOKEN to auto-login)"; return 0; fi
  echo "build-umbrel-image: not logged in to $host and GHCR_TOKEN is unset." >&2
  echo "  Add GHCR_TOKEN=<PAT with write:packages> to scripts/.env, or run once: podman login $host -u $GHCR_USER" >&2
  exit 1
}
[ "$PUSH" = 1 ] && ensure_registry_login

echo "==> building $TAG  platforms=$PLATFORMS  SEEDER_VERSION=$VERSION  engine=$ENGINE  push=$PUSH"

if [ "$ENGINE" = podman ]; then
  podman manifest rm "$TAG" 2>/dev/null || true
  podman build --platform="$PLATFORMS" --manifest "$TAG" \
    --build-arg SEEDER_VERSION="$VERSION" \
    -f seeder-launcher/umbrel/Dockerfile .
  [ "$PUSH" = 1 ] && podman manifest push --all "$TAG" "docker://$TAG"
else
  docker buildx build --platform "$PLATFORMS" \
    --build-arg SEEDER_VERSION="$VERSION" \
    -f seeder-launcher/umbrel/Dockerfile \
    -t "$TAG" "$([ "$PUSH" = 1 ] && echo --push || echo --load)" .
fi

DIGEST=""
if [ "$PUSH" = 1 ] && command -v skopeo >/dev/null 2>&1; then
  DIGEST="$(skopeo inspect "docker://$TAG" 2>/dev/null \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["Digest"])' 2>/dev/null || true)"
fi
echo "==> ${PUSH:+pushed }$TAG${DIGEST:+  digest=$DIGEST}"

# Pin the in-repo umbrel manifest (source of truth). `^version:` won't touch
# `manifestVersion:`. The image is pinned to the manifest-list digest so Umbrel
# pulls the right arch automatically.
sed -i "s/^version: .*/version: \"$VERSION\"/" seeder-launcher/umbrel/umbrel-app.yml
if [ -n "$DIGEST" ]; then
  sed -i "s#image: ${IMAGE}:.*#image: ${IMAGE}:${VERSION}@${DIGEST}#" seeder-launcher/umbrel/docker-compose.yml
else
  sed -i "s#image: ${IMAGE}:.*#image: ${IMAGE}:${VERSION}#" seeder-launcher/umbrel/docker-compose.yml
fi
echo "==> pinned seeder-launcher/umbrel manifest to $VERSION${DIGEST:+@$DIGEST}"

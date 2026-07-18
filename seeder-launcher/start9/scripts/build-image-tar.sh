#!/usr/bin/env bash
# Build the runtime image for one arch and export it as a docker-archive tar the
# s9pk packer loads, with the exact `start9/<id>/main:<version>` RepoTag
# `start-sdk verify` requires. The pinned base image is a multi-arch manifest
# list (amd64 + arm64), so `--platform` selects the right layer.
#
# Works with either Docker or Podman:
#   - Docker keeps the short tag in the saved archive, so `docker buildx ... -o`
#     is enough.
#   - Podman/skopeo canonicalize the reference (localhost/... or docker.io/...),
#     so we save then rewrite manifest.json's RepoTags back to the bare form.
#
# Usage: build-image-tar.sh <pkg_id> <version> <arch_tar_path> [platform]
#   platform defaults to linux/amd64; StartOS arch is inferred from the tar name
#   (x86_64.tar -> linux/amd64, aarch64.tar -> linux/arm64) when not given.
set -euo pipefail

PKG_ID="${1:?pkg id}"
VERSION="${2:?version}"
OUT="${3:?output tar path}"
# Resolve the build platform from the 4th arg or the tar's arch in its name.
PLATFORM="${4:-}"
if [ -z "$PLATFORM" ]; then
  case "$(basename "$OUT")" in
    *aarch64*|*arm64*) PLATFORM=linux/arm64 ;;
    *) PLATFORM=linux/amd64 ;;
  esac
fi
TAG="start9/${PKG_ID}/main:${VERSION}"

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
mkdir -p "$(dirname "$OUT")"
# Absolutize OUT so it survives the `cd "$tmp"` subshell below.
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"

if command -v docker >/dev/null 2>&1; then
  echo "[build-image-tar] docker buildx ($PLATFORM) -> $OUT"
  docker buildx build --tag "$TAG" --platform="$PLATFORM" \
    -o "type=docker,dest=$OUT" .
  exit 0
fi

if ! command -v podman >/dev/null 2>&1; then
  echo "Error: need docker or podman on PATH." >&2
  exit 1
fi

echo "[build-image-tar] podman build ($PLATFORM) $TAG"
podman build --platform="$PLATFORM" -t "$TAG" -f Dockerfile .

echo "[build-image-tar] save + normalize RepoTags -> $OUT"
# podman save refuses to modify an existing docker-archive; start clean.
rm -f "$OUT"
podman save --format docker-archive -o "$OUT" "$TAG"

# Rewrite manifest.json RepoTags to the bare start9/ form (podman writes
# localhost/start9/...). No jq/deno dependency: pure tar + sed on manifest.json.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tar -xf "$OUT" -C "$tmp"
chmod -R u+w "$tmp"
sed -i -E "s#\"[^\"]*(start9/${PKG_ID}/main:${VERSION})\"#\"\1\"#g" "$tmp/manifest.json"
( cd "$tmp" && tar -cf "$OUT.new" * )
mv "$OUT.new" "$OUT"
echo "[build-image-tar] RepoTags: $(tar -xOf "$OUT" manifest.json | grep -oE '"RepoTags":\[[^]]*\]')"

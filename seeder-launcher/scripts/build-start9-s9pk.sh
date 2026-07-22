#!/usr/bin/env bash
# Build a versioned universal PearCal seeder .s9pk for StartOS (Start9).
#
# Run AFTER build-umbrel-image.sh — it resolves the IMAGE:VERSION manifest-list
# digest from the registry (so that image must already be pushed), pins the
# Start9 package to it, and builds + verifies the s9pk with a .sha256 sidecar in
# seeder-launcher/start9/.
#
# Usage:   build-start9-s9pk.sh [version]
#
# Version resolution: arg > release git tag (vX.Y.Z) > seeder package.json.
#
# Env:
#   IMAGE   base image repo (default ghcr.io/peerloomllc/pearcal-seeder)
#
# Requires: the StartOS SDK (start-sdk), deno, yq, skopeo, and docker or podman
# (+ qemu-user-static for the arm64 image tar on an x86 host).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
START9_DIR="$REPO_ROOT/seeder-launcher/start9"
IMAGE="${IMAGE:-ghcr.io/peerloomllc/pearcal-seeder}"

# --- version ---------------------------------------------------------------
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION="$( (git -C "$REPO_ROOT" describe --tags --abbrev=0 2>/dev/null || true) | sed 's/^v//' )"
fi
if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('$REPO_ROOT/seeder-launcher/package.json').version" 2>/dev/null || echo 0.0.0)"
fi
VERSION="${VERSION#v}"
echo "==> Start9 s9pk for version $VERSION (image $IMAGE)"

# --- toolchain preflight (fail fast) ---------------------------------------
_missing=""
for t in start-sdk deno yq skopeo make; do command -v "$t" >/dev/null || _missing="$_missing $t"; done
command -v docker >/dev/null || command -v podman >/dev/null || _missing="$_missing docker/podman"
if [ -n "$_missing" ]; then
  echo "build-start9-s9pk: missing required tools:$_missing" >&2
  echo "  Install the StartOS SDK + deno/yq/skopeo to build the s9pk." >&2
  exit 1
fi

# --- resolve the multi-arch manifest-list digest of IMAGE:VERSION ----------
# The image must already be pushed (by build-umbrel-image.sh). The OCI list
# digest is the sha256 of the raw manifest bytes exactly as the registry serves
# them, which is what `skopeo inspect --raw` prints.
echo "==> resolving $IMAGE:$VERSION digest ..."
if ! RAW="$(skopeo inspect --raw "docker://$IMAGE:$VERSION" 2>/dev/null)"; then
  echo "build-start9-s9pk: cannot inspect $IMAGE:$VERSION — is it pushed?" >&2
  echo "  Run seeder-launcher/scripts/build-umbrel-image.sh $VERSION first." >&2
  exit 1
fi
DIGEST="sha256:$(printf '%s' "$RAW" | sha256sum | cut -d' ' -f1)"
echo "    digest=$DIGEST"
printf '%s' "$RAW" | grep -q '"manifests"' \
  || echo "    WARNING: $IMAGE:$VERSION is not a manifest list — the aarch64 tar build will fail." >&2

# --- pin the version-bearing files -----------------------------------------
echo "==> pinning manifest.yaml / migrations.ts / Dockerfile to $VERSION ..."
yq -i ".version = \"$VERSION\"" "$START9_DIR/manifest.yaml"

# release-notes feeds the StartOS Updates page: it is baked into the .s9pk and
# published by build-registry.sh to /package/v0/release-notes/<id>, the
# version-keyed map StartOS reads. Nothing used to rewrite it, so every release
# after the first shipped the original submission blurb and operators updating
# were told it was the "First StartOS release". Sourced from release-notes.yaml
# and FAILED HARD when missing, so that cannot silently happen again.
NOTES_FILE="$START9_DIR/release-notes.yaml"
[ -f "$NOTES_FILE" ] || { echo "build-start9-s9pk: missing $NOTES_FILE" >&2; exit 1; }

# Most releases change the app but not the seeder: between v1.0.34 and v1.0.35
# src/seed.js and src/lib/seed*.js were byte-identical and only the packaging
# version strings moved. Demanding hand-written notes for those releases invites
# pasting the MOBILE APP's notes into a StartOS package, whose operators run a
# server and may never use the calendar app.
#
# So ask git whether the seeder actually changed since the previous release tag.
# Changed -> a hand-written entry is required. Unchanged -> generate an honest
# note rather than inventing one. Version pins are excluded from the comparison
# because this script rewrites them on every build, which would make every
# release look changed.
_prev_tag="$(git -C "$REPO_ROOT" describe --tags --abbrev=0 "v${VERSION}^" 2>/dev/null \
  || git -C "$REPO_ROOT" tag --sort=-version:refname | grep -v "^v${VERSION}$" | head -1)"
_seeder_changed=unknown
if [ -n "$_prev_tag" ]; then
  if git -C "$REPO_ROOT" diff --quiet "$_prev_tag" -- \
       src/seed.js src/lib/seedInvite.js src/lib/seedEnroll.js \
       src/lib/seederPair.js src/lib/seederPairLink.js src/lib/seederPairTopic.js \
       seeder-launcher/host seeder-launcher/start9/docker_entrypoint.sh \
       seeder-launcher/start9/write-stats.js 2>/dev/null; then
    _seeder_changed=no
  else
    _seeder_changed=yes
  fi
fi

if [ "$(yq -r "has(\"$VERSION\")" "$NOTES_FILE")" = "true" ]; then
  NOTES="$(yq -r ".\"$VERSION\"" "$NOTES_FILE")" \
    yq -i '.["release-notes"] = strenv(NOTES)' "$START9_DIR/manifest.yaml"
  echo "    release-notes <- release-notes.yaml[$VERSION]"
elif [ "$_seeder_changed" = "no" ]; then
  NOTES="No seeder changes in this release. The version was raised to stay aligned
with the PearCal app." \
    yq -i '.["release-notes"] = strenv(NOTES)' "$START9_DIR/manifest.yaml"
  echo "    release-notes <- generated (seeder unchanged since $_prev_tag)"
else
  echo "build-start9-s9pk: no release notes for $VERSION in $NOTES_FILE," >&2
  if [ "$_seeder_changed" = "yes" ]; then
    echo "  and the seeder DID change since $_prev_tag:" >&2
    git -C "$REPO_ROOT" diff --name-only "$_prev_tag" -- \
      src/seed.js src/lib/seed*.js src/lib/seeder*.js seeder-launcher/host \
      seeder-launcher/start9/docker_entrypoint.sh seeder-launcher/start9/write-stats.js \
      2>/dev/null | sed 's/^/    /' >&2
  else
    echo "  and the seeder diff could not be determined (no previous tag?)." >&2
  fi
  echo "  Add a \"$VERSION\": | entry describing what changes for a StartOS OPERATOR." >&2
  echo "  They run a server and may not use the app, so do not paste the app notes." >&2
  exit 1
fi
sed -i -E "s/fromMapping\(\{\}, \"[0-9.]+\"\)/fromMapping({}, \"$VERSION\")/" \
  "$START9_DIR/scripts/procedures/migrations.ts"
# FROM <image>:<ver>[@sha256:<digest>]  ->  new ver + digest
sed -i -E "s#^FROM ${IMAGE}:[0-9.]+(@sha256:[0-9a-f]+)?#FROM ${IMAGE}:${VERSION}@${DIGEST}#" \
  "$START9_DIR/Dockerfile"
grep -q "^FROM ${IMAGE}:${VERSION}@${DIGEST}\$" "$START9_DIR/Dockerfile" \
  || { echo "build-start9-s9pk: failed to rewrite Dockerfile FROM" >&2; exit 1; }

# --- build + verify the universal s9pk (make handles both arch tars) --------
echo "==> building s9pk (make) ..."
make -C "$START9_DIR"
S9PK="$START9_DIR/pearcal-seeder.s9pk"
[ -f "$S9PK" ] || { echo "build-start9-s9pk: make produced no s9pk" >&2; exit 1; }
( cd "$START9_DIR" && sha256sum "pearcal-seeder.s9pk" > "pearcal-seeder.s9pk.sha256" )
echo "==> s9pk ready: $S9PK ($(du -h "$S9PK" | cut -f1))"

echo ""
echo "==> Done. Review + commit the pinned start9/ files with the release:"
echo "      $START9_DIR/{manifest.yaml,Dockerfile,scripts/procedures/migrations.ts}"
echo "S9PK=$S9PK"

#!/usr/bin/env bash
# Build a versioned universal PearCal seeder .s9pk for StartOS (Start9).
#
# Run AFTER build-umbrel-image.sh — it resolves the IMAGE:VERSION manifest-list
# digest from the registry (so that image must already be pushed), pins the
# Start9 package to it, and builds + verifies the s9pk with a .sha256 sidecar in
# seeder-launcher/start9/.
#
# Emits TWO packages: the v1 s9pk that StartOS 0.3.5.x reads, and a v2 s9pk
# converted from it for 0.4.0+ (which refuses v1 in its web UI, and whose
# registry entry publishes a commitment computed over the v2 file).
#
# Usage:   build-start9-s9pk.sh [version]
#
# Version resolution: arg > release git tag (vX.Y.Z) > seeder package.json.
#
# Env:
#   IMAGE             base image repo (default ghcr.io/peerloomllc/pearcal-seeder)
#   START_CLI_V2      0.4.x-era start-cli for the v2 conversion (default: found on PATH)
#   START9_WORKSPACE  packaging workspace holding the build signing key
#                     (default ~/.start9-workspace)
#
# Requires: the StartOS SDK (start-sdk), deno, yq, skopeo, and docker or podman
# (+ qemu-user-static for the arm64 image tar on an x86 host). The v2 conversion
# additionally needs start-cli 1.x plus a packaging workspace; without them it is
# skipped loudly rather than failing the build.
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

# --- also emit a v2 s9pk for StartOS 0.4.0+ --------------------------------
# 0.4.0's web UI refuses a v1 package outright: sideload.utils.ts sniffs the
# magic bytes (3b 3b 01 vs 3b 3b 02) and tells the operator the format is
# deprecated. The OS still installs v1 through `start-cli package install
# --sideload`, so v1 is not dead - but "sideload from the browser" is how a
# StartOS user expects to install a package we do not list in a marketplace.
#
# It is also what the 0.4 REGISTRY entry is built from: the published
# `commitment` is computed over this file, so registry/build-registry-04.js
# needs it and 0.4 boxes download it (see the /package/v1 rule in the website's
# _redirects).
#
# We do NOT hand-author a second package for that. StartOS ships a converter
# (`start-cli s9pk convert`, backed by S9pk::from_v1), which is how Start9
# migrated its own catalogue; a converted package keeps its 0.3.5-era
# procedures and gains " (Legacy)" on its title. So the v1 above stays the
# single source of truth and the v2 is derived from it.
#
# Needs the 0.4.x-era start-cli (the 0.3.5 SDK's `start-cli` cannot do this)
# and a packaging workspace, which holds the build signing key the converted
# package is signed with. Both are machine setup, not repo state - the key must
# never be committed. Create one with `start-cli s9pk init-workspace`.
V2_S9PK="$START9_DIR/pearcal-seeder-v2.s9pk"
START9_WORKSPACE="${START9_WORKSPACE:-$HOME/.start9-workspace}"

# Resolve a start-cli that can convert. `start-cli --version` prints "StartOS
# CLI 0.3.5.1" for the old SDK and "start-cli 1.1.0" for the new one, so the
# leading token tells them apart without comparing version numbers.
_v2_cli=""
for _cand in "${START_CLI_V2:-}" start-cli-1.1.0 start-cli; do
  [ -n "$_cand" ] || continue
  command -v "$_cand" >/dev/null 2>&1 || continue
  if "$_cand" --version 2>/dev/null | grep -qE '^start-cli [1-9]'; then _v2_cli="$_cand"; break; fi
done

if [ -z "$_v2_cli" ] || [ ! -f "$START9_WORKSPACE/.startos/config.yaml" ]; then
  echo ""
  echo "  !! SKIPPING the v2 s9pk - StartOS 0.4.0 users will not be able to" >&2
  echo "  !! sideload this release from the web UI, and the 0.4 registry entry" >&2
  echo "  !! cannot be regenerated (CLI sideload still works)." >&2
  # if/fi, not `[ ] && echo`: under `set -e` a false test would exit the script,
  # turning a skipped optional artifact into a failed release build.
  if [ -z "$_v2_cli" ]; then
    echo "  !!   missing: a 0.4.x start-cli (set START_CLI_V2, or install start-cli 1.x)" >&2
  fi
  if [ ! -f "$START9_WORKSPACE/.startos/config.yaml" ]; then
    echo "  !!   missing: a packaging workspace at $START9_WORKSPACE" >&2
  fi
  echo "  !!   fix: start-cli s9pk init-workspace $START9_WORKSPACE" >&2
  echo ""
else
  echo "==> converting to a v2 s9pk for StartOS 0.4.0+ ($_v2_cli) ..."
  # convert rewrites IN PLACE, so it operates on a copy - losing the v1 here
  # would strand every 0.3.5 box.
  cp -f "$S9PK" "$V2_S9PK"
  # Run from inside the workspace: the converter walks up from the CWD looking
  # for .startos, and signs with that workspace's build key.
  if ( cd "$START9_WORKSPACE" && "$_v2_cli" s9pk convert "$V2_S9PK" ); then
    # Trust the bytes, not the exit code: a v2 package starts 3b 3b 02.
    if [ "$(head -c 3 "$V2_S9PK" | od -An -tx1 | tr -d ' \n')" = "3b3b02" ]; then
      ( cd "$START9_DIR" && sha256sum "pearcal-seeder-v2.s9pk" > "pearcal-seeder-v2.s9pk.sha256" )
      echo "==> v2 s9pk ready: $V2_S9PK ($(du -h "$V2_S9PK" | cut -f1))"
    else
      rm -f "$V2_S9PK"
      echo "build-start9-s9pk: conversion reported success but the output is not a v2 s9pk" >&2
      exit 1
    fi
  else
    rm -f "$V2_S9PK"
    echo "build-start9-s9pk: v2 conversion failed" >&2
    exit 1
  fi
fi

echo ""
echo "==> Done. Review + commit the pinned start9/ files with the release:"
echo "      $START9_DIR/{manifest.yaml,Dockerfile,scripts/procedures/migrations.ts}"
echo "S9PK=$S9PK"
if [ -f "$V2_S9PK" ]; then echo "S9PK_V2=$V2_S9PK"; fi

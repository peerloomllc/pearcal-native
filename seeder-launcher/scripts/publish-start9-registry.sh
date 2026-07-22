#!/usr/bin/env bash
# Publish/refresh the StartOS community registry on the website for a PearCal
# seeder release: UPSERT the pearcal-seeder metadata under /package/v0 (merging
# into the shared registry that also lists pearcircle-seeder — never wiping it)
# and ensure the _redirects rule points its s9pk at the release tag, then
# (opt-in) open + squash-merge a website PR. The website is a Cloudflare project
# that deploys on merge to main, so the merge is the deploy. Run AFTER the GitHub
# release + s9pk asset exist — the metadata advertises the version and _redirects
# points at that release's asset.
#
# Usage: publish-start9-registry.sh [version]
#
# Env:
#   WEBSITE_DIR          (required) a clone of the website repo. For the auto-PR
#                        path use a DEDICATED clone: the branch is cut fresh off
#                        origin/main (git checkout -B), discarding leftovers.
#   WEBSITE_REGISTRY_PR  1 = commit, push the branch, open + squash-merge the PR
#                        via gh (deploys on merge). Default = regenerate the files
#                        + print the git/gh commands to run yourself.
#   S9PK                 built s9pk path
#                        (default seeder-launcher/start9/pearcal-seeder.s9pk)
#   RELEASE_REPO         GitHub owner/repo hosting the s9pk release asset
#                        (default peerloomllc/pearcal-native)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
START9_DIR="$REPO_ROOT/seeder-launcher/start9"
RELEASE_REPO="${RELEASE_REPO:-peerloomllc/pearcal-native}"

# --- version ---------------------------------------------------------------
VERSION="${1:-}"
[ -z "$VERSION" ] && VERSION="$( (git -C "$REPO_ROOT" describe --tags --abbrev=0 2>/dev/null || true) | sed 's/^v//' )"
[ -z "$VERSION" ] && VERSION="$(node -p "require('$REPO_ROOT/seeder-launcher/package.json').version" 2>/dev/null || echo 0.0.0)"
VERSION="${VERSION#v}"

: "${WEBSITE_DIR:?set WEBSITE_DIR to a clone of the website repo}"
[ -d "$WEBSITE_DIR/.git" ] || { echo "publish-start9-registry: $WEBSITE_DIR is not a git clone" >&2; exit 1; }
S9PK="${S9PK:-$START9_DIR/pearcal-seeder.s9pk}"
[ -f "$S9PK" ] || { echo "publish-start9-registry: s9pk not found: $S9PK (run build-start9-s9pk.sh first)" >&2; exit 1; }

AUTO="${WEBSITE_REGISTRY_PR:-}"
BRANCH="start9-registry-pearcal-v${VERSION}"
echo "==> Publishing StartOS registry for pearcal-seeder v$VERSION (website $WEBSITE_DIR)"

# For the automated path, cut a fresh branch off the latest main so the diff is
# only the registry (and a lingering same-version branch from a re-run resets).
base="main"
if [ "$AUTO" = 1 ]; then
  git -C "$WEBSITE_DIR" fetch -q origin
  base="$(git -C "$WEBSITE_DIR" remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p')"; base="${base:-main}"
  # An earlier aborted run leaves its generated output in exactly the paths this
  # script rewrites, and `checkout -B` then refuses to switch over them:
  #   error: Your local changes to the following files would be overwritten by
  #   checkout: _redirects, package/v0/index, package/v0/latest
  # Worse, that leftover is generated against whatever main was at the time, so
  # keeping it would make the upsert below merge onto a stale base and could
  # revert a previous publish. It is pure generated output and is regenerated a
  # few lines down, so clear it. Scoped to the registry paths ONLY, so unrelated
  # edits elsewhere in the clone (CLAUDE.md, site content) are never touched.
  if [ -n "$(git -C "$WEBSITE_DIR" status --porcelain -- package _redirects)" ]; then
    echo "    clearing leftover registry output from a previous run (package/, _redirects)"
    git -C "$WEBSITE_DIR" checkout -q -- package _redirects 2>/dev/null || true
    git -C "$WEBSITE_DIR" clean -qfd -- package 2>/dev/null || true
  fi
  git -C "$WEBSITE_DIR" checkout -q -B "$BRANCH" "origin/${base}"
else
  # Manual path: no branch is cut, so the upsert merges into whatever this clone
  # currently holds. A clone behind origin silently produces a stale-base merge
  # that drops entries added upstream since, so say so rather than fail quietly.
  git -C "$WEBSITE_DIR" fetch -q origin 2>/dev/null || true
  _behind="$(git -C "$WEBSITE_DIR" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
  if [ "${_behind:-0}" -gt 0 ]; then
    echo "    WARNING: $WEBSITE_DIR is $_behind commit(s) behind origin/main." >&2
    echo "             The upsert merges into this tree, so a stale base can revert a" >&2
    echo "             previous publish. Run: git -C \"$WEBSITE_DIR\" pull --ff-only origin main" >&2
  fi
fi

# Merge the pearcal-seeder metadata into the (possibly multi-package) tree.
echo "==> upserting pearcal-seeder /package/v0 metadata for v$VERSION ..."
OUT_DIR="$WEBSITE_DIR" SKIP_S9PK=1 bash "$START9_DIR/registry/build-registry.sh" "$S9PK"

# Ensure the _redirects rules send /package/v0/pearcal-seeder.s9pk (and the
# double-slash variant StartOS sometimes builds) at the release asset. Bump the
# tag in place if the rules exist, else append them.
RED="$WEBSITE_DIR/_redirects"
ASSET_BASE="https://github.com/${RELEASE_REPO}/releases/download"
touch "$RED"
if grep -qE '^//?package/v0/pearcal-seeder\.s9pk' "$RED"; then
  sed -i -E "s#(${RELEASE_REPO}/releases/download/)v[0-9.]+(/pearcal-seeder\.s9pk)#\1v${VERSION}\2#g" "$RED"
  echo "    bumped existing _redirects rules to v$VERSION"
else
  {
    echo "/package/v0/pearcal-seeder.s9pk  ${ASSET_BASE}/v${VERSION}/pearcal-seeder.s9pk  302"
    echo "//package/v0/pearcal-seeder.s9pk  ${ASSET_BASE}/v${VERSION}/pearcal-seeder.s9pk  302"
  } >> "$RED"
  echo "    appended _redirects rules for pearcal-seeder v$VERSION"
fi

# Nothing to publish? (re-run at the same version — metadata is deterministic.)
if [ -z "$(git -C "$WEBSITE_DIR" status --porcelain -- package _redirects)" ]; then
  echo "==> registry already current for pearcal-seeder v$VERSION — nothing to publish."
  exit 0
fi

if [ "$AUTO" = 1 ]; then
  ( cd "$WEBSITE_DIR"
    git add package _redirects
    git commit -q -m "chore: StartOS registry -> pearcal-seeder v${VERSION}"
    git push -q -f -u origin "$BRANCH"
    if [ -z "$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null)" ]; then
      gh pr create --base "$base" --head "$BRANCH" \
        --title "chore: StartOS registry -> pearcal-seeder v${VERSION}" \
        --body "Upserted \`/package/v0\` metadata + \`_redirects\` for pearcal-seeder v${VERSION} (merged alongside the other listed packages). Auto-generated by publish-start9-registry.sh; merging deploys the registry (Cloudflare)." \
        >/dev/null
    fi
    if gh pr merge "$BRANCH" --squash --delete-branch >/dev/null 2>&1; then
      echo "==> Website registry deployed — PR merged to $base (Cloudflare deploys on merge)."
    else
      echo "    WARNING: PR opened for v$VERSION but auto-merge failed — merge it manually to deploy." >&2
    fi
  )
else
  echo ""
  echo "==> Registry files regenerated in $WEBSITE_DIR (not committed). To publish:"
  echo "      cd $WEBSITE_DIR"
  echo "      git checkout -B $BRANCH && git add package _redirects"
  echo "      git commit -m 'chore: StartOS registry -> pearcal-seeder v${VERSION}'"
  echo "      git push -u origin $BRANCH"
  echo "      gh pr create --base $base --fill && gh pr merge --squash --delete-branch"
  echo "    (or set WEBSITE_REGISTRY_PR=1 to do all of that automatically)"
fi

#!/usr/bin/env bash
# PearCal local release script
# Usage: ./scripts/release.sh v1.0.11
#
# Required env vars (or set in scripts/.env):
#   KEYSTORE_PASSWORD   - release keystore password
#   KEY_PASSWORD        - release key password
#   SIGN_WITH           - Zapstore NSEC for signing
#
# Optional env vars:
#   KEYSTORE_FILE       - path to keystore (default: ~/keystore.jks)
#   KEY_ALIAS           - key alias (default: pearcal)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load scripts/.env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

# --- Argument ---
if [ -z "${1:-}" ]; then
  echo "Usage: $0 <tag>  (e.g. $0 v1.0.11)"
  exit 1
fi
RELEASE_TAG="$1"
if [[ ! "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: tag must be in format vX.Y.Z (got: $RELEASE_TAG)"
  exit 1
fi
APP_VERSION="${RELEASE_TAG#v}"

# --- Required credentials ---
: "${KEYSTORE_PASSWORD:?Set KEYSTORE_PASSWORD or add it to scripts/.env}"
: "${KEY_PASSWORD:?Set KEY_PASSWORD or add it to scripts/.env}"
: "${SIGN_WITH:?Set SIGN_WITH (Zapstore NSEC) or add it to scripts/.env}"
KEYSTORE_FILE="${KEYSTORE_FILE:-$HOME/keystore.jks}"
KEY_ALIAS="${KEY_ALIAS:-pearcal}"

if [ ! -f "$KEYSTORE_FILE" ]; then
  echo "Error: keystore not found at $KEYSTORE_FILE"
  exit 1
fi

cd "$REPO_ROOT"

# --- 1. Build UI bundle ---
echo "==> Building UI bundle..."
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle

# --- 2. Build Bare bundle ---
echo "==> Building Bare bundle..."
node_modules/.bin/bare-pack --linked src/bare.js -o assets/bare-universal.bundle

# --- 3. Build signed release APK ---
echo "==> Building signed release APK (this takes a few minutes)..."
(
  export KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD KEY_PASSWORD APP_VERSION
  cd android && ./gradlew assembleRelease -q
)

# --- 4. Copy APK with version name ---
APK_NAME="pearcal-${RELEASE_TAG}.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$APK_NAME"
echo "==> Built: $APK_NAME"

# --- 5. Generate release notes from merged PRs ---
echo "==> Generating release notes..."
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
PREV_RELEASE_DATE=$(gh api "repos/$REPO/releases" \
  --jq '[.[] | select(.draft == false)] | .[0].published_at // ""')

NOTES="## What's Changed\n\n"
if [ -z "$PREV_RELEASE_DATE" ]; then
  NOTES="${NOTES}Initial release.\n"
else
  ALL_PRS=$(gh pr list --state merged --limit 100 \
    --json number,title,body,mergedAt)
  FILTERED=$(echo "$ALL_PRS" | jq --arg since "$PREV_RELEASE_DATE" \
    '[.[] | select(.mergedAt > $since)]')
  PR_COUNT=$(echo "$FILTERED" | jq 'length')

  if [ "$PR_COUNT" = "0" ]; then
    NOTES="${NOTES}No merged PRs since last release.\n"
  else
    while IFS= read -r pr_json; do
      TITLE=$(echo "$pr_json" | jq -r '.title')
      BODY=$(echo "$pr_json" | jq -r '.body // ""')
      SUMMARY=$(printf '%s' "$BODY" | awk '/^## Summary/{f=1;next} /^## /{if(f)exit} f && /\S/{print}')
      NOTES="${NOTES}### ${TITLE}\n"
      [ -n "$SUMMARY" ] && NOTES="${NOTES}${SUMMARY}\n"
      NOTES="${NOTES}\n"
    done < <(echo "$FILTERED" | jq -c '.[]')
  fi
fi
printf "%b" "$NOTES" > release_notes.md
echo "--- Release notes ---"
cat release_notes.md
echo "---"
echo ""
read -rp "Release notes look good? Push $RELEASE_TAG and publish? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted. Edit release_notes.md manually and re-run, or adjust PRs and retry."
  exit 0
fi

# --- 6. Push tag to GitHub ---
echo "==> Pushing tag $RELEASE_TAG..."
git tag "$RELEASE_TAG" 2>/dev/null && echo "Created local tag" || echo "Tag already exists locally"
git push github "$RELEASE_TAG" 2>/dev/null && echo "Pushed tag" || echo "Tag already on remote"

# --- 7. Create GitHub release ---
echo "==> Creating GitHub release $RELEASE_TAG..."
gh release create "$RELEASE_TAG" "$APK_NAME" \
  --title "$RELEASE_TAG" \
  --notes-file release_notes.md

# --- 8. Install zsp if needed ---
if ! command -v zsp &>/dev/null; then
  echo "==> Installing zsp..."
  ZSP_URL=$(curl -s https://api.github.com/repos/zapstore/zsp/releases/latest \
    | grep browser_download_url | grep linux-amd64 | cut -d '"' -f 4)
  sudo curl -sL "$ZSP_URL" -o /usr/local/bin/zsp
  sudo chmod +x /usr/local/bin/zsp
fi

# --- 9. Publish to Zapstore ---
echo "==> Publishing to Zapstore..."
GITHUB_TOKEN=$(gh auth token) zsp publish -y zapstore.yaml

echo ""
echo "==> Release $RELEASE_TAG complete."

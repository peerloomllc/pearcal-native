#!/usr/bin/env bash
# Resume the App Store leg of a release that already archived and exported.
#
# release.sh does five things for Apple: archive, export, upload, create the
# version record + apply metadata, submit for review.  When one of the later
# steps fails there is no way to pick up where it stopped without re-running
# the whole release, which would rebuild bundles, re-tag and re-publish every
# other channel.  This script runs upload -> version -> metadata -> submit
# against an IPA that has already been exported on the Mac Mini.
#
# Usage: ./scripts/resume-appstore.sh [X.Y.Z]
#
# Version defaults to the newest vX.Y.Z git tag, which is what release.sh
# itself treats as the source of truth (it derives APP_VERSION from the tag and
# then WRITES app.json).  Do not default to app.json: its bump lands in a
# release commit that is only pushed at the end of the run, so a release that
# died partway through leaves app.json behind the version actually built.
# Reads the same scripts/app.conf and scripts/.env as release.sh, and expects
# the API-key vars: ASC_KEY_ID, ASC_ISSUER_ID, ASC_APP_ID.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ -f "$SCRIPT_DIR/app.conf" ]; then set -a; source "$SCRIPT_DIR/app.conf"; set +a; fi
if [ -f "$SCRIPT_DIR/.env" ]; then set -a; source "$SCRIPT_DIR/.env"; set +a; fi

if [ -n "${1:-}" ]; then
  APP_VERSION="$1"
else
  _LATEST_TAG=$(git tag --sort=-version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
  APP_VERSION="${_LATEST_TAG#v}"
  [ -n "$APP_VERSION" ] || APP_VERSION=$(node -p "require('./app.json').expo.version")
  _JSON_VERSION=$(node -p "require('./app.json').expo.version")
  if [ "$_JSON_VERSION" != "$APP_VERSION" ]; then
    echo "Note: app.json says ${_JSON_VERSION} but the newest tag is ${APP_VERSION}."
    echo "      Using ${APP_VERSION}. This gap means the release commit for"
    echo "      ${APP_VERSION} was never merged - worth fixing separately."
  fi
fi
MAC_MINI="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
MAC_REPO="${MAC_MINI_REPO_PATH:-peerloomllc/pearcal-native}"
METADATA_DIR="$REPO_ROOT/metadata/ios"
VERSION_DIR="$METADATA_DIR/version/${APP_VERSION}"
DEFAULT_DIR="$METADATA_DIR/version/default"
REMOTE_IPA="/tmp/${APP_NAME}-appstore/${APP_NAME}.ipa"

for v in ASC_KEY_ID ASC_ISSUER_ID ASC_APP_ID; do
  if [ -z "${!v:-}" ]; then echo "Error: $v is not set (scripts/.env)."; exit 1; fi
done
command -v asc >/dev/null || { echo "Error: asc CLI not installed."; exit 1; }

_confirm() {
  local _reply
  while true; do
    echo ""
    read -rp "    ${1:-Continue?} [y/N] " _reply
    echo ""
    case "$_reply" in
      [Yy]) return 0 ;;
      [Nn]|"") echo "Aborted."; exit 0 ;;
      *) echo "    Please enter y or n." ;;
    esac
  done
}

_asc_auth() {
  local key_file="${ASC_PRIVATE_KEY_PATH:-$HOME/.appstoreconnect/AuthKey_${ASC_KEY_ID}.p8}"
  [ -f "$key_file" ] || { echo "Error: API key not found at $key_file"; exit 1; }
  asc auth login --bypass-keychain --name "${APP_NAME:-App}-CI" \
    --key-id "$ASC_KEY_ID" --issuer-id "$ASC_ISSUER_ID" --private-key "$key_file" >/dev/null
}

echo "==> Resuming App Store release ${APP_VERSION}"
echo "    App ID : $ASC_APP_ID"
echo "    IPA    : ${MAC_MINI}:${REMOTE_IPA}"

# ── Step 1: Upload the already-exported IPA ────────────────────────────────
if ! ssh "$MAC_MINI" "[ -f '$REMOTE_IPA' ]"; then
  echo "Error: no exported IPA at ${MAC_MINI}:${REMOTE_IPA}"
  echo "  Run scripts/ios-appstore.sh on the Mac Mini first, or use release.sh."
  exit 1
fi
_IPA_VERSION=$(ssh "$MAC_MINI" "cd /tmp && rm -rf .resume-ipa && mkdir .resume-ipa && cd .resume-ipa && unzip -qo '$REMOTE_IPA' 'Payload/*/Info.plist' && plutil -extract CFBundleShortVersionString raw -o - Payload/*.app/Info.plist; cd /tmp && rm -rf .resume-ipa")
if [ "$_IPA_VERSION" != "$APP_VERSION" ]; then
  echo "Error: the exported IPA is version ${_IPA_VERSION}, not ${APP_VERSION}."
  echo "  Refusing to upload a build that does not match the version being released."
  echo "  If ${_IPA_VERSION} is the one you meant to ship, re-run as:"
  echo "    ./scripts/resume-appstore.sh ${_IPA_VERSION}"
  exit 1
fi
echo "    IPA version confirmed: ${_IPA_VERSION}"

_confirm "Upload the ${APP_VERSION} build to App Store Connect?"
ssh "$MAC_MINI" "
  export PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' LANG=en_US.UTF-8
  cd ${MAC_REPO}
  asc auth login --bypass-keychain --name '${APP_NAME}-CI' \
    --key-id '${ASC_KEY_ID}' --issuer-id '${ASC_ISSUER_ID}' \
    --private-key \"\${ASC_PRIVATE_KEY_PATH:-\$HOME/.appstoreconnect/AuthKey_${ASC_KEY_ID}.p8}\"
  asc builds upload --app '${ASC_APP_ID}' --ipa '${REMOTE_IPA}'
"
echo "    Upload complete."

# ── Step 2: Ensure the version record exists ───────────────────────────────
_asc_auth
echo ""
echo "==> Checking App Store version record for ${APP_VERSION}..."
VERSION_EXISTS=$(asc versions list --app "$ASC_APP_ID" --version "$APP_VERSION" --output json 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('data', d if isinstance(d,list) else [])))" 2>/dev/null || echo 0)

if [ "${VERSION_EXISTS:-0}" = "0" ]; then
  PRIOR_VERSION=$(asc versions list --app "$ASC_APP_ID" --paginate --output json 2>/dev/null \
    | APP_VERSION="$APP_VERSION" python3 -c "
import json, os, sys
d = json.load(sys.stdin)
items = d.get('data', d if isinstance(d, list) else [])
def ver(x):
    v = x.get('attributes', {}).get('versionString') or x.get('versionString', '')
    try: return tuple(int(p) for p in v.split('.'))
    except: return (0,)
target = tuple(int(p) for p in os.environ['APP_VERSION'].split('.') if p.isdigit())
priors = sorted([x for x in items if ver(x) < target], key=ver, reverse=True)
if priors:
    print(priors[0].get('attributes', {}).get('versionString') or priors[0].get('versionString', ''))
")
  if [ -n "$PRIOR_VERSION" ]; then
    echo "    Creating ${APP_VERSION}, copying metadata from ${PRIOR_VERSION}..."
    asc versions create --app "$ASC_APP_ID" --version "$APP_VERSION" --copy-metadata-from "$PRIOR_VERSION"
  else
    echo "    Creating ${APP_VERSION} with no prior version to copy from..."
    asc versions create --app "$ASC_APP_ID" --version "$APP_VERSION"
  fi
else
  echo "    Version ${APP_VERSION} already exists."
fi

# ── Step 3: Build versioned metadata with whatsNew, then apply ─────────────
if [ -d "$DEFAULT_DIR" ] && [ ! -d "$VERSION_DIR" ]; then
  mkdir -p "$VERSION_DIR"
  WHATS_NEW=""
  [ -f "$REPO_ROOT/release_notes.md" ] && WHATS_NEW=$(cat "$REPO_ROOT/release_notes.md")
  for f in "$DEFAULT_DIR"/*.json; do
    OUT="$VERSION_DIR/$(basename "$f")" SRC="$f" python3 -c "
import json, os, re, sys
with open(os.environ['SRC']) as fh:
    data = json.load(fh)
# App Store rejects emoji and other non-Latin symbols in whatsNew.
notes = sys.stdin.read().strip()
data['whatsNew'] = re.sub(r'[^\x00-\x7FÀ-ɏ—’‘“”]+\s*', '', notes)
with open(os.environ['OUT'], 'w') as out:
    json.dump(data, out)
" <<< "$WHATS_NEW"
    echo "    Created $VERSION_DIR/$(basename "$f")"
  done
elif [ -d "$VERSION_DIR" ]; then
  echo "    Reusing existing $VERSION_DIR"
fi

echo ""
echo "==> Metadata dry run:"
asc metadata apply --app "$ASC_APP_ID" --version "$APP_VERSION" --dir "$METADATA_DIR" --dry-run || true
_confirm "Apply this metadata to version ${APP_VERSION}?"
asc metadata apply --app "$ASC_APP_ID" --version "$APP_VERSION" --dir "$METADATA_DIR" \
  && echo "    Metadata applied." \
  || echo "    WARNING: metadata apply failed (non-fatal)."

# ── Step 4: Submit for review ──────────────────────────────────────────────
echo ""
echo "==> Submit for App Store review"
echo "    Builds take 5-15 minutes to process after upload. If the build is"
echo "    still processing, submission fails and you can just retry."
_confirm "Submit version ${APP_VERSION} for App Store review?"

if asc publish appstore --app "$ASC_APP_ID" --version "$APP_VERSION" --submit --confirm; then
  echo "    Submitted for review."
  echo ""
  asc review status --app "$ASC_APP_ID" || true
  echo ""
  echo "    Monitor:  asc review status --app $ASC_APP_ID"
  echo "    Diagnose: asc review doctor --app $ASC_APP_ID"
else
  echo "    WARNING: submission failed - the build may still be processing."
  echo "    Retry: asc publish appstore --app $ASC_APP_ID --version $APP_VERSION --submit --confirm"
  exit 1
fi

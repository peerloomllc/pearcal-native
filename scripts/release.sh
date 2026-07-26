#!/usr/bin/env bash
# Local release script (app-specific config in scripts/app.conf)
# Usage: ./scripts/release.sh [vX.Y.Z] [--retag] [--check-versions]
#
# Flags:
#   vX.Y.Z             Override the auto-detected version
#   --retag            Delete and recreate a stranded local tag from a failed run
#   --check-versions   Query GitHub and Zapstore versions and exit (no build)
#   --skip-play        Skip Google Play upload even if credentials are configured
#   --skip-nostr       Skip Nostr announcement even if selected
#   --skip-desktop     Skip desktop builds (Linux/Mac/Win) even if the Mac Mini is reachable
#   --skip-seeder      Skip blind-seeder installer builds (Linux/Win/macOS) even if buildable
#   --skip-seeder-store Skip seeder STORE artifacts (ghcr image + Start9 .s9pk + registry)
#
# Required env vars (or set in scripts/.env):
#   KEYSTORE_PASSWORD            - release keystore password
#   KEY_PASSWORD                 - release key password
#   SIGN_WITH                    - Zapstore NSEC for signing
#
# Optional env vars:
#   KEYSTORE_FILE                - path to keystore (default: ~/keystore.jks)
#   KEY_ALIAS                    - key alias (default: from app.conf)
#   GITHUB_TOKEN                 - GitHub PAT (falls back to gh auth token)
#   GITHUB_REMOTE                - git remote name (default: github, then origin)
#   PLAY_SERVICE_ACCOUNT_JSON    - path to GCP service account JSON for Play upload
#   PLAY_TRACK                   - Play track: internal / alpha / beta / production
#                                  (default: alpha)
#   ASC_KEY_ID                 - App Store Connect API key ID
#   ASC_ISSUER_ID              - App Store Connect API issuer ID
#   ASC_PRIVATE_KEY_PATH       - Path to .p8 private key file
#   ASC_APP_ID                 - Numeric App Store app ID (from `asc apps list`)
#   ASC_APPLE_ID               - (legacy) Apple ID email for altool upload
#   ASC_APP_PASSWORD           - (legacy) App-specific password for altool upload
#   MAC_MINI_HOST              - Mac Mini SSH hostname (default: Tims-Mac-mini.local)
#   PLAY_QUOTA_PROJECT     - GCP project ID for Play API quota when using ADC
#                            (required if PLAY_SERVICE_ACCOUNT_JSON is not set;
#                             run 'gcloud projects list' to find your project ID)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load app config and env
if [ -f "$SCRIPT_DIR/app.conf" ]; then
  set -a; source "$SCRIPT_DIR/app.conf"; set +a
fi
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

# Required app.conf keys, checked once, up front.
#
# Each of these used to carry a hard-coded default copied from whichever
# sibling app the script was forked from. That is how PearGuard came to
# announce itself as PearCal on Nostr, PearPetal as PearList, and how
# PearPetal would have named its APK pearlist-*.apk had app.conf ever lost a
# key. Dormant wrong defaults are still wrong defaults: fail here, where it
# costs nothing, instead of mid-release or after the announcement is public.
for _k in APP_NAME; do
  if [ -z "${!_k:-}" ]; then
    echo "error: $_k is not set — check $SCRIPT_DIR/app.conf" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Helper: derive "owner/repo" from the git remote URL without gh CLI
# ---------------------------------------------------------------------------
_remote_slug() {
  local remote_url
  remote_url=$(git remote get-url "${GITHUB_REMOTE:-}" 2>/dev/null \
    || git remote get-url github 2>/dev/null \
    || git remote get-url origin 2>/dev/null \
    || echo "")
  if [ -z "$remote_url" ]; then
    echo ""
    return
  fi
  # Handle both SSH (git@github.com:owner/repo.git) and HTTPS forms
  local slug
  slug=$(printf '%s' "$remote_url" \
    | sed -E 's|.*github\.com[:/]([^/]+/[^/]+?)(\.git)?$|\1|' \
    | sed 's/\.git$//')
  printf '%s' "$slug"
}

# ---------------------------------------------------------------------------
# Helper: resolve GITHUB_TOKEN without requiring `gh auth token` to work
# ---------------------------------------------------------------------------
_github_token() {
  # 1. Already set in environment / .env
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    printf '%s' "$GITHUB_TOKEN"
    return
  fi
  # 2. Try gh CLI (may fail when account is limited — that's fine)
  local tok
  tok=$(gh auth token 2>/dev/null || echo "")
  if [ -n "$tok" ]; then
    printf '%s' "$tok"
    return
  fi
  echo ""
}

# ---------------------------------------------------------------------------
# Helper: confirmation prompt — loops until y or n is entered
# Usage: _confirm "Question to ask"
# ---------------------------------------------------------------------------
_confirm() {
  local prompt="${1:-Continue?}"
  local _reply
  while true; do
    echo ""
    read -rp "    ${prompt} [y/N] " _reply
    echo ""
    case "$_reply" in
      [Yy]) return 0 ;;
      [Nn]|"")
        echo "Aborted."
        exit 0
        ;;
      *)
        echo "    Please enter y or n."
        ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Helper: fetch latest version from GitHub releases (returns bare X.Y.Z or "")
# ---------------------------------------------------------------------------
_github_latest_version() {
  local token="$1" slug="$2"
  [ -z "$token" ] || [ -z "$slug" ] && echo "" && return
  curl -s \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${slug}/releases/latest" \
    2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tag_name','').lstrip('v'))" \
    2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Helper: fetch latest version published on Zapstore for this app.
# Queries the Nostr relay at wss://relay.zapstore.dev for kind 30063 events
# whose "i" tag matches the app's Android package name (identifier).
# Returns bare X.Y.Z or "".
# ---------------------------------------------------------------------------
_zapstore_latest_version() {
  local identifier="${1:-}"
  [ -z "$identifier" ] && echo "" && return

  # Build a NIP-01 REQ filter for kind 30063 events tagged with this app id
  local filter
  filter=$(python3 -c "
import json
req = ['REQ', 'sub1', {'kinds': [30063], '#i': ['${identifier}'], 'limit': 5}]
print(json.dumps(req))
")

  local version=""

  # --- Try websocat first (fastest) ---
  if command -v websocat &>/dev/null; then
    version=$(printf '%s\n' "$filter" \
      | timeout 10 websocat --no-close wss://relay.zapstore.dev 2>/dev/null \
      | python3 -c "
import sys, json
best = ()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
        if isinstance(msg, list) and msg[0] == 'EOSE':
            break
        if isinstance(msg, list) and msg[0] == 'EVENT':
            ev = msg[2]
            tags = {t[0]: t[1] for t in ev.get('tags',[]) if len(t)>=2}
            ver = tags.get('version','')
            if ver:
                parts = tuple(int(x) for x in ver.lstrip('v').split('.') if x.isdigit())
                if parts > best:
                    best = parts
    except:
        pass
if best: print('.'.join(str(x) for x in best))
" 2>/dev/null || echo "")

  # --- Fallback: python3 websockets ---
  elif python3 -c "import websockets" 2>/dev/null; then
    version=$(python3 - "$identifier" <<'PYEOF' 2>/dev/null
import asyncio, json, sys
import websockets

async def query(identifier):
    uri = "wss://relay.zapstore.dev"
    req = json.dumps(["REQ", "sub1", {"kinds": [30063], "#i": [identifier], "limit": 5}])
    best = ()
    try:
        async with websockets.connect(uri, open_timeout=6, close_timeout=2) as ws:
            await ws.send(req)
            for _ in range(10):
                try:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                    if isinstance(msg, list) and msg[0] == "EOSE":
                        break
                    if isinstance(msg, list) and msg[0] == "EVENT":
                        tags = {t[0]: t[1] for t in msg[2].get("tags", []) if len(t) >= 2}
                        ver = tags.get("version", "")
                        if ver:
                            parts = tuple(int(x) for x in ver.lstrip("v").split(".") if x.isdigit())
                            if parts > best:
                                best = parts
                except asyncio.TimeoutError:
                    break
    except Exception:
        pass
    if best:
        print(".".join(str(x) for x in best))

asyncio.run(query(sys.argv[1]))
PYEOF
    )
  else
    # No WebSocket tool available — emit a diagnostic on stderr, return empty
    echo "    (Note: install 'websocat' or 'pip install websockets' to enable Zapstore version lookup)" >&2
    echo ""
    return
  fi

  printf '%s' "${version:-}"
}

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Helper: obtain a Google Play API OAuth2 token.
# Tries gcloud application-default credentials first (no key file needed),
# then falls back to service account JSON if PLAY_SERVICE_ACCOUNT_JSON is set.
# Returns the token string or "" on failure.
# ---------------------------------------------------------------------------
_play_token() {
  local sa_json="${1:-}"

  # --- Path 1: service account JSON (preferred — no quota project needed) ---
  if [ -n "$sa_json" ] && [ -f "$sa_json" ]; then
    python3 - "$sa_json" <<'PYEOF' 2>/dev/null || echo ""
import sys, json, time, base64
from urllib.request import urlopen, Request
from urllib.parse import urlencode

svc = json.load(open(sys.argv[1]))
now = int(time.time())
header  = base64.urlsafe_b64encode(json.dumps({"alg":"RS256","typ":"JWT"}).encode()).rstrip(b'=')
payload = base64.urlsafe_b64encode(json.dumps({
    "iss": svc["client_email"],
    "scope": "https://www.googleapis.com/auth/androidpublisher",
    "aud": "https://oauth2.googleapis.com/token",
    "iat": now, "exp": now + 3600
}).encode()).rstrip(b'=')

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    key = serialization.load_pem_private_key(svc["private_key"].encode(), password=None)
    sig_input = header + b'.' + payload
    sig = base64.urlsafe_b64encode(key.sign(sig_input, padding.PKCS1v15(), hashes.SHA256())).rstrip(b'=')
    jwt = (sig_input + b'.' + sig).decode()
except ImportError:
    import subprocess, tempfile, os
    sig_input = (header + b'.' + payload).decode()
    with tempfile.NamedTemporaryFile(suffix='.pem', delete=False) as f:
        f.write(svc["private_key"].encode()); kp = f.name
    try:
        sig_bytes = subprocess.check_output(['openssl','dgst','-sha256','-sign',kp], input=sig_input.encode())
        sig = base64.urlsafe_b64encode(sig_bytes).rstrip(b'=').decode()
        jwt = sig_input + '.' + sig
    finally:
        os.unlink(kp)

data = urlencode({"grant_type":"urn:ietf:params:oauth:grant-type:jwt-bearer","assertion":jwt}).encode()
resp = json.loads(urlopen(Request("https://oauth2.googleapis.com/token", data=data)).read())
print(resp.get("access_token",""))
PYEOF
    return
  fi

  # --- Path 2: gcloud application-default credentials ---
  # The androidpublisher API requires x-goog-user-project on every request when
  # using ADC user credentials. Resolve project from PLAY_QUOTA_PROJECT or gcloud.
  if command -v gcloud > /dev/null 2>&1; then
    local proj
    proj="${PLAY_QUOTA_PROJECT:-$(gcloud config get-value project 2>/dev/null || echo "")}"
    if [ -z "$proj" ]; then
      echo "ERROR: Cannot determine GCP quota project for Android Publisher API." >&2
      echo "  Set PLAY_QUOTA_PROJECT=<your-gcp-project-id> in scripts/.env" >&2
      echo "  or use PLAY_SERVICE_ACCOUNT_JSON instead of ADC." >&2
      echo ""
      return
    fi
    local tok
    tok=$(gcloud auth application-default print-access-token 2>/dev/null || echo "")
    if [ -n "$tok" ]; then
      printf '%s' "$tok"
      return
    fi
  fi

  echo ""
}

# ---------------------------------------------------------------------------
# Helper: fetch latest version published on Google Play for this app.
# Queries the configured PLAY_TRACK (default: production).
# Returns bare X.Y.Z or "".
# ---------------------------------------------------------------------------
_play_latest_version() {
  local package="${1:-}" sa_json="${2:-}" track="${3:-production}"
  [ -z "$package" ] && echo "" && return

  local token
  token=$(_play_token "$sa_json")
  [ -z "$token" ] && echo "" && return

  python3 - "$package" "$track" "$token" <<'PYEOF' 2>/dev/null || echo ""
import sys, json
from urllib.request import urlopen, Request

package = sys.argv[1]
track   = sys.argv[2]
token   = sys.argv[3]

url = f"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{package}/tracks/{track}"
req = Request(url, headers={"Authorization": f"Bearer {token}"})
try:
    track_data = json.loads(urlopen(req).read())
    releases = track_data.get("releases", [])
    for status in ("completed", "inProgress", "halted", "draft"):
        for r in releases:
            if r.get("status") == status:
                print(r.get("name", ""))
                sys.exit(0)
except Exception:
    pass
PYEOF
}


# ---------------------------------------------------------------------------
# Helper: fetch the current live version from the Apple App Store.
# Uses the public iTunes Search API — no credentials required.
# Returns bare X.Y.Z or "".
# ---------------------------------------------------------------------------
_appstore_latest_version() {
  local bundle_id="${1:-${BUNDLE_ID:-com.pearcal}}"

  # Preferred: asc CLI (sees all versions including in-review and TestFlight)
  if command -v asc &>/dev/null \
     && [ -n "${ASC_KEY_ID:-}" ] \
     && [ -n "${ASC_APP_ID:-}" ]; then
    if _asc_auth_linux 2>/dev/null; then
      local ver
      ver=$(asc versions list --app "$ASC_APP_ID" --output json 2>/dev/null \
        | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('data', data) if isinstance(data, dict) else data
if isinstance(items, list) and items:
    versions = [v.get('attributes', v).get('versionString', '') for v in items if v.get('attributes', v).get('versionString')]
    if versions:
        versions.sort(key=lambda v: tuple(int(x) for x in v.split('.') if x.isdigit()), reverse=True)
        print(versions[0])
" 2>/dev/null)
      if [ -n "$ver" ]; then
        echo "$ver"
        return
      fi
    fi
  fi

  # Fallback: iTunes Search API (only sees live App Store version)
  curl -sf --max-time 8 \
    "https://itunes.apple.com/lookup?bundleId=${bundle_id}" \
    2>/dev/null \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
results = d.get('results', [])
print(results[0].get('version', '') if results else '')
" 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Helper: authenticate asc CLI on the local (Linux) machine.
# Returns 1 if asc is not installed or the .p8 key file is missing.
# ---------------------------------------------------------------------------
_asc_auth_linux() {
  if ! command -v asc &>/dev/null; then
    echo "WARNING: asc CLI not installed on this machine. Skipping ASC operations."
    return 1
  fi
  local key_file="${ASC_PRIVATE_KEY_PATH:-$HOME/.appstoreconnect/AuthKey_${ASC_KEY_ID}.p8}"
  if [ ! -f "$key_file" ]; then
    echo "WARNING: API key file not found at $key_file"
    return 1
  fi
  asc auth login \
    --bypass-keychain \
    --name "${APP_NAME:-App}-CI" \
    --key-id "$ASC_KEY_ID" \
    --issuer-id "$ASC_ISSUER_ID" \
    --private-key "$key_file" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# _asc_version_id <versionString>
#
# Prints the App Store version record's UUID, or nothing if it does not exist.
# ---------------------------------------------------------------------------
_asc_version_id() {
  asc versions list --app "$ASC_APP_ID" --version "$1" --output json 2>/dev/null \
    | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
items = d.get('data', d if isinstance(d, list) else [])
if items:
    print(items[0].get('id', ''))
" 2>/dev/null
}

# ---------------------------------------------------------------------------
# _asc_prior_encryption
#
# Prints how this app's most recent ANSWERED build declared export compliance,
# as "false", "true", or empty when no prior build has answered. Used to show
# the actual precedent at the declaration prompt rather than asserting one.
# ---------------------------------------------------------------------------
_asc_prior_encryption() {
  asc builds list --app "$ASC_APP_ID" --limit 20 --output json 2>/dev/null \
    | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for x in d.get('data', d if isinstance(d, list) else []):
    v = x.get('attributes', x).get('usesNonExemptEncryption')
    if v is not None:
        print(str(v).lower())
        break
" 2>/dev/null
}

# ---------------------------------------------------------------------------
# _asc_build_id <buildNumber>
#
# Prints "<uuid> <processingState>" for the build with that CFBundleVersion, or
# nothing if App Store Connect has not registered it yet. `asc builds list`
# reports CFBundleVersion in `version` (NOT the marketing version), and build
# numbers are unique per app, so this is an exact match rather than a guess.
# ---------------------------------------------------------------------------
_asc_build_id() {
  asc builds list --app "$ASC_APP_ID" --limit 20 --output json 2>/dev/null \
    | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
items = d.get('data', d if isinstance(d, list) else [])
want = str('$1').strip()
for x in items:
    a = x.get('attributes', x)
    if str(a.get('version', '')).strip() == want:
        print('%s %s' % (x.get('id', ''), a.get('processingState', 'UNKNOWN')))
        break
" 2>/dev/null
}

# Uses $REPO_ROOT so this works regardless of invocation directory.
# ---------------------------------------------------------------------------
_android_package_name() {
  local gradle_file="$REPO_ROOT/android/app/build.gradle"

  # 1. Try aapt on the most recently built APK (most authoritative)
  local apk="$REPO_ROOT/android/app/build/outputs/apk/release/app-release.apk"
  if [ -f "$apk" ] && command -v aapt &>/dev/null; then
    aapt dump badging "$apk" 2>/dev/null \
      | grep "^package:" \
      | sed -E "s/.*name='([^']+)'.*/\1/"
    return
  fi

  # 2. Parse applicationId from build.gradle
  if [ ! -f "$gradle_file" ]; then
    echo "    Warning: $gradle_file not found" >&2
    echo ""
    return
  fi

  grep -E 'applicationId' "$gradle_file" \
    | head -1 \
    | sed -E "s/.*applicationId[[:space:]]+['\"]([^'\"]+)['\"].*/\1/"
}

# ---------------------------------------------------------------------------
# Helper: compare two X.Y.Z version strings.
# Prints "gt" / "lt" / "eq"
# ---------------------------------------------------------------------------
_ver_cmp() {
  python3 - "$1" "$2" <<'EOF'
import sys
a = tuple(int(x) for x in sys.argv[1].split("."))
b = tuple(int(x) for x in sys.argv[2].split("."))
print("gt" if a > b else ("lt" if a < b else "eq"))
EOF
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
RELEASE_TAG=""
RETAG=false
CHECK_VERSIONS_ONLY=false
SKIP_PLAY=false
SKIP_NOSTR=false
SKIP_DESKTOP=false
SKIP_SEEDER=false
SKIP_SEEDER_STORE=false
SEEDER_IMAGE="${SEEDER_IMAGE:-ghcr.io/peerloomllc/pearcal-seeder}"

for arg in "$@"; do
  case "$arg" in
    --retag) RETAG=true ;;
    --check-versions) CHECK_VERSIONS_ONLY=true ;;
    --skip-play) SKIP_PLAY=true ;;
    --skip-nostr) SKIP_NOSTR=true ;;
    --skip-desktop) SKIP_DESKTOP=true ;;
    --skip-seeder) SKIP_SEEDER=true ;;
    --skip-seeder-store) SKIP_SEEDER_STORE=true ;;
    v[0-9]*.[0-9]*.[0-9]*)
      if [[ ! "$arg" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "Error: tag must be in format vX.Y.Z (got: $arg)"
        exit 1
      fi
      RELEASE_TAG="$arg"
      EXPLICIT_TAG="$arg"
      ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Determine release tag — entirely local via git tags
# ---------------------------------------------------------------------------
if [ -z "$RELEASE_TAG" ]; then
  # Exclude any tag that exactly matches a version we might be retrying —
  # find the highest tag that already has at least one commit since it,
  # i.e. the most recent tag that is genuinely a prior release.
  LATEST=$(git tag --sort=-version:refname \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || echo "")
  if [ -z "$LATEST" ]; then
    RELEASE_TAG="v1.0.0"
    echo "==> No prior tags found, starting at $RELEASE_TAG"
  else
    IFS='.' read -r MAJOR MINOR PATCH <<< "${LATEST#v}"
    RELEASE_TAG="v${MAJOR}.${MINOR}.$((PATCH + 1))"
    echo "==> Auto-detected next version: $RELEASE_TAG  (latest tag was $LATEST)"
  fi
fi
APP_VERSION="${RELEASE_TAG#v}"

# ---------------------------------------------------------------------------
# Handle --retag: clean up a stranded local tag from a failed previous run
# ---------------------------------------------------------------------------
if $RETAG; then
  if git tag | grep -q "^${RELEASE_TAG}$"; then
    echo "==> --retag: deleting stranded local tag $RELEASE_TAG..."
    git tag -d "$RELEASE_TAG"
    echo "    Done. Proceeding with fresh run for $RELEASE_TAG."
  else
    echo "==> --retag: local tag $RELEASE_TAG not found, nothing to clean up."
  fi
fi

if ! $CHECK_VERSIONS_ONLY; then
  _confirm "Release tag will be $RELEASE_TAG — proceed with build?"
fi

# ---------------------------------------------------------------------------
# Required credentials (skipped for --check-versions)
# ---------------------------------------------------------------------------
if ! $CHECK_VERSIONS_ONLY; then
  : "${KEYSTORE_PASSWORD:?Set KEYSTORE_PASSWORD or add it to scripts/.env}"
  : "${KEY_PASSWORD:?Set KEY_PASSWORD or add it to scripts/.env}"
  : "${SIGN_WITH:?Set SIGN_WITH (Zapstore NSEC) or add it to scripts/.env}"
  KEYSTORE_FILE="${KEYSTORE_FILE:-$HOME/keystore.jks}"
  KEY_ALIAS="${KEY_ALIAS:-${KEY_ALIAS_DEFAULT:-pearcal}}"
  if [ ! -f "$KEYSTORE_FILE" ]; then
    echo "Error: keystore not found at $KEYSTORE_FILE"
    exit 1
  fi
fi

cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Pre-flight: compare GitHub vs Zapstore versions to decide what needs doing
#
# Outcomes:
#   ZAPSTORE_ONLY=true   GitHub is ahead — skip build, publish existing release
#   ZAPSTORE_ONLY=false  Versions match (or both unknown) — full build + publish
#   exit 1               GitHub is behind Zapstore — something is wrong
# ---------------------------------------------------------------------------
ZAPSTORE_ONLY=false

# Resolve these early so the check can use them
REPO_SLUG=$(_remote_slug)
GH_TOKEN=$(_github_token)

# Read app identifier (Android package name) — used to query Zapstore relay.
# Falls back to the known hardcoded value if build.gradle can't be parsed.
ZSP_IDENTIFIER=$(_android_package_name)
if [ -z "$ZSP_IDENTIFIER" ]; then
  ZSP_IDENTIFIER="${BUNDLE_ID:-com.pearcal}"
  echo "    App identifier: $ZSP_IDENTIFIER (hardcoded fallback)"
else
  echo "    App identifier: $ZSP_IDENTIFIER"
fi

echo "==> Checking published versions..."
GH_VERSION=$(_github_latest_version "$GH_TOKEN" "$REPO_SLUG")
ZSP_VERSION_CURRENT=$(_zapstore_latest_version "$ZSP_IDENTIFIER")
PLAY_VERSION_CURRENT=$(_play_latest_version "$ZSP_IDENTIFIER" "${PLAY_SERVICE_ACCOUNT_JSON:-}" "${PLAY_TRACK:-production}")
ASC_VERSION_CURRENT=$(_appstore_latest_version "${BUNDLE_ID:-com.pearcal}")

echo "    GitHub       : ${GH_VERSION:-unknown}"
echo "    Zapstore     : ${ZSP_VERSION_CURRENT:-unknown}"
if [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] && [ -f "${PLAY_SERVICE_ACCOUNT_JSON:-}" ]; then
  echo "    Google Play  : ${PLAY_VERSION_CURRENT:-unknown} (${PLAY_TRACK:-production} track)"
elif command -v gcloud > /dev/null 2>&1 \
     && gcloud auth application-default print-access-token > /dev/null 2>&1; then
  echo "    Google Play  : ${PLAY_VERSION_CURRENT:-unknown} (${PLAY_TRACK:-production} track, via gcloud)"
else
  echo "    Google Play  : (not configured)"
fi
if [ -n "${ASC_KEY_ID:-}" ] && command -v asc &>/dev/null; then
  echo "    App Store    : ${ASC_VERSION_CURRENT:-unknown} (via ASC API - includes TestFlight/in-review)"
else
  echo "    App Store    : ${ASC_VERSION_CURRENT:-unknown} (live only; iTunes lookup)"
fi

# --check-versions: print diagnostic info and exit without doing anything else
if $CHECK_VERSIONS_ONLY; then
  echo ""
  if [ -n "$ZSP_VERSION_CURRENT" ]; then
    echo "    Zapstore relay query succeeded for identifier: $ZSP_IDENTIFIER"
  else
    echo "    Zapstore relay query returned nothing for identifier: $ZSP_IDENTIFIER"
    echo "    This could mean:"
    echo "      - The app has not been published to Zapstore yet"
    echo "      - The identifier is wrong (check applicationId in build.gradle)"
    echo "      - websocat / websockets is not installed (relay query was skipped)"
    echo "      - The relay is temporarily unreachable"
    echo ""
    echo "    To test the relay manually:"
    echo "      echo '[\"REQ\",\"test\",{\"kinds\":[30063],\"#i\":[\"${ZSP_IDENTIFIER}\"],\"limit\":5}]' \\"
    echo "        | websocat --no-close wss://relay.zapstore.dev"
  fi
  if [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] && [ -f "${PLAY_SERVICE_ACCOUNT_JSON:-}" ]; then
    echo ""
    if [ -n "$PLAY_VERSION_CURRENT" ]; then
      echo "    Google Play query succeeded: $PLAY_VERSION_CURRENT"
    else
      echo "    Google Play query returned nothing — app may not be published yet,"
      echo "    or the service account lacks permissions on the production track."
    fi
  fi
  echo ""
  if [ -n "$ASC_VERSION_CURRENT" ]; then
    if [ -n "${ASC_KEY_ID:-}" ] && command -v asc &>/dev/null; then
      echo "    App Store query succeeded: $ASC_VERSION_CURRENT (via ASC API - includes TestFlight/in-review)"
    else
      echo "    App Store query succeeded: $ASC_VERSION_CURRENT (live release only)"
    fi
  else
    echo "    App Store query returned nothing - app may not be publicly released yet."
    if ! command -v asc &>/dev/null || [ -z "${ASC_KEY_ID:-}" ]; then
      echo "    Note: using iTunes lookup (live version only). Install asc + set ASC_KEY_ID"
      echo "    for richer queries that include TestFlight and in-review builds."
    fi
  fi
  exit 0
fi

if [ -n "${EXPLICIT_TAG:-}" ]; then
  GH_HAS_VERSION=false
  ZSP_HAS_VERSION=false
  PLAY_HAS_VERSION=false
  ASC_HAS_VERSION=false
  [ "$GH_VERSION" = "$APP_VERSION" ]           && GH_HAS_VERSION=true
  [ "$ZSP_VERSION_CURRENT" = "$APP_VERSION" ]  && ZSP_HAS_VERSION=true
  [ "$PLAY_VERSION_CURRENT" = "$APP_VERSION" ] && PLAY_HAS_VERSION=true
  [ "$ASC_VERSION_CURRENT"  = "$APP_VERSION" ] && ASC_HAS_VERSION=true

  # Build a human-readable summary of what's already published
  _already=""
  $GH_HAS_VERSION   && _already="${_already}GitHub, "
  $ZSP_HAS_VERSION  && _already="${_already}Zapstore, "
  $PLAY_HAS_VERSION && _already="${_already}Google Play, "
  $ASC_HAS_VERSION  && _already="${_already}App Store, "
  _already="${_already%, }"   # strip trailing comma+space

  # Check if all configured destinations already have this version
  _all_have=true
  $GH_HAS_VERSION  || _all_have=false
  $ZSP_HAS_VERSION || _all_have=false
  if [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] && [ -f "${PLAY_SERVICE_ACCOUNT_JSON:-}" ]; then
    $PLAY_HAS_VERSION || _all_have=false
  fi
  if [ -n "${ASC_APPLE_ID:-}" ] && [ -n "${ASC_APP_PASSWORD:-}" ]; then
    $ASC_HAS_VERSION || _all_have=false
  fi

  if $_all_have; then
    echo ""
    echo "    $RELEASE_TAG is already published on all configured destinations: $_already"
    echo "    Nothing to do unless you want to republish (e.g. to fix release notes)."
    echo ""
    while true; do
      read -rp "    Proceed to destination selection anyway? [y/n] " _reply
      case "$_reply" in
        [Yy]) break ;;
        [Nn]) echo "Aborted."; exit 0 ;;
        *) echo "    Please enter y or n." ;;
      esac
    done

  elif $GH_HAS_VERSION && ! $ZSP_HAS_VERSION && $ASC_HAS_VERSION; then
    echo ""
    echo "    $RELEASE_TAG exists on GitHub and App Store but not on Zapstore — publishing to Zapstore only."
    ZAPSTORE_ONLY=true

  elif $GH_HAS_VERSION && ! $ZSP_HAS_VERSION; then
    echo ""
    echo "    $RELEASE_TAG exists on GitHub but not on Zapstore or App Store — proceed to destination selection."

  elif ! $GH_HAS_VERSION; then
    echo ""
    echo "    $RELEASE_TAG does not exist on GitHub yet — running full build."
  fi

else
  # -------------------------------------------------------------------------
  # Auto-detected version — compare latest published versions to decide route.
  # -------------------------------------------------------------------------
  if [ -n "$GH_VERSION" ] && [ -n "$ZSP_VERSION_CURRENT" ]; then
    CMP=$(_ver_cmp "$GH_VERSION" "$ZSP_VERSION_CURRENT")
    case "$CMP" in
      gt)
        echo ""
        echo "==> GitHub ($GH_VERSION) is ahead of Zapstore ($ZSP_VERSION_CURRENT)."
        echo "    Skipping build — will publish existing GitHub release to Zapstore only."
        RELEASE_TAG="v${GH_VERSION}"
        APP_VERSION="$GH_VERSION"
        echo "    Using release tag: $RELEASE_TAG"
        ZAPSTORE_ONLY=true
        ;;
      lt)
        echo ""
        echo "ERROR: Zapstore ($ZSP_VERSION_CURRENT) is ahead of GitHub ($GH_VERSION)."
        echo "       This should not happen. Check both platforms before proceeding."
        echo "       To override, pass the version explicitly: ./scripts/release.sh v${ZSP_VERSION_CURRENT}"
        exit 1
        ;;
      eq)
        echo "    Versions match ($GH_VERSION) — proceeding with full build for next version."
        ;;
    esac

  elif [ -n "$GH_VERSION" ] && [ -z "$ZSP_VERSION_CURRENT" ]; then
    echo ""
    echo "    Zapstore version unknown (app may not be listed yet or API unavailable)."
    echo ""
    if [ "$GH_VERSION" = "$APP_VERSION" ]; then
      echo "    GitHub already has $GH_VERSION — a full build would create a duplicate."
      echo ""
      echo "    Options:"
      echo "      y = publish existing GitHub release ($GH_VERSION) to Zapstore only"
      echo "      n = run full build for next version ($(
            IFS='.' read -r _ma _mi _pa <<< "$GH_VERSION"
            echo "v${_ma}.${_mi}.$((_pa + 1))"
          ))"
      echo "      q = quit"
      echo ""
      while true; do
        read -rp "    How do you want to proceed? [y/n/q] " _zsp_reply
        case "$_zsp_reply" in
          [Yy])
            RELEASE_TAG="v${GH_VERSION}"
            APP_VERSION="$GH_VERSION"
            ZAPSTORE_ONLY=true
            echo "    Using existing GitHub release $RELEASE_TAG — Zapstore publish only."
            break ;;
          [Nn])
            IFS='.' read -r _ma _mi _pa <<< "$GH_VERSION"
            RELEASE_TAG="v${_ma}.${_mi}.$((_pa + 1))"
            APP_VERSION="${RELEASE_TAG#v}"
            echo "    Proceeding with full build for $RELEASE_TAG."
            break ;;
          [Qq]) echo "Aborted."; exit 0 ;;
          *) echo "    Please enter y, n, or q." ;;
        esac
      done
    else
      echo "    Cannot determine if Zapstore is up to date."
      echo ""
      echo "    Options:"
      echo "      y = force publish GitHub release $GH_VERSION to Zapstore now"
      echo "      n = proceed with full build for $RELEASE_TAG"
      echo "      q = quit"
      echo ""
      while true; do
        read -rp "    How do you want to proceed? [y/n/q] " _zsp_reply
        case "$_zsp_reply" in
          [Yy])
            RELEASE_TAG="v${GH_VERSION}"
            APP_VERSION="$GH_VERSION"
            ZAPSTORE_ONLY=true
            echo "    Force-publishing GitHub release $RELEASE_TAG to Zapstore."
            break ;;
          [Nn])
            echo "    Proceeding with full build for $RELEASE_TAG."
            break ;;
          [Qq]) echo "Aborted."; exit 0 ;;
          *) echo "    Please enter y, n, or q." ;;
        esac
      done
    fi

  else
    echo "    Could not determine one or both versions — proceeding with normal flow."
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# Destination selection — ask which targets to publish to before any build
# work starts. Skipped in ZAPSTORE_ONLY mode (destinations are implied).
# ---------------------------------------------------------------------------
PUBLISH_GITHUB=true
PUBLISH_ZAPSTORE=true
PUBLISH_NOSTR=true
NEEDS_BUILD=false  # set true inside the destination-prompt block when any selected destination needs an APK/AAB/desktop artifact; stays false in ZAPSTORE_ONLY mode (we just republish the existing release).
DESKTOP_ARTIFACTS=()  # populated by the desktop build phase below; iterated by the GitHub-release upload loop. Init here so the upload loop is safe even when ZAPSTORE_ONLY skips the build phase.
CHECKSUM_ARTIFACTS=() # .sha256 sidecars generated by step 4e for the APK and the desktop
                      # artifacts. The seeder build makes its own sidecars, so those stay in
                      # SEEDER_ARTIFACTS. Uploaded alongside the binaries they cover.
SEEDER_ARTIFACTS=()   # blind-seeder installers + their .sha256 sidecars (auto-update assets). Same lifecycle as DESKTOP_ARTIFACTS: populated by the seeder build phase, uploaded to the GitHub Release.
PUBLISH_PLAY=false
PUBLISH_APP_STORE=false
PUBLISH_FAILED=false   # set to true if any selected publish step fails

# Play is available if either gcloud is authenticated or a SA JSON is present
_play_configured() {
  command -v gcloud > /dev/null 2>&1 \
    && gcloud auth application-default print-access-token > /dev/null 2>&1 \
    && return 0
  [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] && [ -f "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] \
    && return 0
  return 1
}
_play_configured && PUBLISH_PLAY=true

_appstore_configured() {
  # Mac Mini must be reachable for the xcodebuild archive+export step
  ssh -o ConnectTimeout=5 -o BatchMode=yes "${MAC_MINI_HOST:-Tims-Mac-mini.local}" exit 2>/dev/null || return 1
  # Prefer API key auth, fall back to legacy app-specific password
  if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_APP_ID:-}" ]; then
    return 0
  fi
  [ -n "${ASC_APPLE_ID:-}" ] && [ -n "${ASC_APP_PASSWORD:-}" ] && return 0
  return 1
}
_appstore_configured && PUBLISH_APP_STORE=true

# Desktop builds: the signed .dmg needs the Mac Mini (Developer ID keychain);
# the Windows .exe and Linux .AppImage both cross-build LOCALLY via
# electron-builder (the .exe target needs wine for rcedit/NSIS). So only the Mac
# Mini gates the check - if it's unreachable, desktop is unavailable. The
# Windows sub-build errors on its own in the build phase if wine is missing.
# Honors --skip-desktop to opt out even when the Mac is up.
PUBLISH_DESKTOP=false
_desktop_configured() {
  $SKIP_DESKTOP && return 1
  ssh -o ConnectTimeout=5 -o BatchMode=yes "${MAC_MINI_HOST:-Tims-Mac-mini.local}" exit 2>/dev/null || return 1
  return 0
}
_desktop_configured && PUBLISH_DESKTOP=true

# Blind-seeder installers (auto-update assets attached to the GitHub Release, so a
# self-managed seeder can self-update — see seeder-launcher/host/updateCheck.js +
# src/lib/seederUpdateCheck.js). Linux .AppImage + .deb and the Windows .exe all
# cross-build LOCALLY (appimagetool/dpkg-deb/makensis); only the macOS .pkg needs
# the Mac Mini over SSH. So the seeder is "configured" whenever the local tooling
# is present — the .pkg is best-effort on top (skipped, with a note, if the Mac is
# unreachable). Store-managed deploys (Umbrel/Start9/Docker) update through their
# marketplace and gate their own update check OFF, so they are NOT built here.
PUBLISH_SEEDER=false
_seeder_configured() {
  $SKIP_SEEDER && return 1
  # The Linux seeder .deb needs dpkg-deb; the Windows .exe needs makensis. If
  # neither local packer is present there is nothing we can build locally, so
  # treat the seeder as unavailable (the .pkg alone isn't worth a prompt).
  command -v dpkg-deb >/dev/null 2>&1 && return 0
  command -v makensis >/dev/null 2>&1 && return 0
  command -v mingw32-makensis >/dev/null 2>&1 && return 0
  return 1
}
_seeder_configured && PUBLISH_SEEDER=true

# Blind-seeder STORE artifacts (Docker image → ghcr + Start9 .s9pk + the combined
# StartOS community registry on the website). Heavier + slower than the installers
# (a multi-arch image build/push + a ~hundreds-of-MB s9pk pack), so it's a separate
# opt-in. Needs podman (build/push), start-sdk + deno + yq + skopeo (s9pk), an
# existing ghcr login, and — for the registry publish — WEBSITE_DIR pointing at a
# website clone. These publish the Umbrel/Start9 packages; the mobile app release
# doesn't need them.
PUBLISH_SEEDER_STORE=false
_seeder_store_configured() {
  $SKIP_SEEDER_STORE && return 1
  command -v podman   >/dev/null 2>&1 || return 1
  command -v start-sdk >/dev/null 2>&1 || return 1
  command -v skopeo   >/dev/null 2>&1 || return 1
  command -v deno     >/dev/null 2>&1 || return 1
  command -v yq       >/dev/null 2>&1 || return 1
  # Must already be logged in to ghcr (the image push needs write:packages).
  podman login --get-login "${SEEDER_IMAGE%%/*}" >/dev/null 2>&1 || \
    podman login --get-login ghcr.io >/dev/null 2>&1 || return 1
  return 0
}
_seeder_store_configured && PUBLISH_SEEDER_STORE=true

if ! $ZAPSTORE_ONLY && ! $CHECK_VERSIONS_ONLY; then
  echo "==> Select publish destinations for $RELEASE_TAG:"
  echo ""

  # GitHub
  while true; do
    read -rp "    Publish to GitHub Releases? [Y/n] " _r
    case "${_r:-y}" in
      [Yy]) PUBLISH_GITHUB=true;  echo "    ✓ GitHub"; break ;;
      [Nn]) PUBLISH_GITHUB=false; echo "    ✗ GitHub (skipped)"; break ;;
      *) echo "    Please enter y or n." ;;
    esac
  done

  # Zapstore
  while true; do
    read -rp "    Publish to Zapstore? [Y/n] " _r
    case "${_r:-y}" in
      [Yy]) PUBLISH_ZAPSTORE=true;  echo "    ✓ Zapstore"; break ;;
      [Nn]) PUBLISH_ZAPSTORE=false; echo "    ✗ Zapstore (skipped)"; break ;;
      *) echo "    Please enter y or n." ;;
    esac
  done

  # Google Play — only prompt if gcloud or SA JSON is configured
  if _play_configured; then
    while true; do
      read -rp "    Publish to Google Play (${PLAY_TRACK:-production} track)? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_PLAY=true;  echo "    ✓ Google Play"; break ;;
        [Nn]) PUBLISH_PLAY=false; echo "    ✗ Google Play (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  else
    PUBLISH_PLAY=false
    echo "    - Google Play (not configured — run 'gcloud auth application-default login' to enable)"
  fi

  # Apple App Store — only prompt if Mac Mini is reachable and credentials are set
  if _appstore_configured; then
    while true; do
      read -rp "    Publish to Apple App Store? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_APP_STORE=true;  echo "    ✓ Apple App Store"; break ;;
        [Nn]) PUBLISH_APP_STORE=false; echo "    ✗ Apple App Store (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  else
    PUBLISH_APP_STORE=false
    echo "    - Apple App Store (not configured - set ASC_KEY_ID + ASC_ISSUER_ID + ASC_APP_ID, or legacy ASC_APPLE_ID + ASC_APP_PASSWORD; ensure ${MAC_MINI_HOST:-Tims-Mac-mini.local} is reachable)"
  fi

  # Desktop builds — uploaded as additional artifacts on the GitHub Release.
  # Linux .AppImage + .deb builds locally; Mac arm64+x64 .dmg builds via Mac
  # Mini SSH (signed Developer ID, NOT notarized — Sequoia LAN-gate workaround,
  # see feedback_macos_lan_gate_hardened_runtime.md); Win .exe builds via Win
  # VM SSH (currently unsigned). All three run in parallel.
  if $SKIP_DESKTOP; then
    PUBLISH_DESKTOP=false
    echo "    - Desktop (skipped via --skip-desktop)"
  elif _desktop_configured; then
    while true; do
      read -rp "    Publish desktop builds (Linux/Mac/Win) to GitHub Release? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_DESKTOP=true;  echo "    ✓ Desktop"; break ;;
        [Nn]) PUBLISH_DESKTOP=false; echo "    ✗ Desktop (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  else
    PUBLISH_DESKTOP=false
    echo "    - Desktop (not configured — Mac Mini ${MAC_MINI_HOST:-Tims-Mac-mini.local} unreachable)"
  fi
  # Desktop builds attach to the GitHub Release, so they need GitHub as the
  # upload target. If the user picked Desktop but declined GitHub, auto-enable
  # GitHub rather than silently dropping Desktop (which would then trip the
  # "No destinations selected" bail-out below).
  if $PUBLISH_DESKTOP && ! $PUBLISH_GITHUB; then
    echo "    Note: desktop builds need GitHub Release as upload target — auto-enabling GitHub."
    PUBLISH_GITHUB=true
  fi

  # Blind-seeder installers — attach to the GitHub Release as auto-update assets.
  if $SKIP_SEEDER; then
    PUBLISH_SEEDER=false
    echo "    - Seeder installers (skipped via --skip-seeder)"
  elif _seeder_configured; then
    _seeder_mac_note=""
    ssh -o ConnectTimeout=5 -o BatchMode=yes "${MAC_MINI_HOST:-Tims-Mac-mini.local}" exit 2>/dev/null \
      || _seeder_mac_note=" (macOS .pkg skipped — ${MAC_MINI_HOST:-Tims-Mac-mini.local} unreachable)"
    while true; do
      read -rp "    Publish blind-seeder installers (Linux/Win/macOS) to GitHub Release?${_seeder_mac_note} [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_SEEDER=true;  echo "    ✓ Seeder installers"; break ;;
        [Nn]) PUBLISH_SEEDER=false; echo "    ✗ Seeder installers (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  else
    PUBLISH_SEEDER=false
    echo "    - Seeder installers (not configured — need dpkg-deb and/or makensis locally)"
  fi
  # Seeder installers attach to the GitHub Release too — same auto-enable rule.
  if $PUBLISH_SEEDER && ! $PUBLISH_GITHUB; then
    echo "    Note: seeder installers need GitHub Release as upload target — auto-enabling GitHub."
    PUBLISH_GITHUB=true
  fi

  # Blind-seeder STORE artifacts — Docker image → ghcr + Start9 .s9pk (release
  # asset) + the combined StartOS registry on the website.
  if $SKIP_SEEDER_STORE; then
    PUBLISH_SEEDER_STORE=false
    echo "    - Seeder store artifacts (skipped via --skip-seeder-store)"
  elif _seeder_store_configured; then
    _store_reg_note=""
    { [ -n "${WEBSITE_DIR:-}" ] && [ -d "${WEBSITE_DIR:-}/.git" ]; } \
      || _store_reg_note=" (Start9 registry publish skipped — set WEBSITE_DIR to a website clone)"
    while true; do
      read -rp "    Publish seeder store artifacts (ghcr image + Start9 .s9pk + registry)?${_store_reg_note} [y/N] " _r
      case "${_r:-n}" in
        [Yy]) PUBLISH_SEEDER_STORE=true;  echo "    ✓ Seeder store artifacts"; break ;;
        [Nn]) PUBLISH_SEEDER_STORE=false; echo "    ✗ Seeder store artifacts (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  else
    PUBLISH_SEEDER_STORE=false
    echo "    - Seeder store artifacts (not configured — need podman+start-sdk+skopeo+deno+yq and a ghcr login)"
  fi
  # The .s9pk uploads to the GitHub Release (the registry redirects to it).
  if $PUBLISH_SEEDER_STORE && ! $PUBLISH_GITHUB; then
    echo "    Note: seeder store artifacts need GitHub Release as upload target — auto-enabling GitHub."
    PUBLISH_GITHUB=true
  fi

  # Nostr announcement
  if $SKIP_NOSTR; then
    PUBLISH_NOSTR=false
    echo "    - Nostr (skipped via --skip-nostr)"
  else
    while true; do
      read -rp "    Post release announcement to Nostr? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_NOSTR=true;  echo "    ✓ Nostr"; break ;;
        [Nn]) PUBLISH_NOSTR=false; echo "    ✗ Nostr (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  fi

  echo ""

  # Bail out if nothing selected
  if ! $PUBLISH_GITHUB && ! $PUBLISH_ZAPSTORE && ! $PUBLISH_NOSTR && ! $PUBLISH_PLAY && ! $PUBLISH_APP_STORE && ! $PUBLISH_DESKTOP && ! $PUBLISH_SEEDER && ! $PUBLISH_SEEDER_STORE; then
    echo "No destinations selected. Aborted."
    exit 0
  fi

  # Determine if any selected destination needs a build
  NEEDS_BUILD=false
  if $PUBLISH_GITHUB || $PUBLISH_ZAPSTORE || $PUBLISH_PLAY || $PUBLISH_APP_STORE; then
    NEEDS_BUILD=true
  fi

  # Google Play requires an AAB — warn if Play is selected alongside APK targets
  if $PUBLISH_PLAY; then
    echo "    Note: Google Play requires AAB format. Both APK and AAB will be built."
    echo ""
  fi

  # Desktop builds also need NEEDS_BUILD even when no other publish target wants
  # one (e.g., desktop-only release). Folded after the Play warning so the
  # earlier flag math doesn't need rework.
  if $PUBLISH_DESKTOP; then NEEDS_BUILD=true; fi
  # Seeder installers likewise — a seeder-only release must still build.
  if $PUBLISH_SEEDER; then NEEDS_BUILD=true; fi
  # Store artifacts need a build too (image push + s9pk pack).
  if $PUBLISH_SEEDER_STORE; then NEEDS_BUILD=true; fi
fi

# Artifact names and sizes, declared before the build fences so the post-notes
# checksum step and the final gate are safe to reference them on a run that
# skipped the build entirely (a Zapstore-only republish). set -u is on.
APK_NAME=""; APK_SIZE=""
AAB_NAME=""; AAB_SIZE=""

if $NEEDS_BUILD; then

# ---------------------------------------------------------------------------
# 0. Update app.json version and versionCode
# ---------------------------------------------------------------------------
echo "==> Updating app.json to $APP_VERSION..."
APP_VERSION="$APP_VERSION" node -e "
  const fs = require('fs');
  const f = 'app.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const v = process.env.APP_VERSION;
  const [major, minor, patch] = v.split('.').map(Number);
  const versionCode = major * 1000000 + minor * 1000 + patch;
  j.expo.version = v;
  if (!j.expo.android) j.expo.android = {};
  j.expo.android.versionCode = versionCode;
  if (!j.expo.ios) j.expo.ios = {};
  const prevBuild = parseInt(j.expo.ios.buildNumber || '1', 10);
  j.expo.ios.buildNumber = String(prevBuild + 1);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  console.log('Updated app.json to ' + v + ' (versionCode: ' + versionCode + ', iOS buildNumber: ' + j.expo.ios.buildNumber + ')');
"

# Sync electron/package.json#version so esbuild's --define injects the right
# string into the desktop bundle and electron-builder names the .dmg / .exe /
# .AppImage with the release version. Skipped if electron/ subproject is
# missing (e.g., a future strip-down where desktop is a separate repo).
if [ -f electron/package.json ]; then
  echo "==> Updating electron/package.json to $APP_VERSION..."
  APP_VERSION="$APP_VERSION" node -e "
    const fs = require('fs');
    const f = 'electron/package.json';
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.version = process.env.APP_VERSION;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
    console.log('Updated electron/package.json to ' + j.version);
  "
fi

# Derive APP_VERSION_CODE from the version string for Gradle
IFS='.' read -r _vmaj _vmin _vpat <<< "$APP_VERSION"
APP_VERSION_CODE=$(( _vmaj * 1000000 + _vmin * 1000 + _vpat ))
export APP_VERSION_CODE

# Sync iOS version into project.pbxproj so xcodebuild picks up the right values
_ios_build_number=$(node -p "require('./app.json').expo.ios.buildNumber")
sed -i \
  "s/CURRENT_PROJECT_VERSION = [0-9][0-9]*/CURRENT_PROJECT_VERSION = ${_ios_build_number}/g; \
   s/MARKETING_VERSION = [0-9][0-9.]*;/MARKETING_VERSION = ${APP_VERSION};/g" \
  "${XCODE_PROJECT:-ios/PearCal.xcodeproj/project.pbxproj}"

echo "    Version     : $(node -p "require('./app.json').expo.version")"
echo "    versionCode : $(node -p "require('./app.json').expo.android.versionCode")"
echo "    iOS build   : $(node -p "require('./app.json').expo.ios.buildNumber")"
_confirm "app.json version looks correct — proceed with bundle builds?"

# ---------------------------------------------------------------------------
# 1. Canonical verify gate (tests + all bundles)
#
# Constitution §5 gate: the unit tests run first and a red suite aborts the
# release via set -e, then every bundle the release ships is rebuilt.
#
# The bundle commands stay inlined rather than delegated to `npm run verify`,
# so what a release builds is visible right here rather than one indirection
# away. They are no longer DIFFERENT, though: as of #132, package.json's
# bundle:ui builds this exact command and reproduces the shipped bundle
# byte-for-byte, and `npm run verify` no longer writes to the tracked artifact
# at all (it builds the UI to a throwaway path purely to prove it compiles).
# ---------------------------------------------------------------------------
echo "==> Running unit tests..."
npm test

echo "==> Building UI bundle..."
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle

echo "==> Building Bare bundle..."
# --defer fs --defer path: bare.js conditional-requires Node's `fs` and
# `path` modules as a fallback for the Electron desktop path
# (`typeof Bare !== 'undefined' ? require('bare-fs') : require('fs')`).
# bare-pack does static traversal and trips on the Node builtin branch
# even though it's never taken on mobile. Deferring resolution leaves
# those requires for runtime — Bare uses bare-fs/bare-path, Electron's
# Node has the real builtins.
node_modules/.bin/bare-pack --linked --defer fs --defer path src/bare.js -o assets/bare-universal.bundle

if $PUBLISH_APP_STORE; then
  echo "==> Building iOS Bare bundle..."
  node_modules/.bin/bare-pack --host ios-arm64 --linked --defer fs --defer path src/bare.js -o assets/bare-ios.bundle
fi

# ---------------------------------------------------------------------------
# 2. Native project preparation
#
# android/ is checked into this repo, so there is nothing to regenerate here.
# The step holds the slot: PearList and PearPetal gitignore android/ and run
# `expo prebuild --clean` at this point to apply the release-signing config
# plugin. Keeping the number reserved is what lets the pipeline checker tell
# "this app has no prebuild" apart from "this app runs prebuild in the wrong
# place". See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
echo "==> Native project: android/ is checked in, no prebuild needed."

# ---------------------------------------------------------------------------
# 3. Build signed release APK (and AAB if publishing to Google Play)
# ---------------------------------------------------------------------------
# React Native 0.81's gradle plugin doesn't support JDK 25 (which Fedora 44
# ships as the default). Pin Gradle to JDK 17 or 21 if the system default is
# newer. Prefers $ANDROID_JAVA_HOME, then $JAVA_HOME (if it's <=21), then
# probes well-known install paths.
pick_android_java_home() {
  _is_supported_jdk() {
    local home="$1"
    [ -x "$home/bin/java" ] || return 1
    local ver
    ver=$("$home/bin/java" -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+).*/\1/')
    case "$ver" in
      17|21) return 0 ;;
      *) return 1 ;;
    esac
  }
  if [ -n "${ANDROID_JAVA_HOME:-}" ] && _is_supported_jdk "$ANDROID_JAVA_HOME"; then
    echo "$ANDROID_JAVA_HOME"; return
  fi
  if [ -n "${JAVA_HOME:-}" ] && _is_supported_jdk "$JAVA_HOME"; then
    echo "$JAVA_HOME"; return
  fi
  for candidate in \
    /usr/lib/jvm/temurin-21-jdk \
    /usr/lib/jvm/java-21-temurin-jdk \
    /usr/lib/jvm/java-21-openjdk \
    /usr/lib/jvm/java-17-openjdk \
    /Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home \
    /Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home; do
    if _is_supported_jdk "$candidate"; then
      echo "$candidate"; return
    fi
  done
  return 1
}

ANDROID_JAVA=""
if ANDROID_JAVA="$(pick_android_java_home)"; then
  echo "==> Using JDK for Gradle: $ANDROID_JAVA"
else
  echo "Error: no supported JDK (17 or 21) found for the Android build."
  echo "       Install one (e.g. 'sudo dnf install temurin-21-jdk') or set ANDROID_JAVA_HOME."
  exit 1
fi

echo "==> Building signed release APK (this takes a few minutes)..."
(
  export KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD KEY_PASSWORD APP_VERSION APP_VERSION_CODE
  export JAVA_HOME="$ANDROID_JAVA"
  export PATH="$ANDROID_JAVA/bin:$PATH"
  cd android && ./gradlew assembleRelease -q
)

if $PUBLISH_PLAY; then
  echo "==> Building signed release AAB for Google Play..."
  (
    export KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD KEY_PASSWORD APP_VERSION APP_VERSION_CODE
    export JAVA_HOME="$ANDROID_JAVA"
    export PATH="$ANDROID_JAVA/bin:$PATH"
    cd android && ./gradlew bundleRelease -q
  )
fi

# ---------------------------------------------------------------------------
# 4. Copy artifacts with version names
# ---------------------------------------------------------------------------
APK_NAME="${ARTIFACT_PREFIX:-pearcal}-${RELEASE_TAG}.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$APK_NAME"
APK_SIZE=$(du -sh "$APK_NAME" | cut -f1)
echo "==> Built APK: $APK_NAME  ($APK_SIZE)"

AAB_NAME=""
if $PUBLISH_PLAY; then
  AAB_NAME="${ARTIFACT_PREFIX:-pearcal}-${RELEASE_TAG}.aab"
  cp android/app/build/outputs/bundle/release/app-release.aab "$AAB_NAME"
  AAB_SIZE=$(du -sh "$AAB_NAME" | cut -f1)
  echo "==> Built AAB: $AAB_NAME  ($AAB_SIZE)"
fi

# ---------------------------------------------------------------------------
# 4e. Generate .sha256 sidecars for the mobile artifacts
#
# PearCal was the only app in the suite shipping its APK with no checksum:
# the seeder build made its own sidecars and the mobile artifacts had none.
# Anyone sideloading the APK from GitHub had nothing to verify it against.
# See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
for _artifact in "${APK_NAME:-}" "${AAB_NAME:-}"; do
  [ -z "$_artifact" ] && continue
  [ -f "$_artifact" ] || continue
  ( cd "$REPO_ROOT" && sha256sum "$_artifact" > "${_artifact}.sha256" )
  echo "    sha256  $(cut -d' ' -f1 < "${_artifact}.sha256")  $_artifact"
  # The AAB goes to Play, not to the GitHub release, so its sidecar stays local
  [ "$_artifact" != "${AAB_NAME:-}" ] && CHECKSUM_ARTIFACTS+=("${_artifact}.sha256")
done

echo ""
_BUILD_SUMMARY="APK (${APK_SIZE:-?})"
if $PUBLISH_PLAY && [ -n "${AAB_NAME:-}" ]; then _BUILD_SUMMARY="$_BUILD_SUMMARY, AAB ($AAB_SIZE)"; fi
_confirm "$_BUILD_SUMMARY look correct — proceed with release notes?"

fi # end NEEDS_BUILD

# ---------------------------------------------------------------------------
# 5. Generate release notes from git log / merge commits
#
# Strategy (no gh pr list needed):
#   a) Find the commit that the previous vX.Y.Z tag points to.
#   b) Walk git log from that point to HEAD.
#   c) Each merge commit (two parents) is treated as a merged PR.
#      - The merge commit subject becomes the PR title.
#      - Lines after a blank line in the commit body become the summary,
#        honouring the "## Summary" section if present (same as before).
#   d) Non-merge commits are grouped under "Other commits" as a bullet list.
#
# If GITHUB_TOKEN is available we attempt to enrich merge-commit titles with
# the real PR title from the GitHub API, but this is purely cosmetic and the
# script continues without it if the API call fails.
# ---------------------------------------------------------------------------
echo "==> Generating release notes from git log..."

PREV_TAG=$(git tag --sort=-version:refname \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | grep -v "^${RELEASE_TAG}$" \
  | head -1 || echo "")

if [ -n "$PREV_TAG" ]; then
  LOG_RANGE="${PREV_TAG}..HEAD"
  echo "    Commits since $PREV_TAG"
else
  LOG_RANGE="HEAD"
  echo "    No previous tag — including all commits"
fi

# Resolve repo slug for optional GitHub API enrichment
REPO_SLUG=$(_remote_slug)
GH_TOKEN=$(_github_token)

# Build an associative array: merge-commit sha -> PR number (best-effort)
declare -A PR_NUM_FOR_SHA
if [ -n "$REPO_SLUG" ] && [ -n "$GH_TOKEN" ]; then
  # Pull PR numbers from merge commit subjects that look like
  # "Merge pull request #123 from …" (GitHub's default merge message)
  while IFS='|' read -r sha subject; do
    if [[ "$subject" =~ Merge\ pull\ request\ #([0-9]+) ]]; then
      PR_NUM_FOR_SHA["$sha"]="${BASH_REMATCH[1]}"
    fi
  done < <(git log "$LOG_RANGE" --merges --format="%H|%s")
fi

FEAT_LINES=""
FIX_LINES=""
OTHER_LINES=""

# Helper: strip conventional commit prefix (feat:, fix:, etc.) from a title,
# returning just the description. Handles optional scope e.g. feat(ui): ...
_strip_prefix() {
  printf '%s' "$1" | sed -E 's/^[a-z]+(\([^)]*\))?!?:[[:space:]]*//'
}

# Helper: categorise a title into feat / fix / other
_category() {
  if [[ "$1" =~ ^feat(\([^\)]*\))?!?: ]]; then
    echo "feat"
  elif [[ "$1" =~ ^fix(\([^\)]*\))?!?: ]]; then
    echo "fix"
  else
    echo "other"
  fi
}

# Helper: append an entry to the right bucket.
# Usage: _add_entry "<raw title>" "<optional summary>"
_add_entry() {
  local raw_title="$1"
  local summary="$2"
  local cat
  cat=$(_category "$raw_title")
  local clean_title
  clean_title=$(_strip_prefix "$raw_title")

  local entry="- **${clean_title}**"
  [ -n "$summary" ] && entry="${entry}: ${summary}"
  entry="${entry}\n"

  case "$cat" in
    feat)  FEAT_LINES="${FEAT_LINES}${entry}" ;;
    fix)   FIX_LINES="${FIX_LINES}${entry}" ;;
    *)     OTHER_LINES="${OTHER_LINES}${entry}" ;;
  esac
}

# Process merge commits (treated as PRs) oldest-first
while IFS= read -r sha; do
  [[ -z "$sha" ]] && continue

  SUBJECT=$(git log -1 --format="%s" "$sha")
  BODY=$(git log -1 --format="%b" "$sha")

  # Derive a clean title ---------------------------------------------------
  TITLE="$SUBJECT"

  # Strip GitHub's boilerplate "Merge pull request #N from branch" prefix
  if [[ "$TITLE" =~ ^Merge\ pull\ request\ #[0-9]+\ from\ (.+)$ ]]; then
    BRANCH_TITLE="${BASH_REMATCH[1]}"
    # Try to get the real PR title from the API if we have a token
    PR_NUM="${PR_NUM_FOR_SHA[$sha]:-}"
    if [ -n "$PR_NUM" ] && [ -n "$REPO_SLUG" ] && [ -n "$GH_TOKEN" ]; then
      API_TITLE=$(curl -sf \
        -H "Authorization: Bearer $GH_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/${REPO_SLUG}/pulls/${PR_NUM}" \
        2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('title',''))" \
        2>/dev/null || echo "")
      [ -n "$API_TITLE" ] && TITLE="$API_TITLE"
    fi
    # Fallback: humanise the branch name
    if [[ "$TITLE" == "$SUBJECT" ]]; then
      TITLE=$(printf '%s' "$BRANCH_TITLE" \
        | sed -E 's|^[^/]+/||; s/[-_]/ /g')
    fi
  fi

  # Extract summary from commit body (honours "## Summary" section) --------
  SUMMARY=""
  if [ -n "$BODY" ]; then
    SUMMARY=$(printf '%s' "$BODY" \
      | awk '/^## Summary/{f=1;next} /^## /{if(f)exit} f && /\S/{print}')
    if [ -z "$SUMMARY" ]; then
      SUMMARY=$(printf '%s' "$BODY" \
        | awk 'NF{p=1} p && /^$/{exit} p{print}')
    fi
  fi

  # Skip summary if it's a duplicate of the title (with or without prefix)
  if [ -n "$SUMMARY" ]; then
    CLEAN_TITLE=$(_strip_prefix "$TITLE")
    CLEAN_SUMMARY=$(_strip_prefix "$SUMMARY")
    if [ "$CLEAN_SUMMARY" = "$CLEAN_TITLE" ] || [ "$SUMMARY" = "$TITLE" ]; then
      SUMMARY=""
    fi
  fi

  _add_entry "$TITLE" "$SUMMARY"
done < <(git log "$LOG_RANGE" --merges --format="%H" --reverse)

# Collect non-merge commits made directly on the branch (--first-parent
# excludes commits that arrived via merged PRs, avoiding near-duplicates)
while IFS='|' read -r sha subject; do
  [[ -z "$subject" ]] && continue
  _add_entry "$subject" ""
done < <(git log "$LOG_RANGE" --no-merges --first-parent --format="%H|%s")

# Assemble final notes ------------------------------------------------------
NOTES="## What's Changed\n\n"

if [ -z "$FEAT_LINES" ] && [ -z "$FIX_LINES" ] && [ -z "$OTHER_LINES" ]; then
  NOTES="${NOTES}No commits since last release.\n"
else
  [ -n "$FEAT_LINES" ] && NOTES="${NOTES}### ✨ Improvements\n\n${FEAT_LINES}\n"
  [ -n "$FIX_LINES"  ] && NOTES="${NOTES}### 🐛 Bug Fixes\n\n${FIX_LINES}\n"
  [ -n "$OTHER_LINES" ] && NOTES="${NOTES}### 🔧 Other\n\n${OTHER_LINES}\n"
fi

printf "%b" "$NOTES" > release_notes.md
sed -i 's/\*\*//g' release_notes.md
echo "    Opening release notes in vi for review/editing..."
vi release_notes.md
echo "--- Release notes ---"
cat release_notes.md
echo "---"
_confirm "Release notes look good?"

# Auto-populate iOS metadata release notes if the directory exists
if [ -d "$REPO_ROOT/metadata/ios/en-US" ]; then
  cp release_notes.md "$REPO_ROOT/metadata/ios/en-US/release_notes.txt"
  echo "    Updated metadata/ios/en-US/release_notes.txt"
fi

# ---------------------------------------------------------------------------
# Phase B (slow) — the desktop, seeder and store builds run here, AFTER the
# release notes are finalized, so they run unattended instead of making you
# wait before you can edit the notes. Adopted suite-wide from PearCircle.
# Still gated on NEEDS_BUILD and still best-effort. See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
if $NEEDS_BUILD; then

# ---------------------------------------------------------------------------
# 5b. Build desktop artifacts in parallel (Linux/Mac/Win)
# ---------------------------------------------------------------------------
# Three independent build paths run concurrently in subshells; output is
# tee'd to per-platform log files in /tmp so a failure in one doesn't bury
# another's stdout. Failures are isolated — a single platform that errors
# is announced and skipped, the rest of the release continues. Ships the
# Mac signed-not-notarized .dmg and the unsigned Win .exe as official
# artifacts (per project decision; users right-click → Open on Mac, click-
# through SmartScreen on Win). Linux is the one fully clean platform.
if $PUBLISH_DESKTOP; then
  echo "==> Building desktop artifacts in parallel (Linux + Mac + Win)..."
  rm -f /tmp/pearcal-build-{linux,mac,windows}.log
  (cd electron && bash scripts/build-linux.sh)   > /tmp/pearcal-build-linux.log   2>&1 &
  PID_LINUX=$!
  (cd electron && npm run build:mac --silent)    > /tmp/pearcal-build-mac.log     2>&1 &
  PID_MAC=$!
  (cd electron && npm run build:windows --silent) > /tmp/pearcal-build-windows.log 2>&1 &
  PID_WIN=$!

  # Wait for each independently and capture per-platform exit status so a
  # single failure doesn't take down the others. `wait $PID` re-raises the
  # child exit code, but under `set -e` a non-zero would abort the script;
  # the `|| STATUS=$?` form catches the failure AND records the real exit
  # code (using `|| true; $?` would always be 0 — the truthy true).
  STATUS_LINUX=0; wait $PID_LINUX || STATUS_LINUX=$?
  STATUS_MAC=0;   wait $PID_MAC   || STATUS_MAC=$?
  STATUS_WIN=0;   wait $PID_WIN   || STATUS_WIN=$?

  rename_and_collect () {
    local label="$1" status="$2" src_glob="$3" dest_pattern="$4" log_file="$5"
    if [ "$status" -ne 0 ]; then
      echo "    ✗ $label build FAILED (exit $status) — see $log_file"
      tail -20 "$log_file" | sed 's/^/        /'
      return
    fi
    # Expand glob; bail out gracefully if no matches.
    # NB: a literal path that contains spaces (e.g. the Windows
    # "PearCal Setup X.Y.Z.exe" artifact) must NOT be word-split by the
    # `for` loop — that would shatter it into "PearCal", "Setup", "…exe"
    # and report "no artifacts found" for a file that exists. Check the
    # literal path first; only fall back to glob expansion when it has
    # wildcards that didn't resolve to an existing file.
    local matched=0
    local -a srcs=()
    if [ -f "$src_glob" ]; then
      srcs=("$src_glob")
    else
      shopt -s nullglob
      srcs=( $src_glob )
      shopt -u nullglob
    fi
    for src in "${srcs[@]}"; do
      [ -f "$src" ] || continue
      matched=1
      local dest
      dest=$(printf "$dest_pattern" "$(basename "$src")")
      cp "$src" "$dest"
      DESKTOP_ARTIFACTS+=("$dest")
      local size; size=$(du -sh "$dest" | cut -f1)
      echo "    ✓ $label: $dest ($size)"
    done
    if [ "$matched" -eq 0 ]; then
      echo "    ✗ $label: no artifacts found at $src_glob — see $log_file"
    fi
  }

  # Linux .AppImage + .deb. electron-builder writes both to electron/dist/
  # using {version} from electron/package.json.
  rename_and_collect "Linux AppImage" "$STATUS_LINUX" \
    "electron/dist/PearCal-${APP_VERSION}.AppImage" \
    "${ARTIFACT_PREFIX:-pearcal}-${RELEASE_TAG}-x86_64.AppImage" \
    /tmp/pearcal-build-linux.log
  rename_and_collect "Linux deb" "$STATUS_LINUX" \
    "electron/dist/pearcal-electron_${APP_VERSION}_amd64.deb" \
    "${ARTIFACT_PREFIX:-pearcal}-${RELEASE_TAG}-amd64.deb" \
    /tmp/pearcal-build-linux.log

  # Mac arm64 + x64 .dmg. build-mac.sh rsyncs both back to electron/dist/.
  # electron-builder uses {version} from electron/package.json (which the
  # version-bump step above set to APP_VERSION) — match exactly to avoid
  # collisions with stale files from a previous run.
  rename_and_collect "Mac arm64" "$STATUS_MAC" \
    "electron/dist/PearCal-${APP_VERSION}-arm64.dmg" \
    "${ARTIFACT_PREFIX:-pearcal}-${RELEASE_TAG}-mac-arm64.dmg" \
    /tmp/pearcal-build-mac.log
  rename_and_collect "Mac x64" "$STATUS_MAC" \
    "electron/dist/PearCal-${APP_VERSION}.dmg" \
    "${ARTIFACT_PREFIX:-pearcal}-${RELEASE_TAG}-mac-x64.dmg" \
    /tmp/pearcal-build-mac.log

  # Win NSIS .exe. build-windows.sh writes to electron/dist/.
  rename_and_collect "Windows installer" "$STATUS_WIN" \
    "electron/dist/PearCal Setup ${APP_VERSION}.exe" \
    "${ARTIFACT_PREFIX:-pearcal}-Setup-${RELEASE_TAG}.exe" \
    /tmp/pearcal-build-windows.log

  # In-place auto-update manifests (#105). electron-updater (electron/src/main/
  # auto-updater.js) downloads latest.yml (Windows NSIS) / latest-linux.yml
  # (Linux AppImage) from this release, then fetches the binary named in the
  # manifest's `path` and verifies its sha512. We generate them HERE rather than
  # via electron-builder --publish because (a) the desktop builds run without a
  # GH_TOKEN so electron-builder never emits them, and (b) we rename artifacts
  # after the build — so the manifest's url/path/sha512 must describe the FINAL
  # renamed asset, not electron-builder's default-named output. sha512 is
  # base64(sha512(file)), exactly electron-builder's format. .deb and the
  # un-notarized Mac .dmg can't self-update and intentionally get no manifest.
  _gen_update_manifest () {
    local artifact="$1" manifest="$2"
    local name size sha date
    name=$(basename "$artifact")
    size=$(stat -c%s "$artifact")
    sha=$(openssl dgst -sha512 -binary "$artifact" | openssl base64 -A)
    date=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    cat > "$manifest" <<MANIFEST_EOF
version: ${APP_VERSION}
files:
  - url: ${name}
    sha512: ${sha}
    size: ${size}
path: ${name}
sha512: ${sha}
releaseDate: '${date}'
MANIFEST_EOF
    DESKTOP_ARTIFACTS+=("$manifest")
    echo "    ✓ update manifest: ${manifest} -> ${name}"
  }
  if [ "${#DESKTOP_ARTIFACTS[@]}" -gt 0 ]; then
    _win_exe=""; _linux_appimage=""
    for d in "${DESKTOP_ARTIFACTS[@]}"; do
      case "$d" in
        *.exe)      _win_exe="$d" ;;
        *.AppImage) _linux_appimage="$d" ;;
      esac
    done
    [ -n "$_win_exe" ]        && _gen_update_manifest "$_win_exe"        "$(dirname "$_win_exe")/latest.yml"
    [ -n "$_linux_appimage" ] && _gen_update_manifest "$_linux_appimage" "$(dirname "$_linux_appimage")/latest-linux.yml"
  fi

  if [ "${#DESKTOP_ARTIFACTS[@]}" -eq 0 ]; then
    echo "    ✗ All desktop builds failed — release will continue with mobile artifacts only."
  fi
fi

# ---------------------------------------------------------------------------
# 5c. Build blind-seeder installers (auto-update assets)
# ---------------------------------------------------------------------------
# A self-managed seeder polls this repo's GitHub Releases and self-updates by
# downloading the installer named for its platform+arch, then verifying the
# .sha256 sidecar (seeder-launcher/host/updateCheck.js + updateApply.js;
# src/lib/seederUpdateCheck.js#selectAsset picks the asset). Until these assets
# are attached, the whole update path is inert — selectAsset finds nothing and
# the dashboard UpdateBar never lights. This phase builds them and hands each
# installer + its sidecar to SEEDER_ARTIFACTS for the GitHub upload loop.
#
# The seeder build scripts already emit the final, "seeder"-named filenames AND
# their .sha256 sidecars, so (unlike the desktop artifacts) we do NOT rename —
# renaming would orphan the sidecar. Linux (.AppImage x86_64 + .deb amd64) and
# Windows (.exe) cross-build locally; macOS (.pkg, arm64 + x64) builds on the Mac
# Mini over SSH and is best-effort (skipped with a note if unreachable). Failures
# are isolated per platform — the release continues on the assets that did build.
# Signing: build-macos-remote.sh inherits APP_SIGN_ID/PKG_SIGN_ID/NOTARY_PROFILE
# from the environment (set them in scripts/.env to ship a signed+notarized .pkg;
# unset = unsigned, install via right-click → Open).
if $PUBLISH_SEEDER; then
  echo "==> Building blind-seeder installers (Linux + Windows local; macOS via Mac Mini)..."
  SEEDER_DIR="$REPO_ROOT/seeder-launcher"
  rm -f /tmp/pearcal-seeder-{linux,windows,macos}.log
  # Clear this run's expected outputs first. Collection below is existence-based
  # (so a partial build still ships what it produced), which is only safe if a
  # FAILED build can't leave a stale file to be mistaken for fresh — critical for
  # the AppImage, whose name carries no version (a prior release's leftover would
  # otherwise be re-shipped under this tag).
  rm -f \
    "$SEEDER_DIR/dist/linux/PearCalSeeder-x86_64.AppImage"{,.sha256} \
    "$SEEDER_DIR/dist/linux/pearcal-seeder_${APP_VERSION}_amd64.deb"{,.sha256} \
    "$SEEDER_DIR/dist/windows/PearCalSeeder-Setup-${APP_VERSION}.exe"{,.sha256} \
    "$SEEDER_DIR/dist/macos/PearCalSeeder-${APP_VERSION}"-{arm64,x64}.pkg{,.sha256} 2>/dev/null || true

  # Linux: AppImage (x86_64) then .deb (amd64), sequentially in one subshell —
  # they share the staging cache (bundled node download) and dist/linux dir, so
  # serialising avoids a download/dir race. Skips the .deb if dpkg-deb is absent.
  ( set -e
    VERSION="$APP_VERSION" bash "$SEEDER_DIR/scripts/build-appimage-linux.sh"
    if command -v dpkg-deb >/dev/null 2>&1; then
      VERSION="$APP_VERSION" bash "$SEEDER_DIR/scripts/build-deb-linux.sh"
    else
      echo "build-deb: dpkg-deb not found — skipping .deb"
    fi
  ) > /tmp/pearcal-seeder-linux.log 2>&1 &
  PID_SLINUX=$!

  # Windows NSIS .exe — cross-built on Linux via makensis (no Windows host).
  PID_SWIN=""
  if command -v makensis >/dev/null 2>&1 || command -v mingw32-makensis >/dev/null 2>&1; then
    ( VERSION="$APP_VERSION" bash "$SEEDER_DIR/scripts/build-windows.sh" ) \
      > /tmp/pearcal-seeder-windows.log 2>&1 &
    PID_SWIN=$!
  else
    echo "    - Windows seeder .exe skipped (makensis not installed)"
  fi

  # macOS .pkg (arm64 + x64) on the Mac Mini — best-effort.
  PID_SMAC=""
  if ssh -o ConnectTimeout=5 -o BatchMode=yes "${MAC_MINI_HOST:-Tims-Mac-mini.local}" exit 2>/dev/null; then
    ( MAC_MINI_HOST="${MAC_MINI_HOST:-Tims-Mac-mini.local}" \
        bash "$SEEDER_DIR/scripts/build-macos-remote.sh" "$APP_VERSION" ) \
      > /tmp/pearcal-seeder-macos.log 2>&1 &
    PID_SMAC=$!
  else
    echo "    - macOS seeder .pkg skipped (${MAC_MINI_HOST:-Tims-Mac-mini.local} unreachable)"
  fi

  SSTATUS_LINUX=0; wait $PID_SLINUX || SSTATUS_LINUX=$?
  SSTATUS_WIN=0;   [ -n "$PID_SWIN" ] && { wait $PID_SWIN || SSTATUS_WIN=$?; }
  SSTATUS_MAC=0;   [ -n "$PID_SMAC" ] && { wait $PID_SMAC || SSTATUS_MAC=$?; }

  # Collect an installer + its (already-built) .sha256 sidecar. Both are attached
  # so the updater can verify the download; a missing sidecar is a hard warning
  # (the seeder REQUIRES it — updateApply aborts without a verified hash).
  _collect_seeder () {
    local label="$1" installer="$2"
    if [ ! -f "$installer" ]; then
      echo "    ✗ $label: not found at $installer"
      return
    fi
    SEEDER_ARTIFACTS+=("$installer")
    local size; size=$(du -sh "$installer" | cut -f1)
    if [ -f "$installer.sha256" ]; then
      SEEDER_ARTIFACTS+=("$installer.sha256")
      echo "    ✓ $label: $(basename "$installer") ($size) + .sha256"
    else
      echo "    ✗ $label: $(basename "$installer") ($size) — .sha256 sidecar MISSING (seeder can't verify → won't self-update)"
    fi
  }

  # Collect by file existence, not by aggregate exit status — a build that fails
  # PART way (e.g. AppImage ok, .deb errors) should still ship what it produced.
  # A non-zero status just surfaces the log for diagnosis.
  [ "$SSTATUS_LINUX" -ne 0 ] && {
    echo "    ✗ Linux seeder build reported exit $SSTATUS_LINUX — see /tmp/pearcal-seeder-linux.log"
    tail -15 /tmp/pearcal-seeder-linux.log | sed 's/^/        /'
  }
  _collect_seeder "Linux AppImage" "$SEEDER_DIR/dist/linux/PearCalSeeder-x86_64.AppImage"
  _collect_seeder "Linux deb"      "$SEEDER_DIR/dist/linux/pearcal-seeder_${APP_VERSION}_amd64.deb"

  if [ -n "$PID_SWIN" ]; then
    [ "$SSTATUS_WIN" -ne 0 ] && {
      echo "    ✗ Windows seeder build reported exit $SSTATUS_WIN — see /tmp/pearcal-seeder-windows.log"
      tail -15 /tmp/pearcal-seeder-windows.log | sed 's/^/        /'
    }
    _collect_seeder "Windows installer" "$SEEDER_DIR/dist/windows/PearCalSeeder-Setup-${APP_VERSION}.exe"
  fi

  if [ -n "$PID_SMAC" ]; then
    [ "$SSTATUS_MAC" -ne 0 ] && {
      echo "    ✗ macOS seeder build reported exit $SSTATUS_MAC — see /tmp/pearcal-seeder-macos.log"
      tail -15 /tmp/pearcal-seeder-macos.log | sed 's/^/        /'
    }
    # build-macos-remote.sh defaults to both arches; SEEDER_PKG_ARCHES can override.
    for _a in ${SEEDER_PKG_ARCHES:-arm64 x64}; do
      _collect_seeder "macOS pkg ($_a)" "$SEEDER_DIR/dist/macos/PearCalSeeder-${APP_VERSION}-${_a}.pkg"
    done
  fi

  if [ "${#SEEDER_ARTIFACTS[@]}" -eq 0 ]; then
    echo "    ✗ No seeder installers were produced — release will continue without seeder auto-update assets."
  fi
fi

# ---------------------------------------------------------------------------
# 5d. Build blind-seeder STORE artifacts (Docker image → ghcr + Start9 .s9pk)
# ---------------------------------------------------------------------------
# The Umbrel app + the Start9 package both run the SAME published multi-arch
# image, and the .s9pk pins that image's manifest-list digest — so the image
# must be built+pushed FIRST, then the s9pk. The .s9pk is uploaded to this
# release as `pearcal-seeder.s9pk`; the website's StartOS registry _redirects
# points `/package/v0/pearcal-seeder.s9pk` at it (the s9pk is over Cloudflare's
# per-file limit). The registry metadata publish runs AFTER the release exists
# (step 7c). Heavy + slow; opt-in via the prompt above. Failures are surfaced
# but don't abort the rest of the release.
#
# NB: build-umbrel-image.sh + build-start9-s9pk.sh REWRITE in-repo pins
# (seeder-launcher/umbrel/{umbrel-app.yml,docker-compose.yml} version+digest,
# seeder-launcher/start9/{manifest.yaml,Dockerfile,scripts/procedures/migrations.ts}) —
# review + commit those with the release.
SEEDER_S9PK=""
if $PUBLISH_SEEDER_STORE; then
  echo "==> Building + pushing the seeder image, then packing the Start9 .s9pk (slow)..."
  _store_ok=true
  if VERSION="$APP_VERSION" bash "$REPO_ROOT/seeder-launcher/scripts/build-umbrel-image.sh" "$APP_VERSION"; then
    echo "    ✓ image pushed: ${SEEDER_IMAGE}:${APP_VERSION}"
  else
    echo "    ✗ image build/push FAILED — skipping the s9pk + registry (they pin the pushed digest)."
    _store_ok=false
  fi
  if $_store_ok; then
    if bash "$REPO_ROOT/seeder-launcher/scripts/build-start9-s9pk.sh" "$APP_VERSION"; then
      SEEDER_S9PK="$REPO_ROOT/seeder-launcher/start9/pearcal-seeder.s9pk"
      if [ -f "$SEEDER_S9PK" ]; then
        SEEDER_ARTIFACTS+=("$SEEDER_S9PK")
        [ -f "$SEEDER_S9PK.sha256" ] && SEEDER_ARTIFACTS+=("$SEEDER_S9PK.sha256")
        echo "    ✓ s9pk: pearcal-seeder.s9pk ($(du -sh "$SEEDER_S9PK" | cut -f1)) — queued for upload"
      else
        echo "    ✗ s9pk build reported success but the file is missing."
        SEEDER_S9PK=""
      fi
    else
      echo "    ✗ s9pk build FAILED — the Start9 registry publish will be skipped."
    fi
  fi
fi

fi # end NEEDS_BUILD (desktop + seeder artifacts)

# ---------------------------------------------------------------------------
# 5e. Generate .sha256 sidecars for the desktop artifacts, then the final gate
#
# The seeder build makes its own sidecars (the self-updater verifies against
# them), so only the desktop artifacts need one here. This is the last confirm
# before anything irreversible: step 6 commits and step 6b pushes the tag.
# ---------------------------------------------------------------------------
for _artifact in "${DESKTOP_ARTIFACTS[@]:-}"; do
  [ -z "$_artifact" ] && continue
  [ -f "$_artifact" ] || continue
  case "$_artifact" in
    *.sha256|*.yml|*.yaml) continue ;;   # sidecars and update manifests
  esac
  [ -f "${_artifact}.sha256" ] && continue
  ( cd "$(dirname "$_artifact")" && sha256sum "$(basename "$_artifact")" > "$(basename "$_artifact").sha256" )
  echo "    sha256  $(cut -d' ' -f1 < "${_artifact}.sha256")  $(basename "$_artifact")"
  CHECKSUM_ARTIFACTS+=("${_artifact}.sha256")
done

echo ""
_RELEASE_SUMMARY="APK (${APK_SIZE:-?})"
if $PUBLISH_PLAY && [ -n "${AAB_NAME:-}" ]; then _RELEASE_SUMMARY="$_RELEASE_SUMMARY, AAB ($AAB_SIZE)"; fi
if [ "${#DESKTOP_ARTIFACTS[@]}" -gt 0 ]; then _RELEASE_SUMMARY="$_RELEASE_SUMMARY, ${#DESKTOP_ARTIFACTS[@]} desktop artifact(s)"; fi
if [ "${#SEEDER_ARTIFACTS[@]}" -gt 0 ];  then _RELEASE_SUMMARY="$_RELEASE_SUMMARY, ${#SEEDER_ARTIFACTS[@]} seeder artifact(s)"; fi
_confirm "$_RELEASE_SUMMARY ready to publish?"

# ---------------------------------------------------------------------------
# Phase D — publishing starts here. Nothing below this line is undoable.
# ---------------------------------------------------------------------------
if $PUBLISH_GITHUB; then

# Determine the remote to push to
GIT_REMOTE="${GITHUB_REMOTE:-}"
if [ -z "$GIT_REMOTE" ]; then
  if git remote | grep -q '^github$'; then
    GIT_REMOTE="github"
  else
    GIT_REMOTE="origin"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Commit the version bumps this run made, BEFORE tagging
# ---------------------------------------------------------------------------
# Step 0 rewrites app.json + the Xcode project, and the seeder store step
# rewrites the Start9/Umbrel pins, but nothing ever committed them. The tag was
# then cut from a tree still carrying the PREVIOUS version, so every release
# left master declaring the version before it and the bumps stranded as
# uncommitted changes. That is how master sat on 1.0.31 while 1.0.34 shipped.
#
# Committing here (before the tag) means the tag actually contains the version
# it claims to be.
#
# Explicit allowlist, never `git add -A`: assets/*.bundle are build outputs that
# can lag the source they were built from, and committing one would bake a stale
# artifact into the release.
_bump_paths=(
  app.json
  ios/PearCal.xcodeproj/project.pbxproj
  electron/package.json
  seeder-launcher/start9/Dockerfile
  seeder-launcher/start9/manifest.yaml
  seeder-launcher/start9/scripts/procedures/migrations.ts
  seeder-launcher/umbrel/docker-compose.yml
  seeder-launcher/umbrel/umbrel-app.yml
  metadata/ios/en-US/release_notes.txt
  "metadata/ios/version/${APP_VERSION}"
)
_bump_existing=()
for _p in "${_bump_paths[@]}"; do [ -e "$_p" ] && _bump_existing+=("$_p"); done
if [ ${#_bump_existing[@]} -gt 0 ] \
   && [ -n "$(git status --porcelain -- "${_bump_existing[@]}")" ]; then
  echo "==> Committing version bumps for $APP_VERSION..."
  git add -- "${_bump_existing[@]}"
  git commit -q -m "chore(release): $APP_VERSION" \
    && echo "    Committed $(git diff --name-only HEAD~1 HEAD | wc -l) file(s)" \
    || echo "    WARNING: version-bump commit failed — the tag will not contain them." >&2
else
  echo "==> No uncommitted version bumps to record (already committed)."
fi

# ---------------------------------------------------------------------------
# 6b. Push branch and tag
# ---------------------------------------------------------------------------
echo ""
echo "    Remote : $GIT_REMOTE"
echo "    Tag    : $RELEASE_TAG"
echo "    Branch : $(git rev-parse --abbrev-ref HEAD)"
echo "    Commit : $(git rev-parse --short HEAD)  $(git log -1 --format='%s')"
_confirm "Push branch $(git rev-parse --abbrev-ref HEAD) + tag $RELEASE_TAG to $GIT_REMOTE? (This cannot be undone without a force-delete)"

# The bump commit has to reach the remote too, or the pushed tag points at a
# commit nobody else has.
_branch="$(git rev-parse --abbrev-ref HEAD)"
git push "$GIT_REMOTE" "$_branch" \
  && echo "    Pushed $_branch to $GIT_REMOTE" \
  || echo "    WARNING: branch push failed — push $_branch manually so the tag resolves." >&2

# Create the local tag here — as late as possible, only after all confirmations
echo "==> Tagging and pushing $RELEASE_TAG..."
git tag "$RELEASE_TAG" 2>/dev/null \
  && echo "    Created local tag" \
  || echo "    Tag already exists locally"

git push "$GIT_REMOTE" "$RELEASE_TAG" \
  && echo "    Pushed tag to $GIT_REMOTE" \
  || echo "    Tag already on remote"

# ---------------------------------------------------------------------------
# 7. Create GitHub release and upload APK
# ---------------------------------------------------------------------------
echo "==> Creating GitHub release $RELEASE_TAG..."

GH_TOKEN=$(_github_token)   # re-resolve in case env changed

echo ""
echo "    Repo   : ${REPO_SLUG:-unknown}"
echo "    Tag    : $RELEASE_TAG"
echo "    Asset  : $APK_NAME ($APK_SIZE)"
if [ "${#DESKTOP_ARTIFACTS[@]}" -gt 0 ]; then
  echo "    + Desktop:"
  for d in "${DESKTOP_ARTIFACTS[@]}"; do
    echo "        $d ($(du -sh "$d" | cut -f1))"
  done
fi
if [ "${#SEEDER_ARTIFACTS[@]}" -gt 0 ]; then
  echo "    + Seeder:"
  for d in "${SEEDER_ARTIFACTS[@]}"; do
    echo "        $d ($(du -sh "$d" | cut -f1))"
  done
fi
_confirm "Create public GitHub release $RELEASE_TAG and upload these assets?"

if [ -n "$GH_TOKEN" ] && [ -n "$REPO_SLUG" ]; then
  # --- Look up an existing release for this tag first ---
  # A prior run may have created the release but failed before all assets were
  # uploaded (e.g. desktop builds finished after the GitHub step the first
  # time). POSTing again returns 422 already_exists, so reuse the existing
  # release instead of aborting.
  echo "    Calling GitHub API for repo: $REPO_SLUG"
  EXISTING_RESP=$(curl -s \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO_SLUG}/releases/tags/${RELEASE_TAG}")
  EXISTING_ID=$(printf '%s' "$EXISTING_RESP" \
    | python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
    print(d.get('id','') if isinstance(d.get('id',None),int) else '')
except Exception:
    print('')" 2>/dev/null || echo "")

  if [ -n "$EXISTING_ID" ]; then
    echo "    Release $RELEASE_TAG already exists (id=$EXISTING_ID) — reusing it."
    RELEASE_RESP="$EXISTING_RESP"
    RELEASE_ID="$EXISTING_ID"
  else
    # --- Create the release via REST API ---
    RELEASE_RESP=$(curl -s \
      -X POST \
      -H "Authorization: Bearer $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" \
      "https://api.github.com/repos/${REPO_SLUG}/releases" \
      -d "$(python3 -c "
import sys, json
body = open('release_notes.md').read()
print(json.dumps({'tag_name': '${RELEASE_TAG}', 'name': '${RELEASE_TAG}', 'body': body, 'draft': False, 'prerelease': False}))
")")

    # Check for API-level errors before proceeding
    API_ERROR=$(printf '%s' "$RELEASE_RESP" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" \
      2>/dev/null || echo "")
    if [ -n "$API_ERROR" ]; then
      echo ""
      echo "ERROR: GitHub API returned an error:"
      printf '%s\n' "$RELEASE_RESP" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$RELEASE_RESP"
      echo ""
      echo "The tag has been pushed. Once your GitHub account is restored you can"
      echo "create the release manually, or re-run this script with:"
      echo "  ./scripts/release.sh $RELEASE_TAG"
      exit 1
    fi

    RELEASE_ID=$(printf '%s' "$RELEASE_RESP" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" \
      2>/dev/null || echo "")
  fi

  UPLOAD_URL=$(printf '%s' "$RELEASE_RESP" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['upload_url'].split('{')[0])")

  # Helper: pick a sensible Content-Type per extension. GitHub doesn't
  # validate but it surfaces in the asset's metadata.
  _release_content_type () {
    case "$1" in
      *.apk)      echo "application/vnd.android.package-archive" ;;
      *.dmg)      echo "application/x-apple-diskimage" ;;
      *.exe)      echo "application/vnd.microsoft.portable-executable" ;;
      *.AppImage) echo "application/x-executable" ;;
      *.deb)      echo "application/vnd.debian.binary-package" ;;
      *.pkg)      echo "application/vnd.apple.installer+xml" ;;
      *.sha256)   echo "text/plain" ;;
      *.yml)      echo "text/yaml" ;;
      *)          echo "application/octet-stream" ;;
    esac
  }

  # Helper: upload one asset to the release. Returns 0 on success, 1 on
  # parsable API error. We don't bail the whole script on a single asset
  # failure — desktop artifacts are best-effort, and a single platform
  # upload glitch shouldn't gate the rest of the release.
  # Helper: delete an existing asset by name (used when re-uploading replaces a
  # stale artifact from a prior partial run). Silent on failure — the caller's
  # retry will surface any real problem.
  _delete_release_asset_by_name () {
    local name="$1"
    [ -z "${RELEASE_ID:-}" ] && return 1
    local list; list=$(curl -s \
      -H "Authorization: Bearer $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${REPO_SLUG}/releases/${RELEASE_ID}/assets")
    local asset_id; asset_id=$(printf '%s' "$list" \
      | python3 -c "import sys,json
try:
    arr=json.load(sys.stdin)
    for a in arr:
        if a.get('name')=='${name}':
            print(a.get('id',''))
            break
except Exception:
    pass" 2>/dev/null || echo "")
    [ -z "$asset_id" ] && return 1
    curl -s -X DELETE \
      -H "Authorization: Bearer $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${REPO_SLUG}/releases/assets/${asset_id}" > /dev/null
    return 0
  }

  _upload_release_asset () {
    local file="$1"
    local name; name=$(basename "$file")
    local ctype; ctype=$(_release_content_type "$name")
    local attempt=0
    while [ $attempt -lt 2 ]; do
      attempt=$((attempt + 1))
      echo "==> Uploading $name..."
      local resp_file; resp_file=$(mktemp)
      curl \
        -X POST \
        -H "Authorization: Bearer $GH_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        -H "Content-Type: $ctype" \
        "${UPLOAD_URL}?name=${name}" \
        --data-binary "@${file}" \
        --progress-bar \
        -o "$resp_file" 2>&1
      local resp; resp=$(cat "$resp_file"); rm -f "$resp_file"
      local err; err=$(printf '%s' "$resp" \
        | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" \
        2>/dev/null || echo "")
      if [ -z "$err" ]; then
        echo "    ✓ Uploaded $name."
        return 0
      fi
      # If GitHub says the asset already exists, delete the stale one and retry once.
      local already; already=$(printf '%s' "$resp" \
        | python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
    for e in d.get('errors',[]) or []:
        if e.get('code')=='already_exists':
            print('1'); break
except Exception:
    pass" 2>/dev/null || echo "")
      if [ "$already" = "1" ] && [ $attempt -lt 2 ]; then
        echo "    (asset $name already exists on the release — deleting and retrying)"
        _delete_release_asset_by_name "$name" || true
        continue
      fi
      echo "    ✗ Upload failed for $name:"
      printf '%s\n' "$resp" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$resp"
      return 1
    done
  }

  # --- Upload APK (mandatory) ---
  if ! _upload_release_asset "$APK_NAME"; then
    echo ""
    echo "The GitHub release was created but the APK was not attached."
    echo "You can upload it manually at: https://github.com/${REPO_SLUG}/releases/tag/${RELEASE_TAG}"
    exit 1
  fi

  # --- Upload desktop artifacts (best-effort) ---
  for d in "${DESKTOP_ARTIFACTS[@]}"; do
    _upload_release_asset "$d" || \
      echo "    (continuing — desktop artifact failure doesn't block the rest of the release)"
  done

  # --- Upload .sha256 sidecars (best-effort) ---
  for d in "${CHECKSUM_ARTIFACTS[@]}"; do
    _upload_release_asset "$d" || \
      echo "    (continuing — checksum sidecar failure doesn't block the rest of the release)"
  done

  # --- Upload seeder installers + sidecars (best-effort) ---
  for d in "${SEEDER_ARTIFACTS[@]}"; do
    _upload_release_asset "$d" || \
      echo "    (continuing — seeder artifact failure doesn't block the rest of the release)"
  done

else
  # Fallback: gh CLI (requires working auth)
  echo "    (GITHUB_TOKEN not set or repo slug unknown — falling back to gh CLI)"
  gh release create "$RELEASE_TAG" "$APK_NAME" "${DESKTOP_ARTIFACTS[@]}" "${CHECKSUM_ARTIFACTS[@]}" "${SEEDER_ARTIFACTS[@]}" \
    --title "$RELEASE_TAG" \
    --notes-file release_notes.md
fi

else
  echo ""
  echo "==> Skipping GitHub release (not selected)."
fi # end PUBLISH_GITHUB

# ---------------------------------------------------------------------------
# 7b. Publish the Start9 community registry (points at the uploaded .s9pk)
# ---------------------------------------------------------------------------
# Runs AFTER the release + pearcal-seeder.s9pk asset exist. publish-start9-registry.sh
# UPSERTS the combined /package/v0 metadata (pearcal-seeder alongside pearcircle-seeder)
# and points _redirects at releases/download/<tag>/pearcal-seeder.s9pk. Set
# WEBSITE_REGISTRY_PR=1 (env) to auto-open + squash-merge the website PR (merge =
# Cloudflare deploy); otherwise it regenerates the files + prints the git/gh commands.
if $PUBLISH_SEEDER_STORE && [ -n "$SEEDER_S9PK" ] && $PUBLISH_GITHUB; then
  if [ -n "${WEBSITE_DIR:-}" ] && [ -d "${WEBSITE_DIR:-}/.git" ]; then
    echo "==> Publishing the Start9 community registry (website $WEBSITE_DIR)..."
    WEBSITE_DIR="$WEBSITE_DIR" S9PK="$SEEDER_S9PK" \
      bash "$REPO_ROOT/seeder-launcher/scripts/publish-start9-registry.sh" "$APP_VERSION" \
      || echo "    ✗ registry publish failed — re-run publish-start9-registry.sh manually."
  else
    echo "==> Start9 registry publish skipped (WEBSITE_DIR not set to a website clone)."
    echo "    Publish it with: WEBSITE_DIR=/path/to/website bash seeder-launcher/scripts/publish-start9-registry.sh $APP_VERSION"
  fi
fi

# ---------------------------------------------------------------------------
# 8. Install zsp if needed
# ---------------------------------------------------------------------------
if $PUBLISH_ZAPSTORE && ! command -v zsp &>/dev/null; then
  echo "==> Installing zsp..."
  ZSP_URL=$(curl -s https://api.github.com/repos/zapstore/zsp/releases/latest \
    | grep browser_download_url | grep linux-amd64 | cut -d '"' -f 4)
  mkdir -p "$HOME/.local/bin"
  curl -sL "$ZSP_URL" -o "$HOME/.local/bin/zsp"
  chmod +x "$HOME/.local/bin/zsp"
  export PATH="$HOME/.local/bin:$PATH"
fi

# ---------------------------------------------------------------------------
# 9. Publish to Zapstore
# ---------------------------------------------------------------------------
if $PUBLISH_ZAPSTORE; then
echo "==> Publishing to Zapstore..."

# Resolve token for zsp
EXPORT_TOKEN="${GH_TOKEN:-}"
if [ -z "$EXPORT_TOKEN" ]; then
  EXPORT_TOKEN=$(gh auth token 2>/dev/null || echo "")
fi

# --- Pre-step: link Android signing certificate to Nostr identity ---
# zsp needs to know your APK signing cert to prove app ownership.
# This is a one-time operation per keystore — if already linked it's a no-op.
# We extract the DER certificate from the keystore and pass it to zsp identity.
ZSP_P12_FILE=$(mktemp --suffix=.p12)
echo "==> Linking signing certificate to Nostr identity..."
if keytool -importkeystore \
    -srckeystore "$KEYSTORE_FILE" \
    -srcalias "$KEY_ALIAS" \
    -srcstorepass "$KEYSTORE_PASSWORD" \
    -srckeypass "$KEY_PASSWORD" \
    -destkeystore "$ZSP_P12_FILE" \
    -deststoretype PKCS12 \
    -deststorepass "$KEYSTORE_PASSWORD" \
    -noprompt 2>/dev/null; then
  if SIGN_WITH="$SIGN_WITH" KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD" \
      zsp identity --link-key "$ZSP_P12_FILE"; then
    echo "    Certificate linked to Nostr identity."
  else
    echo "    Certificate link returned non-zero (may already be linked — continuing)."
  fi
else
  echo "    Warning: could not convert keystore to PKCS12 — skipping identity link."
  echo "    zsp may prompt interactively."
fi
rm -f "$ZSP_P12_FILE"

# --- Resolve release version and notes for Zapstore ---
# Try to pull from the GitHub release first (handles the case where a prior
# run already published to GitHub, so the canonical data lives there).
# Falls back to what we generated locally this run.
ZSP_VERSION=""
ZSP_NOTES=""

if [ -n "$EXPORT_TOKEN" ] && [ -n "$REPO_SLUG" ]; then
  echo "    Checking GitHub for existing release $RELEASE_TAG..."
  GH_RELEASE=$(curl -s \
    -H "Authorization: Bearer $EXPORT_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO_SLUG}/releases/tags/${RELEASE_TAG}" \
    2>/dev/null || echo "")

  GH_RELEASE_ERR=$(printf '%s' "$GH_RELEASE" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" \
    2>/dev/null || echo "")

  if [ -z "$GH_RELEASE_ERR" ]; then
    ZSP_VERSION=$(printf '%s' "$GH_RELEASE" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tag_name','').lstrip('v'))" \
      2>/dev/null || echo "")
    ZSP_NOTES=$(printf '%s' "$GH_RELEASE" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('body',''))" \
      2>/dev/null || echo "")
    [ -n "$ZSP_VERSION" ] && echo "    Using GitHub release data (version: $ZSP_VERSION)"
  else
    echo "    GitHub release not found or inaccessible ($GH_RELEASE_ERR) — using local data"
  fi
fi

# Fall back to locally generated values
if [ -z "$ZSP_VERSION" ]; then
  ZSP_VERSION="$APP_VERSION"
  echo "    Using local version: $ZSP_VERSION"
fi
if [ -z "$ZSP_NOTES" ] && [ -f release_notes.md ]; then
  ZSP_NOTES=$(cat release_notes.md)
  echo "    Using local release notes"
fi

# Write resolved notes to a temp file for zsp
ZSP_NOTES_FILE=$(mktemp)
printf '%s' "$ZSP_NOTES" > "$ZSP_NOTES_FILE"

echo ""
echo "    Version : $ZSP_VERSION"
echo "    Notes   : $(head -3 "$ZSP_NOTES_FILE" | tr '\n' ' ')..."
_confirm "Publish $RELEASE_TAG to Zapstore?"

# Always patch zapstore.yaml to inject local release notes so the Nostr
# event content is populated regardless of GitHub availability.
# Also inject release_source if we have a local APK (avoids GitHub download).
ZAPSTORE_YAML_BAK=$(mktemp)
cp zapstore.yaml "$ZAPSTORE_YAML_BAK"

LOCAL_APK=""
if [ -f "$REPO_ROOT/${APK_NAME:-}" ]; then
  LOCAL_APK="$REPO_ROOT/${APK_NAME}"
elif [ -f "$REPO_ROOT/android/app/build/outputs/apk/release/app-release.apk" ]; then
  LOCAL_APK="$REPO_ROOT/android/app/build/outputs/apk/release/app-release.apk"
fi

python3 - "$ZSP_NOTES_FILE" "${LOCAL_APK}" <<PYEOF
import sys, re
notes_file = sys.argv[1]
local_apk  = sys.argv[2]
txt = open('zapstore.yaml').read()
# Remove any existing release_notes / release_source lines
txt = re.sub(r'^release_notes:.*\n', '', txt, flags=re.MULTILINE)
txt = re.sub(r'^release_source:.*\n', '', txt, flags=re.MULTILINE)
# Prepend both fields
header = f"release_notes: {notes_file}\n"
if local_apk:
    header += f"release_source: {local_apk}\n"
txt = header + txt
open('zapstore.yaml', 'w').write(txt)
PYEOF

if [ -n "$LOCAL_APK" ]; then
  echo "    zapstore.yaml patched with local APK and release notes"
else
  echo "    zapstore.yaml patched with release notes"
fi

# Use --overwrite-release when republishing an already-existing version
ZSP_OVERWRITE=""
if [ -n "${EXPLICIT_TAG:-}" ]; then
  ZSP_OVERWRITE="--overwrite-release"
fi

if APP_VERSION="$ZSP_VERSION" GITHUB_TOKEN="$EXPORT_TOKEN" SIGN_WITH="$SIGN_WITH" \
    zsp publish -y zapstore.yaml ${ZSP_OVERWRITE}; then
  echo ""
  echo "==> Release $RELEASE_TAG complete."
else
  echo ""
  PUBLISH_FAILED=true
  echo "ERROR: Zapstore publish failed."
  echo ""
  echo "Manual retry:"
  echo "  source scripts/.env \\"
  echo "    && APP_VERSION=$ZSP_VERSION GITHUB_TOKEN=<token> SIGN_WITH=\"\$SIGN_WITH\" \\"
  echo "    ~/.local/bin/zsp publish --overwrite-release -y zapstore.yaml"
  echo ""
  echo "==> Release $RELEASE_TAG partially complete (GitHub release created, Zapstore skipped)."
fi

# Always restore original zapstore.yaml
mv "$ZAPSTORE_YAML_BAK" zapstore.yaml
echo "    zapstore.yaml restored."

rm -f "$ZSP_NOTES_FILE"

else
  echo ""
  echo "==> Skipping Zapstore publish (not selected)."
fi # end PUBLISH_ZAPSTORE

# ---------------------------------------------------------------------------
# 10. Upload to Google Play Store
#
# Uses the Google Play Developer API (Publishing API v3) directly via curl.
# Uploads AAB format (required for new Play apps since Aug 2021).
# Requires PLAY_SERVICE_ACCOUNT_JSON (path to GCP service account JSON).
#
# Flow: obtain OAuth2 token → create edit → upload AAB → assign to track
#       with release notes → commit edit.
# ---------------------------------------------------------------------------
if ! $PUBLISH_PLAY; then
  echo ""
  echo "==> Skipping Google Play upload (not selected)."
else
  echo ""
  echo "==> Uploading to Google Play Store..."

  PLAY_TRACK="${PLAY_TRACK:-alpha}"
  PLAY_PACKAGE="${BUNDLE_ID:-com.pearcal}"

  # Locate the AAB — prefer versioned copy, fall back to Gradle output
  PLAY_AAB=""
  if [ -n "${AAB_NAME:-}" ] && [ -f "$REPO_ROOT/$AAB_NAME" ]; then
    PLAY_AAB="$REPO_ROOT/$AAB_NAME"
  elif [ -f "$REPO_ROOT/android/app/build/outputs/bundle/release/app-release.aab" ]; then
    PLAY_AAB="$REPO_ROOT/android/app/build/outputs/bundle/release/app-release.aab"
  fi

  if [ -z "$PLAY_AAB" ]; then
    echo "    ERROR: No AAB found. Run with Google Play selected to build the AAB."
    echo "    Skipping Google Play upload."
  else
    PLAY_AAB_SIZE=$(du -sh "$PLAY_AAB" | cut -f1)
    echo "    Package : $PLAY_PACKAGE"
    echo "    Track   : $PLAY_TRACK"
    echo "    AAB     : $PLAY_AAB ($PLAY_AAB_SIZE)"
    echo "    Version : $APP_VERSION"
    _confirm "Upload $RELEASE_TAG to Google Play ($PLAY_TRACK track)?"

    # --- Obtain OAuth2 Bearer token (gcloud or SA JSON) ---
    # Determine the quota header in the parent shell BEFORE calling _play_token.
    # (_play_token runs in a subshell via $(...) so any variables it sets are lost.)
    # SA JSON tokens don't need x-goog-user-project; ADC user tokens do.
    PLAY_QUOTA_HDR=()
    if [ -z "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] || [ ! -f "${PLAY_SERVICE_ACCOUNT_JSON:-/dev/null}" ]; then
      _adc_proj="${PLAY_QUOTA_PROJECT:-$(gcloud config get-value project 2>/dev/null || echo "")}"
      [ -n "$_adc_proj" ] && PLAY_QUOTA_HDR=(-H "x-goog-user-project: ${_adc_proj}")
    fi

    PLAY_TOKEN=$(_play_token "${PLAY_SERVICE_ACCOUNT_JSON:-}")

    if [ -z "$PLAY_TOKEN" ]; then
      echo "    ERROR: Failed to obtain Google OAuth2 token."
      echo "    Run 'gcloud auth application-default login' or set PLAY_SERVICE_ACCOUNT_JSON."
    else
      echo "    OAuth2 token obtained${_adc_proj:+ (quota project: ${_adc_proj})}."

      BASE_URL="https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE}"

      # --- Step 1: Create edit ---
      EDIT_RESP=$(curl -s \
        -X POST \
        -H "Authorization: Bearer $PLAY_TOKEN" \
        "${PLAY_QUOTA_HDR[@]}" \
        -H "Content-Type: application/json" \
        "${BASE_URL}/edits" \
        -d '{}')
      EDIT_ID=$(printf '%s' "$EDIT_RESP" \
        | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")

      if [ -z "$EDIT_ID" ]; then
        echo "    ERROR: Failed to create Play edit."
        printf '%s\n' "$EDIT_RESP" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$EDIT_RESP"
      else
        echo "    Edit created: $EDIT_ID"

        # --- Step 2: Upload AAB ---
        echo "    Uploading AAB..."
        UPLOAD_RESP_FILE=$(mktemp)
        curl \
          -X POST \
          -H "Authorization: Bearer $PLAY_TOKEN" \
          "${PLAY_QUOTA_HDR[@]}" \
          -H "Content-Type: application/octet-stream" \
          "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PLAY_PACKAGE}/edits/${EDIT_ID}/bundles?uploadType=media" \
          --data-binary "@${PLAY_AAB}" \
          --progress-bar \
          -o "$UPLOAD_RESP_FILE" 2>&1
        UPLOAD_RESP=$(cat "$UPLOAD_RESP_FILE"); rm -f "$UPLOAD_RESP_FILE"

        VERSION_CODE=$(printf '%s' "$UPLOAD_RESP" \
          | python3 -c "import sys,json; print(json.load(sys.stdin).get('versionCode',''))" \
          2>/dev/null || echo "")
        UPLOAD_ERR=$(printf '%s' "$UPLOAD_RESP" \
          | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',{}).get('message',''))" \
          2>/dev/null || echo "")

        if [ -n "$UPLOAD_ERR" ]; then
          echo "    ERROR: AAB upload failed: $UPLOAD_ERR"
          printf '%s\n' "$UPLOAD_RESP" | python3 -m json.tool 2>/dev/null

          # Discard the edit to avoid leaving a dangling draft
          curl -sf -X DELETE \
            -H "Authorization: Bearer $PLAY_TOKEN" \
            "${PLAY_QUOTA_HDR[@]}" \
            "${BASE_URL}/edits/${EDIT_ID}" > /dev/null 2>&1 || true
          echo "    Edit discarded."
        else
          echo "    APK uploaded (versionCode: $VERSION_CODE)"

          # --- Step 3: Assign AAB to track with release notes ---
          # Fit the release notes into Play's 500-char limit on a LINE
          # boundary. `head -c 500` cut mid-word and could leave a dangling
          # markdown heading as the last thing a Play user reads.
          # See RELEASE-PIPELINE.md §3.
          PLAY_NOTES_TEXT=""
          _play_notes_src=""
          if [ -f "${ZSP_NOTES_FILE:-}" ]; then
            _play_notes_src="$ZSP_NOTES_FILE"
          elif [ -f release_notes.md ]; then
            _play_notes_src="release_notes.md"
          fi
          if [ -n "$_play_notes_src" ]; then
            PLAY_NOTES_TEXT=$(NOTES_SRC="$_play_notes_src" python3 -c '
import os, sys

LIMIT = 500
out, used = [], 0
with open(os.environ["NOTES_SRC"], encoding="utf-8", errors="replace") as fh:
    for raw in fh:
        line = raw.rstrip("\n")
        cost = len(line) + 1
        if used + cost > LIMIT:
            break
        out.append(line)
        used += cost
# Drop a heading left dangling at the end with nothing under it
while out and out[-1].lstrip().startswith("#"):
    out.pop()
sys.stdout.write("\n".join(out).strip())
')
          fi

          TRACK_BODY=$(python3 -c "
import json, sys
notes = '''${PLAY_NOTES_TEXT}'''
body = {
  'track': '${PLAY_TRACK}',
  'releases': [{
    'name': '${APP_VERSION}',
    'versionCodes': ['${VERSION_CODE}'],
    'status': 'completed',
    'releaseNotes': [{'language': 'en-US', 'text': notes}]
  }]
}
print(json.dumps(body))
")
          TRACK_RESP=$(curl -s \
            -X PUT \
            -H "Authorization: Bearer $PLAY_TOKEN" \
            "${PLAY_QUOTA_HDR[@]}" \
            -H "Content-Type: application/json" \
            "${BASE_URL}/edits/${EDIT_ID}/tracks/${PLAY_TRACK}" \
            -d "$TRACK_BODY")
          TRACK_ERR=$(printf '%s' "$TRACK_RESP" \
            | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',{}).get('message',''))" \
            2>/dev/null || echo "")

          if [ -n "$TRACK_ERR" ]; then
            PUBLISH_FAILED=true
            echo "    ERROR: Track assignment failed: $TRACK_ERR"
            curl -sf -X DELETE \
              -H "Authorization: Bearer $PLAY_TOKEN" \
              "${PLAY_QUOTA_HDR[@]}" \
              "${BASE_URL}/edits/${EDIT_ID}" > /dev/null 2>&1 || true
            echo "    Edit discarded."
          else
            echo "    Assigned to $PLAY_TRACK track."

            # --- Step 4: Commit edit ---
            COMMIT_RESP=$(curl -s \
              -X POST \
              -H "Authorization: Bearer $PLAY_TOKEN" \
              "${PLAY_QUOTA_HDR[@]}" \
              "${BASE_URL}/edits/${EDIT_ID}:commit")
            COMMIT_ERR=$(printf '%s' "$COMMIT_RESP" \
              | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',{}).get('message',''))" \
              2>/dev/null || echo "")

            if [ -n "$COMMIT_ERR" ]; then
              PUBLISH_FAILED=true
              echo "    ERROR: Commit failed: $COMMIT_ERR"
              echo "    The edit has NOT been committed — no changes made to Play Store."
              printf '%s\n' "$COMMIT_RESP" | python3 -m json.tool 2>/dev/null
            else
              echo ""
              echo "==> Google Play upload complete."
              echo "    Track    : $PLAY_TRACK"
              echo "    Version  : $APP_VERSION ($VERSION_CODE)"
              echo "    View at  : https://play.google.com/console/app/${PLAY_PACKAGE}/releases"
            fi
          fi
        fi
      fi
    fi
  fi
fi # end PUBLISH_PLAY

# ---------------------------------------------------------------------------
# 11. Build, upload, and submit iOS App Store build
#
# Phase 1 (Mac Mini via SSH): Sync repo, archive with xcodebuild, export IPA,
#   upload to App Store Connect (asc CLI preferred, altool fallback).
# Phase 2 (Linux, asc only): Apply metadata, submit for App Review, check status.
#
# Auth: API key (ASC_KEY_ID/ASC_ISSUER_ID/ASC_APP_ID) preferred;
#   falls back to legacy ASC_APPLE_ID/ASC_APP_PASSWORD for altool.
# ---------------------------------------------------------------------------
if ! $PUBLISH_APP_STORE; then
  echo ""
  echo "==> Skipping Apple App Store upload (not selected)."
else
  echo ""
  echo "==> Building and uploading to Apple App Store..."

  MAC_MINI="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
  MAC_MINI_REPO_PATH="${MAC_MINI_REPO_PATH:-peerloomllc/pearcal-native}"

  # ── Step 1: Sync repo to Mac Mini ──
  echo "    Syncing repo to $MAC_MINI (including freshly built bundles)..."
  rsync -az --rsync-path=/opt/homebrew/bin/rsync \
    --exclude='.git' --exclude='node_modules' --exclude='android' \
    "$REPO_ROOT/" "${MAC_MINI}:${MAC_MINI_REPO_PATH}/"
  echo "    Sync complete."
  echo ""

  # ── Determine auth mode ──
  USE_ASC_REMOTE=false
  if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_APP_ID:-}" ]; then
    USE_ASC_REMOTE=true
    echo "    Auth mode : API key (asc CLI)"
    echo "    Key ID    : ${ASC_KEY_ID}"
    echo "    App ID    : ${ASC_APP_ID}"
  else
    echo "    Auth mode : app-specific password (altool, legacy)"
    echo "    Apple ID  : ${ASC_APPLE_ID:-not set}"
  fi
  echo "    Host      : $MAC_MINI"
  echo "    Team ID   : ${ASC_TEAM_ID:-G79ALD29NA}"
  _confirm "Archive, export, and upload to App Store Connect on $MAC_MINI?"

  # ── Step 2: SSH to Mac Mini - archive, export, upload ──
  if $USE_ASC_REMOTE; then
    _asc_team="${ASC_TEAM_ID:-G79ALD29NA}"

    ssh "$MAC_MINI" "
      export PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' LANG=en_US.UTF-8
      export ASC_KEY_ID='${ASC_KEY_ID}'
      export ASC_ISSUER_ID='${ASC_ISSUER_ID}'
      export ASC_APP_ID='${ASC_APP_ID}'
      export ASC_TEAM_ID='${_asc_team}'
      cd ${MAC_MINI_REPO_PATH}
      /bin/bash scripts/ios-appstore.sh
    "
  else
    # Legacy altool path
    _asc_id="${ASC_APPLE_ID//\'/\'\\\'\'}"
    _asc_pw="${ASC_APP_PASSWORD//\'/\'\\\'\'}"
    _asc_team="${ASC_TEAM_ID:-G79ALD29NA}"

    ssh "$MAC_MINI" "
      export PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' LANG=en_US.UTF-8
      export ASC_APPLE_ID='${_asc_id}'
      export ASC_APP_PASSWORD='${_asc_pw}'
      export ASC_TEAM_ID='${_asc_team}'
      cd ${MAC_MINI_REPO_PATH}
      /bin/bash scripts/ios-appstore.sh
    "
  fi

  echo ""
  echo "==> Upload complete. Build is processing on App Store Connect."

  # ── Step 3: Apply metadata (Linux-side, asc only) ──
  # Resolved by the version-record step below and read again by Step 4. Empty
  # means "no usable version record", which gates both metadata and submission.
  ASC_VERSION_ID=""
  METADATA_DIR="$REPO_ROOT/metadata/ios"
  if $USE_ASC_REMOTE && [ -d "$METADATA_DIR" ] && command -v asc &>/dev/null; then
    echo ""
    echo "==> Applying App Store metadata from metadata/ios/..."

    VERSION_DIR="$METADATA_DIR/version/${APP_VERSION}"
    DEFAULT_DIR="$METADATA_DIR/version/default"

    # Ensure the App Store version record exists (required for pull/apply).
    # A freshly uploaded build does NOT auto-create the version record.
    #
    # App Store Connect allows only ONE in-flight version at a time, so a bare
    # `versions create` fails with "You cannot create a new version of the App
    # in the current state" whenever an earlier version is still open. That
    # bit PearPetal on 2026-07-23 (1.0.3 refused while 1.0.2 sat in review),
    # and every later step then failed as a knock-on. Two cases, opposite
    # handling:
    #
    #   EDITABLE  (PREPARE_FOR_SUBMISSION, DEVELOPER_REJECTED, REJECTED,
    #             METADATA_REJECTED, INVALID_BINARY) - the open version has not
    #             shipped, so RENAME it to this version. That is Apple's
    #             supported way to supersede an unreleased version.
    #   BLOCKING  (WAITING_FOR_REVIEW, IN_REVIEW, PENDING_DEVELOPER_RELEASE,
    #             PROCESSING_FOR_APP_STORE) - Apple owns it. Nothing local can
    #             fix it, so say so once and skip the rest instead of emitting
    #             a cascade of misleading warnings.
    #
    # ASC_VERSION_ID is the handle every later step needs; empty means "not
    # ready", which gates both metadata apply and submission.
    ASC_VERSION_ID=""
    if _asc_auth_linux; then
      _V_CASE=""; _V_ID=""; _V_FROM=""; _V_STATE=""
      eval "$(asc versions list --app "$ASC_APP_ID" --paginate --output json 2>/dev/null \
        | python3 -c "
import json, shlex, sys

EDITABLE = {'PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED',
            'METADATA_REJECTED', 'INVALID_BINARY'}
BLOCKING = {'WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE',
            'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_APP_STORE'}

try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
items = d.get('data', d if isinstance(d, list) else [])

def attr(x, *keys):
    a = x.get('attributes', {})
    for k in keys:
        if a.get(k) or x.get(k):
            return a.get(k) or x.get(k)
    return ''

target = '${APP_VERSION}'
match = editable = blocking = None
for x in items:
    v = attr(x, 'versionString')
    state = attr(x, 'appStoreState', 'appVersionState')
    if v == target:
        match = (x.get('id'), state)
    elif state in EDITABLE and editable is None:
        editable = (x.get('id'), v, state)
    elif state in BLOCKING and blocking is None:
        blocking = (v, state)

def emit(**kv):
    for k, v in kv.items():
        print('%s=%s' % (k, shlex.quote(str(v or ''))))

if match:
    emit(_V_CASE='exists', _V_ID=match[0], _V_STATE=match[1])
elif editable:
    emit(_V_CASE='rename', _V_ID=editable[0], _V_FROM=editable[1], _V_STATE=editable[2])
elif blocking:
    emit(_V_CASE='blocked', _V_FROM=blocking[0], _V_STATE=blocking[1])
else:
    emit(_V_CASE='create')
" 2>/dev/null)"

      case "${_V_CASE:-create}" in
        exists)
          ASC_VERSION_ID="$_V_ID"
          echo "    App Store version ${APP_VERSION} already exists (${_V_STATE})."
          ;;

        rename)
          echo "    App Store version ${APP_VERSION} does not exist, and version"
          echo "    ${_V_FROM} is still open in state ${_V_STATE}."
          echo "    App Store Connect allows only one in-flight version, so ${APP_VERSION}"
          echo "    cannot be created alongside it. Renaming the open version is the"
          echo "    supported way to supersede something that never shipped."
          _confirm "Rename App Store version ${_V_FROM} to ${APP_VERSION}?"
          if asc versions update --version-id "$_V_ID" --version "$APP_VERSION" >/dev/null; then
            ASC_VERSION_ID="$_V_ID"
            echo "    Renamed ${_V_FROM} -> ${APP_VERSION}."
          else
            echo "    WARNING: rename failed - skipping metadata apply and submission."
          fi
          ;;

        blocked)
          echo "    CANNOT PROCEED: version ${_V_FROM} is ${_V_STATE}."
          echo "    Apple owns that version right now, so ${APP_VERSION} cannot be created."
          echo "    Your build IS uploaded and safe in TestFlight - nothing is lost."
          echo "    Either wait for ${_V_FROM} to finish review, or cancel it:"
          echo "      asc review status --app ${ASC_APP_ID}"
          echo "      asc submit cancel --app ${ASC_APP_ID} --id <SUBMISSION_ID> --confirm"
          echo "    Then re-run the release. Skipping metadata apply and submission."
          ;;

        create)
          echo "    App Store version ${APP_VERSION} does not exist yet - creating..."
          PRIOR_VERSION=$(asc versions list --app "$ASC_APP_ID" --paginate --output json 2>/dev/null \
            | python3 -c "
import json, sys
d = json.load(sys.stdin)
items = d.get('data', d if isinstance(d, list) else [])
def ver(x):
    v = x.get('attributes', {}).get('versionString') or x.get('versionString', '')
    try: return tuple(int(p) for p in v.split('.'))
    except: return (0,)
target = tuple(int(p) for p in '${APP_VERSION}'.split('.') if p.isdigit())
priors = [x for x in items if ver(x) < target]
priors.sort(key=ver, reverse=True)
if priors:
    print(priors[0].get('attributes', {}).get('versionString') or priors[0].get('versionString', ''))
" 2>/dev/null)
          if [ -n "$PRIOR_VERSION" ]; then
            echo "    Copying metadata from prior version ${PRIOR_VERSION}..."
            asc versions create --app "$ASC_APP_ID" --version "$APP_VERSION" \
              --copy-metadata-from "$PRIOR_VERSION" >/dev/null \
              || echo "    WARNING: versions create failed."
          else
            echo "    No prior version found - creating ${APP_VERSION} without metadata copy."
            asc versions create --app "$ASC_APP_ID" --version "$APP_VERSION" >/dev/null \
              || echo "    WARNING: versions create failed."
          fi
          ASC_VERSION_ID=$(_asc_version_id "$APP_VERSION")
          if [ -n "$ASC_VERSION_ID" ]; then
            echo "    Created version ${APP_VERSION}."
          else
            echo "    WARNING: version ${APP_VERSION} still not found - skipping metadata apply."
          fi
          ;;
      esac
    fi

    # Bootstrap: if no canonical .json files exist anywhere, pull current state
    # from App Store Connect to seed metadata/ios/version/default/.
    if ! find "$METADATA_DIR" -name '*.json' -type f 2>/dev/null | grep -q .; then
      echo "    No canonical metadata found — bootstrapping from App Store Connect..."
      if _asc_auth_linux && asc metadata pull --app "$ASC_APP_ID" --version "$APP_VERSION" --dir "$METADATA_DIR"; then
        PULLED_DIR="$METADATA_DIR/version/${APP_VERSION}"
        if [ -d "$PULLED_DIR" ] && [ ! -d "$DEFAULT_DIR" ]; then
          mkdir -p "$DEFAULT_DIR"
          cp "$PULLED_DIR"/*.json "$DEFAULT_DIR/" 2>/dev/null || true
          echo "    Seeded $DEFAULT_DIR from pulled metadata."
        fi
        # Remove the pulled versioned dir so the whatsNew-injection step below
        # regenerates it from default/.
        rm -rf "$PULLED_DIR"
      else
        echo "    WARNING: metadata bootstrap pull failed — skipping metadata apply."
        DEFAULT_DIR=""
      fi
    fi

    # Create versioned metadata with whatsNew from release notes.
    #
    # Regenerated on EVERY run, not just when $VERSION_DIR is absent: a failed
    # release leaves a version dir behind, and the old "create only if missing"
    # test meant the retry silently shipped the first run's notes even after
    # release_notes.md had been fixed.
    if [ -n "$DEFAULT_DIR" ] && [ -d "$DEFAULT_DIR" ]; then
      mkdir -p "$VERSION_DIR"
      for f in "$DEFAULT_DIR"/*.json; do
        WHATS_NEW=""
        if [ -f "$REPO_ROOT/release_notes.md" ]; then
          WHATS_NEW=$(cat "$REPO_ROOT/release_notes.md")
        fi
        python3 -c "
import json, sys, re
with open('$f') as fh:
    data = json.load(fh)
# Strip emojis — App Store rejects non-ASCII symbols in whatsNew
notes = sys.stdin.read().strip()
data['whatsNew'] = re.sub(r'[^\x00-\x7F\u00C0-\u024F\u2014\u2019\u2018\u201C\u201D]+\s*', '', notes)
with open('${VERSION_DIR}/$(basename "$f")', 'w') as out:
    json.dump(data, out)
" <<< "$WHATS_NEW"
        echo "    Created ${VERSION_DIR}/$(basename "$f")"
      done
    fi

    if [ -z "$ASC_VERSION_ID" ]; then
      echo "    Skipping metadata apply - no usable App Store version record."
    elif _asc_auth_linux; then
      echo "    Dry run:"
      asc metadata apply --app "$ASC_APP_ID" --version "$APP_VERSION" \
        --dir "$METADATA_DIR" --dry-run || true
      echo ""
      _confirm "Apply this metadata to version ${APP_VERSION}?"
      if asc metadata apply --app "$ASC_APP_ID" --version "$APP_VERSION" \
           --dir "$METADATA_DIR"; then
        echo "    Metadata applied."
      else
        echo "    WARNING: Metadata apply failed (non-fatal)."
      fi
    fi
  elif $USE_ASC_REMOTE && [ -d "$METADATA_DIR" ]; then
    echo "    Metadata directory found but asc not available on Linux - skipping."
  fi

  # ── Step 4: Submit for App Review (Linux-side, asc only) ──
  #
  # NOT `asc publish appstore --submit`. That command requires --ipa (or a
  # local Xcode build) because it owns the whole upload-then-submit flow, and
  # the .ipa only ever exists on the Mac mini - so from this box it failed with
  # "Error: --ipa is required" on every release. Step 2 already uploaded the
  # build, so what is left is the lower-level submission lifecycle:
  #
  #   attach build -> declare export compliance -> validate -> submit
  #
  # `asc review submissions-*` is the API path for that, and it needs no .ipa.
  if $USE_ASC_REMOTE && command -v asc &>/dev/null; then
    echo ""
    echo "==> Submit for App Store review"

    if [ -z "${ASC_VERSION_ID:-}" ]; then
      echo "    Skipping submission - no usable App Store version record."
      echo "    The build IS uploaded; submit from App Store Connect once the"
      echo "    blocking version above is resolved."
    elif ! _asc_auth_linux; then
      echo "    WARNING: asc auth failed on Linux. Submit via App Store Connect."
    else
      # Attach the build. `asc builds list` needs a few minutes after upload
      # before the record appears, so say which is which rather than failing
      # with a bare 404.
      _BUILD_INFO=$(_asc_build_id "${_ios_build_number:-}")
      _BUILD_ID="${_BUILD_INFO%% *}"
      _BUILD_STATE="${_BUILD_INFO##* }"

      if [ -z "$_BUILD_ID" ]; then
        echo "    Build ${_ios_build_number} is not registered on App Store Connect yet."
        echo "    Builds take 5-15 minutes to process. Once it appears, run:"
        echo "      asc versions attach-build --version-id ${ASC_VERSION_ID} --build <BUILD_ID>"
        echo "    Skipping submission."
      elif [ "$_BUILD_STATE" != "VALID" ]; then
        echo "    Build ${_ios_build_number} is still ${_BUILD_STATE}, not VALID."
        echo "    Wait for processing to finish, then re-run. Skipping submission."
      else
        echo "    Attaching build ${_ios_build_number} (${_BUILD_ID})..."
        asc versions attach-build --version-id "$ASC_VERSION_ID" --build "$_BUILD_ID" >/dev/null \
          || echo "    WARNING: attach-build failed (it may already be attached)."

        # Export compliance. Apple blocks submission until every build answers
        # this, and it is set per BUILD, so a new build always starts unset.
        # It is a legal declaration, so ask rather than assume.
        # `asc validate` exits non-zero when it finds blocking errors, which is
        # exactly the case we care about, so capture first rather than piping
        # into grep under `set -o pipefail`.
        _VALIDATE_JSON=$(asc validate --app "$ASC_APP_ID" --version "$APP_VERSION" \
          --output json 2>/dev/null || true)
        if printf '%s' "$_VALIDATE_JSON" | grep -q 'build.encryption.missing'; then
          _PRIOR_ENC=$(_asc_prior_encryption)
          echo ""
          echo "    Apple needs an export-compliance answer for build ${_ios_build_number}."
          echo "    It is set per build, so a new build always starts unset, and it is a"
          echo "    legal declaration - so this asks rather than assuming."
          if [ -n "$_PRIOR_ENC" ]; then
            echo "    Most recent answered build of this app declared:"
            echo "      uses non-exempt encryption = ${_PRIOR_ENC}"
          else
            echo "    No prior build of this app has answered, so there is no precedent."
          fi
          _confirm "Declare build ${_ios_build_number} as NOT using non-exempt encryption?"
          asc builds update --build-id "$_BUILD_ID" --uses-non-exempt-encryption=false >/dev/null \
            || echo "    WARNING: could not set export compliance."
        fi

        echo "    Readiness check:"
        asc validate --app "$ASC_APP_ID" --version "$APP_VERSION" || true
        echo ""
        echo "    Note: submission fails if the build is still processing."
        _confirm "Submit version ${APP_VERSION} for App Store review?"

        echo "    Submitting ${APP_VERSION} for review..."
        _SUBMISSION_ID=$(asc review submissions-create --app "$ASC_APP_ID" --platform IOS --output json 2>/dev/null \
          | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('data', {}).get('id', ''))
except Exception:
    pass
" 2>/dev/null)

        if [ -z "$_SUBMISSION_ID" ]; then
          echo "    WARNING: could not create a review submission."
          echo "    Submit manually: https://appstoreconnect.apple.com/apps/${ASC_APP_ID}"
        elif ! asc review items-add --submission "$_SUBMISSION_ID" \
                --item-type appStoreVersions --item-id "$ASC_VERSION_ID" >/dev/null; then
          echo "    WARNING: could not add version ${APP_VERSION} to the submission."
          echo "    Cancel the empty submission: asc submit cancel --app ${ASC_APP_ID} --id ${_SUBMISSION_ID} --confirm"
        elif asc review submissions-submit --id "$_SUBMISSION_ID" --confirm >/dev/null; then
          echo "    Submitted for review."

          # ── Step 5: Check review status ──
          echo ""
          echo "==> Checking review status..."
          asc review status --app "$ASC_APP_ID" || true
          echo ""
          echo "    Monitor status:    asc review status --app $ASC_APP_ID"
          echo "    Diagnose issues:   asc review doctor --app $ASC_APP_ID"
        else
          echo "    WARNING: Submission failed - build may still be processing."
          echo "    Retry: asc review submissions-submit --id ${_SUBMISSION_ID} --confirm"
        fi
      fi
    fi
  else
    echo "    Build will appear in TestFlight within a few minutes."
    echo "    Submit for review manually via App Store Connect."
  fi
fi # end PUBLISH_APP_STORE

# ---------------------------------------------------------------------------
# 12. Post release announcement to Nostr
#
# Signs a kind:1 note with the Zapstore NSEC (SIGN_WITH) and broadcasts it
# to a set of well-known relays. Downloads nak if not already installed.
# ---------------------------------------------------------------------------
if ! $PUBLISH_NOSTR; then
  echo ""
  echo "==> Skipping Nostr announcement (not selected)."
elif $PUBLISH_FAILED; then
  echo ""
  echo "==> Skipping Nostr announcement — one or more publish steps failed."
else
  echo ""
  echo "==> Posting release announcement to Nostr..."

  # Ensure nak is available
  if ! command -v nak &>/dev/null; then
    echo "    nak not found — downloading..."
    NAK_URL=$(curl -s https://api.github.com/repos/fiatjaf/nak/releases/latest \
      | python3 -c "import sys,json; assets=json.load(sys.stdin).get('assets',[]); \
        url=[a['browser_download_url'] for a in assets if 'linux-amd64' in a['name'] and not a['name'].endswith('.sha256')]; \
        print(url[0] if url else '')" 2>/dev/null)
    if [ -z "$NAK_URL" ]; then
      echo "    ERROR: Could not find nak release for linux-amd64. Skipping Nostr step."
      echo "    Install manually: https://github.com/fiatjaf/nak/releases"
    else
      mkdir -p "$HOME/.local/bin"
      curl -sL "$NAK_URL" -o "$HOME/.local/bin/nak"
      chmod +x "$HOME/.local/bin/nak"
      export PATH="$HOME/.local/bin:$PATH"
      echo "    nak installed."
    fi
  fi

  if command -v nak &>/dev/null; then
    # Zapstore Nostr identity
    ZAPSTORE_HEX="78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d"
    ZAPSTORE_NPUB="npub10r8xl2njyepcw2zwv3a6dyufj4e4ajx86hz6v4ehu4gnpupxxp7stjt2p8"

    # Build the "what's new" body from the release notes, PRESERVING the
    # section grouping (Improvements / Bug Fixes / Other) and filling up to a
    # character budget.
    #
    # This replaces the old `head -3`, which took the first three bullets in
    # file order, threw the headings away, and so announced a twelve-PR release
    # as three uncategorised lines while the GitHub release told the full story.
    # See RELEASE-PIPELINE.md §4.
    NOSTR_NOTE_BUDGET="${NOSTR_NOTE_BUDGET:-900}"
    BULLETS=""
    NOTES_SRC=""
    if [ -n "${ZSP_NOTES_FILE:-}" ] && [ -f "${ZSP_NOTES_FILE:-}" ]; then
      NOTES_SRC="$ZSP_NOTES_FILE"
    elif [ -f release_notes.md ]; then
      NOTES_SRC="release_notes.md"
    fi
    if [ -n "$NOTES_SRC" ]; then
      BULLETS=$(NOTES_SRC="$NOTES_SRC" BUDGET="$NOSTR_NOTE_BUDGET" python3 -c '
import os, re, sys

BULLET = "• "
ELLIPSIS = "…"
ITEM_MAX = 120          # a single overlong bullet is trimmed, not dropped

src = os.environ["NOTES_SRC"]
budget = int(os.environ["BUDGET"])

# Parse the notes into [(heading, [items])] in file order. Headings keep their
# emoji so the Nostr note reads the same as the GitHub release.
groups = []
with open(src, encoding="utf-8", errors="replace") as fh:
    for raw in fh:
        line = raw.rstrip("\n")
        m = re.match(r"^#{2,4}\s+(.*)$", line)
        if m:
            title = m.group(1).strip()
            # The document title line is not a section heading
            if title.lower().startswith("what"):
                continue
            groups.append((title, []))
            continue
        m = re.match(r"^\s*[-*]\s+(.+)$", line)
        if m:
            item = m.group(1).replace("**", "").strip()
            if not item:
                continue
            if len(item) > ITEM_MAX:
                cut = item[:ITEM_MAX].rsplit(" ", 1)[0].rstrip(",.;:")
                item = cut + ELLIPSIS
            if not groups:
                groups.append((None, []))
            groups[-1][1].append(item)

out, used, dropped = [], 0, 0
for heading, items in groups:
    kept = []
    for item in items:
        cost = len(BULLET) + len(item) + 1
        if dropped == 0 and used + cost <= budget:
            kept.append(BULLET + item)
            used += cost
        else:
            dropped += 1
    if not kept:
        continue          # never emit a heading with nothing under it
    if heading:
        out.append(heading)
        used += len(heading) + 1
    out.extend(kept)

if dropped:
    out.append("%s%sand %d more" % (BULLET, ELLIPSIS, dropped))

sys.stdout.write("\n".join(out))
')
    fi

    NOTE_CONTENT="${APP_NAME} ${RELEASE_TAG} is out!"$'\n\n'"${APP_TAGLINE:-}"

    if [ -n "$BULLETS" ]; then
      NOTE_CONTENT+=$'\n\n'"What's new:"$'\n'"${BULLETS}"
    fi

    NOTE_CONTENT+=$'\n\n'"${APP_WEBSITE:-}"$'\n\n'"nostr:${ZAPSTORE_NPUB}"$'\n\n'"${NOSTR_HASHTAGS:-}"

    NOSTR_RELAYS=(
      wss://relay.damus.io
      wss://nos.lol
      wss://relay.primal.net
      wss://relay.nostr.net
    )

    # Write note to temp file and open in vi for editing
    NOSTR_DRAFT=$(mktemp /tmp/nostr-note-XXXXXX.txt)
    printf '%s' "$NOTE_CONTENT" > "$NOSTR_DRAFT"
    echo "    Opening note in vi for review/editing..."
    vi "$NOSTR_DRAFT"
    NOTE_CONTENT=$(cat "$NOSTR_DRAFT")
    rm -f "$NOSTR_DRAFT"

    echo "    Final content:"
    echo "$NOTE_CONTENT" | sed 's/^/      /'
    echo ""
    echo "    Relays: ${NOSTR_RELAYS[*]}"

    _confirm "Post this note to Nostr?"

    if nak event --sec "$SIGN_WITH" -k 1 -c "$NOTE_CONTENT" \
        -p "$ZAPSTORE_HEX" \
        "${NOSTR_RELAYS[@]}"; then
      echo "    Nostr announcement posted."
    else
      echo "    WARNING: Nostr publish failed (non-fatal — release is already complete)."
    fi
  fi
fi # end PUBLISH_NOSTR

# ---------------------------------------------------------------------------
# 13. Close-out summary and deferred-action reminders
#
# Every publish step is best-effort past the tag push: a Zapstore outage sets
# PUBLISH_FAILED rather than aborting, so an already-created GitHub release is
# never stranded. That makes a final ledger worth printing, because a partial
# release otherwise scrolls past unnoticed. See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
echo ""
echo "==> $APP_NAME $RELEASE_TAG"
_report() { printf '    %-14s %s\n' "$1" "$2"; }
$PUBLISH_GITHUB    && _report "GitHub"    "published" || _report "GitHub"    "skipped"
$PUBLISH_ZAPSTORE  && _report "Zapstore"  "published" || _report "Zapstore"  "skipped"
$PUBLISH_PLAY      && _report "Google Play" "published" || _report "Google Play" "skipped"
$PUBLISH_APP_STORE && _report "App Store" "uploaded"  || _report "App Store" "skipped"
$PUBLISH_NOSTR     && _report "Nostr"     "announced" || _report "Nostr"     "skipped"

if $PUBLISH_FAILED; then
  echo ""
  echo "    WARNING: at least one publish step failed. Scroll up for which."
  echo "    Re-run with --retag to redo the release in place once fixed."
fi

if ${APP_STORE_DEFERRED:-false}; then
  echo ""
  echo "==> Reminder: App Store review submission deferred"
  echo "    The IPA uploaded but Apple was still processing the build when the"
  echo "    script checked. Once processing completes (5-15 min after upload),"
  echo "    submit for review from App Store Connect or with the asc commands"
  echo "    printed by step 11 above."
fi

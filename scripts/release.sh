#!/usr/bin/env bash
# PearCal local release script
# Usage: ./scripts/release.sh [vX.Y.Z] [--retag] [--check-versions]
#
# Flags:
#   vX.Y.Z             Override the auto-detected version
#   --retag            Delete and recreate a stranded local tag from a failed run
#   --check-versions   Query GitHub and Zapstore versions and exit (no build)
#   --skip-play        Skip Google Play upload even if credentials are configured
#
# Required env vars (or set in scripts/.env):
#   KEYSTORE_PASSWORD            - release keystore password
#   KEY_PASSWORD                 - release key password
#   SIGN_WITH                    - Zapstore NSEC for signing
#
# Optional env vars:
#   KEYSTORE_FILE                - path to keystore (default: ~/keystore.jks)
#   KEY_ALIAS                    - key alias (default: pearcal)
#   GITHUB_TOKEN                 - GitHub PAT (falls back to gh auth token)
#   GITHUB_REMOTE                - git remote name (default: github, then origin)
#   PLAY_SERVICE_ACCOUNT_JSON    - path to GCP service account JSON for Play upload
#   PLAY_TRACK                   - Play track: internal / alpha / beta / production
#                                  (default: production)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load scripts/.env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

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

  # --- Path 1: gcloud application-default credentials ---
  if command -v gcloud > /dev/null 2>&1; then
    local tok
    tok=$(gcloud auth application-default print-access-token 2>/dev/null || echo "")
    if [ -n "$tok" ]; then
      printf '%s' "$tok"
      return
    fi
  fi

  # --- Path 2: service account JSON ---
  if [ -z "$sa_json" ] || [ ! -f "$sa_json" ]; then
    echo ""
    return
  fi

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

for arg in "$@"; do
  case "$arg" in
    --retag) RETAG=true ;;
    --check-versions) CHECK_VERSIONS_ONLY=true ;;
    --skip-play) SKIP_PLAY=true ;;
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
  KEY_ALIAS="${KEY_ALIAS:-pearcal}"
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
  ZSP_IDENTIFIER="com.pearcal"
  echo "    App identifier: $ZSP_IDENTIFIER (hardcoded fallback)"
else
  echo "    App identifier: $ZSP_IDENTIFIER"
fi

echo "==> Checking published versions..."
GH_VERSION=$(_github_latest_version "$GH_TOKEN" "$REPO_SLUG")
ZSP_VERSION_CURRENT=$(_zapstore_latest_version "$ZSP_IDENTIFIER")
PLAY_VERSION_CURRENT=$(_play_latest_version "$ZSP_IDENTIFIER" "${PLAY_SERVICE_ACCOUNT_JSON:-}" "${PLAY_TRACK:-production}")

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
  exit 0
fi

if [ -n "${EXPLICIT_TAG:-}" ]; then
  GH_HAS_VERSION=false
  ZSP_HAS_VERSION=false
  PLAY_HAS_VERSION=false
  [ "$GH_VERSION" = "$APP_VERSION" ]           && GH_HAS_VERSION=true
  [ "$ZSP_VERSION_CURRENT" = "$APP_VERSION" ]  && ZSP_HAS_VERSION=true
  [ "$PLAY_VERSION_CURRENT" = "$APP_VERSION" ] && PLAY_HAS_VERSION=true

  # Build a human-readable summary of what's already published
  _already=""
  $GH_HAS_VERSION   && _already="${_already}GitHub, "
  $ZSP_HAS_VERSION  && _already="${_already}Zapstore, "
  $PLAY_HAS_VERSION && _already="${_already}Google Play, "
  _already="${_already%, }"   # strip trailing comma+space

  # Check if all configured destinations already have this version
  _all_have=true
  $GH_HAS_VERSION  || _all_have=false
  $ZSP_HAS_VERSION || _all_have=false
  if [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] && [ -f "${PLAY_SERVICE_ACCOUNT_JSON:-}" ]; then
    $PLAY_HAS_VERSION || _all_have=false
  fi

  if $_all_have; then
    echo ""
    echo "    $RELEASE_TAG is already published on all configured destinations: $_already"
    echo "    Nothing to do unless you want to republish (e.g. to fix release notes)."
    echo ""
    while true; do
      read -rp "    Republish $RELEASE_TAG to Zapstore? [y/n] " _reply
      case "$_reply" in
        [Yy]) ZAPSTORE_ONLY=true; break ;;
        [Nn]) echo "Aborted."; exit 0 ;;
        *) echo "    Please enter y or n." ;;
      esac
    done

  elif $GH_HAS_VERSION && ! $ZSP_HAS_VERSION; then
    echo ""
    echo "    $RELEASE_TAG exists on GitHub but not on Zapstore — publishing to Zapstore only."
    ZAPSTORE_ONLY=true

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
PUBLISH_PLAY=false

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

  echo ""

  # Bail out if nothing selected
  if ! $PUBLISH_GITHUB && ! $PUBLISH_ZAPSTORE && ! $PUBLISH_PLAY; then
    echo "No destinations selected. Aborted."
    exit 0
  fi

  # Google Play requires an AAB — warn if Play is selected alongside APK targets
  if $PUBLISH_PLAY; then
    echo "    Note: Google Play requires AAB format. Both APK and AAB will be built."
    echo ""
  fi
fi

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
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  console.log('Updated app.json to ' + v + ' (versionCode: ' + versionCode + ')');
"

# Derive APP_VERSION_CODE from the version string for Gradle
IFS='.' read -r _vmaj _vmin _vpat <<< "$APP_VERSION"
APP_VERSION_CODE=$(( _vmaj * 1000000 + _vmin * 1000 + _vpat ))
export APP_VERSION_CODE

echo "    Version     : $(node -p "require('./app.json').expo.version")"
echo "    versionCode : $(node -p "require('./app.json').expo.android.versionCode")"
_confirm "app.json version looks correct — proceed with bundle builds?"

# ---------------------------------------------------------------------------
# 1. Build UI bundle
# ---------------------------------------------------------------------------
echo "==> Building UI bundle..."
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle

# ---------------------------------------------------------------------------
# 2. Build Bare bundle
# ---------------------------------------------------------------------------
echo "==> Building Bare bundle..."
node_modules/.bin/bare-pack --linked src/bare.js -o assets/bare-universal.bundle

# ---------------------------------------------------------------------------
# 3. Build signed release APK (and AAB if publishing to Google Play)
# ---------------------------------------------------------------------------
echo "==> Building signed release APK (this takes a few minutes)..."
(
  export KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD KEY_PASSWORD APP_VERSION APP_VERSION_CODE
  cd android && ./gradlew assembleRelease -q
)

if $PUBLISH_PLAY; then
  echo "==> Building signed release AAB for Google Play..."
  (
    export KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD KEY_PASSWORD APP_VERSION APP_VERSION_CODE
    cd android && ./gradlew bundleRelease -q
  )
fi

# ---------------------------------------------------------------------------
# 4. Copy artifacts with version names
# ---------------------------------------------------------------------------
APK_NAME="pearcal-${RELEASE_TAG}.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$APK_NAME"
APK_SIZE=$(du -sh "$APK_NAME" | cut -f1)
echo "==> Built APK: $APK_NAME  ($APK_SIZE)"

AAB_NAME=""
if $PUBLISH_PLAY; then
  AAB_NAME="pearcal-${RELEASE_TAG}.aab"
  cp android/app/build/outputs/bundle/release/app-release.aab "$AAB_NAME"
  AAB_SIZE=$(du -sh "$AAB_NAME" | cut -f1)
  echo "==> Built AAB: $AAB_NAME  ($AAB_SIZE)"
fi

echo ""
if $PUBLISH_PLAY; then
  _confirm "APK ($APK_SIZE) and AAB ($AAB_SIZE) look correct — proceed with release notes?"
else
  _confirm "APK size looks reasonable ($APK_SIZE) — proceed with release notes?"
fi

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

  _add_entry "$TITLE" "$SUMMARY"
done < <(git log "$LOG_RANGE" --merges --format="%H" --reverse)

# Collect non-merge commits (no commit IDs, categorised the same way)
while IFS='|' read -r sha subject; do
  [[ -z "$subject" ]] && continue
  _add_entry "$subject" ""
done < <(git log "$LOG_RANGE" --no-merges --format="%H|%s")

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
echo "--- Release notes ---"
cat release_notes.md
echo "---"
_confirm "Release notes look good?"

# ---------------------------------------------------------------------------
# 6. Push tag and create GitHub release
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

echo ""
echo "    Remote : $GIT_REMOTE"
echo "    Tag    : $RELEASE_TAG"
echo "    Branch : $(git rev-parse --abbrev-ref HEAD)"
echo "    Commit : $(git rev-parse --short HEAD)  $(git log -1 --format='%s')"
_confirm "Push tag $RELEASE_TAG to $GIT_REMOTE? (This cannot be undone without a force-delete)"

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
_confirm "Create public GitHub release $RELEASE_TAG and upload APK?"

if [ -n "$GH_TOKEN" ] && [ -n "$REPO_SLUG" ]; then
  # --- Create the release via REST API ---
  echo "    Calling GitHub API for repo: $REPO_SLUG"
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

  UPLOAD_URL=$(printf '%s' "$RELEASE_RESP" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['upload_url'].split('{')[0])")

  # --- Upload APK asset ---
  echo "==> Uploading $APK_NAME..."
  UPLOAD_RESP_FILE=$(mktemp)
  curl \
    -X POST \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/vnd.android.package-archive" \
    "${UPLOAD_URL}?name=${APK_NAME}" \
    --data-binary "@${APK_NAME}" \
    --progress-bar \
    -o "$UPLOAD_RESP_FILE" 2>&1
  UPLOAD_RESP=$(cat "$UPLOAD_RESP_FILE"); rm -f "$UPLOAD_RESP_FILE"

  UPLOAD_ERROR=$(printf '%s' "$UPLOAD_RESP" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" \
    2>/dev/null || echo "")
  if [ -n "$UPLOAD_ERROR" ]; then
    echo ""
    echo "ERROR: APK upload failed:"
    printf '%s\n' "$UPLOAD_RESP" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$UPLOAD_RESP"
    echo ""
    echo "The GitHub release was created but the APK was not attached."
    echo "You can upload it manually at: https://github.com/${REPO_SLUG}/releases/tag/${RELEASE_TAG}"
    exit 1
  fi
  echo "    Uploaded successfully."

else
  # Fallback: gh CLI (requires working auth)
  echo "    (GITHUB_TOKEN not set or repo slug unknown — falling back to gh CLI)"
  gh release create "$RELEASE_TAG" "$APK_NAME" \
    --title "$RELEASE_TAG" \
    --notes-file release_notes.md
fi

else
  echo ""
  echo "==> Skipping GitHub release (not selected)."
fi # end PUBLISH_GITHUB

fi # end of full build + GitHub release pipeline

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

  PLAY_TRACK="${PLAY_TRACK:-production}"
  PLAY_PACKAGE="com.pearcal"

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
    PLAY_TOKEN=$(_play_token "${PLAY_SERVICE_ACCOUNT_JSON:-}")

    if [ -z "$PLAY_TOKEN" ]; then
      echo "    ERROR: Failed to obtain Google OAuth2 token."
      echo "    Run 'gcloud auth application-default login' or set PLAY_SERVICE_ACCOUNT_JSON."
    else
      echo "    OAuth2 token obtained."

      BASE_URL="https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE}"

      # --- Step 1: Create edit ---
      EDIT_RESP=$(curl -sf \
        -X POST \
        -H "Authorization: Bearer $PLAY_TOKEN" \
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
            "${BASE_URL}/edits/${EDIT_ID}" > /dev/null 2>&1 || true
          echo "    Edit discarded."
        else
          echo "    APK uploaded (versionCode: $VERSION_CODE)"

          # --- Step 3: Assign AAB to track with release notes ---
          # Truncate release notes to 500 chars (Play Store limit)
          PLAY_NOTES_TEXT=""
          if [ -f "${ZSP_NOTES_FILE:-}" ]; then
            PLAY_NOTES_TEXT=$(head -c 500 "$ZSP_NOTES_FILE")
          elif [ -f release_notes.md ]; then
            PLAY_NOTES_TEXT=$(head -c 500 release_notes.md)
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
          TRACK_RESP=$(curl -sf \
            -X PUT \
            -H "Authorization: Bearer $PLAY_TOKEN" \
            -H "Content-Type: application/json" \
            "${BASE_URL}/edits/${EDIT_ID}/tracks/${PLAY_TRACK}" \
            -d "$TRACK_BODY")
          TRACK_ERR=$(printf '%s' "$TRACK_RESP" \
            | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',{}).get('message',''))" \
            2>/dev/null || echo "")

          if [ -n "$TRACK_ERR" ]; then
            echo "    ERROR: Track assignment failed: $TRACK_ERR"
            curl -sf -X DELETE \
              -H "Authorization: Bearer $PLAY_TOKEN" \
              "${BASE_URL}/edits/${EDIT_ID}" > /dev/null 2>&1 || true
            echo "    Edit discarded."
          else
            echo "    Assigned to $PLAY_TRACK track."

            # --- Step 4: Commit edit ---
            COMMIT_RESP=$(curl -sf \
              -X POST \
              -H "Authorization: Bearer $PLAY_TOKEN" \
              "${BASE_URL}/edits/${EDIT_ID}:commit")
            COMMIT_ERR=$(printf '%s' "$COMMIT_RESP" \
              | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',{}).get('message',''))" \
              2>/dev/null || echo "")

            if [ -n "$COMMIT_ERR" ]; then
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
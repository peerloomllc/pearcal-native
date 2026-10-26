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

# Shared release helpers, one copy for every PeerLoom app, in the sibling repo
# peerloomllc/peerloom-release (proposals/2026-09-17-shared-release-library.md).
RELEASE_LIB="$REPO_ROOT/../peerloom-release/release-lib.sh"
if [ ! -f "$RELEASE_LIB" ]; then
  echo "error: $RELEASE_LIB not found - clone peerloomllc/peerloom-release beside this repo" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$RELEASE_LIB"

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
for _k in APP_NAME ARTIFACT_PREFIX; do
  if [ -z "${!_k:-}" ]; then
    echo "error: $_k is not set — check $SCRIPT_DIR/app.conf" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------

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

# Uses $REPO_ROOT so this works regardless of invocation directory.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
RELEASE_TAG=""
RETAG=false
CHECK_VERSIONS_ONLY=false
SKIP_PLAY=false
SKIP_NOSTR=false
SKIP_DESKTOP=false

for arg in "$@"; do
  case "$arg" in
    --retag) RETAG=true ;;
    --check-versions) CHECK_VERSIONS_ONLY=true ;;
    --skip-play) SKIP_PLAY=true ;;
    --skip-nostr) SKIP_NOSTR=true ;;
    --skip-desktop) SKIP_DESKTOP=true ;;
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

# A real release must run the reviewed, current shared library (release-lib.sh).
if ! $CHECK_VERSIONS_ONLY; then release_lib_require_current; fi

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
                      # artifacts. Uploaded alongside the binaries they cover.
PUBLISH_PLAY=false
PUBLISH_APP_STORE=false
PUBLISH_FAILED=false   # set to true if any selected publish step fails

_play_configured && PUBLISH_PLAY=true

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

# PearCal's own blind seeder is no longer built or published here. PeerLoom
# Seeder (peerloomllc/peerloom-seeder) is the one seeder for every app. See
# proposals/2026-10-12-peerloom-seeder-product.md.

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
  if ! $PUBLISH_GITHUB && ! $PUBLISH_ZAPSTORE && ! $PUBLISH_NOSTR && ! $PUBLISH_PLAY && ! $PUBLISH_APP_STORE && ! $PUBLISH_DESKTOP; then
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
elif $ZAPSTORE_ONLY; then
  # Republish the existing GitHub release to Zapstore. Nothing is built, so the
  # other stores stay off (they would run with no artifacts). The Nostr note is
  # still offered: a rerun like this usually follows a failed release, which
  # skipped the note too.
  PUBLISH_GITHUB=false
  release_ask_nostr
  PUBLISH_PLAY=false
  PUBLISH_APP_STORE=false
  PUBLISH_DESKTOP=false
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

# Nothing collects these if the run stops first: a "no" at the step 4e gate, a
# red Gradle build, a Ctrl-C. Without a trap the electron-builder and rsync
# processes would keep going after the script is gone. Each collected PID is
# cleared right after its wait, so on a normal run this fires against an empty
# list. Kills the whole tree, since a background subshell here is not its own
# process group and killing it alone would orphan its children.
_kill_tree () {
  local _p="$1" _c
  for _c in $(pgrep -P "$_p" 2>/dev/null || true); do _kill_tree "$_c"; done
  kill "$_p" 2>/dev/null || true
}
_reap_background_builds () {
  local _p _any=false
  for _p in "${PID_LINUX:-}" "${PID_MAC:-}" "${PID_WIN:-}"; do
    [ -n "$_p" ] || continue
    kill -0 "$_p" 2>/dev/null || continue
    $_any || { echo ""; echo "==> Stopping the background builds still running..."; _any=true; }
    _kill_tree "$_p"
  done
}
trap _reap_background_builds EXIT
trap '_reap_background_builds; exit 130' INT
trap '_reap_background_builds; exit 143' TERM

# ---------------------------------------------------------------------------
# Start the slow local builds now, in the background
#
# The desktop artifacts share nothing with the Android build: different
# toolchains, different directories, and nothing between here and Phase B'
# writes anything they package. Every bundle they ship was built in step 1
# above. So they start here and run while Gradle works and while you edit the
# release notes, instead of the machine standing idle through both. Step 5b
# collects them and keeps the same best-effort behaviour: a platform that
# fails is reported and skipped, never blocking the mobile release.
#
# Every background job reads stdin from /dev/null. Their output goes to log
# files, so a build that unexpectedly prompted would otherwise steal keystrokes
# from the vi session editing the release notes.
# ---------------------------------------------------------------------------
PID_LINUX=""; PID_MAC=""; PID_WIN=""; DESKTOP_STARTED_AT=$(date +%s)
if $PUBLISH_DESKTOP; then
  # Re-vendor, re-patch and re-bundle the UI ONCE, here, before the three
  # builds fork. Each build script used to do it itself, so running them
  # concurrently had three processes writing electron/node_modules,
  # electron/vendor/ and src/renderer/app-ui-electron.js at the same time.
  # SKIP_ELECTRON_PREP tells them it is already done; run on its own, each
  # script still does its own prep.
  echo "==> Preparing the desktop build tree (vendor, patches, UI bundle)..."
  ( cd electron && node scripts/prepack.js && npm run patch && bash scripts/bundle-ui.sh ) \
    > /tmp/pearcal-build-prep.log 2>&1 \
    || { echo "    ✗ desktop prep FAILED - see /tmp/pearcal-build-prep.log"; tail -20 /tmp/pearcal-build-prep.log | sed 's/^/        /'; PUBLISH_DESKTOP=false; }
fi
if $PUBLISH_DESKTOP; then
  echo "==> Starting the desktop builds in the background (Linux + Mac + Win)..."
  echo "    Logs: /tmp/pearcal-build-{linux,mac,windows}.log"
  rm -f /tmp/pearcal-build-{linux,mac,windows}.log
  export SKIP_ELECTRON_PREP=1
  (cd electron && bash scripts/build-linux.sh)    < /dev/null > /tmp/pearcal-build-linux.log   2>&1 &
  PID_LINUX=$!
  (cd electron && npm run build:mac --silent)     < /dev/null > /tmp/pearcal-build-mac.log     2>&1 &
  PID_MAC=$!
  (cd electron && npm run build:windows --silent) < /dev/null > /tmp/pearcal-build-windows.log 2>&1 &
  PID_WIN=$!
  unset SKIP_ELECTRON_PREP
fi

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

# Both artifacts come out of ONE Gradle invocation. As two invocations the
# whole configuration phase, the JS bundle and the resource processing were
# done twice; as two tasks in a single build Gradle shares all of that and only
# the packaging differs.
GRADLE_TASKS=(assembleRelease)
if $PUBLISH_PLAY; then
  GRADLE_TASKS+=(bundleRelease)
  echo "==> Building signed release APK and AAB (this takes a few minutes)..."
else
  echo "==> Building signed release APK (this takes a few minutes)..."
fi
(
  export KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD KEY_PASSWORD APP_VERSION APP_VERSION_CODE
  export JAVA_HOME="$ANDROID_JAVA"
  export PATH="$ANDROID_JAVA/bin:$PATH"
  cd android && ./gradlew "${GRADLE_TASKS[@]}" -q -PreactNativeArchitectures=arm64-v8a,armeabi-v7a
)

# ---------------------------------------------------------------------------
# 4. Copy artifacts with version names
# ---------------------------------------------------------------------------
release_copy_android_artifacts

# ---------------------------------------------------------------------------
# 4e. Generate .sha256 sidecars for the mobile artifacts
#
# PearCal used to ship its APK with no checksum, so anyone sideloading it
# from GitHub had nothing to verify it against.
# See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
release_write_checksums

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
release_write_notes

# ---------------------------------------------------------------------------
# Phase B (slow) — the desktop builds run here, AFTER the
# release notes are finalized, so they run unattended instead of making you
# wait before you can edit the notes. Adopted suite-wide from PearCircle.
# Still gated on NEEDS_BUILD and still best-effort. See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
if $NEEDS_BUILD; then

# ---------------------------------------------------------------------------
# 5b. Build desktop artifacts in parallel (Linux/Mac/Win)
# ---------------------------------------------------------------------------
# Three independent build paths run concurrently in subshells, started back
# before the Gradle build so they overlap it and the release-notes edit; this
# step only collects them. Output goes to per-platform log files in /tmp so a
# failure in one doesn't bury another's stdout. Failures are isolated - a
# single platform that errors is announced and skipped, the rest of the
# release continues. Ships the Mac signed-not-notarized .dmg and the unsigned
# Win .exe as official artifacts (per project decision; users right-click
# → Open on Mac, click-through SmartScreen on Win). Linux is the one fully
# clean platform.
if $PUBLISH_DESKTOP; then
  echo "==> Collecting the desktop builds (started before the Gradle build)..."

  # Wait for each independently and capture per-platform exit status so a
  # single failure doesn't take down the others. `wait $PID` re-raises the
  # child exit code, but under `set -e` a non-zero would abort the script;
  # the `|| STATUS=$?` form catches the failure AND records the real exit
  # code (using `|| true; $?` would always be 0 — the truthy true).
  STATUS_LINUX=0; wait $PID_LINUX || STATUS_LINUX=$?
  STATUS_MAC=0;   wait $PID_MAC   || STATUS_MAC=$?
  STATUS_WIN=0;   wait $PID_WIN   || STATUS_WIN=$?
  PID_LINUX=""; PID_MAC=""; PID_WIN=""
  echo "    Desktop builds finished in $(( $(date +%s) - DESKTOP_STARTED_AT ))s (linux $STATUS_LINUX, mac $STATUS_MAC, win $STATUS_WIN)."

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

fi # end NEEDS_BUILD (desktop artifacts)

# ---------------------------------------------------------------------------
# 5e. Generate .sha256 sidecars for the desktop artifacts, then the final gate
#
# The APK got its sidecar in step 4e, so only the desktop artifacts need one
# here. This is the last confirm before anything irreversible: step 6 commits
# and step 6b pushes the tag.
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
_confirm "$_RELEASE_SUMMARY ready to publish?"

# ---------------------------------------------------------------------------
# 5f. Generate the iOS version metadata BEFORE the bump commit
# ---------------------------------------------------------------------------
# metadata/ios/version/$APP_VERSION is a generated dir: version/default/*.json
# with `whatsNew` replaced by release_notes.md. It used to be written only in
# the App Store step (11), which runs after §6, so §6 never saw it and the dir
# was left uncommitted.
#
# Generating here means §6 commits it and the tag carries the notes the release
# shipped with. The App Store step still calls this a second time, because it
# is the only place that can seed version/default/ by pulling it from App Store
# Connect. The function is idempotent: the same default/ plus the same
# release_notes.md gives identical files, so the second call is normally a
# no-op.
_gen_ios_version_metadata() {
  local _metadata_dir="$REPO_ROOT/metadata/ios"
  local _default_dir="$_metadata_dir/version/default"
  local _version_dir="$_metadata_dir/version/${APP_VERSION}"
  local _f _whats_new=""

  # Nothing to generate from yet. The App Store step can bootstrap default/.
  compgen -G "$_default_dir/*.json" > /dev/null || return 1

  if [ -f "$REPO_ROOT/release_notes.md" ]; then
    _whats_new=$(cat "$REPO_ROOT/release_notes.md")
  fi

  mkdir -p "$_version_dir"
  for _f in "$_default_dir"/*.json; do
    python3 -c "
import json, sys, re
with open('$_f') as fh:
    data = json.load(fh)
# Strip emojis - App Store rejects non-ASCII symbols in whatsNew
notes = sys.stdin.read().strip()
data['whatsNew'] = re.sub(r'[^\x00-\x7FÀ-ɏ—’‘“”]+\s*', '', notes)
with open('${_version_dir}/$(basename "$_f")', 'w') as out:
    json.dump(data, out)
" <<< "$_whats_new"
    echo "    Created ${_version_dir}/$(basename "$_f")"
  done
}

if $PUBLISH_APP_STORE; then
  echo ""
  echo "==> Generating iOS version metadata for $APP_VERSION..."
  _gen_ios_version_metadata \
    || echo "    Skipped - no metadata/ios/version/default/*.json yet (the App Store step will seed it)."
fi

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
# Step 0 rewrites app.json + the Xcode project, but nothing ever committed
# them. The tag was then cut from a tree still carrying the PREVIOUS version, so every release
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
  metadata/ios/en-US/release_notes.txt
  metadata/ios/version/default
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
release_push_and_tag

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

  # --- Upload every asset, several at a time ---
  #
  # These went out strictly one after another: the APK, up to five desktop
  # installers, every .sha256 sidecar and the update manifests, one file at a time over a link nowhere
  # near saturated. Uploads are network-bound and independent of each other,
  # so they now overlap. Four at a time by default, because more streams to one
  # host stop adding throughput and start competing; RELEASE_UPLOAD_JOBS
  # overrides it.
  #
  # The per-file progress bars are gone, since interleaved bars are unreadable.
  # Nothing else about an upload changed: every response is still captured and
  # checked one by one below, a name that already exists on the release is
  # still deleted and retried through _upload_release_asset, a failed desktop
  # asset is still best-effort, and a failed APK still stops the run.
  RELEASE_UPLOAD_JOBS="${RELEASE_UPLOAD_JOBS:-4}"

  if [ ! -f "$APK_NAME" ]; then
    echo ""
    echo "ERROR: $APK_NAME is missing - nothing to attach to the release."
    exit 1
  fi

  UPLOAD_QUEUE=()
  for _f in "$APK_NAME" "${DESKTOP_ARTIFACTS[@]:-}" "${CHECKSUM_ARTIFACTS[@]:-}"; do
    [ -n "$_f" ] && [ -f "$_f" ] && UPLOAD_QUEUE+=("$_f")
  done

  echo "==> Uploading ${#UPLOAD_QUEUE[@]} asset(s), up to ${RELEASE_UPLOAD_JOBS} at a time..."
  _upload_started_at=$(date +%s)
  _upload_resps=()
  for _f in "${UPLOAD_QUEUE[@]}"; do
    _name=$(basename "$_f")
    _ctype=$(_release_content_type "$_name")
    _rf=$(mktemp); _upload_resps+=("$_rf")
    echo "    uploading $_name ($_ctype, $(du -h "$_f" | cut -f1))"
    curl -s \
      -X POST \
      -H "Authorization: Bearer $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: $_ctype" \
      "${UPLOAD_URL}?name=${_name}" \
      --data-binary "@${_f}" \
      -o "$_rf" 2>/dev/null &
    # Hold the queue at RELEASE_UPLOAD_JOBS. `wait -n` reaps whichever finishes
    # first; `|| true` because a failed upload must not trip `set -e` here, it
    # is diagnosed from its own response below.
    while [ "$(jobs -rp | wc -l)" -ge "$RELEASE_UPLOAD_JOBS" ]; do wait -n 2>/dev/null || true; done
  done
  wait
  echo "    Uploads finished in $(( $(date +%s) - _upload_started_at ))s. Checking each response..."

  APK_UPLOAD_OK=true
  for _i in "${!UPLOAD_QUEUE[@]}"; do
    _f="${UPLOAD_QUEUE[$_i]}"
    _name=$(basename "$_f")
    _resp=$(cat "${_upload_resps[$_i]}"); rm -f "${_upload_resps[$_i]}"
    _err=$(printf '%s' "$_resp" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" \
      2>/dev/null || echo "")
    if [ -z "$_err" ]; then
      echo "    ✓ Uploaded $_name."
      continue
    fi
    _already=$(printf '%s' "$_resp" \
      | python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
    for e in d.get('errors',[]) or []:
        if e.get('code')=='already_exists':
            print('1'); break
except Exception:
    pass" 2>/dev/null || echo "")
    if [ "$_already" = "1" ]; then
      echo "    (asset $_name already exists on the release - deleting and retrying)"
      _delete_release_asset_by_name "$_name" || true
      if _upload_release_asset "$_f"; then continue; fi
    else
      echo "    ✗ Upload failed for $_name:"
      printf '%s\n' "$_resp" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$_resp"
    fi
    if [ "$_f" = "$APK_NAME" ]; then
      APK_UPLOAD_OK=false
    else
      echo "    (continuing - a desktop artifact failure doesn't block the rest of the release)"
    fi
  done

  if ! $APK_UPLOAD_OK; then
    echo ""
    echo "The GitHub release was created but the APK was not attached."
    echo "You can upload it manually at: https://github.com/${REPO_SLUG}/releases/tag/${RELEASE_TAG}"
    exit 1
  fi


else
  # Fallback: gh CLI (requires working auth)
  echo "    (GITHUB_TOKEN not set or repo slug unknown — falling back to gh CLI)"
  gh release create "$RELEASE_TAG" "$APK_NAME" "${DESKTOP_ARTIFACTS[@]}" "${CHECKSUM_ARTIFACTS[@]}" \
    --title "$RELEASE_TAG" \
    --notes-file release_notes.md
fi

else
  echo ""
  echo "==> Skipping GitHub release (not selected)."
fi # end PUBLISH_GITHUB

# ---------------------------------------------------------------------------
# 8. Install zsp if needed
# ---------------------------------------------------------------------------
release_install_zsp

# ---------------------------------------------------------------------------
# 9. Publish to Zapstore
# ---------------------------------------------------------------------------
release_publish_zapstore

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
release_upload_play

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
  MAC_MINI_HOST="$MAC_MINI" MAC_MINI_REPO_PATH="$MAC_MINI_REPO_PATH" \
    "$REPO_ROOT/scripts/mac-sync.sh" --rsync-path /opt/homebrew/bin/rsync
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
    #
    # §5f already ran this once, before the version-bump commit, so on the
    # normal path this rewrites the same bytes. It stays because the bootstrap
    # above is the only thing that can seed version/default/ from App Store
    # Connect, and when it does, §5f had nothing to generate from.
    if [ -n "$DEFAULT_DIR" ] && [ -d "$DEFAULT_DIR" ]; then
      _gen_ios_version_metadata \
        || echo "    WARNING: no ${DEFAULT_DIR}/*.json to generate whatsNew from."
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
      # Wait for Apple to process the upload, then attach it. Gives up after
      # ASC_PROCESS_WAIT seconds (default 30 min); the branches below say which.
      _BUILD_INFO=$(_asc_wait_for_build "$APP_VERSION" "${_ios_build_number:-}")
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
      elif ! _asc_attach_build "$ASC_VERSION_ID" "$_BUILD_ID"; then
        PUBLISH_FAILED=true
      else

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
release_post_nostr

# ---------------------------------------------------------------------------
# 13. Close-out summary and deferred-action reminders
#
# Every publish step is best-effort past the tag push: a Zapstore outage sets
# PUBLISH_FAILED rather than aborting, so an already-created GitHub release is
# never stranded. That makes a final ledger worth printing, because a partial
# release otherwise scrolls past unnoticed. See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
release_summary
release_summary_end

release_deferred_reminders

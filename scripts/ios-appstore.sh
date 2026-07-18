#!/usr/bin/env bash
# iOS App Store archive + upload script
# Run this directly on the Mac Mini (not via SSH).
#
# Usage: ./scripts/ios-appstore.sh
#
# Required env vars (or set in scripts/.env) - one of these auth methods:
#
#   Preferred (API key via asc CLI):
#     ASC_KEY_ID           - App Store Connect API key ID
#     ASC_ISSUER_ID        - App Store Connect API issuer ID
#     ASC_APP_ID           - Numeric App Store app ID (from `asc apps list`)
#     ASC_PRIVATE_KEY_PATH - Path to .p8 key (default: ~/.appstoreconnect/AuthKey_<KEY_ID>.p8)
#
#   Legacy (app-specific password via altool):
#     ASC_APPLE_ID         - Apple ID email
#     ASC_APP_PASSWORD     - App-specific password (appleid.apple.com → App-Specific Passwords)
#
# Optional env vars:
#   ASC_TEAM_ID        - Team ID (default: G79ALD29NA)
#   ARCHIVE_PATH       - Path to existing .xcarchive to skip rebuild (default: builds fresh)

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

# ── Determine upload method ─────────────────────────────────────────────────
# Prefer asc CLI (API key auth), fall back to altool (app-specific password)
USE_ASC=false
if command -v asc &>/dev/null \
   && [ -n "${ASC_KEY_ID:-}" ] \
   && [ -n "${ASC_ISSUER_ID:-}" ] \
   && [ -n "${ASC_APP_ID:-}" ]; then
  USE_ASC=true
  echo "Upload method: asc CLI (API key auth)"
elif [ -n "${ASC_APPLE_ID:-}" ] && [ -n "${ASC_APP_PASSWORD:-}" ]; then
  echo "Upload method: altool (app-specific password, legacy)"
else
  echo "Error: No upload credentials configured."
  echo "  Option A (preferred): Install 'asc' and set ASC_KEY_ID, ASC_ISSUER_ID, ASC_APP_ID"
  echo "  Option B (legacy):    Set ASC_APPLE_ID and ASC_APP_PASSWORD"
  exit 1
fi

TEAM_ID="${ASC_TEAM_ID:-G79ALD29NA}"
ARCHIVE_PATH="${ARCHIVE_PATH:-/tmp/${APP_NAME}.xcarchive}"
EXPORT_PATH="/tmp/${APP_NAME}-appstore"
EXPORT_OPTIONS="/tmp/ExportOptions.plist"

# ── Write ExportOptions.plist ───────────────────────────────────────────────
cat > "$EXPORT_OPTIONS" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>teamID</key>
  <string>${TEAM_ID}</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>${BUNDLE_ID}</key>
    <string>${IOS_PROVISIONING_PROFILE}</string>${IOS_WIDGET_BUNDLE_ID:+
    <key>${IOS_WIDGET_BUNDLE_ID}</key>
    <string>${IOS_WIDGET_PROVISIONING_PROFILE}</string>}
  </dict>
  <key>signingCertificate</key>
  <string>Apple Distribution</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>uploadSymbols</key>
  <false/>
</dict>
</plist>
EOF

# ── Unlock signing keychain and grant codesign access ───────────────────────
# unlock-keychain: allows access in this session
# list-keychains -s: makes it visible to all child processes
# set-key-partition-list: grants apple-tool/codesign access to private keys,
#   fixing errSecInternalComponent when the distribution pipeline re-signs
#   embedded frameworks like BareKit.framework over SSH
security unlock-keychain -p "" ~/Library/Keychains/buildkey.keychain
security list-keychains -s \
  ~/Library/Keychains/buildkey.keychain \
  ~/Library/Keychains/login.keychain-db \
  /Library/Keychains/System.keychain
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s -k "" \
  ~/Library/Keychains/buildkey.keychain

# ── Xcode PATH ─────────────────────────────────────────────────────────────
# Xcode's distribution pipeline invokes rsync internally.  If Homebrew's GNU
# rsync (3.4.x) is on PATH it conflicts with Apple's built-in openrsync,
# causing "Copy failed" during IPA packaging.  Strip /opt/homebrew/bin from
# PATH for xcodebuild invocations so the system rsync is found instead.
XCODE_PATH=$(printf '%s' "$PATH" | sed 's|/opt/homebrew/bin:||g; s|:/opt/homebrew/bin||g')

# ── Sync CocoaPods sandbox with current dependencies ────────────────────────
# release.sh rsyncs the repo (including the Linux-generated ios/Podfile.lock)
# to the Mac just before this script runs, but excludes node_modules.  The
# react-native-bare-kit pod embeds a content hash that differs between the
# Linux bundle and the Mac's xcframeworks, so the rsynced Podfile.lock never
# matches the Mac's Pods/Manifest.lock and Xcode's "Check Pods Manifest.lock"
# phase fails the archive.  Reinstall node deps + pods here — AFTER the rsync,
# BEFORE archiving — so both lockfiles agree on a Mac-reproducible hash.  Runs
# with the full PATH (Homebrew node/npm/pod), not the stripped XCODE_PATH.
echo "Syncing CocoaPods sandbox (npm install + pod install)..."
( cd "$REPO_ROOT" && npm install --no-audit --no-fund )
( cd "$REPO_ROOT/ios" && pod install )

# ── Archive ─────────────────────────────────────────────────────────────────
rm -rf "$ARCHIVE_PATH"
echo "Archiving..."
PATH="$XCODE_PATH" xcodebuild \
  -workspace "$REPO_ROOT/${XCODE_WORKSPACE}" \
  -scheme "$XCODE_SCHEME" \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  OTHER_CODE_SIGN_FLAGS="--keychain ~/Library/Keychains/buildkey.keychain" \
  archive | grep -E "^(error:|warning:|note:|.*ARCHIVE)" || true

# xcodebuild's exit code is masked by the grep pipe above, so verify the
# archive actually exists rather than falling through to a confusing
# "archive not found" during export.
if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "Error: archive failed — $ARCHIVE_PATH was not created (see errors above)."
  exit 1
fi
echo "Archive complete: $ARCHIVE_PATH"

# ── Export ──────────────────────────────────────────────────────────────────
echo "Exporting..."
rm -rf "$EXPORT_PATH"
PATH="$XCODE_PATH" xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  2>&1 | grep -v "^2[0-9][0-9][0-9]-" || true  # suppress timestamp lines

IPA_PATH=$(find "$EXPORT_PATH" -name "*.ipa" | head -1)
if [ -z "$IPA_PATH" ]; then
  echo "Error: export failed — no .ipa found in $EXPORT_PATH"
  exit 1
fi
echo "Export complete: $IPA_PATH"

# ── Upload ──────────────────────────────────────────────────────────────────
echo "Uploading to App Store Connect..."
if $USE_ASC; then
  ASC_KEY_FILE="${ASC_PRIVATE_KEY_PATH:-$HOME/.appstoreconnect/AuthKey_${ASC_KEY_ID}.p8}"
  asc auth login \
    --bypass-keychain \
    --name "${APP_NAME}-CI" \
    --key-id "$ASC_KEY_ID" \
    --issuer-id "$ASC_ISSUER_ID" \
    --private-key "$ASC_KEY_FILE"

  asc builds upload --app "$ASC_APP_ID" --ipa "$IPA_PATH"
else
  xcrun altool \
    --upload-app \
    --type ios \
    --file "$IPA_PATH" \
    --username "$ASC_APPLE_ID" \
    --password "$ASC_APP_PASSWORD" \
    --show-progress
fi

echo ""
echo "Upload complete. Build is processing on App Store Connect."

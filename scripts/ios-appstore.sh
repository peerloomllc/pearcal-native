#!/usr/bin/env bash
# PearCal iOS App Store archive + upload script
# Run this directly on the Mac Mini (not via SSH).
#
# Usage: ./scripts/ios-appstore.sh
#
# Required env vars (or set in scripts/.env):
#   ASC_APPLE_ID       - Apple ID email used for App Store Connect
#   ASC_APP_PASSWORD   - App-specific password (appleid.apple.com → App-Specific Passwords)
#
# Optional env vars:
#   ASC_TEAM_ID        - Team ID (default: G79ALD29NA)
#   ARCHIVE_PATH       - Path to existing .xcarchive to skip rebuild (default: builds fresh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load scripts/.env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

# ── Validate credentials ────────────────────────────────────────────────────
if [ -z "${ASC_APPLE_ID:-}" ] || [ -z "${ASC_APP_PASSWORD:-}" ]; then
  echo "Error: ASC_APPLE_ID and ASC_APP_PASSWORD must be set."
  echo "  Generate an app-specific password at: https://appleid.apple.com → Security → App-Specific Passwords"
  exit 1
fi

TEAM_ID="${ASC_TEAM_ID:-G79ALD29NA}"
ARCHIVE_PATH="${ARCHIVE_PATH:-/tmp/PearCal.xcarchive}"
EXPORT_PATH="/tmp/PearCal-appstore"
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
    <key>com.pearcal</key>
    <string>PearCal App Store</string>
  </dict>
  <key>signingCertificate</key>
  <string>Apple Distribution</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
EOF

# ── Archive (skip if ARCHIVE_PATH already exists) ──────────────────────────
if [ -d "$ARCHIVE_PATH" ]; then
  echo "Using existing archive: $ARCHIVE_PATH"
else
  echo "Archiving..."
  security unlock-keychain -p "" ~/Library/Keychains/buildkey.keychain 2>/dev/null || true
  xcodebuild \
    -workspace "$REPO_ROOT/ios/PearCal.xcworkspace" \
    -scheme PearCal \
    -configuration Release \
    -destination "generic/platform=iOS" \
    -archivePath "$ARCHIVE_PATH" \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    OTHER_CODE_SIGN_FLAGS="--keychain ~/Library/Keychains/buildkey.keychain" \
    archive | grep -E "^(error:|warning:|note:|.*ARCHIVE)" || true
  echo "Archive complete: $ARCHIVE_PATH"
fi

# ── Export ──────────────────────────────────────────────────────────────────
echo "Exporting..."
rm -rf "$EXPORT_PATH"
xcodebuild \
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
xcrun altool \
  --upload-app \
  --type ios \
  --file "$IPA_PATH" \
  --username "$ASC_APPLE_ID" \
  --password "$ASC_APP_PASSWORD" \
  --show-progress

echo ""
echo "Done. Build will appear in App Store Connect under TestFlight / Builds within a few minutes."

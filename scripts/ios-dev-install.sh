#!/usr/bin/env bash
# Build PearCal on the Mac Mini and install it on the USB-connected iPhone.
#
# Usage: ./scripts/ios-dev-install.sh [--version X.Y.Z] [--pods] [--no-install]
#
#   --version X.Y.Z  marketing version for this build. Give a distinct one when
#                    asking Tim to retest: a build reporting the same version as
#                    the unfixed one has wasted on-device test rounds before.
#   --pods           run npm install + pod install on the Mac first. REQUIRED
#                    after any package.json change, or the Linux-packed bare
#                    bundle demands addon versions the Mac's xcframeworks do not
#                    have and the app dies at launch with ADDON_NOT_FOUND.
#   --no-install     build and fetch the .ipa, skip the device install.
#
# Env: MAC_MINI_HOST, MAC_MINI_REPO_PATH, IOS_TEAM_ID.
#
# Rebuilds the bundles first, because the Mac gets source only and an iOS build
# reads assets/, not src/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

MAC_HOST="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
MAC_REPO="${MAC_MINI_REPO_PATH:-peerloomllc/pearcal-native}"
TEAM_ID="${IOS_TEAM_ID:-G79ALD29NA}"

VERSION=""
RUN_PODS=false
DO_INSTALL=true
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --pods) RUN_PODS=true; shift ;;
    --no-install) DO_INSTALL=false; shift ;;
    *) echo "ios-dev-install: unknown argument: $1" >&2; exit 2 ;;
  esac
done

echo "==> Bundling bare + UI"
node_modules/.bin/bare-pack --linked --defer fs --defer path src/bare.js -o assets/bare-universal.bundle
node_modules/.bin/bare-pack --host ios-arm64 --linked --defer fs --defer path src/bare.js -o assets/bare-ios.bundle
# The simulator slice differs only in which native addons get linked in, which
# happens on the Mac at pod-install time, so the bundle itself is the same bytes.
cp assets/bare-ios.bundle assets/bare-ios-sim.bundle
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle 2>&1 | tail -2

echo "==> Syncing to $MAC_HOST"
"$SCRIPT_DIR/mac-sync.sh"

# Order matters: pods AFTER the sync. Running them before lets rsync clobber the
# Mac's freshly-resolved Podfile.lock, and "Check Pods Manifest.lock" then fails
# the build with exit 65.
PODS_STEP=""
if [ "$RUN_PODS" = true ]; then
  echo "==> Reinstalling node deps + pods on $MAC_HOST"
  PODS_STEP='npm install --no-audit --no-fund && cd ios && pod install && cd .. &&'
elif ! ssh "$MAC_HOST" "cd ~/$MAC_REPO && cmp -s ios/Podfile.lock ios/Pods/Manifest.lock" 2>/dev/null; then
  # Self-heal rather than dying in "[CP] Check Pods Manifest.lock" with exit 65,
  # which says nothing about what is actually wrong. The Mac's lock and its
  # installed Pods drift whenever the Podfile changes, and historically also
  # whenever anything pushed a Podfile.lock over the Mac's own.
  echo "==> Mac's Pods are out of date with its Podfile.lock; running pod install"
  PODS_STEP='cd ios && pod install && cd .. &&'
fi

VERSION_ARG=""
if [ -n "$VERSION" ]; then
  VERSION_ARG="MARKETING_VERSION=$VERSION"
  echo "==> Marketing version: $VERSION"
fi

echo "==> Building on $MAC_HOST"
# set -o pipefail is load-bearing: without it the chained tail swallows
# xcodebuild's non-zero exit and the next step happily repackages a STALE
# PearCal.app out of DerivedData, silently shipping an old build.
ssh "$MAC_HOST" "set -o pipefail && export PATH=/opt/homebrew/bin:\$PATH && export LANG=en_US.UTF-8 && \
  security unlock-keychain -p '' ~/Library/Keychains/buildkey.keychain && \
  cd ~/$MAC_REPO && $PODS_STEP \
  xcodebuild -workspace ios/PearCal.xcworkspace -scheme PearCal -configuration Release \
    -destination 'generic/platform=iOS' DEVELOPMENT_TEAM=$TEAM_ID $VERSION_ARG \
    OTHER_CODE_SIGN_FLAGS='--keychain ~/Library/Keychains/buildkey.keychain' 2>&1 | tail -20 && \
  rm -rf /tmp/Payload && mkdir -p /tmp/Payload && \
  cp -r \"\$(ls -d ~/Library/Developer/Xcode/DerivedData/PearCal-*/Build/Products/Release-iphoneos/PearCal.app | head -1)\" /tmp/Payload/ && \
  cd /tmp && ditto -c -k --sequesterRsrc --keepParent Payload PearCal-release.ipa && rm -rf Payload && echo 'IPA ready'"

echo "==> Fetching .ipa"
rsync -az "$MAC_HOST:/tmp/PearCal-release.ipa" /tmp/

if [ "$DO_INSTALL" = false ]; then
  echo "==> Built: /tmp/PearCal-release.ipa (install skipped)"
  exit 0
fi

echo "==> Installing on the USB iPhone"
ideviceinstaller install /tmp/PearCal-release.ipa

echo "==> Installed:"
ideviceinstaller list 2>/dev/null | grep -i pearcal || true

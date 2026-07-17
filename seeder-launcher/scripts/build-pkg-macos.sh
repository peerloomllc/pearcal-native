#!/usr/bin/env bash
# Build a macOS .pkg for the PearCal blind-seeder launcher (phase C1). Runs ON a
# Mac (needs pkgbuild/productbuild/sips/iconutil/codesign). Cross-arch capable:
# an arm64 Mac can build both the arm64 and the x64 .pkg (every native addon
# ships both darwin prebuilds + bare-runtime is npm-packable). Drive it for both
# arches from Linux via scripts/build-macos-remote.sh.
#
# Env:
#   VERSION           release version stamped into the seeder (default 0.1.0)
#   SEEDER_PKG_ARCH   arm64 | x64   (default: this Mac's arch)
#   APP_SIGN_ID       "Developer ID Application: … (G79ALD29NA)"  (optional; unsigned if unset)
#   PKG_SIGN_ID       "Developer ID Installer: … (G79ALD29NA)"    (optional; unsigned if unset)
#   NODE_VERSION      bundled Node.js (default 22.20.0)
#
# Unsigned (default) install:  sudo installer -allowUntrusted -pkg <pkg> -target /
set -euo pipefail

cd "$(dirname "$0")/.."
LAUNCHER=$(pwd)
REPO=$(cd "$LAUNCHER/.." && pwd)

VERSION="${VERSION:-0.1.0}"; VERSION="${VERSION#v}"
APP_SIGN_ID="${APP_SIGN_ID:-}"
PKG_SIGN_ID="${PKG_SIGN_ID:-}"
NODE_VERSION="${NODE_VERSION:-22.20.0}"
KEYCHAIN_PATH="${KEYCHAIN_PATH:-$HOME/Library/Keychains/buildkey.keychain}"

ARCH="${SEEDER_PKG_ARCH:-}"
if [ -z "$ARCH" ]; then case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "unsupported arch $(uname -m); set SEEDER_PKG_ARCH" >&2; exit 1 ;; esac; fi
case "$ARCH" in arm64|x64) ;; *) echo "SEEDER_PKG_ARCH must be arm64|x64" >&2; exit 1 ;; esac
BARE_HOST="darwin-$ARCH"

INSTALL_PREFIX="usr/local/lib/pearcal-seeder"
DIST="$LAUNCHER/dist/macos-$ARCH"
PAYLOAD="$DIST/payload"
PAYLOAD_LIB="$PAYLOAD/$INSTALL_PREFIX"
SCRIPTS_DIR="$DIST/scripts"

echo "==> build-pkg-macos  arch=$ARCH  version=$VERSION"
rm -rf "$DIST"
mkdir -p "$PAYLOAD_LIB/installer" "$SCRIPTS_DIR"

# 1. Stage the worklet + host payload (bare, worklet/seed.bundle, darwin
#    prebuilds, host/*, qrcode, brand.png, fonts.css, updateCheck.js) straight
#    into the install prefix. Reuses the proven cross-stage engine.
BARE_HOST="$BARE_HOST" OUT_DIR="$PAYLOAD_LIB" bash "$LAUNCHER/scripts/stage-macos.sh"
rm -f "$PAYLOAD_LIB/run.sh"  # the .pkg uses the bundled-node wrapper below, not the PATH-node run.sh
mkdir -p "$PAYLOAD_LIB/installer"  # stage-macos.sh rm -rf'd OUT_DIR, so recreate after it

# 2. Bundled Node.js (a distributed .pkg can't assume the user has node).
#    Official static build from nodejs.org, cached across builds.
NODE_PKG="node-v${NODE_VERSION}-darwin-${ARCH}"
NODE_CACHE="$LAUNCHER/dist/cache/$NODE_PKG"
if [ ! -x "$NODE_CACHE/bin/node" ]; then
  mkdir -p "$LAUNCHER/dist/cache"
  URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PKG}.tar.xz"
  echo "--> downloading $URL"
  curl -fsSL "$URL" -o "$LAUNCHER/dist/cache/${NODE_PKG}.tar.xz"
  tar -xJf "$LAUNCHER/dist/cache/${NODE_PKG}.tar.xz" -C "$LAUNCHER/dist/cache"
  rm -f "$LAUNCHER/dist/cache/${NODE_PKG}.tar.xz"
fi
cp "$NODE_CACHE/bin/node" "$PAYLOAD_LIB/node"; chmod +x "$PAYLOAD_LIB/node"

# 3. Launch wrapper: the LaunchAgent runs this; it uses the BUNDLED node.
cat > "$PAYLOAD_LIB/pearcal-seeder" <<'WRAP'
#!/bin/bash
DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DATA="${PEARCAL_SEED_DATA:-$HOME/.pearcal-seed}"
exec "$DIR/node" "$DIR/host/index.js" --bare "$DIR/bare" --bundle "$DIR/worklet/seed.bundle" --data "$DATA" "$@"
WRAP
chmod +x "$PAYLOAD_LIB/pearcal-seeder"

# 4. LaunchAgent template with the build version baked in (__LOG_PATH__ stays for
#    postinstall to fill per-user).
sed "s|__VERSION__|$VERSION|g" "$LAUNCHER/installer/macos/com.pearcal.seeder.plist" > "$PAYLOAD_LIB/installer/com.pearcal.seeder.plist"

# 5. Uninstaller: the teardown script + a clickable Uninstall app.
cp "$LAUNCHER/installer/macos/uninstall.sh" "$PAYLOAD_LIB/uninstall.sh"; chmod +x "$PAYLOAD_LIB/uninstall.sh"
UNINSTALL_APP="$PAYLOAD_LIB/Uninstall PearCal Seeder.app"
mkdir -p "$UNINSTALL_APP/Contents/MacOS" "$UNINSTALL_APP/Contents/Resources"
cat > "$UNINSTALL_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>uninstall</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.pearcal.seeder.uninstall</string>
  <key>CFBundleName</key><string>Uninstall PearCal Seeder</string>
  <key>CFBundleDisplayName</key><string>Uninstall PearCal Seeder</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
</dict>
</plist>
PLIST
cat > "$UNINSTALL_APP/Contents/MacOS/uninstall" <<'LAUNCH'
#!/bin/bash
SCRIPT="/usr/local/lib/pearcal-seeder/uninstall.sh"
if [ ! -f "$SCRIPT" ]; then
  /usr/bin/osascript -e 'display dialog "PearCal Seeder does not appear to be installed." with title "Uninstall PearCal Seeder" buttons {"OK"} default button "OK" with icon caution'
  exit 0
fi
CONFIRM=$(/usr/bin/osascript \
  -e 'try' \
  -e '  display dialog "Uninstall PearCal Seeder?\n\nThis stops and removes the background seeder and all its program files." buttons {"Cancel", "Uninstall"} default button "Uninstall" cancel button "Cancel" with title "Uninstall PearCal Seeder" with icon caution' \
  -e '  return "go"' -e 'on error' -e '  return "cancel"' -e 'end try' 2>/dev/null)
[ "$CONFIRM" = "go" ] || exit 0
IDENTITY=$(/usr/bin/osascript \
  -e 'try' \
  -e '  display dialog "Also remove the seeder identity and all group enrollments?\n\nKeep them to reinstall later as the same seeder." buttons {"Keep", "Remove"} default button "Keep" with title "Uninstall PearCal Seeder" with icon note' \
  -e '  return button returned of result' -e 'on error' -e '  return "Keep"' -e 'end try' 2>/dev/null)
FLAG="--keep"; [ "$IDENTITY" = "Remove" ] && FLAG="--purge"
OUT=$(/usr/bin/osascript -e "do shell script \"/bin/bash '$SCRIPT' $FLAG 2>&1\" with administrator privileges" 2>&1)
if [ "$?" = "0" ]; then
  /usr/bin/osascript -e 'display dialog "PearCal Seeder has been uninstalled." with title "Uninstall PearCal Seeder" buttons {"OK"} default button "OK" with icon note' >/dev/null 2>&1
else
  /usr/bin/osascript -e "display dialog \"Uninstall did not complete:\n\n$OUT\" with title \"Uninstall PearCal Seeder\" buttons {\"OK\"} default button \"OK\" with icon stop" >/dev/null 2>&1
fi
exit 0
LAUNCH
chmod +x "$UNINSTALL_APP/Contents/MacOS/uninstall"

# 6. App icon (.icns) from the repo's icon.png.
ICON_SRC="$REPO/assets/images/icon.png"
if [ -f "$ICON_SRC" ]; then
  ICONSET="$DIST/AppIcon.iconset"; rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  sips -z 16 16   "$ICON_SRC" --out "$ICONSET/icon_16x16.png"      >/dev/null
  sips -z 32 32   "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
  sips -z 32 32   "$ICON_SRC" --out "$ICONSET/icon_32x32.png"      >/dev/null
  sips -z 64 64   "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
  sips -z 128 128 "$ICON_SRC" --out "$ICONSET/icon_128x128.png"    >/dev/null
  sips -z 256 256 "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
  sips -z 256 256 "$ICON_SRC" --out "$ICONSET/icon_256x256.png"    >/dev/null
  sips -z 512 512 "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
  sips -z 512 512 "$ICON_SRC" --out "$ICONSET/icon_512x512.png"    >/dev/null
  cp "$ICON_SRC"               "$ICONSET/icon_512x512@2x.png"
  iconutil -c icns "$ICONSET" -o "$PAYLOAD_LIB/AppIcon.icns"
  rm -rf "$ICONSET"
  cp "$PAYLOAD_LIB/AppIcon.icns" "$UNINSTALL_APP/Contents/Resources/AppIcon.icns" 2>/dev/null || true
else
  echo "warning: $ICON_SRC missing; apps will use a generic icon"
fi

# 7. Sign the Mach-O binaries (ad-hoc when no Developer ID). Notary rejects a
#    signed .pkg with any unsigned nested Mach-O, so sign addons inside-out.
if [ -n "$APP_SIGN_ID" ]; then
  if [ -e "$KEYCHAIN_PATH" ] || [ -e "${KEYCHAIN_PATH}-db" ]; then
    security unlock-keychain -p "" "$KEYCHAIN_PATH" 2>/dev/null || true
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  fi
  ENT="$LAUNCHER/installer/macos/entitlements.plist"
  while IFS= read -r f; do
    if file "$f" | grep -q 'Mach-O'; then
      codesign --force --options runtime --timestamp --sign "$APP_SIGN_ID" "$f" || { echo "sign failed: $f" >&2; exit 1; }
    fi
  done < <(find "$PAYLOAD_LIB" -type f \( -name '*.node' -o -name '*.bare' -o -name '*.dylib' -o -name '*.so' \))
  codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$APP_SIGN_ID" "$PAYLOAD_LIB/node"
  codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$APP_SIGN_ID" "$PAYLOAD_LIB/bare"
else
  codesign --force --sign - "$PAYLOAD_LIB/node"
  codesign --force --sign - "$PAYLOAD_LIB/bare"
fi

# 8. postinstall for pkgbuild.
cp "$LAUNCHER/scripts/postinstall-macos.sh" "$SCRIPTS_DIR/postinstall"; chmod +x "$SCRIPTS_DIR/postinstall"

# 9. Component pkg. Force non-relocatable + always-overwrite so an install always
#    lays down exactly the shipped payload (a relocatable/version-checked bundle
#    half-updates on upgrade — matters once the C2 auto-updater exists).
COMPONENT="$DIST/PearCalSeeder-component.pkg"
COMPONENT_PLIST="$DIST/component.plist"
pkgbuild --analyze --root "$PAYLOAD" "$COMPONENT_PLIST"
python3 - "$COMPONENT_PLIST" <<'PY'
import sys, plistlib
p = sys.argv[1]
with open(p, 'rb') as f: comps = plistlib.load(f)
for c in comps:
    c['BundleIsRelocatable'] = False
    c['BundleIsVersionChecked'] = False
    c['BundleOverwriteAction'] = 'upgrade'
with open(p, 'wb') as f: plistlib.dump(comps, f)
PY
pkgbuild --root "$PAYLOAD" --component-plist "$COMPONENT_PLIST" \
  --identifier com.pearcal.seeder --version "$VERSION" --scripts "$SCRIPTS_DIR" \
  --install-location / "$COMPONENT"

# 10. Distribution pkg (unsigned unless PKG_SIGN_ID set).
OUT="$DIST/PearCalSeeder-$VERSION-$ARCH.pkg"
if [ -n "$PKG_SIGN_ID" ]; then
  productbuild --distribution "$LAUNCHER/installer/macos/Distribution.xml" \
    --resources "$LAUNCHER/installer/macos/Resources" --package-path "$DIST" \
    --sign "$PKG_SIGN_ID" --timestamp "$OUT"
else
  productbuild --distribution "$LAUNCHER/installer/macos/Distribution.xml" \
    --resources "$LAUNCHER/installer/macos/Resources" --package-path "$DIST" "$OUT"
  echo "warning: unsigned .pkg. Install with: sudo installer -allowUntrusted -pkg $OUT -target /"
fi

echo "built: $OUT"

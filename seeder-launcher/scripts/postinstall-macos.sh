#!/bin/bash
# Runs as root under the macOS installer's postinstall context (phase C1).
# Resolves the console user (whose login session runs the LaunchAgent), templates
# the plist into their LaunchAgents dir, loads it in their session, installs the
# dashboard + uninstaller apps to /Applications, and on a fresh install opens the
# dashboard in their browser. (Phase C2 adds the privileged updater daemon.)
set -euo pipefail

# Resolve the console user, not $USER (which is root during install).
USER_NAME=$(stat -f %Su /dev/console)
USER_UID=$(id -u "$USER_NAME")
USER_HOME=$(dscl . -read "/Users/$USER_NAME" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
if [ -z "$USER_HOME" ]; then USER_HOME="/Users/$USER_NAME"; fi

DATA_DIR="$USER_HOME/.pearcal-seed"
LOG_PATH="$USER_HOME/Library/Logs/pearcal-seeder.log"
PLIST_SRC="/usr/local/lib/pearcal-seeder/installer/com.pearcal.seeder.plist"
PLIST_DST="$USER_HOME/Library/LaunchAgents/com.pearcal.seeder.plist"
PORT=8731

# Update vs fresh: if the LaunchAgent already exists this is a re-install / auto-
# update, so skip the first-run browser open (an update must not pop windows).
IS_UPDATE=0
[ -f "$PLIST_DST" ] && IS_UPDATE=1

mkdir -p "$DATA_DIR" "$USER_HOME/Library/LaunchAgents" "$USER_HOME/Library/Logs"
chown "$USER_NAME" "$DATA_DIR" "$USER_HOME/Library/LaunchAgents" "$USER_HOME/Library/Logs"

# Template the per-user log path into the plist (__VERSION__ was filled at build).
sed "s|__LOG_PATH__|$LOG_PATH|g" "$PLIST_SRC" > "$PLIST_DST"
chown "$USER_NAME" "$PLIST_DST"
chmod 0644 "$PLIST_DST"

# (Re)load in the user's GUI session so the seeder runs there, not as root.
launchctl asuser "$USER_UID" launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl asuser "$USER_UID" launchctl load "$PLIST_DST"

# --- Uninstaller app (fresh + update, so it stays current) -------------------
UNINSTALL_SRC="/usr/local/lib/pearcal-seeder/Uninstall PearCal Seeder.app"
UNINSTALL_DST="/Applications/Uninstall PearCal Seeder.app"
if [ -d "$UNINSTALL_SRC" ]; then
  ( set +e
    rm -rf "$UNINSTALL_DST"
    /usr/bin/ditto "$UNINSTALL_SRC" "$UNINSTALL_DST" 2>/dev/null || cp -R "$UNINSTALL_SRC" "$UNINSTALL_DST"
    /usr/bin/xattr -dr com.apple.quarantine "$UNINSTALL_DST" 2>/dev/null
    /usr/bin/touch "$UNINSTALL_DST"
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$UNINSTALL_DST" 2>/dev/null
    /usr/bin/mdimport "$UNINSTALL_DST" 2>/dev/null
  )
fi

# --- Dashboard shortcut app (fresh + update) ---------------------------------
APP="/Applications/PearCal Seeder.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>open-ui</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.pearcal.seeder.shortcut</string>
  <key>CFBundleName</key><string>PearCal Seeder</string>
  <key>CFBundleDisplayName</key><string>PearCal Seeder</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
</dict>
</plist>
PLIST
cat > "$APP/Contents/MacOS/open-ui" <<'LAUNCH'
#!/bin/bash
# Read the current auth token and open the dashboard in the default browser.
TOKEN=$(cat "$HOME/.pearcal-seed/auth.token" 2>/dev/null | tr -d '\n')
if [ -z "$TOKEN" ]; then
  /usr/bin/osascript -e 'display dialog "PearCal Seeder is not running yet. Check ~/Library/Logs/pearcal-seeder.log." with title "PearCal Seeder" buttons {"OK"} default button "OK" with icon caution'
  exit 1
fi
exec /usr/bin/open "http://127.0.0.1:8731/?t=$TOKEN"
LAUNCH
chmod +x "$APP/Contents/MacOS/open-ui"
if [ -f /usr/local/lib/pearcal-seeder/AppIcon.icns ]; then
  cp /usr/local/lib/pearcal-seeder/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
fi
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
/usr/bin/touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
/usr/bin/mdimport "$APP" 2>/dev/null || true

# On a re-install / update the operator isn't watching — skip the browser open.
if [ "$IS_UPDATE" = "1" ]; then
  echo "PearCal Seeder updated; LaunchAgent reloaded (silent)."
  exit 0
fi

# First-run convenience (best-effort; must never fail the install).
set +e
TOKEN=""
for i in $(seq 1 30); do
  TOKEN=$(cat "$DATA_DIR/auth.token" 2>/dev/null | tr -d '\n')
  [ -n "$TOKEN" ] && break
  sleep 0.5
done
if [ -n "$TOKEN" ]; then
  URL="http://127.0.0.1:$PORT/?t=$TOKEN"
  echo "PearCal Seeder running. Open: $URL"
  launchctl asuser "$USER_UID" sudo -u "$USER_NAME" open "$URL" 2>/dev/null || true
else
  echo "warning: PearCal Seeder did not write an auth token within 15s; check $LOG_PATH"
fi
exit 0

#!/bin/bash
# Runs as root under the macOS installer's postinstall context (phase C1).
# Resolves the console user (whose account the seeder runs under and whose home
# holds the seed store), templates the plist into /Library/LaunchDaemons and
# bootstraps it into the SYSTEM domain so it outlives the login session, retires
# the login-bound LaunchAgent this used to be, installs the
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
PLIST_DST="/Library/LaunchDaemons/com.pearcal.seeder.plist"
# Where this used to live. Every install before 2026-08-17 has one, and it must be
# torn down or we end up running two seeders against one store.
LEGACY_AGENT="$USER_HOME/Library/LaunchAgents/com.pearcal.seeder.plist"
PORT=8731

# Update vs fresh: if either the daemon or the legacy agent already exists this is
# a re-install / auto-update, so skip the first-run browser open (an update must
# not pop windows).
IS_UPDATE=0
{ [ -f "$PLIST_DST" ] || [ -f "$LEGACY_AGENT" ]; } && IS_UPDATE=1

mkdir -p "$DATA_DIR" "$USER_HOME/Library/Logs"
chown "$USER_NAME" "$DATA_DIR" "$USER_HOME/Library/Logs"

# --- Retire the login-bound LaunchAgent --------------------------------------
# This job used to be an agent in ~/Library/LaunchAgents, whose own comment
# claimed it "survives logout via KeepAlive". It does not: agents there load into
# gui/501, a `type = login` domain that loginwindow tears down at logout, and
# KeepAlive does not exempt a job from its domain's teardown. Measured on the
# mac-mini 2026-07-31 across one real logout/login - the job was killed and a
# DIFFERENT pid appeared only at the next login. Boot it out before bootstrapping
# the daemon, or both run at once against the same seed store.
if [ -f "$LEGACY_AGENT" ]; then
  launchctl asuser "$USER_UID" launchctl unload "$LEGACY_AGENT" 2>/dev/null || true
  launchctl bootout "gui/$USER_UID/com.pearcal.seeder" 2>/dev/null || true
  rm -f "$LEGACY_AGENT"
fi

# Clear a stale disabled override on the label in the USER domain. Booting a job
# out can leave `"com.pearcal.seeder" => disabled` in
# /var/db/com.apple.xpc.launchd/disabled.$USER_UID.plist. That override keys on
# the LABEL and survives an uninstall, so it silently tombstones any later
# agent-based install of the same label: `launchctl load` exits 0 and does
# nothing, `bootstrap` fails with "5: Input/output error", and the seeder simply
# never starts. Diagnosed on PearCircle (pearcircle#197) on the mac-mini
# 2026-08-18; PearCal shares the install shape, so it gets the same guard.
launchctl asuser "$USER_UID" launchctl enable "gui/$USER_UID/com.pearcal.seeder" 2>/dev/null || true

# Template the log path, the credentials to run under and the seed store location
# (see the template's own note on why the store is set explicitly). __VERSION__
# was filled at build.
sed -e "s|__LOG_PATH__|$LOG_PATH|g" \
    -e "s|__USER__|$USER_NAME|g" \
    -e "s|__GROUP__|staff|g" \
    -e "s|__USER_HOME__|$USER_HOME|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    "$PLIST_SRC" > "$PLIST_DST"
chown root:wheel "$PLIST_DST"
chmod 0644 "$PLIST_DST"

# (Re)load as a system daemon so the seeder outlives the login session. UserName
# in the plist keeps it running as the user, so the store's ownership is
# untouched.
launchctl bootout "system/com.pearcal.seeder" 2>/dev/null || true
# Same disabled-override trap as the agent above, one domain up: clear it before
# bootstrapping or the daemon refuses to start and says nothing.
launchctl enable "system/com.pearcal.seeder" 2>/dev/null || true
launchctl bootstrap system "$PLIST_DST" 2>/dev/null \
  || launchctl load "$PLIST_DST" 2>/dev/null || true

# --- Privileged updater LaunchDaemon (phase C2) ------------------------------
# The root auto-updater that applies one-click updates without a sudo prompt. The
# unprivileged seeder drops a verified-pkg request into REQ_DIR (0733: it can
# write+traverse but not list); the daemon's WatchPaths fires the helper, which
# re-verifies (sha256 + team + notarization) and installs. We do NOT bootout an
# already-loaded updater: during an auto-update THIS postinstall runs *inside*
# the helper, and booting it out would kill the in-flight install.
UPDATES_DIR="/Library/Application Support/PearCal Seeder/updates"
REQ_DIR="$UPDATES_DIR/requests"
mkdir -p "$REQ_DIR"
chown root:wheel "$UPDATES_DIR" "$REQ_DIR"
chmod 0755 "$UPDATES_DIR"
chmod 0733 "$REQ_DIR"
DAEMON_SRC="/usr/local/lib/pearcal-seeder/installer/com.pearcal.seeder.updater.plist"
DAEMON_DST="/Library/LaunchDaemons/com.pearcal.seeder.updater.plist"
if [ -f "$DAEMON_SRC" ]; then
  cp "$DAEMON_SRC" "$DAEMON_DST"; chown root:wheel "$DAEMON_DST"; chmod 0644 "$DAEMON_DST"
  # The helper runs as root, so it must be root-owned + not group/world-writable.
  chown root:wheel /usr/local/lib/pearcal-seeder/updater-helper.sh 2>/dev/null || true
  chmod 0755 /usr/local/lib/pearcal-seeder/updater-helper.sh 2>/dev/null || true
  launchctl enable "system/com.pearcal.seeder.updater" 2>/dev/null || true
  launchctl bootstrap system "$DAEMON_DST" 2>/dev/null || launchctl load "$DAEMON_DST" 2>/dev/null || true
fi

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
  echo "PearCal Seeder updated; LaunchDaemon reloaded (silent)."
  exit 0
fi

# First-run convenience (best-effort; must never fail the install).
set +e
# auth.token persists across restarts AND survives an uninstall (the seed store
# is kept by default), so its mere presence proves nothing about THIS install -
# a seeder that failed to start would still hand us a token and we would open a
# dead URL. Wait for the dashboard to actually answer instead.
TOKEN=""
LIVE=0
for i in $(seq 1 30); do
  TOKEN=$(cat "$DATA_DIR/auth.token" 2>/dev/null | tr -d '\n')
  if [ -n "$TOKEN" ] && curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/?t=$TOKEN" 2>/dev/null; then
    LIVE=1
    break
  fi
  sleep 0.5
done
if [ "$LIVE" = "1" ]; then
  URL="http://127.0.0.1:$PORT/?t=$TOKEN"
  echo "PearCal Seeder running. Open: $URL"
  launchctl asuser "$USER_UID" sudo -u "$USER_NAME" open "$URL" 2>/dev/null || true
else
  # Say something. A silent "successful" install that leaves nothing running is
  # how the equivalent PearCircle failure went unnoticed. First-run only (the
  # update path exited above), so this cannot interrupt an auto-update.
  echo "warning: PearCal Seeder did not answer on 127.0.0.1:$PORT within 15s; check $LOG_PATH"
  launchctl asuser "$USER_UID" sudo -u "$USER_NAME" /usr/bin/osascript -e 'display dialog "PearCal Seeder is installed but did not start within 15 seconds.\n\nOpen \"PearCal Seeder\" from your Applications folder to try again, or check ~/Library/Logs/pearcal-seeder.log" with title "PearCal Seeder" buttons {"OK"} default button "OK" with icon caution' 2>/dev/null &
fi
exit 0

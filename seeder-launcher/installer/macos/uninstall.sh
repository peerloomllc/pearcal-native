#!/bin/bash
# PearCal Seeder — macOS uninstaller (phase C1).
#
# Tears down everything the .pkg install lays down:
#   seeder daemon      /Library/LaunchDaemons/com.pearcal.seeder.plist
#                      (plus the legacy ~/Library/LaunchAgents agent, pre-2026-08-17)
#   payload            /usr/local/lib/pearcal-seeder
#   dashboard app      /Applications/PearCal Seeder.app
#   uninstall app      /Applications/Uninstall PearCal Seeder.app
#   log                ~/Library/Logs/pearcal-seeder.log
#
# The seeder identity + group enrollments live under ~/.pearcal-seed and are
# KEPT by default so a reinstall stays the same seeder. Pass --purge to wipe
# them, --keep to force-keep; with neither, an interactive terminal is prompted.
# (Phase C2 will also remove a root updater LaunchDaemon + its updates dir.)
#
# Must run as root (it removes /usr/local/lib). The Uninstall.app wrapper handles
# the privilege prompt; from a terminal: sudo bash /usr/local/lib/pearcal-seeder/uninstall.sh
set -uo pipefail

PAYLOAD="/usr/local/lib/pearcal-seeder"

# Re-exec from /tmp if running from inside the payload we're about to delete —
# bash re-reads the script file as it runs, so removing it mid-flight breaks
# later lines.
SELF="$0"
case "$SELF" in
  "$PAYLOAD"/*)
    TMP=$(mktemp /tmp/pcalseeder-uninstall.XXXXXX) || exit 1
    cp "$SELF" "$TMP" && chmod +x "$TMP"
    exec /bin/bash "$TMP" "$@"
    ;;
esac

PURGE=""   # "", "1" (wipe identity), or "0" (keep)
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --keep)  PURGE=0 ;;
  esac
done

if [ "$(id -u)" != "0" ]; then
  echo "error: must run as root. Try: sudo bash $PAYLOAD/uninstall.sh" >&2
  exit 1
fi

# Resolve the console user whose LaunchAgent + data dir we touch ($USER is root
# in an admin context).
USER_NAME=$(stat -f %Su /dev/console 2>/dev/null)
if [ -z "$USER_NAME" ] || [ "$USER_NAME" = "root" ]; then
  USER_NAME="${SUDO_USER:-$USER_NAME}"
fi
USER_UID=$(id -u "$USER_NAME" 2>/dev/null || echo "")
USER_HOME=$(dscl . -read "/Users/$USER_NAME" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
[ -z "$USER_HOME" ] && USER_HOME="/Users/$USER_NAME"

IDENTITY_DIR="$USER_HOME/.pearcal-seed"

echo "Uninstalling PearCal Seeder (user: $USER_NAME)..."

# 1. The seeder itself: a system LaunchDaemon since 2026-08-17. Bootout of the
# system domain, then remove. The old login-bound LaunchAgent is cleaned up too -
# an install that predates the daemon still has one, and a machine that has been
# through both has both.
SEEDER_DAEMON="/Library/LaunchDaemons/com.pearcal.seeder.plist"
launchctl bootout system/com.pearcal.seeder 2>/dev/null \
  || launchctl unload "$SEEDER_DAEMON" 2>/dev/null || true
rm -f "$SEEDER_DAEMON"

LEGACY_AGENT="$USER_HOME/Library/LaunchAgents/com.pearcal.seeder.plist"
if [ -n "$USER_UID" ]; then
  launchctl asuser "$USER_UID" launchctl bootout "gui/$USER_UID/com.pearcal.seeder" 2>/dev/null \
    || launchctl asuser "$USER_UID" launchctl unload "$LEGACY_AGENT" 2>/dev/null || true
fi
rm -f "$LEGACY_AGENT"

# 2. Root updater LaunchDaemon (phase C2): bootout of the system domain, remove.
DAEMON="/Library/LaunchDaemons/com.pearcal.seeder.updater.plist"
launchctl bootout system/com.pearcal.seeder.updater 2>/dev/null \
  || launchctl unload "$DAEMON" 2>/dev/null || true
rm -f "$DAEMON"

# 2b. Root updates scratch dir (verified-pkg requests + updater.log).
rm -rf "/Library/Application Support/PearCal Seeder"

# 3. Dashboard shortcut + the Uninstall app itself (both in /Applications,
#    unrestricted, so root removes them cleanly).
rm -rf "/Applications/PearCal Seeder.app"
rm -rf "/Applications/Uninstall PearCal Seeder.app"

# 3. Log.
rm -f "$USER_HOME/Library/Logs/pearcal-seeder.log"

# 4. Payload (binaries, worklet, host, this script's origin).
rm -rf "$PAYLOAD"

# 5. Identity / enrollments — decide last so the keep/purge choice is explicit.
if [ -z "$PURGE" ]; then
  if [ -t 0 ]; then
    printf 'Also remove the seeder identity and all group enrollments at\n  %s ? [y/N] ' "$IDENTITY_DIR"
    read -r ans
    case "$ans" in y|Y|yes|YES) PURGE=1 ;; *) PURGE=0 ;; esac
  else
    PURGE=0   # non-interactive default: keep identity
  fi
fi

if [ "$PURGE" = "1" ]; then
  rm -rf "$IDENTITY_DIR"
  echo "Removed the seeder identity and enrollments."
else
  echo "Kept the seeder identity at:"
  echo "  $IDENTITY_DIR"
  echo "Delete it by hand for a full wipe, or re-run with --purge."
fi

echo "PearCal Seeder uninstalled."

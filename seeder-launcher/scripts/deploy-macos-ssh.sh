#!/usr/bin/env bash
# Deploy the PearCal blind seeder to a macOS host over SSH as a per-user
# LaunchAgent — the darwin analog of deploy-user-ssh.sh (systemd --user).
#
#   scripts/deploy-macos-ssh.sh user@host [BARE_HOST]
#
# Cross-stages a darwin payload locally (no Mac build needed — see stage-macos.sh),
# rsyncs it to ~/pearcal-seeder on the Mac, installs a per-user LaunchAgent
# (~/Library/LaunchAgents/com.pearcal.seeder.plist) with RunAtLoad + KeepAlive,
# and (re)loads it. Idempotent — re-run to update.
#
# THIS IS A DEV DEPLOY AND IT IS LOGIN-BOUND. An agent in ~/Library/LaunchAgents
# lives in gui/$UID, a `type = login` domain that loginwindow tears down at
# logout, so this seeder STOPS at logout and only comes back at the next login —
# KeepAlive does not change that (measured on the mac-mini 2026-07-31: killed at
# logout, a DIFFERENT pid at the next login). It "survives a reboot" only in the
# sense that it reloads once somebody logs in again. Fine for iterating over SSH;
# NOT how a real always-on seeder should run. The shipped .pkg installs a SYSTEM
# LaunchDaemon instead (/Library/LaunchDaemons/com.pearcal.seeder.plist, running
# as the user), which is what actually survives logout — use that for anything
# long-lived.
#
# The two share the label com.pearcal.seeder and the seed store, so running both
# would put two seeders on one store. This script refuses to do that; see the
# daemon check below.
#
# Env overrides:
#   SEEDER_PORT  dashboard port (default 8731)
#   REMOTE_DIR   payload dir on host   (default pearcal-seeder, under $HOME)
#   DATA_DIR     seed data dir on host (default .pearcal-seed, under $HOME)
set -euo pipefail

TARGET="${1:?usage: deploy-macos-ssh.sh user@host [BARE_HOST]}"
BARE_HOST="${2:-darwin-arm64}"
PORT="${SEEDER_PORT:-8731}"
case "$BARE_HOST" in darwin-arm64|darwin-x64) ;; *) echo "deploy-macos: BARE_HOST must be darwin-arm64|darwin-x64" >&2; exit 1 ;; esac
cd "$(dirname "$0")/.."
LAUNCHER=$(pwd)

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
echo "==> staging payload ($BARE_HOST) -> $STAGE"
BARE_HOST="$BARE_HOST" OUT_DIR="$STAGE" bash "$LAUNCHER/scripts/stage-macos.sh"

# Refuse to stack a dev agent on top of a .pkg-installed system daemon. Same label,
# same seed store: two seeders writing one store is not something to discover later.
# Removing the daemon needs root, which this script deliberately does not take, so
# say what to run and stop.
if ssh "$TARGET" 'test -f /Library/LaunchDaemons/com.pearcal.seeder.plist'; then
  echo "error: $TARGET already runs the packaged seeder as a system LaunchDaemon" >&2
  echo "       (/Library/LaunchDaemons/com.pearcal.seeder.plist), which shares this" >&2
  echo "       script's label and seed store. Running both would put two seeders on" >&2
  echo "       one store." >&2
  echo "       Uninstall the package first:  sudo bash /usr/local/lib/pearcal-seeder/uninstall.sh --keep" >&2
  exit 1
fi

# Unload any running instance first so rsync can replace the bare binary / run.sh
# without hitting ETXTBSY on the live process.
echo "==> unloading existing agent (if any)"
ssh "$TARGET" 'launchctl bootout gui/$(id -u)/com.pearcal.seeder 2>/dev/null; launchctl unload ~/Library/LaunchAgents/com.pearcal.seeder.plist 2>/dev/null; true'

echo "==> rsync payload -> $TARGET:~/${REMOTE_DIR:-pearcal-seeder}"
ssh "$TARGET" "mkdir -p ~/${REMOTE_DIR:-pearcal-seeder}"
rsync -az --delete "$STAGE"/ "$TARGET":"${REMOTE_DIR:-pearcal-seeder}/"

echo "==> installing LaunchAgent + loading"
ssh "$TARGET" "PORT='$PORT' REMOTE_DIR='${REMOTE_DIR:-pearcal-seeder}' DATA_DIR='${DATA_DIR:-.pearcal-seed}' bash -s" <<'REMOTE'
set -euo pipefail
DIR="$HOME/$REMOTE_DIR"
DATA="$HOME/$DATA_DIR"
LOG="$HOME/Library/Logs/pearcal-seeder.log"
UID_NUM="$(id -u)"

# Locate node: SSH non-interactive shells often lack Homebrew on PATH. Try the
# usual spots so the LaunchAgent's PATH can point at the right bin dir.
NODE_BIN="$(command -v node 2>/dev/null || true)"
for cand in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$NODE_BIN" ] && break
  [ -x "$cand" ] && NODE_BIN="$cand"
done
[ -n "$NODE_BIN" ] || { echo "node not found on $HOSTNAME (looked on PATH, /opt/homebrew/bin, /usr/local/bin)" >&2; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"

mkdir -p "$DATA" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
chmod +x "$DIR/run.sh" "$DIR/bare" 2>/dev/null || true

PLIST="$HOME/Library/LaunchAgents/com.pearcal.seeder.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pearcal.seeder</string>
  <key>ProgramArguments</key>
  <array><string>$DIR/run.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:/usr/local/bin:/usr/bin:/bin</string>
    <key>PEARCAL_SEED_DATA</key><string>$DATA</string>
    <key>SEEDER_PORT</key><string>$PORT</string>
  </dict>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL

# Load into the GUI (Aqua) domain. bootstrap is the modern verb; fall back to
# the legacy load -w if bootstrap isn't accepted over this SSH session.
launchctl bootout "gui/$UID_NUM/com.pearcal.seeder" 2>/dev/null || true
if ! launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
  echo "(bootstrap unavailable over SSH — using legacy load)"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
fi
launchctl kickstart -k "gui/$UID_NUM/com.pearcal.seeder" 2>/dev/null || true
sleep 3
echo "--- launchctl print ---"
launchctl print "gui/$UID_NUM/com.pearcal.seeder" 2>/dev/null | grep -iE "state|pid|program|path =" | head -8 || echo "(agent not listed yet)"
REMOTE

echo
echo "==> deployed (LaunchAgent). Dashboard:"
IP=$(ssh "$TARGET" "ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo ''")
TOKEN=$(ssh "$TARGET" "cat ~/${DATA_DIR:-.pearcal-seed}/auth.token 2>/dev/null | tr -d '\n'")
if [ -n "$TOKEN" ]; then
  echo "    http://${IP:-<host-ip>}:$PORT/?t=$TOKEN"
else
  echo "    token not yet written; check: ssh $TARGET 'cat ~/${DATA_DIR:-.pearcal-seed}/auth.token'"
fi
echo "    Logs:    ssh $TARGET 'tail -f ~/Library/Logs/pearcal-seeder.log'"
echo "    Status:  ssh $TARGET 'launchctl print gui/\$(id -u)/com.pearcal.seeder | grep -i state'"
echo "    Restart: ssh $TARGET 'launchctl kickstart -k gui/\$(id -u)/com.pearcal.seeder'"
echo "    Pair a device: open the dashboard → Add group → Show pairing QR → scan in PearCal."

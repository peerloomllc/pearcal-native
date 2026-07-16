#!/usr/bin/env bash
# Deploy the PearCal blind seeder to a Linux host over SSH as a ROOTLESS
# `systemd --user` service — no sudo, no system unit, no dedicated user.
#
#   scripts/deploy-user-ssh.sh user@host [BARE_HOST]
#
# Suits appliances like Umbrel where you have a normal login + linger but not
# passwordless root (Umbrel's `umbrel` user needs a sudo password, which the
# system-wide deploy-linux-ssh.sh can't drive non-interactively). Stages the
# payload locally, rsyncs it to ~/pearcal-seeder on the host, installs a
# per-user systemd unit, enables lingering (so it runs with no login session),
# and enables + starts it. Idempotent — re-run to update.
#
# Env overrides:
#   SEEDER_PORT  dashboard port (default 8731; Umbrel already uses 8731 → 8732)
#   REMOTE_DIR   payload dir on host   (default ~/pearcal-seeder)
#   DATA_DIR     seed data dir on host (default ~/.pearcal-seed)
set -euo pipefail

TARGET="${1:?usage: deploy-user-ssh.sh user@host [BARE_HOST]}"
BARE_HOST="${2:-linux-x64}"
PORT="${SEEDER_PORT:-8731}"
cd "$(dirname "$0")/.."
LAUNCHER=$(pwd)

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
echo "==> staging payload ($BARE_HOST) -> $STAGE"
BARE_HOST="$BARE_HOST" OUT_DIR="$STAGE" bash "$LAUNCHER/scripts/stage-linux.sh"

echo "==> checking node on $TARGET"
ssh "$TARGET" 'command -v node >/dev/null || { echo "node not found on host PATH" >&2; exit 1; }'

# Stop any running instance first so rsync can replace the bare binary / run.sh
# without hitting ETXTBSY on the live process.
echo "==> stopping existing service (if any)"
ssh "$TARGET" 'systemctl --user stop pearcal-seeder.service 2>/dev/null || true'

echo "==> rsync payload -> $TARGET:~/${REMOTE_DIR:-pearcal-seeder}"
ssh "$TARGET" "mkdir -p ~/${REMOTE_DIR:-pearcal-seeder}"
rsync -az --delete "$STAGE"/ "$TARGET":"${REMOTE_DIR:-pearcal-seeder}/"

echo "==> installing user unit + enabling linger + starting"
ssh "$TARGET" "PORT='$PORT' REMOTE_DIR='${REMOTE_DIR:-pearcal-seeder}' DATA_DIR='${DATA_DIR:-.pearcal-seed}' bash -s" <<'REMOTE'
set -euo pipefail
DIR="$HOME/$REMOTE_DIR"
DATA="$HOME/$DATA_DIR"
NODE_DIR="$(dirname "$(command -v node)")"
mkdir -p "$DATA" "$HOME/.config/systemd/user"
chmod +x "$DIR/run.sh" "$DIR/bare" 2>/dev/null || true

cat > "$HOME/.config/systemd/user/pearcal-seeder.service" <<UNIT
[Unit]
Description=PearCal blind seeder (always-on group replicator)
Documentation=https://github.com/peerloomllc/pearcal-native
After=network-online.target

[Service]
Type=simple
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
Environment=PEARCAL_SEED_DATA=$DATA
Environment=SEEDER_PORT=$PORT
WorkingDirectory=$DIR
ExecStart=$DIR/run.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT

# Linger lets the --user service keep running with no active login session
# (i.e. after this SSH session ends and across reboots). Self-enabled without
# root where polkit allows it (Umbrel does); harmless if already on.
loginctl enable-linger "$USER" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now pearcal-seeder.service
sleep 3
systemctl --user --no-pager --lines=15 status pearcal-seeder.service || true
REMOTE

echo
echo "==> deployed (rootless --user). Dashboard:"
IP=$(ssh "$TARGET" "hostname -I 2>/dev/null | awk '{print \$1}'")
TOKEN=$(ssh "$TARGET" "cat ~/${DATA_DIR:-.pearcal-seed}/auth.token 2>/dev/null | tr -d '\n'")
if [ -n "$TOKEN" ]; then
  echo "    http://${IP:-<host-ip>}:$PORT/?t=$TOKEN"
else
  echo "    token not yet written; check: ssh $TARGET 'cat ~/${DATA_DIR:-.pearcal-seed}/auth.token'"
fi
echo "    Logs:    ssh $TARGET 'journalctl --user -u pearcal-seeder -f'"
echo "    Status:  ssh $TARGET 'systemctl --user status pearcal-seeder'"
echo "    Pair a device: open the dashboard → Add group → Show pairing QR → scan in PearCal."

#!/usr/bin/env bash
# Deploy the PearCal blind seeder to a Linux host over SSH as a systemd service.
#
#   scripts/deploy-linux-ssh.sh user@host [BARE_HOST]
#
# BARE_HOST defaults to linux-x64 (use linux-arm64 for arm boards). Stages the
# payload locally, rsyncs it to /opt/pearcal-seeder on the host, installs the
# systemd unit, and enables + starts it. Requires: ssh/rsync access, sudo on the
# host, and node on the host's PATH. Idempotent — re-run to update.
set -euo pipefail

TARGET="${1:?usage: deploy-linux-ssh.sh user@host [BARE_HOST]}"
BARE_HOST="${2:-linux-x64}"
cd "$(dirname "$0")/.."
LAUNCHER=$(pwd)

STAGE=$(mktemp -d)
echo "==> staging payload ($BARE_HOST) -> $STAGE"
BARE_HOST="$BARE_HOST" OUT_DIR="$STAGE" bash "$LAUNCHER/scripts/stage-linux.sh"

echo "==> checking node on $TARGET"
ssh "$TARGET" 'command -v node >/dev/null || { echo "node not found on host PATH" >&2; exit 1; }'

echo "==> creating service user + dirs on $TARGET"
ssh "$TARGET" 'sudo useradd --system --home-dir /var/lib/pearcal-seeder --create-home --shell /usr/sbin/nologin pearcal 2>/dev/null || true; \
  sudo mkdir -p /opt/pearcal-seeder /var/lib/pearcal-seeder && \
  sudo chown -R pearcal:pearcal /var/lib/pearcal-seeder && \
  sudo chown "$(id -u):$(id -g)" /opt/pearcal-seeder'

echo "==> rsync payload -> $TARGET:/opt/pearcal-seeder"
rsync -az --delete "$STAGE"/ "$TARGET":/opt/pearcal-seeder/
ssh "$TARGET" 'sudo chown -R root:root /opt/pearcal-seeder && sudo chmod -R a+rX /opt/pearcal-seeder'

echo "==> installing systemd unit"
scp "$LAUNCHER/deploy/pearcal-seeder.service" "$TARGET":/tmp/pearcal-seeder.service
ssh "$TARGET" 'sudo mv /tmp/pearcal-seeder.service /etc/systemd/system/pearcal-seeder.service && \
  sudo systemctl daemon-reload && \
  sudo systemctl enable --now pearcal-seeder.service && \
  sleep 3 && sudo systemctl --no-pager --lines=15 status pearcal-seeder.service || true'

rm -rf "$STAGE"
echo "==> deployed. Logs: ssh $TARGET 'journalctl -u pearcal-seeder -f'"
echo "    Admit a device (one-shot QR): ssh -t $TARGET 'sudo systemctl stop pearcal-seeder; \\"
echo "      sudo -u pearcal PEARCAL_SEED_DATA=/var/lib/pearcal-seeder /opt/pearcal-seeder/run.sh --pair'"
echo "    Then Ctrl-C after pairing and: ssh $TARGET 'sudo systemctl start pearcal-seeder'"

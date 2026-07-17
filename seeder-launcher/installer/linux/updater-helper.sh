#!/bin/bash
# Privileged Linux updater for the PearCal seeder (auto-update phase C2, ported
# from PearCircle). Runs as ROOT via pkexec — the .deb postinst installs this
# script root-owned (0755) and a polkit rule that lets the seeder's own user run
# exactly this program without a password. The unprivileged host already
# downloaded + sha256-verified the .deb; this helper RE-verifies it before
# `dpkg -i`, so even though pkexec only authorizes *running* the script, a
# tampered/wrong .deb handed in cannot get installed.
#
# Trust anchor: HTTPS to GitHub + the release .sha256 (Linux .debs are unsigned),
# the same boundary the host enforced. The polkit rule is scoped to one user and
# this one absolute, root-owned program path, so it grants no general root.
#
# Usage (from the host's deb applier):
#   pkexec /opt/pearcal-seeder/updater-helper.sh <debPath> <wantSha256> <user> <version>
set -euo pipefail

DEB="${1:-}"
WANT_SHA="${2:-}"
# The user whose `systemctl --user` unit to restart. Fall back to the uid pkexec
# records for the caller when not passed.
TARGET_USER="${3:-}"
VERSION="${4:-}"

log () { echo "$(date -u +%FT%TZ) [updater] $*"; }

if [ -z "$TARGET_USER" ] && [ -n "${PKEXEC_UID:-}" ]; then
  TARGET_USER="$(getent passwd "$PKEXEC_UID" | cut -d: -f1)"
fi

if [ -z "$DEB" ] || [ ! -f "$DEB" ]; then log "no .deb at '$DEB'; REFUSING"; exit 1; fi

# 1. Integrity: the file must match the sha256 the host verified.
GOT_SHA="$(sha256sum "$DEB" | awk '{print $1}')"
if [ -z "$WANT_SHA" ] || [ "$GOT_SHA" != "$WANT_SHA" ]; then
  log "sha256 mismatch (want ${WANT_SHA:0:12}, got ${GOT_SHA:0:12}); REFUSING"; exit 1
fi

log "verified v$VERSION (sha ${GOT_SHA:0:12}); installing for user '$TARGET_USER'"

# 2. Install. dpkg lays the new payload under /opt and reruns the maintainer
#    scripts. The systemd unit's ExecStart is a stable /opt path, so an upgrade
#    needs no unit re-template. dpkg refuses a *downgrade* by default; real
#    updates only ever increase the version, so no --force flags here.
if dpkg -i "$DEB"; then
  log "dpkg installed v$VERSION"
else
  log "dpkg -i failed for v$VERSION"; exit 1
fi

# 3. Restart the seeder LAST. This tears down the host that invoked us (and this
#    helper, both in the user service's cgroup), so it must come after dpkg has
#    fully completed — otherwise the teardown could interrupt the install. Once
#    the restart job is queued, systemd brings the unit back on the new version
#    even though the issuing process is killed during the stop.
if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ]; then
  TARGET_UID="$(id -u "$TARGET_USER" 2>/dev/null || true)"
  if [ -n "$TARGET_UID" ]; then
    log "restarting pearcal-seeder for $TARGET_USER (uid $TARGET_UID)"
    # --no-block: enqueue the restart and return at once. Restarting the unit
    # tears down its cgroup (this helper + the calling host run in it), so a
    # blocking restart would have systemd kill us mid-call; --no-block lets the
    # host report `restarting` cleanly before systemd brings it back.
    runuser -u "$TARGET_USER" -- env "XDG_RUNTIME_DIR=/run/user/$TARGET_UID" \
      systemctl --user restart --no-block pearcal-seeder.service 2>/dev/null || true
  fi
else
  log "no target user to restart; the new version starts on next service restart"
fi

log "update to v$VERSION complete"

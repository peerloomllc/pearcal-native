#!/bin/bash
# Privileged macOS updater for the PearCal seeder (proposal 2026-07-17 phase C2).
# Runs as ROOT, started by the com.pearcal.seeder.updater LaunchDaemon's
# WatchPaths when the unprivileged launcher drops an apply request. The launcher
# already downloaded + sha256-verified the .pkg; this helper RE-verifies it
# (sha256 + Developer-ID team + notarization) before running `installer`, so a
# malicious local drop cannot get an arbitrary pkg installed — only a
# PearCal-signed, Apple-notarized package passes. That signature check is the
# trust anchor; without it (an unsigned pkg) this handoff would be a local
# privilege-escalation hole, which is why the seeder .pkg is signed + notarized.
set -euo pipefail

REQ_DIR="/Library/Application Support/PearCal Seeder/updates/requests"
REQ="$REQ_DIR/apply.json"
TEAM_ID="G79ALD29NA"

log () { echo "$(date -u +%FT%TZ) [updater] $*"; }

# WatchPaths also fires on our own cleanup (the rm below). No request -> done.
[ -f "$REQ" ] || exit 0

# Read fields with plutil (ships with macOS); python3 is a fallback.
read_field () {
  /usr/bin/plutil -extract "$1" raw -o - "$REQ" 2>/dev/null \
    || /usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$REQ" "$1" 2>/dev/null \
    || true
}

PKG="$(read_field pkgPath)"
WANT_SHA="$(read_field sha256)"
VERSION="$(read_field version)"

# Always clear the request, even on refusal, so a bad drop can't loop.
cleanup () { rm -f "$REQ"; }
trap cleanup EXIT

if [ -z "$PKG" ] || [ ! -f "$PKG" ]; then log "no pkg at '$PKG'; ignoring"; exit 0; fi

# 1. Integrity: the file must match the sha256 the launcher verified.
GOT_SHA="$(/usr/bin/shasum -a 256 "$PKG" | awk '{print $1}')"
if [ -z "$WANT_SHA" ] || [ "$GOT_SHA" != "$WANT_SHA" ]; then
  log "sha256 mismatch (want ${WANT_SHA:0:12}, got ${GOT_SHA:0:12}); REFUSING"; exit 1
fi

# 2. Authenticity: signed by OUR Developer ID Installer team. THE trust anchor —
#    a local attacker cannot forge an Apple-issued signature.
SIG="$(/usr/sbin/pkgutil --check-signature "$PKG" 2>&1 || true)"
if ! printf '%s' "$SIG" | grep -q "$TEAM_ID"; then
  log "pkg not signed by $TEAM_ID; REFUSING"; exit 1
fi

# 3. Notarization: Gatekeeper accepts it for installation.
if ! /usr/sbin/spctl -a -vvv -t install "$PKG" 2>&1 | grep -qi "accepted"; then
  log "pkg not notarized / not accepted by Gatekeeper; REFUSING"; exit 1
fi

log "verified v$VERSION ($TEAM_ID, notarized, sha ${GOT_SHA:0:12}); installing"
# The .pkg's own postinstall reinstalls the payload + reloads the seeder
# LaunchAgent on the new version (and detects "update" to skip first-run UI).
if /usr/sbin/installer -pkg "$PKG" -target / >/dev/null 2>&1; then
  log "installed v$VERSION"
else
  log "installer failed for v$VERSION"; exit 1
fi

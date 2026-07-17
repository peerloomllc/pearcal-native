#!/bin/bash
# Open the PearCal Seeder monitoring dashboard in the default browser, with the
# current auth token filled in. Used by the .deb's desktop entry (so the seeder
# is searchable + clickable in the apps menu) and by the postinst's first-install
# convenience open. The token is read fresh on every launch so the shortcut keeps
# working across token rotation (e.g. if the data dir is wiped).
DATA="${PEARCAL_SEED_DATA:-$HOME/.pearcal-seed}"
URL="http://127.0.0.1:${SEEDER_PORT:-8731}/"
if [ -f "$DATA/auth.token" ]; then
  URL="${URL}?t=$(tr -d '\r\n' < "$DATA/auth.token")"
fi
exec xdg-open "$URL"

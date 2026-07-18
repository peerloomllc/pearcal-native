#!/usr/bin/env bash
# Generate/refresh a static StartOS 0.3.5.x community-registry tree for the
# PearCal seeder from the built .s9pk. The output is a plain file tree that
# implements the marketplace protocol's GET endpoints; host it on any static
# HTTPS server (see README.md) and users add the URL via Marketplace -> Change
# -> Add custom registry.
#
# COMBINED registry: this UPSERTS the PearCal package into whatever tree already
# exists at OUT_DIR — it does NOT wipe it — so one registry (peerloomllc.com) can
# list several PeerLoom seeders (e.g. pearcircle-seeder + pearcal-seeder). The
# per-id files (manifest/instructions/license/icon/version/release-notes) are
# namespaced by id and simply (over)written for THIS id; only the three shared
# aggregates are merged: `index` (array — this id's entry is replaced in place),
# `latest` ({id:ver}), and `info` (categories are unioned). Any other package's
# entries are preserved untouched.
#
# NOTE: every app publishing into the shared tree must use merge-aware tooling
# like this — a legacy `rm -rf package`-style generator would drop the others.
#
# The JSON shapes mirror the live Start9 registry (registry.start9.com):
#   /package/v0/info                     {name, categories[]}
#   /package/v0/index                    [ {categories, dependency-metadata, icon(base64),
#                                            instructions(path), license(path), manifest,
#                                            published-at, versions[] } ]
#   /package/v0/latest                   {id: version}
#   /package/v0/version/<id>             {version}
#   /package/v0/manifest/<id>            <normalized manifest>
#   /package/v0/release-notes/<id>       {version: notes}
#   /package/v0/instructions/<id>        <raw markdown>
#   /package/v0/license/<id>             <raw text>
#   /package/v0/icon/<id>                <raw png bytes>
#   /package/v0/<id>.s9pk                <the signed s9pk>
#
# Usage: build-registry.sh [path-to-s9pk]   (default ../pearcal-seeder.s9pk)
# Requires: start-sdk (manifest inspection), node (JSON assembly).
#
# Env:
#   OUT_DIR     where to write the tree (default ./dist). Point this at a static
#               site (e.g. the website repo root) to deploy the registry there.
#   SKIP_S9PK   set to 1 to NOT copy the (large) .s9pk into the tree. Use this
#               when the host serves the s9pk elsewhere (e.g. a GitHub Release)
#               and redirects /package/v0/<id>.s9pk to it — the s9pk is over
#               Cloudflare Pages' 25 MiB per-file limit, so the website deploy
#               skips it and relies on a _redirects rule.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$HERE/.." && pwd)"
S9PK="${1:-$PKG_DIR/pearcal-seeder.s9pk}"
OUT="${OUT_DIR:-$HERE/dist}"
REGISTRY_NAME="${REGISTRY_NAME:-PeerLoom LLC}"
CATEGORIES_JSON="${CATEGORIES_JSON:-[\"featured\",\"networking\"]}"
# published-at is not read from the clock (kept reproducible); override to stamp.
PUBLISHED_AT="${PUBLISHED_AT:-1970-01-01T00:00:00Z}"

[ -f "$S9PK" ] || { echo "build-registry: s9pk not found: $S9PK (run \`make\` in $PKG_DIR first)" >&2; exit 1; }
command -v start-sdk >/dev/null || { echo "build-registry: start-sdk not on PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "build-registry: node not on PATH" >&2; exit 1; }

echo "==> upserting $(basename "$S9PK") into registry at $OUT"
# Create (never wipe) the tree — OUT may hold OTHER packages' entries.
V0="$OUT/package/v0"
mkdir -p "$V0/version" "$V0/manifest" "$V0/release-notes" "$V0/instructions" "$V0/license" "$V0/icon"

# Normalized manifest (embeds id, version, eos-version, git-hash, arches).
start-sdk inspect manifest "$S9PK" > "$V0/manifest.tmp.json"
PKG_ID="$(node -e "console.log(require('$V0/manifest.tmp.json').id)")"
PKG_VER="$(node -e "console.log(require('$V0/manifest.tmp.json').version)")"
echo "    id=$PKG_ID version=$PKG_VER"

# Assets straight from the package sources (identical to what's in the s9pk).
cp "$PKG_DIR/instructions.md" "$V0/instructions/$PKG_ID"
cp "$PKG_DIR/LICENSE" "$V0/license/$PKG_ID"
cp "$PKG_DIR/icon.png" "$V0/icon/$PKG_ID"
if [ "${SKIP_S9PK:-}" = "1" ]; then
  echo "    SKIP_S9PK=1: not copying the s9pk (host must serve/redirect /package/v0/$PKG_ID.s9pk)"
else
  cp "$S9PK" "$V0/$PKG_ID.s9pk"
fi

# Per-id manifest endpoint.
cp "$V0/manifest.tmp.json" "$V0/manifest/$PKG_ID"

REGISTRY_NAME="$REGISTRY_NAME" CATEGORIES_JSON="$CATEGORIES_JSON" \
PUBLISHED_AT="$PUBLISHED_AT" PKG_ID="$PKG_ID" PKG_VER="$PKG_VER" \
ICON_PATH="$PKG_DIR/icon.png" MANIFEST_PATH="$V0/manifest.tmp.json" V0="$V0" \
node <<'NODE'
const fs = require('fs')
const p = process.env
const manifest = JSON.parse(fs.readFileSync(p.MANIFEST_PATH, 'utf8'))
const id = p.PKG_ID, ver = p.PKG_VER
const iconB64 = fs.readFileSync(p.ICON_PATH).toString('base64')
const categories = JSON.parse(p.CATEGORIES_JSON)
const releaseNotes = manifest['release-notes'] || ''

const file = (rel) => `${p.V0}/${rel}`
const readJSON = (rel, fallback) => {
  try { return JSON.parse(fs.readFileSync(file(rel), 'utf8')) } catch { return fallback }
}
const write = (rel, data) =>
  fs.writeFileSync(file(rel), typeof data === 'string' ? data : JSON.stringify(data))

// This package's /package/v0/index entry (icon is RAW base64; instructions /
// license are PATHS).
const entry = {
  categories,
  'dependency-metadata': {},
  icon: iconB64,
  instructions: `/package/v0/instructions/${id}`,
  license: `/package/v0/license/${id}`,
  manifest,
  'published-at': p.PUBLISHED_AT,
  versions: [ver],
}

// --- MERGE the three shared aggregates (preserve other packages) -----------
// index: replace this id's entry in place, keep every other package's.
const index = readJSON('index', [])
const merged = (Array.isArray(index) ? index : []).filter((e) => e?.manifest?.id !== id)
merged.push(entry)
// stable order by id so re-runs produce a deterministic diff
merged.sort((a, b) => String(a?.manifest?.id).localeCompare(String(b?.manifest?.id)))
write('index', merged)

// latest: {id: version} for ALL packages.
const latest = readJSON('latest', {})
latest[id] = ver
write('latest', latest)

// info: {name, categories} — union categories across all packages.
const info = readJSON('info', { name: p.REGISTRY_NAME, categories: [] })
const cats = new Set([...(info.categories || []), ...categories])
write('info', { name: p.REGISTRY_NAME, categories: [...cats] })

// --- per-id endpoints ------------------------------------------------------
write(`version/${id}`, { version: ver })
write(`release-notes/${id}`, { [ver]: releaseNotes })

console.log(`    merged: index (${merged.length} package(s)), latest, info; wrote version, release-notes`)
NODE

rm -f "$V0/manifest.tmp.json"

echo "==> registry tree ready at: $OUT"
echo "    entrypoint: $OUT/package/v0/info"
( cd "$OUT" && find package -type f | sort | sed 's/^/      /' )

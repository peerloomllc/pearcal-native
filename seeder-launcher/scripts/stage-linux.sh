#!/usr/bin/env bash
# Stage a self-contained PearCal blind-seeder payload for Linux.
#
# Produces a flat directory the launcher host runs in prod mode:
#   <OUT>/bare                      the Bare runtime binary
#   <OUT>/worklet/seed.bundle       bare-packed src/seed.js
#   <OUT>/worklet/node_modules/…    native-addon prebuilds for the host arch
#   <OUT>/host/…                    the Node launcher host (index.js + worklet.js)
#   <OUT>/run.sh                    convenience launcher
#
# The worklet runs under the Bare runtime (no node_modules needed for it); the
# host is Node (spawns the Bare subprocess, keeps it alive, sends IPC). Ported
# from PearCircle seeder-launcher/scripts/stage-payload-linux.sh, trimmed to the
# Node-host path (SEA + monitoring dashboard are follow-ups).
#
# Usage:
#   BARE_HOST=linux-x64  OUT_DIR=/abs/payload  bash scripts/stage-linux.sh
#   BARE_HOST=linux-arm64 …
set -euo pipefail

cd "$(dirname "$0")/.."
LAUNCHER=$(pwd)
REPO=$(cd "$LAUNCHER/.." && pwd)

BARE_HOST="${BARE_HOST:?BARE_HOST must be linux-x64 or linux-arm64}"
OUT_DIR="${OUT_DIR:?OUT_DIR must be an absolute payload path}"
case "$BARE_HOST" in
  linux-x64|linux-arm64) ;;
  *) echo "stage-linux: unsupported BARE_HOST '$BARE_HOST'" >&2; exit 1 ;;
esac

echo "==> staging PearCal seeder  host=$BARE_HOST  ->  $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/worklet" "$OUT_DIR/host"

# 1. Bare runtime binary. Not an npm dependency of the app (mobile links its own
#    runtime), so fetch the pinned version for the target arch via `npm pack`.
#    Override with BARE_VER=… if the bundle format ever needs a newer runtime.
BARE_VER="${BARE_VER:-1.28.5}"
BARE_BIN_SRC="$REPO/node_modules/bare-runtime-$BARE_HOST/bin/bare"
if [ ! -x "$BARE_BIN_SRC" ]; then
  echo "--> fetching bare-runtime-$BARE_HOST@$BARE_VER"
  PACKDIR=$(mktemp -d)
  ( cd "$PACKDIR" && npm pack --loglevel=error "bare-runtime-$BARE_HOST@$BARE_VER" >/dev/null )
  DEST="$REPO/node_modules/bare-runtime-$BARE_HOST"
  rm -rf "$DEST"; mkdir -p "$DEST"
  tar -xzf "$PACKDIR"/*.tgz -C "$DEST" --strip-components=1
  rm -rf "$PACKDIR"
  chmod +x "$BARE_BIN_SRC"
fi
[ -x "$BARE_BIN_SRC" ] || { echo "stage-linux: bare binary missing: $BARE_BIN_SRC" >&2; exit 1; }
cp "$BARE_BIN_SRC" "$OUT_DIR/bare"; chmod +x "$OUT_DIR/bare"

# 2. Worklet bundle. bare-pack collapses seed.js's whole module graph into one
#    bundle; only native addon prebuilds ship beside it. --base one level below
#    node_modules makes the bundle resolve addons at ../node_modules next to it.
#    `bare-process`/`bare-fs`/`bare-path` are bundled (installed deps); only the
#    fs/path aliases are deferred (resolved by the runtime).
echo "--> worklet bundle (bare-pack --host $BARE_HOST)"
"$REPO/node_modules/.bin/bare-pack" --host "$BARE_HOST" \
  --base "$REPO/worklet" --defer fs --defer path \
  "$REPO/src/seed.js" -o "$OUT_DIR/worklet/seed.bundle"

# 3. Native addon prebuilds the bundle references, staged so ../node_modules
#    specifiers resolve next to the bundle.
echo "--> worklet addon prebuilds"
staged=0
while read -r d; do
  [ -z "$d" ] && continue
  rel="${d#./}"
  mkdir -p "$OUT_DIR/worklet/node_modules/$(dirname "$rel")"
  cp -R "$REPO/node_modules/$rel" "$OUT_DIR/worklet/node_modules/$(dirname "$rel")/"
  staged=$((staged + 1))
done < <(cd "$REPO/node_modules" && find . -type d -path "*/prebuilds/$BARE_HOST")
echo "    staged $staged addon prebuild dirs"
[ "$staged" -gt 0 ] || { echo "stage-linux: no $BARE_HOST prebuilds found; run \`npm install\`" >&2; exit 1; }

# 4. Launcher host (Node) + version (for the dashboard pill).
cp "$LAUNCHER/host/index.js" "$LAUNCHER/host/worklet.js" "$LAUNCHER/host/dashboard.js" \
   "$LAUNCHER/host/auth.js" "$OUT_DIR/host/"
cp "$LAUNCHER/package.json" "$OUT_DIR/package.json" 2>/dev/null || true

# 4a. Brand mark: a small copy of the app icon for the dashboard header.
if command -v magick >/dev/null 2>&1; then
  magick "$REPO/assets/images/icon.png" -resize 64x64 "$OUT_DIR/host/brand.png" 2>/dev/null && echo "--> brand mark staged"
elif command -v convert >/dev/null 2>&1; then
  convert "$REPO/assets/images/icon.png" -resize 64x64 "$OUT_DIR/host/brand.png" 2>/dev/null && echo "--> brand mark staged"
else
  echo "--> no imagemagick; dashboard uses the ◆ fallback mark"
fi

# 4b. Offline dashboard font: extract the Manrope woff2 @font-face CSS from the
#     app's fonts.js so the dashboard renders without a Google Fonts round-trip.
node -e '
  const fs=require("fs");
  const t=fs.readFileSync(process.argv[1],"utf8");
  const m=t.match(/FONT_CSS\s*=\s*("(?:[^"\\]|\\.)*")/s);
  if(m) fs.writeFileSync(process.argv[2], JSON.parse(m[1]));
' "$REPO/src/ui/fonts.js" "$OUT_DIR/host/fonts.css" 2>/dev/null && \
  echo "--> inlined offline font ($(wc -c < "$OUT_DIR/host/fonts.css" 2>/dev/null || echo 0) bytes)" || \
  echo "--> font extract skipped (dashboard falls back to Google Fonts)"

# 4c. Host runtime deps. The Node host pulls in `qrcode` (the dashboard renders
#     pairing + support QRs via qrcode.toDataURL; the terminal --pair path uses
#     it too). Stage qrcode + its runtime deps under host/node_modules so the
#     payload is self-contained — otherwise the host only resolves qrcode when a
#     repo checkout happens to sit on NODE_PATH (true on the dev box, false on a
#     bare deploy target like Umbrel). All pure-JS, so arch-independent.
echo "--> host runtime deps (qrcode)"
mkdir -p "$OUT_DIR/host/node_modules"
for m in qrcode dijkstrajs pngjs; do
  [ -d "$REPO/node_modules/$m" ] || { echo "stage-linux: missing node_modules/$m; run \`npm install\`" >&2; exit 1; }
  cp -R "$REPO/node_modules/$m" "$OUT_DIR/host/node_modules/"
done

# 5. Convenience runner: host in prod mode against this payload.
cat > "$OUT_DIR/run.sh" <<'RUN'
#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DATA="${PEARCAL_SEED_DATA:-$HOME/.pearcal-seed}"
exec node "$HERE/host/index.js" --bare "$HERE/bare" --bundle "$HERE/worklet/seed.bundle" --data "$DATA" "$@"
RUN
chmod +x "$OUT_DIR/run.sh"

echo "==> done. Run: PEARCAL_SEED_DATA=<dir> $OUT_DIR/run.sh"
echo "    Pair a device: $OUT_DIR/run.sh --pair"

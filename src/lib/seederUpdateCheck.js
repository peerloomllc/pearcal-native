// Pure version-compare + release-asset selection for the seeder update check
// (proposal 2026-07-17-macos-seeder-and-autoupdate, phase B). No Node / bare /
// network deps, so it is shared by the seeder-launcher host (which does the
// actual GitHub fetch) and is unit-tested here. Ported from PearCircle
// src/lib/seederUpdateCheck.js.
//
// Versions are the release tag scheme `vX.Y.Z` / `X.Y.Z`. Pre-release / build
// suffixes (e.g. `1.0.4-rc1`, `0.0.0-dev`) parse to their numeric core; the
// suffix is ignored for ordering (good enough for "is a newer release out").
//
// PearCal divergence from PearCircle: `updateAvailable` here REQUIRES a matching
// seeder installer asset for the running platform, not just a newer tag. PearCal's
// GitHub releases carry the mobile app (APK/IPA) — a seeder installer (.pkg, later
// .AppImage/.deb) is only attached once phase C ships it. Requiring the asset stops
// an app-only release from false-flagging a seeder update, and means the banner
// stays dark until there is actually something to install for this platform.

// Parse a version string to a [major, minor, patch] number triple, or null when
// it has no numeric core.
function parseVersion (v) {
  if (typeof v !== 'string') return null
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!m) return null
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)]
}

// -1 if a<b, 0 if equal, 1 if a>b. Unparseable versions sort lowest, and two
// unparseable versions are "equal" (neither is newer).
function compareVersions (a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

// True when `latest` is a strictly newer release than `current`. Errs toward
// false (no false "update available") when either side is unparseable.
function isNewer (latest, current) {
  if (!parseVersion(latest) || !parseVersion(current)) return false
  return compareVersions(latest, current) > 0
}

// Architecture name tokens that may appear in an asset filename, keyed by
// Node's process.arch. Linux release assets are arch-specific (x86_64/amd64 vs
// aarch64/arm64), so we must match the running arch - handing the wrong-arch
// binary is worse than handing none.
function archTokens (arch) {
  if (arch === 'x64') return ['x86_64', 'amd64', 'x64']
  if (arch === 'arm64') return ['aarch64', 'arm64']
  return arch ? [String(arch).toLowerCase()] : []
}

// Every arch token that may appear in a seeder installer name, across all
// platforms. Used to tell an arch-suffixed asset from an arch-universal one.
const ALL_ARCH_TOKENS = ['x86_64', 'amd64', 'x64', 'aarch64', 'arm64']

// Pick this platform+arch's installer asset from a GitHub release's `assets`
// array. platform is process.platform ('darwin' | 'win32' | 'linux'), arch is
// process.arch ('x64' | 'arm64'). Windows `.exe` ships as a single (universal)
// asset, so arch is not required there. macOS `.pkg` and Linux `.AppImage`/`.deb`
// are built per-arch (the .pkg name carries `-arm64`/`-x64`), so we match the
// running arch and never hand back a wrong-arch binary — a wrong-arch install is
// worse than none, so we fall back to null. A macOS `.pkg` with no arch token in
// its name is treated as arch-universal (a single fat build). On Linux the
// `installKind` hint decides which artifact a running seeder gets so the apply
// path matches how it was installed. .sha256 sidecars are never returned as the
// primary asset.
function selectAsset (assets, platform, arch, installKind) {
  if (!Array.isArray(assets)) return null
  // Match ONLY seeder-named assets. Every seeder installer carries "seeder" in
  // its name (PearCalSeeder-*.pkg / *.AppImage / *-Setup-*.exe, pearcal-seeder_*.deb),
  // while the SAME GitHub release also carries the mobile APK and the DESKTOP
  // Electron app's own .deb / .AppImage / .exe / .dmg — which share our suffixes
  // on Linux/Windows. Without this filter a Linux/Windows seeder would select the
  // desktop app's installer and false-flag it as its own update. (macOS dodged
  // this only because the desktop app ships a .dmg, not a .pkg.)
  const named = assets.filter((a) => a && typeof a.name === 'string' &&
    !a.name.endsWith('.sha256') && a.name.toLowerCase().includes('seeder'))
  const lower = (a) => a.name.toLowerCase()
  const bySuffix = (suffix) => named.filter((a) => lower(a).endsWith(suffix))
  const toks = archTokens(arch)
  const matchArch = (list) => list.find((a) => toks.some((t) => lower(a).includes(t))) || null
  if (platform === 'darwin') {
    const pkgs = bySuffix('.pkg')
    // Prefer an arch-matching build; otherwise accept an arch-universal pkg (no
    // arch token in the name). Never return the wrong arch's suffixed pkg.
    const universal = pkgs.find((a) => !ALL_ARCH_TOKENS.some((t) => lower(a).includes(t))) || null
    return matchArch(pkgs) || universal
  }
  if (platform === 'win32') return bySuffix('.exe')[0] || null
  if (platform === 'linux') {
    const appimage = () => matchArch(bySuffix('.appimage'))
    const deb = () => matchArch(bySuffix('.deb'))
    return installKind === 'deb'
      ? (deb() || appimage())
      : (appimage() || deb())
  }
  return null
}

// Find the `<assetName>.sha256` sidecar for a chosen asset, or null.
function selectSha256For (assets, assetName) {
  if (!Array.isArray(assets) || typeof assetName !== 'string') return null
  return assets.find((a) => a && a.name === assetName + '.sha256') || null
}

// Evaluate a GitHub `/releases/latest` JSON against the running version for a
// platform. Returns a stable shape the host route + UI consume. `updateAvailable`
// is true only when the release is a strictly newer tag AND carries an installer
// asset for this platform (see the header note on the PearCircle divergence).
function evaluateRelease (release, { currentVersion, platform, arch, installKind } = {}) {
  const latestVersion = typeof release?.tag_name === 'string'
    ? release.tag_name.replace(/^v/i, '')
    : null
  const asset = selectAsset(release?.assets, platform, arch, installKind)
  const sha = asset ? selectSha256For(release?.assets, asset.name) : null
  return {
    currentVersion: currentVersion ?? null,
    latestVersion,
    updateAvailable: !!(latestVersion && asset && isNewer(latestVersion, currentVersion)),
    releaseUrl: typeof release?.html_url === 'string' ? release.html_url : null,
    assetName: asset?.name ?? null,
    assetUrl: asset?.browser_download_url ?? null,
    sha256Url: sha?.browser_download_url ?? null,
  }
}

module.exports = { parseVersion, compareVersions, isNewer, selectAsset, selectSha256For, evaluateRelease }

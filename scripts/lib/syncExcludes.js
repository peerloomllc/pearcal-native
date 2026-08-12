// Shared reader/matcher for scripts/mac-sync-excludes.txt.
//
// rsync consumes that file directly via --exclude-from. This module exists so
// the pre-flight guard and the test can ask the SAME questions rsync will,
// rather than keeping a second copy of the list that drifts (which is the exact
// failure TODO #168 was about, four times over).
//
// Supported pattern forms, a deliberate subset of rsync's:
//
//   name            any path segment equal to `name`, at any depth
//   /path/to/thing  anchored at the repo root
//   *.ext           glob against the basename, at any depth
//
// A trailing slash is accepted and ignored. Anything fancier that rsync
// understands (**, character classes, negation) is rejected at parse time
// rather than silently matching differently here than it does there.

const fs = require('fs')
const path = require('path')

const EXCLUDES_FILE = path.join(__dirname, '..', 'mac-sync-excludes.txt')

// A directory this big that nothing excludes is a build-sync stall waiting to
// happen. Tuned well above any real source directory in the repo.
const HEAVY_DIR_BYTES = 100 * 1024 * 1024

function parseExcludes (text) {
  const out = []
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/\*\*|\[|\]|^!/.test(line)) {
      throw new Error('unsupported rsync pattern in mac-sync-excludes.txt: ' + line)
    }
    out.push(line.replace(/\/+$/, ''))
  }
  return out
}

function loadExcludes (file = EXCLUDES_FILE) {
  return parseExcludes(fs.readFileSync(file, 'utf8'))
}

function globToRegExp (glob) {
  const escaped = glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp('^' + escaped + '$')
}

// `relPath` is repo-root-relative with forward slashes and no leading slash.
function isExcluded (relPath, patterns) {
  const clean = String(relPath).replace(/^\/+/, '').replace(/\/+$/, '')
  if (!clean) return false
  const segments = clean.split('/')
  const base = segments[segments.length - 1]
  for (const pattern of patterns) {
    if (pattern.startsWith('/')) {
      const anchored = pattern.slice(1)
      // An anchored pattern excludes the path itself and everything under it.
      if (clean === anchored || clean.startsWith(anchored + '/')) return true
      continue
    }
    if (pattern.includes('/')) {
      // Unanchored multi-segment pattern: rsync matches it against any tail of
      // the path, so `scripts/.env` hits `scripts/.env` at any depth.
      if (clean === pattern || clean.endsWith('/' + pattern)) return true
      continue
    }
    if (pattern.includes('*') || pattern.includes('?')) {
      const re = globToRegExp(pattern)
      // A glob excludes a path if it matches any segment, since rsync drops the
      // whole subtree once a parent directory is excluded.
      if (segments.some(s => re.test(s))) return true
      continue
    }
    if (segments.includes(pattern)) return true
    if (base === pattern) return true
  }
  return false
}

// Walks the tree the way rsync will, skipping excluded subtrees rather than
// descending into them, and reports what would actually be sent. Returns
// { bytes, files, dirs } where `dirs` are the top offenders by size.
function measureSyncSet (root, patterns, { heavyBytes = HEAVY_DIR_BYTES } = {}) {
  const perTop = new Map()
  let bytes = 0
  let files = 0

  function walk (absDir, relDir, topKey) {
    let entries
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }) } catch (e) { return }
    for (const entry of entries) {
      const rel = relDir ? relDir + '/' + entry.name : entry.name
      if (isExcluded(rel, patterns)) continue
      const abs = path.join(absDir, entry.name)
      const key = topKey || rel
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(abs, rel, key)
      } else if (entry.isFile()) {
        let size = 0
        try { size = fs.statSync(abs).size } catch (e) { continue }
        bytes += size
        files++
        perTop.set(key, (perTop.get(key) || 0) + size)
      }
    }
  }

  walk(root, '', null)

  const dirs = [...perTop.entries()]
    .filter(([, size]) => size >= heavyBytes)
    .sort((a, b) => b[1] - a[1])
    .map(([name, size]) => ({ name, bytes: size }))

  return { bytes, files, dirs }
}

// Every directory in the repo that is big enough to stall a sync and is NOT
// excluded. The test asserts this is empty; the pre-flight prints it.
function unexcludedHeavyDirs (root, patterns, { heavyBytes = HEAVY_DIR_BYTES } = {}) {
  const found = []

  function sizeOf (absDir, relDir) {
    let total = 0
    let entries
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }) } catch (e) { return 0 }
    for (const entry of entries) {
      const rel = relDir ? relDir + '/' + entry.name : entry.name
      const abs = path.join(absDir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (isExcluded(rel, patterns)) continue
        total += sizeOf(abs, rel)
      } else if (entry.isFile()) {
        if (isExcluded(rel, patterns)) continue
        try { total += fs.statSync(abs).size } catch (e) {}
      }
    }
    if (relDir && total >= heavyBytes) found.push({ name: relDir, bytes: total })
    return total
  }

  sizeOf(root, '')
  // Keep only the outermost offender of each chain: reporting src/ui as well as
  // src is noise when excluding src would cover both.
  return found
    .filter(d => !found.some(other => other !== d && d.name.startsWith(other.name + '/')))
    .sort((a, b) => b.bytes - a.bytes)
}

module.exports = {
  EXCLUDES_FILE,
  HEAVY_DIR_BYTES,
  parseExcludes,
  loadExcludes,
  isExcluded,
  measureSyncSet,
  unexcludedHeavyDirs
}

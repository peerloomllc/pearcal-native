// The desktop renderer may only call proxy methods the desktop proxy provides.
//
// `test/dbProxyParity.test.js` covers the modules BOTH UIs import. This covers
// the other half of the same failure, which #163 kept running into: code that
// lives only in `src/ui-desktop/` calling a `db.`/`sync.` method that only
// mobile's proxy defines. Nothing fails loudly when that happens - the entry
// reads as `undefined` and the call throws at click time, or worse, an
// `if (sync.thing)` gate silently renders nothing and the feature just appears
// not to exist (#146).
//
// Written while porting the storage reports (#163): `sync.storageBreakdown` and
// `sync.analyzeStorage` were called from SettingsModal before they existed in
// `main.jsx`, which is exactly the shape this catches.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const UI_DIR = path.join(root, 'src', 'ui-desktop')
const MAIN = path.join(UI_DIR, 'main.jsx')

function walk (dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.jsx?$/.test(e.name) ? [p] : []
  })
}

// The keys of a top-level `const <name> = { ... }` object literal in main.jsx.
// These objects are flat lists of `key: (args) => ...` entries, so the shape is
// predictable and a regex is honest here.
function proxyKeys (src, name) {
  const start = src.indexOf(`const ${name} = {`)
  assert.notStrictEqual(start, -1, `no "const ${name} = {" in main.jsx`)
  const end = src.indexOf('\n}', start)
  assert.notStrictEqual(end, -1, `${name} object never closes`)
  const body = src.slice(start, end)
  return new Set([...body.matchAll(/^ {2}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)].map(m => m[1]))
}

// `sync.foo(` and `sync?.foo(` anywhere in the desktop tree, main.jsx excluded
// since that is where the objects are declared.
function callsTo (receiver) {
  const re = new RegExp(`\\b${receiver}\\??\\.([a-zA-Z_][a-zA-Z0-9_]*)`, 'g')
  const hits = new Map()
  for (const file of walk(UI_DIR)) {
    if (file === MAIN) continue
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(re)) {
      if (!hits.has(m[1])) hits.set(m[1], path.relative(root, file))
    }
  }
  return hits
}

const mainSrc = fs.readFileSync(MAIN, 'utf8')

for (const receiver of ['db', 'sync']) {
  test(`every ${receiver}.* the desktop UI calls exists in the desktop ${receiver} proxy`, () => {
    const defined = proxyKeys(mainSrc, receiver)
    const missing = [...callsTo(receiver)]
      .filter(([method]) => !defined.has(method))
      .map(([method, file]) => `${receiver}.${method} (${file})`)
    assert.deepStrictEqual(missing, [],
      `desktop UI calls proxy methods main.jsx does not define:\n  ${missing.join('\n  ')}`)
  })
}

// The storage port is deliberately read-only. Mobile hides Reclaim Storage and
// Sweep Orphaned Data behind `{false && ...}` because a device left missing
// blocks the shared history still references cannot heal itself (#154, PR #143),
// so shipping them on desktop would hand users a button mobile withholds. If
// mobile ever un-hides them, this fails and says to port them together.
test('the desktop offers no storage action mobile keeps hidden', () => {
  const WRITE_METHODS = ['reclaimStorage', 'rebuildLocalDb', 'auditStorage',
    'purgeMigratedGroup', 'purgeAllMigratedGroups', 'purgeOrphanDataRanges']

  // `name(` or `name:` - a call or a proxy entry. Bare mentions do not count,
  // since main.jsx names all six in the comment explaining their absence.
  const desktop = walk(UI_DIR).map(f => fs.readFileSync(f, 'utf8')).join('\n')
  for (const m of WRITE_METHODS) {
    assert.ok(!new RegExp(`\\b${m}\\s*[:(]`).test(desktop),
      `${m} reached src/ui-desktop. Port it only when mobile stops hiding its storage writes.`)
  }

  const mobile = fs.readFileSync(path.join(root, 'src', 'ui', 'App.jsx'), 'utf8')
  for (const [method, marker] of [['rebuildLocalDb', 'Reclaim Storage'], ['auditStorage', 'Sweep Orphaned Data']]) {
    assert.ok(mobile.includes(method), `mobile no longer calls ${method} - has the storage section moved?`)
    assert.ok(mobile.includes(marker), `mobile no longer has a "${marker}" surface`)
  }
  assert.ok(mobile.includes('{false && (() => {') && mobile.includes('{false && ('),
    'mobile no longer hides its storage write actions - port them to desktop too, or update this test')
})

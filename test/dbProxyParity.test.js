// TODO #146 - the two db proxies are allowed to differ, but not where shared
// code depends on them.
//
// `repairKeylessGroup` was wired in src/ui/main.jsx and dispatched in bare.js,
// and simply absent from src/ui-desktop/main.jsx. Nothing failed loudly: a
// missing proxy entry just reads as `undefined`, and handleInviteLink - which is
// SHARED between the two UIs - gates the keyless-group repair on that entry
// being truthy. So on desktop the branch fell through to `already_member`, the
// precise dead end TODO #124 exists to remove, reintroduced by omission. A
// keyless group on Pear Desktop could not be healed by any user action.
//
// It stayed invisible until a trace happened to land on it, which is the part
// worth fixing permanently. The two proxies are DELIBERATELY different - mobile
// has haptics, QR scanning and Lightning; desktop has launch-at-login - so
// demanding they match would be wrong and would be deleted the first time it
// got in the way. What must hold is narrower and actually true:
//
//   every db method that SHARED code calls must exist in BOTH proxies.
//
// (bugfix/desktop-db-proxy-parity)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

// Modules imported by BOTH src/ui and src/ui-desktop, so anything they call on
// `db` has to be answerable in either host.
const SHARED_MODULES = ['src/invite.js']

const PROXIES = {
  mobile: 'src/ui/main.jsx',
  desktop: 'src/ui-desktop/main.jsx',
}

// Method names defined in a proxy object literal: two-space-indented `name:`.
function proxyMethods (file) {
  return new Set([...read(file).matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1]))
}

// `db.foo(` and `db?.foo(` - the CALL form only. A bare `db.foo` reference (as
// in the truthiness gate this bug hid behind) is deliberately not counted here:
// what matters is the call, and matching bare references would also match
// prose like "db.js" in a comment.
function dbCallsIn (file) {
  return new Set([...read(file).matchAll(/\bdb\??\.\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]))
}

test('shared modules only call db methods that BOTH proxies provide', () => {
  const mobile = proxyMethods(PROXIES.mobile)
  const desktop = proxyMethods(PROXIES.desktop)
  const gaps = []
  for (const mod of SHARED_MODULES) {
    for (const method of dbCallsIn(mod)) {
      if (!mobile.has(method)) gaps.push(`${mod} calls db.${method}() - missing from ${PROXIES.mobile}`)
      if (!desktop.has(method)) gaps.push(`${mod} calls db.${method}() - missing from ${PROXIES.desktop}`)
    }
  }
  assert.deepEqual(gaps, [],
    'a shared module calls a db method one host cannot answer; it will read as undefined and fail silently')
})

test('the desktop can repair a keyless group', () => {
  // Named explicitly rather than left to the sweep above, because this is the
  // one that was actually broken and the sweep would go quiet if the shared
  // call were ever refactored out of the call form it matches.
  assert.match(read(PROXIES.desktop), /repairKeylessGroup:/,
    'without this a keyless group on desktop cannot be healed by any user action (TODO #124/#146)')
})

test('both proxies answer everything the shared invite flow needs', () => {
  // The specific list, so a future edit to invite.js that adds a db call is
  // caught by name rather than only in aggregate.
  const needed = ['getGroup', 'putGroup', 'putMember', 'getProfile',
    'isBlockedFromGroup', 'clearBlockedFromGroup', 'deleteGroup', 'repairKeylessGroup']
  for (const [host, file] of Object.entries(PROXIES)) {
    const have = proxyMethods(file)
    for (const m of needed) assert.ok(have.has(m), `${host} proxy is missing ${m}`)
  }
})

test('the proxies are allowed to differ where nothing shared depends on them', () => {
  // Guards the guard. If someone "fixes" the above by making the two identical,
  // this fails and says why that is not the goal: mobile genuinely has haptics
  // and QR scanning, desktop genuinely has launch-at-login.
  const mobile = proxyMethods(PROXIES.mobile)
  const desktop = proxyMethods(PROXIES.desktop)
  assert.ok(mobile.has('haptic') && !desktop.has('haptic'), 'haptics are mobile-only by design')
  assert.ok(desktop.has('setLaunchAtLogin') && !mobile.has('setLaunchAtLogin'), 'launch-at-login is desktop-only by design')
})

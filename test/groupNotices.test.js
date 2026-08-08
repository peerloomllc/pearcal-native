// #163 — the three trouble notices, now shared by both UIs. These test the
// DECISIONS (when does each speak, and what does it say), which is the part
// that was wrong: on desktop all three were silent, so a broken calendar looked
// identical to a quiet one.
//
// Rendering is checked without React by calling the components as plain
// functions and walking the returned element tree. That keeps the test free of
// a DOM and a renderer while still exercising the real component, including the
// null returns that let callers drop them in unconditionally.
// (feature/desktop-ui-parity-audit)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { transformSync } = require('esbuild')

// The component file is JSX, so compile it to CJS in memory and load it.
const SRC = path.join(__dirname, '..', 'src', 'ui-shared', 'components', 'GroupNotices.jsx')
const compiled = transformSync(fs.readFileSync(SRC, 'utf8'), {
  loader: 'jsx', format: 'cjs', jsx: 'automatic',
}).code
const mod = { exports: {} }
new Function('module', 'exports', 'require', compiled)(mod, mod.exports, require)
const { KeylessNotice, SyncHealthNotice, PendingApprovalNotice, fmtSyncAge } = mod.exports

const THEME = { text: '#fff', muted: '#999' }

// Flatten a returned element tree to its visible text.
function textOf (el) {
  if (el == null || el === false) return ''
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map(textOf).join('')
  if (typeof el.type === 'function') return textOf(el.type(el.props))
  return textOf(el.props?.children)
}

// ── silence when there is nothing wrong ───────────────────────────────────
test('every notice renders nothing when it has nothing to say', () => {
  assert.equal(KeylessNotice({ group: { id: 'g' }, theme: THEME }), null)
  assert.equal(SyncHealthNotice({ group: { id: 'g' }, theme: THEME }), null)
  assert.equal(PendingApprovalNotice({ pending: false, theme: THEME }), null)
})
test('a null group does not throw', () => {
  assert.equal(KeylessNotice({ group: null, theme: THEME }), null)
  assert.equal(SyncHealthNotice({ group: null, theme: THEME }), null)
})

// ── keyless (#124) ────────────────────────────────────────────────────────
test('a certainly-keyless group says it cannot sync, and names the cure', () => {
  const t = textOf(KeylessNotice({
    group: { id: 'gry5nws', keyless: { certainty: 'certain' } }, theme: THEME,
  }))
  assert.match(t, /can't sync on this device/)
  assert.match(t, /missing the key/)
  assert.match(t, /fresh invite link/)
  assert.match(t, /gry5nws/)          // group id, so a user can quote it
})
test('a merely-suspected keyless group hedges instead of accusing', () => {
  const t = textOf(KeylessNotice({
    group: { id: 'g', keyless: { certainty: 'likely' } }, theme: THEME,
  }))
  assert.match(t, /hasn't synced since you joined/)
  assert.match(t, /or the others may simply be offline/)
  assert.doesNotMatch(t, /cannot reach the other members/)
})

// ── sync health (#155) ────────────────────────────────────────────────────
test('a stale calendar reports how long it has been quiet', () => {
  const t = textOf(SyncHealthNotice({
    group: { id: 'g', syncHealth: { state: 'stale', reason: 'quiet', sinceMs: 3 * 86400000 } },
    theme: THEME,
  }))
  assert.match(t, /hasn't synced in 3 days/)
})
test('a never-synced calendar says so rather than reporting an age', () => {
  const t = textOf(SyncHealthNotice({
    group: { id: 'g', syncHealth: { state: 'stale', reason: 'never-synced' } }, theme: THEME,
  }))
  assert.match(t, /hasn't synced yet/)
  assert.match(t, /since you joined/)
})
test('a healthy calendar says nothing', () => {
  assert.equal(SyncHealthNotice({
    group: { id: 'g', syncHealth: { state: 'ok' } }, theme: THEME,
  }), null)
})
test('the two never stack — keyless wins and sync-health stands down', () => {
  const group = {
    id: 'g',
    keyless: { certainty: 'certain' },
    syncHealth: { state: 'stale', reason: 'quiet', sinceMs: 999999999 },
  }
  assert.notEqual(KeylessNotice({ group, theme: THEME }), null)
  assert.equal(SyncHealthNotice({ group, theme: THEME }), null)
})

// ── pending approval ──────────────────────────────────────────────────────
test('a joiner waiting on the owner is told why they see nothing', () => {
  const t = textOf(PendingApprovalNotice({ pending: true, theme: THEME }))
  assert.match(t, /Waiting for owner approval/)
  assert.match(t, /approve your return/)
})

// ── the age wording, coarse on purpose ────────────────────────────────────
test('fmtSyncAge stays coarse and never implies false precision', () => {
  assert.equal(fmtSyncAge(30 * 60 * 1000), 'a while')       // under an hour
  assert.equal(fmtSyncAge(5 * 3600000), '5 hours')
  assert.equal(fmtSyncAge(3 * 86400000), '3 days')
  assert.equal(fmtSyncAge(21 * 86400000), '3 weeks')
})
test('fmtSyncAge survives rubbish rather than printing NaN at a user', () => {
  assert.equal(fmtSyncAge(undefined), 'a while')
  assert.equal(fmtSyncAge(-1), 'a while')
  assert.equal(fmtSyncAge(Infinity), 'a while')
})

// ── host-neutrality, the property that makes sharing possible ─────────────
test('renders with no icon, because desktop has no icon library', () => {
  const t = textOf(KeylessNotice({ group: { id: 'g', keyless: { certainty: 'certain' } }, theme: THEME }))
  assert.match(t, /can't sync/)
})
test('takes colours as a plain theme object, not either host vocabulary', () => {
  // mobile speaks colors.text.primary, desktop speaks tokens.text. The
  // component must know neither. Comments may name them — the header explains
  // exactly this — so strip comments before looking at the code.
  const code = fs.readFileSync(SRC, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /colors\.text/)
  assert.doesNotMatch(code, /\btokens\./)
})

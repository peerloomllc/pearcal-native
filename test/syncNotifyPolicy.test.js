// Unit tests for the timer-free background notification policy
// (src/lib/syncNotifyPolicy.js). TODO #128.
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createSyncNotifyState, decideSyncNotify, contentId, contentKey,
  DEDUP_MS, BURST_MS, SUMMARY_ID,
} = require('../src/lib/syncNotifyPolicy')

const ev = (title, body = 'On Jul 23', extra = {}) => ({ title, body, tab: 'calendar', ...extra })

test('a lone change posts verbatim, so the user sees what changed', () => {
  const s = createSyncNotifyState()
  const d = decideSyncNotify(ev('Sam added Dinner'), s, 1000)
  assert.equal(d.post, true)
  assert.equal(d.title, 'Sam added Dinner')
  assert.equal(d.body, 'On Jul 23')
  assert.equal(d.reason, 'first')
})

test('identical text repeated inside the window is dropped', () => {
  const s = createSyncNotifyState()
  assert.equal(decideSyncNotify(ev('Sam added Dinner'), s, 1000).post, true)
  const d2 = decideSyncNotify(ev('Sam added Dinner'), s, 1000 + DEDUP_MS - 1)
  assert.equal(d2.post, false)
  assert.equal(d2.reason, 'duplicate')
})

test('identical text repeated AFTER the window posts again', () => {
  const s = createSyncNotifyState()
  decideSyncNotify(ev('Sam added Dinner'), s, 1000)
  const d2 = decideSyncNotify(ev('Sam added Dinner'), s, 1000 + DEDUP_MS + 1)
  assert.equal(d2.post, true, 'a genuine later repeat is real news, not a duplicate')
})

test('a content id is stable for identical text and differs for different text', () => {
  const a = contentId(contentKey('Sam added Dinner', 'On Jul 23'))
  const b = contentId(contentKey('Sam added Dinner', 'On Jul 23'))
  const c = contentId(contentKey('Sam added Lunch', 'On Jul 23'))
  assert.equal(a, b, 'same text must reuse the id so the OS REPLACES rather than stacks')
  assert.notEqual(a, c)
})

test('no content id can collide with the reserved summary id', () => {
  for (let i = 0; i < 3000; i++) {
    assert.notEqual(contentId('title ' + i + ' body ' + i), SUMMARY_ID)
  }
})

// ── The #128 regression: an overnight burst ─────────────────────────────────

test('#128: a burst of distinct changes collapses to ONE updating summary', () => {
  const s = createSyncNotifyState()
  const posts = []
  for (let i = 0; i < 12; i++) {
    const d = decideSyncNotify(ev('Sam added Event ' + i), s, 1000 + i * 100)
    if (d.post) posts.push(d)
  }
  assert.equal(posts.length, 12, 'every change still yields a post call')

  const ids = new Set(posts.map(p => p.id))
  assert.equal(ids.size, 2, 'but only TWO distinct notification ids: the first, plus one summary')

  assert.equal(posts[0].reason, 'first')
  for (const p of posts.slice(1)) assert.equal(p.id, SUMMARY_ID)

  // The summary updates in place, so the LAST write is what the user sees.
  const last = posts[posts.length - 1]
  assert.equal(last.title, 'Calendar updated')
  assert.equal(last.body, '12 changes')
})

test('#128: before the fix this would have been 12 separate notifications', () => {
  // Documents the old behaviour for contrast: a fresh random id per post meant
  // the OS could never collapse anything.
  const s = createSyncNotifyState()
  const ids = new Set()
  for (let i = 0; i < 12; i++) {
    const d = decideSyncNotify(ev('Sam added Event ' + i), s, 1000 + i * 100)
    if (d.post) ids.add(d.id)
  }
  assert.ok(ids.size < 12, 'distinct visible notifications must be far fewer than events')
  assert.equal(ids.size, 2)
})

test('a new burst starts once the window has elapsed', () => {
  const s = createSyncNotifyState()
  decideSyncNotify(ev('A'), s, 1000)
  const d2 = decideSyncNotify(ev('B'), s, 1000 + 10)
  assert.equal(d2.reason, 'summary')

  const d3 = decideSyncNotify(ev('C'), s, 1000 + BURST_MS + 1)
  assert.equal(d3.reason, 'first', 'a later, unrelated change is posted verbatim again')
})

test('immediate alerts keep their own text and are never rolled up', () => {
  const s = createSyncNotifyState()
  decideSyncNotify(ev('A'), s, 1000)
  decideSyncNotify(ev('B'), s, 1010)   // burst under way
  const d = decideSyncNotify(ev('Pat wants to rejoin Family', 'Tap to review', { immediate: true }), s, 1020)
  assert.equal(d.post, true)
  assert.equal(d.reason, 'immediate')
  assert.equal(d.title, 'Pat wants to rejoin Family')
  assert.notEqual(d.id, SUMMARY_ID, 'must not overwrite or be overwritten by the rollup')
})

test('an immediate alert is still deduped against an exact repeat', () => {
  const s = createSyncNotifyState()
  const a = decideSyncNotify(ev('Pat wants to rejoin', 'Tap to review', { immediate: true }), s, 1000)
  const b = decideSyncNotify(ev('Pat wants to rejoin', 'Tap to review', { immediate: true }), s, 1500)
  assert.equal(a.post, true)
  assert.equal(b.post, false)
})

test('the dedup map does not grow without bound', () => {
  const s = createSyncNotifyState()
  for (let i = 0; i < 500; i++) decideSyncNotify(ev('Event ' + i), s, 1000 + i * DEDUP_MS)
  assert.ok(s.recent.size <= 2, 'aged-out entries are pruned, size stays bounded')
})

test('missing fields fall back rather than throwing', () => {
  const s = createSyncNotifyState()
  const d = decideSyncNotify({}, s, 1000)
  assert.equal(d.post, true)
  assert.equal(d.title, 'Calendar updated')
  assert.equal(d.body, '')
  assert.equal(d.tab, 'calendar')
})

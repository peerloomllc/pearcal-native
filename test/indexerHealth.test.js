const test = require('node:test')
const assert = require('node:assert')
const { classifyIndexerNotice, MIN_ENTRIES, BEHIND_PCT } = require('../src/lib/indexerHealth.js')

// Mirrors indexerInfoFor() in bare.js.
function info (count, total, signed) {
  const majority = Math.floor(count / 2) + 1
  const behind = Math.max(0, total - signed)
  return {
    count, majority,
    canLose: count - majority,
    total, signed, behind,
    behindPct: total > 0 ? Math.round((behind / total) * 100) : 0,
  }
}

test('nothing to say without indexer data', () => {
  assert.equal(classifyIndexerNotice(null).kind, 'none')
  assert.equal(classifyIndexerNotice({}).kind, 'none')
})

test('a solo calendar is silent — one device signing alone is fine', () => {
  assert.equal(classifyIndexerNotice(info(1, 500, 500)).kind, 'none')
})

test('two signers have no spare, and are told so', () => {
  const r = classifyIndexerNotice(info(2, 500, 495))
  assert.equal(r.kind, 'no-spare')
  assert.equal(r.count, 2)
})

test('a healthy larger calendar stays silent', () => {
  assert.equal(classifyIndexerNotice(info(4, 500, 495)).kind, 'none')
  assert.equal(classifyIndexerNotice(info(7, 5000, 4990)).kind, 'none')
})

// THE REGRESSION. This is the case the first version missed entirely: Tim's
// real calendar, 7 signers with 2,825 of 69,269 signed. canLose is 3, so the
// old `canLose === 0` rule said nothing at all about the worst calendar there.
test('a large calendar falling behind is reported, even with spare signers', () => {
  const r = classifyIndexerNotice(info(7, 69269, 2825))
  assert.equal(r.kind, 'behind', 'the worst-affected calendar must not be silent')
  assert.equal(r.count, 7)
  assert.ok(r.behindPct >= 95)
})

test('being behind outranks having no spare when both are true', () => {
  const r = classifyIndexerNotice(info(2, 1000, 100))
  assert.equal(r.kind, 'behind')
})

test('a young calendar is not nagged, however far behind it looks', () => {
  const r = classifyIndexerNotice(info(4, MIN_ENTRIES - 1, 0))
  assert.equal(r.kind, 'none', 'below the entry floor nothing should be claimed')
})

test('the behind threshold is a floor, not a hair trigger', () => {
  const just = classifyIndexerNotice(info(4, 1000, 1000 - (BEHIND_PCT * 10)))
  assert.equal(just.kind, 'behind', 'exactly at the threshold counts')
  const under = classifyIndexerNotice(info(4, 1000, 1000 - (BEHIND_PCT * 10) + 10))
  assert.equal(under.kind, 'none', 'just under it does not')
})

test('a calendar with no entries yet says nothing', () => {
  assert.equal(classifyIndexerNotice(info(3, 0, 0)).kind, 'none')
})

test('signed ahead of total never produces a negative reading', () => {
  const r = classifyIndexerNotice(info(4, 100, 120))
  assert.equal(r.kind, 'none')
})

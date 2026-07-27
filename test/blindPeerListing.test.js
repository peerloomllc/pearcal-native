// TODO #125 - a followed blind peer stayed listed forever with a group count
// frozen at pair time, and nothing ever said "this one serves nothing of yours".
// Pure decisions in src/lib/blindPeerListing.js.
// (bugfix/stale-blind-peers)
const test = require('node:test')
const assert = require('node:assert/strict')
const { summariseSeederCoverage, seederCoverageLabel } = require('../src/lib/blindPeerListing.js')

test('THE #125 CASE: serves only groups this device does not have', () => {
  // Exactly what was seen on the TCL: the seeder was serving `Hudgins 2`, a
  // group the debug app is not in, while the list said "Seeding 2 groups".
  const s = summariseSeederCoverage({
    servedGroupIds: ['hudgins2'],
    liveGroupIds: ['gAAA', 'gBBB'],
  })
  assert.equal(s.groupsServed, 0)
  assert.equal(s.servesCurrentGroups, false)
  assert.deepEqual(seederCoverageLabel(s), { tone: 'warn', text: 'Not seeding any of your groups' })
})

test('the count is what it serves NOW, not what it served at pair time', () => {
  // The seeder was paired when it held three groups; two are gone.
  const s = summariseSeederCoverage({
    servedGroupIds: ['gAAA', 'gGONE1', 'gGONE2'],
    liveGroupIds: ['gAAA', 'gBBB'],
  })
  assert.equal(s.groupsServed, 1)
  assert.equal(seederCoverageLabel(s).text, 'Seeding 1 group')
})

test('singular and plural read correctly', () => {
  const one = summariseSeederCoverage({ servedGroupIds: ['a'], liveGroupIds: ['a', 'b'] })
  const two = summariseSeederCoverage({ servedGroupIds: ['a', 'b'], liveGroupIds: ['a', 'b'] })
  assert.equal(seederCoverageLabel(one).text, 'Seeding 1 group')
  assert.equal(seederCoverageLabel(two).text, 'Seeding 2 groups')
})

test('a device with NO groups says nothing rather than accusing the seeder', () => {
  // Vacuously it serves none of your groups, but showing that to someone with no
  // groups reads as a fault in the seeder. Three states exist for this reason.
  const s = summariseSeederCoverage({ servedGroupIds: [], liveGroupIds: [] })
  assert.equal(s.servesCurrentGroups, null)
  assert.equal(seederCoverageLabel(s), null)
})

test('a device with groups and a seeder serving none of them IS marked', () => {
  // The distinction that makes the null state honest rather than a cop-out.
  const s = summariseSeederCoverage({ servedGroupIds: [], liveGroupIds: ['gAAA'] })
  assert.equal(s.servesCurrentGroups, false)
  assert.equal(seederCoverageLabel(s).tone, 'warn')
})

test('duplicate rows for the same group count once', () => {
  // One groupSeeder row per (group, pubkey), but a re-enrol or a mirror replay
  // can produce the same groupId twice in the input.
  const s = summariseSeederCoverage({
    servedGroupIds: ['gAAA', 'gAAA', 'gAAA'],
    liveGroupIds: ['gAAA'],
  })
  assert.equal(s.groupsServed, 1)
})

test('accepts a Set or an array for either input', () => {
  const fromSets = summariseSeederCoverage({
    servedGroupIds: new Set(['a']), liveGroupIds: new Set(['a', 'b']),
  })
  assert.equal(fromSets.groupsServed, 1)
  assert.equal(fromSets.servesCurrentGroups, true)
})

test('empty, missing and junk inputs do not throw', () => {
  for (const args of [undefined, {}, { servedGroupIds: null, liveGroupIds: null }]) {
    const s = summariseSeederCoverage(args)
    assert.equal(s.groupsServed, 0)
    assert.equal(s.servesCurrentGroups, null)
  }
  assert.equal(seederCoverageLabel(undefined), null)
  assert.equal(seederCoverageLabel({}), null)
})

test('falsy group ids are ignored rather than counted', () => {
  const s = summariseSeederCoverage({ servedGroupIds: ['', null, undefined], liveGroupIds: ['gAAA'] })
  assert.equal(s.groupsServed, 0)
})

test('the label is the single source of wording for both UIs', () => {
  // Mobile and desktop render the same string from here. If one of them starts
  // composing its own, this is the test that should have stopped it.
  const s = summariseSeederCoverage({ servedGroupIds: ['a'], liveGroupIds: ['a'] })
  const l = seederCoverageLabel(s)
  assert.ok(l && typeof l.text === 'string' && l.text.length > 0)
  assert.ok(['normal', 'warn'].includes(l.tone))
})

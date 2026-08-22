// Where an imported .ics lands. The sheet asks the user a single question -
// personal, one specific group, or keep what the file declared - and every
// answer routes through routeIcsImport, so the rules live here rather than in
// the 8k-line calendar component.
const test = require('node:test')
const assert = require('node:assert')

let icsFileGroups, routeIcsImport
test.before(async () => {
  const mod = await import('../src/ui-shared/lib/ics.js')
  icsFileGroups = mod.icsFileGroups
  routeIcsImport = mod.routeIcsImport
})

const EVENTS = [
  { title: 'Standup', date: '2026-08-24', uid: 'e1', groups: ['work'] },
  { title: 'Dentist', date: '2026-08-25', uid: 'e2' },
  { title: 'Ghost',   date: '2026-08-26', uid: 'e3', groups: ['left-this-one'] },
]
const MINE = ['work', 'family']

test('personal strips every group, including ones the file declared', () => {
  const routed = routeIcsImport(EVENTS, { dest: 'personal', groupIds: MINE })
  assert.deepStrictEqual(routed.map(r => r.keptGroups), [[], [], []])
})

test('a group destination shares every event with that group', () => {
  const routed = routeIcsImport(EVENTS, { dest: 'family', groupIds: MINE })
  assert.deepStrictEqual(routed.map(r => r.keptGroups), [['family'], ['family'], ['family']])
})

test('a destination we are not a member of routes to personal, never to the group', () => {
  const routed = routeIcsImport(EVENTS, { dest: 'someone-elses-group', groupIds: MINE })
  assert.deepStrictEqual(routed.map(r => r.keptGroups), [[], [], []])
})

test('keep-from-file honours declared groups but drops ones we left', () => {
  const routed = routeIcsImport(EVENTS, { dest: 'file', groupIds: MINE })
  assert.deepStrictEqual(routed.map(r => r.keptGroups), [['work'], [], []])
})

test('default destination is personal when the caller says nothing', () => {
  const routed = routeIcsImport(EVENTS, { groupIds: MINE })
  assert.deepStrictEqual(routed.map(r => r.keptGroups), [[], [], []])
})

test('already-imported uids are skipped whatever the destination', () => {
  for (const dest of ['personal', 'family', 'file']) {
    const routed = routeIcsImport(EVENTS, {
      dest, groupIds: MINE, existingEventIds: new Set(['e2']),
    })
    assert.deepStrictEqual(routed.map(r => r.skipped), [false, true, false], dest)
  }
})

test('the @pearcal suffix is stripped before the duplicate check', () => {
  const routed = routeIcsImport([{ title: 'A', date: '2026-08-24', uid: 'e9@pearcal' }],
    { groupIds: MINE, existingEventIds: new Set(['e9']) })
  assert.strictEqual(routed[0].uid, 'e9')
  assert.strictEqual(routed[0].skipped, true)
})

test('an event with no uid is never treated as a duplicate', () => {
  const routed = routeIcsImport([{ title: 'A', date: '2026-08-24' }],
    { groupIds: MINE, existingEventIds: new Set(['e1']) })
  assert.strictEqual(routed[0].skipped, false)
})

test('icsFileGroups reports only groups we are still in', () => {
  assert.deepStrictEqual([...icsFileGroups(EVENTS, MINE)], ['work'])
})

test('icsFileGroups is empty for a foreign .ics, so no keep-from-file option', () => {
  const foreign = [{ title: 'Flight', date: '2026-09-01', uid: 'abc@google.com' }]
  assert.strictEqual(icsFileGroups(foreign, MINE).size, 0)
})

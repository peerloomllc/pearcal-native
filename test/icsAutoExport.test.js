// Files for the desktop's automatic .ics export (#186): one per chosen
// calendar, holidays left out, shared events in every chosen group's file.
const test = require('node:test')
const assert = require('node:assert')

let autoExportFiles, parseIcs
test.before(async () => {
  const mod = await import('../src/ui-shared/lib/ics.js')
  autoExportFiles = mod.autoExportFiles
  parseIcs = mod.parseIcs
})

const GROUPS = [{ id: 'g1', name: 'Family' }, { id: 'g2', name: 'Work Stuff!' }]
const EVENTS = [
  { id: 'p1', title: 'Dentist', date: '2026-11-02', start: '09:00', end: '10:00', groups: [] },
  { id: 'f1', title: 'Soccer', date: '2026-11-03', start: '17:00', end: '18:00', groups: ['g1'] },
  { id: 'b1', title: 'Both', date: '2026-11-04', allDay: true, groups: ['g1', 'g2'] },
  { id: 'holiday-2026-11-26-thanksgiving', title: 'Thanksgiving', date: '2026-11-26', allDay: true, groups: [] }
]

const titles = f => parseIcs(f.content).map(e => e.title).sort()

test('one file per chosen calendar, named from the calendar', () => {
  const files = autoExportFiles(EVENTS, GROUPS, ['personal', 'g1', 'g2'])
  assert.deepStrictEqual(files.map(f => f.name), ['pearcal-personal.ics', 'pearcal-family.ics', 'pearcal-work-stuff.ics'])
  assert.deepStrictEqual(titles(files[0]), ['Dentist'])
  assert.deepStrictEqual(titles(files[1]), ['Both', 'Soccer'])
  assert.deepStrictEqual(titles(files[2]), ['Both'])
})

test('unchosen calendars and unknown group ids produce no file', () => {
  const files = autoExportFiles(EVENTS, GROUPS, ['g1', 'gone'])
  assert.deepStrictEqual(files.map(f => f.name), ['pearcal-family.ics'])
  assert.deepStrictEqual(autoExportFiles(EVENTS, GROUPS, []), [])
})

test('two groups with the same name get distinct file names', () => {
  const files = autoExportFiles(EVENTS, [{ id: 'aaa', name: 'Family' }, { id: 'bbb', name: 'family' }], ['aaa', 'bbb'])
  assert.deepStrictEqual(files.map(f => f.name), ['pearcal-family.ics', 'pearcal-family-bbb.ics'])
})

test('file names always match what main accepts', () => {
  const files = autoExportFiles(EVENTS, [{ id: 'x/../y', name: '../../etc' }, { id: 'z', name: '日本' }], ['x/../y', 'z'])
  for (const f of files) assert.match(f.name, /^pearcal-[a-z0-9-]+\.ics$/)
})

test('planAutoExport writes changed files and removes only its own old ones', async () => {
  const { planAutoExport, icsFingerprint } = await import('../src/ui-shared/lib/ics.js')
  const a1 = 'BEGIN:VCALENDAR\r\nDTSTAMP:20260101T000000Z\r\nSUMMARY:A\r\nEND:VCALENDAR'
  const a2 = a1.replace('20260101', '20260202')
  assert.strictEqual(icsFingerprint(a1), icsFingerprint(a2))
  const first = planAutoExport([{ name: 'pearcal-a.ics', content: a1 }, { name: 'pearcal-b.ics', content: 'B' }], {})
  assert.deepStrictEqual(first.write.map(f => f.name), ['pearcal-a.ics', 'pearcal-b.ics'])
  const second = planAutoExport([{ name: 'pearcal-a.ics', content: a2 }], first.fingerprints)
  assert.deepStrictEqual(second.write, [])
  assert.deepStrictEqual(second.remove, ['pearcal-b.ics'])
  const third = planAutoExport([{ name: 'pearcal-a.ics', content: a1.replace('A', 'A2') }], second.fingerprints)
  assert.deepStrictEqual(third.write.map(f => f.name), ['pearcal-a.ics'])
})

// TODO #189: one file per personal calendar, and 'personal' still meaning all.
test('autoExportFiles splits personal calendars on request', async () => {
  const { autoExportFiles } = await import('../src/ui-shared/lib/ics.js')
  const ev = (id, extra = {}) => ({ id, title: id, date: '2026-11-20', allDay: true, groups: [], ...extra })
  const events = [ev('a'), ev('b', { calendarId: 'health' }), ev('c', { groups: ['g1'], calendarId: 'health' })]
  const cals = [{ id: 'default', name: 'Personal' }, { id: 'health', name: 'Health' }]
  const files = autoExportFiles(events, [{ id: 'g1', name: 'Team' }], ['personal', 'personal:health', 'personal:default'], cals)
  const byName = Object.fromEntries(files.map(f => [f.name, f.content]))
  assert.ok(byName['pearcal-health.ics'].includes('SUMMARY:b'))
  assert.ok(!byName['pearcal-health.ics'].includes('SUMMARY:c'), 'a group event stays out of a personal calendar file')
  const personalFiles = files.filter(f => f.name.startsWith('pearcal-personal'))
  assert.strictEqual(personalFiles.length, 2, 'all-personal and the default calendar each get a file')
  // Old settings without the new argument behave exactly as before.
  const legacy = autoExportFiles(events, [], ['personal'])
  assert.strictEqual(legacy.length, 1)
  assert.ok(legacy[0].content.includes('SUMMARY:a') && legacy[0].content.includes('SUMMARY:b'))
})

test('icsCalendarName reads X-WR-CALNAME', async () => {
  const { icsCalendarName } = await import('../src/ui-shared/lib/ics.js')
  assert.strictEqual(icsCalendarName('BEGIN:VCALENDAR\r\nX-WR-CALNAME:Health\\, body\r\nEND:VCALENDAR'), 'Health, body')
  assert.strictEqual(icsCalendarName('BEGIN:VCALENDAR\r\nEND:VCALENDAR'), null)
  assert.strictEqual(icsCalendarName('X-WR-CALNAME;VALUE=TEXT:Fêtes\r\n'), 'Fêtes')
})

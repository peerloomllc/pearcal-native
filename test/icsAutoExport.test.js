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

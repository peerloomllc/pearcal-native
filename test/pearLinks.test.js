// Links between PearCal and PearOffice
// (proposals/2026-10-26-pearcal-pearoffice-links.md in the suite root).
const test = require('node:test')
const assert = require('node:assert/strict')

const lib = () => import('../src/ui-shared/lib/pearLinks.js')

const FILE_ID = 'aB3_-' + 'x'.repeat(38)          // 43 chars
const FOLDER_ID = '0123456789abcdef0123456789abcdef' // 32 hex

test('PearOffice file and folder links are accepted exactly', async () => {
  const { parsePearLink } = await lib()
  assert.deepEqual(parsePearLink('pearoffice://file/' + FILE_ID), { kind: 'file', id: FILE_ID })
  assert.deepEqual(parsePearLink('pearoffice://folder/' + FOLDER_ID), { kind: 'folder', id: FOLDER_ID })
})

test('near-miss PearOffice links are rejected', async () => {
  const { parsePearLink } = await lib()
  for (const bad of [
    'pearoffice://file/' + FILE_ID.slice(1),          // 42 chars
    'pearoffice://file/' + FILE_ID + 'x',             // 44 chars
    'pearoffice://file/' + FILE_ID.slice(1) + '.',    // bad char
    'pearoffice://folder/' + FOLDER_ID.slice(1) + 'g', // not hex
    'pearoffice://folder/' + FOLDER_ID + '0',         // 33
    'pearoffice://file/' + FILE_ID + '/',
    'pearoffice://file/' + FILE_ID + '?x=1',
    'pearoffice://sheet/' + FILE_ID,
    ' pearoffice://file/' + FILE_ID,
    'PEAROFFICE://file/' + FILE_ID,
    'https://pearoffice/file/' + FILE_ID,
    '', null, undefined, 42,
  ]) assert.equal(parsePearLink(bad), null, String(bad))
})

test('PearCal event links round-trip, occurrence ids included', async () => {
  const { parsePearLink, eventLink } = await lib()
  for (const id of ['e1730000000000', 'e1730000000000_r4', 'e1730000000000_v2_r11',
    'e1730000000000-ab12c', 'abc123@google.com', 'bday-lx1abc']) {
    const url = eventLink('g4k2x9a', id)
    assert.ok(url, id)
    assert.deepEqual(parsePearLink(url), { kind: 'event', calendarId: 'g4k2x9a', eventId: id })
  }
  assert.equal(eventLink('g4k2x9a', 'e1_r4'), 'pearcal://event/g4k2x9a/e1_r4')
})

test('near-miss PearCal event links are rejected', async () => {
  const { parsePearLink, eventLink } = await lib()
  for (const bad of [
    'pearcal://event/g4k2x9a',
    'pearcal://event/g4k2x9a/',
    'pearcal://event//e1',
    'pearcal://event/g4k2x9a/e1/extra',
    'pearcal://event/g4k2x9a/e1?x=1',
    'pearcal://event/g4k.2x/e1',
    'pearcal://event/g4k2x9a/%E0%A4%A',               // broken escape
    'pearcal://events/g4k2x9a/e1',
    'pearcal://join?group=x',
    'pearcal://pair?x=1',
  ]) assert.equal(parsePearLink(bad), null, bad)
  assert.equal(eventLink('', 'e1'), null)
  assert.equal(eventLink('g/x', 'e1'), null)
  assert.equal(eventLink('g4k2x9a', ''), null)
  assert.equal(eventLink(undefined, 'e1'), null)
})

test('PearCal day links accept real dates only', async () => {
  const { parsePearLink, dayLink } = await lib()
  assert.deepEqual(parsePearLink('pearcal://day/2026-10-26'), { kind: 'day', date: '2026-10-26' })
  assert.deepEqual(parsePearLink('pearcal://day/2028-02-29'), { kind: 'day', date: '2028-02-29' })
  assert.equal(dayLink('2026-10-26'), 'pearcal://day/2026-10-26')
  for (const bad of ['pearcal://day/2026-02-30', 'pearcal://day/2026-13-01', 'pearcal://day/2026-1-5',
    'pearcal://day/26-10-26', 'pearcal://day/2026-10-26/', 'pearcal://day/2026-10-26T10:00', 'pearcal://day/']) {
    assert.equal(parsePearLink(bad), null, bad)
  }
  assert.equal(dayLink('2026-02-30'), null)
})

test('links are found in a description, once each, with punctuation trimmed', async () => {
  const { linksInText } = await lib()
  const text = `Agenda: pearoffice://file/${FILE_ID}.
Budget (pearoffice://folder/${FOLDER_ID}), again pearoffice://file/${FILE_ID}
See pearcal://day/2026-10-26, and "pearcal://event/g4k2x9a/e1730000000000_r2"!
Not these: pearoffice://file/short pearcal://day/2026-02-30 https://example.com pearcal://join?x=1`
  assert.deepEqual(linksInText(text).map(l => [l.kind, l.url]), [
    ['file', 'pearoffice://file/' + FILE_ID],
    ['folder', 'pearoffice://folder/' + FOLDER_ID],
    ['day', 'pearcal://day/2026-10-26'],
    ['event', 'pearcal://event/g4k2x9a/e1730000000000_r2'],
  ])
  assert.deepEqual(linksInText(''), [])
  assert.deepEqual(linksInText(undefined), [])
  assert.deepEqual(linksInText('no links here'), [])
})

test('row labels', async () => {
  const { pearLinkLabel, parsePearLink } = await lib()
  assert.equal(pearLinkLabel(parsePearLink('pearoffice://file/' + FILE_ID)), 'PearOffice file')
  assert.equal(pearLinkLabel(parsePearLink('pearoffice://folder/' + FOLDER_ID)), 'PearOffice folder')
  assert.equal(pearLinkLabel(parsePearLink('pearcal://event/g1/e1')), 'PearCal event')
  const day = pearLinkLabel(parsePearLink('pearcal://day/2026-10-26'))
  assert.match(day, /2026/)
  assert.match(day, /26/)
})

test('only pearoffice: links name another app', async () => {
  const { otherAppFor } = await lib()
  assert.deepEqual(otherAppFor('pearoffice://file/' + FILE_ID), { name: 'PearOffice', page: 'https://peerloomllc.com/pearoffice/' })
  assert.equal(otherAppFor('https://example.com'), null)
  assert.equal(otherAppFor('pearcal://day/2026-10-26'), null)
})

test('an event link opens the occurrence, else its series, else says it is missing', async () => {
  const { findLinkedEvent, seriesIdOf } = await lib()
  assert.equal(seriesIdOf('e1_r3'), 'e1')
  assert.equal(seriesIdOf('e1_v2_r3'), 'e1')
  assert.equal(seriesIdOf('e1_v2'), 'e1')
  assert.equal(seriesIdOf('e1'), 'e1')

  const events = [
    { id: 'e1', date: '2026-10-01', groups: ['g1'], recurrenceId: 'e1' },
    { id: 'e1_r1', date: '2026-10-08', groups: ['g1'], recurrenceId: 'e1' },
    { id: 'e2_v1', date: '2026-11-05', groups: ['g1'], recurrenceId: 'e2' },
    { id: 'e2_v1_r1', date: '2026-11-12', groups: ['g1'], recurrenceId: 'e2' },
    { id: 'e3', date: '2026-10-02', groups: ['g2'] },
    { id: 'e4', date: '2026-10-03', groups: ['g1'], isShadow: true },
  ]
  assert.equal(findLinkedEvent(events, 'g1', 'e1_r1').event.id, 'e1_r1')
  assert.equal(findLinkedEvent(events, 'g1', 'e1_r1').series, undefined)
  // occurrence gone: the series root
  assert.deepEqual(findLinkedEvent(events, 'g1', 'e1_r9'), { event: events[0], series: true })
  // series changed cadence, old occurrence gone: earliest of the series
  assert.deepEqual(findLinkedEvent(events, 'g1', 'e2_r4'), { event: events[2], series: true })
  // in another calendar, a shadow, or not there at all
  assert.deepEqual(findLinkedEvent(events, 'g1', 'e3'), { missing: true })
  assert.deepEqual(findLinkedEvent(events, 'g1', 'e4'), { missing: true })
  assert.deepEqual(findLinkedEvent(events, 'g9', 'e1'), { missing: true })
  assert.deepEqual(findLinkedEvent([], 'g1', 'e1'), { missing: true })
})

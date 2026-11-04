// TODO #189 phase 2: web calendar subscriptions (src/lib/webCalendars.js and
// the feed parser in src/ui-shared/hooks/useWebCalendars.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const w = require('../src/lib/webCalendars.js')
const { visibilityKeys, isEventVisible } = require('../src/lib/calendars.js')

const ICS = [
  'BEGIN:VCALENDAR', 'X-WR-CALNAME:Jours fériés', 'BEGIN:VEVENT', 'UID:bastille@example',
  'DTSTART;VALUE=DATE:20260714', 'DTEND;VALUE=DATE:20260715', 'SUMMARY:Fête nationale',
  'RRULE:FREQ=YEARLY', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:noel@example',
  'DTSTART;VALUE=DATE:20261225', 'DTEND;VALUE=DATE:20261226', 'SUMMARY:Noël', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n')

test('normalizeFeedUrl turns webcal into https and rejects junk', () => {
  assert.equal(w.normalizeFeedUrl('webcal://example.com/a.ics'), 'https://example.com/a.ics')
  assert.equal(w.normalizeFeedUrl('  example.com/a.ics '), 'https://example.com/a.ics')
  assert.equal(w.normalizeFeedUrl('http://example.com/a.ics'), 'http://example.com/a.ics')
  assert.throws(() => w.normalizeFeedUrl(''))
  assert.throws(() => w.normalizeFeedUrl('ftp://example.com/a.ics'))
  assert.throws(() => w.normalizeFeedUrl('file:///etc/passwd'))
})

test('makeSubscriptionRecord validates, clamps and moves updatedAt forward', () => {
  const a = w.makeSubscriptionRecord({ id: 's1', url: 'webcal://x.org/c.ics', name: ' FR ', refreshHours: 0 }, null, 1000)
  assert.deepEqual(a, { id: 's1', url: 'https://x.org/c.ics', name: 'FR', color: null, refreshHours: 1, createdAt: 1000, updatedAt: 1000 })
  const b = w.makeSubscriptionRecord({ id: 's1', name: 'France' }, a, 10)
  assert.equal(b.updatedAt, 1001)
  assert.equal(b.url, 'https://x.org/c.ics')
  const d = w.makeSubscriptionRecord({ id: 's1', deleted: true }, b, 2000)
  assert.equal(d.deleted, true)
  assert.throws(() => w.makeSubscriptionRecord({ id: 'a:b', url: 'x.org' }))
  assert.equal(w.makeSubscriptionRecord({ id: 's2', url: 'x.org', refreshHours: 9999 }).refreshHours, 168)
})

test('listSubscriptions keeps the newest version and drops deleted', () => {
  const list = w.listSubscriptions([
    { id: 'b', createdAt: 2, updatedAt: 2 }, { id: 'a', createdAt: 1, updatedAt: 1 },
    { id: 'a', createdAt: 1, updatedAt: 5, name: 'new' }, { id: 'c', createdAt: 3, updatedAt: 3, deleted: true },
  ])
  assert.deepEqual(list.map(x => [x.id, x.name]), [['a', 'new'], ['b', undefined]])
})

test('isFeedDue: never fetched, url changed, interval passed, failures back off', () => {
  const sub = { id: 's', url: 'https://x/a', refreshHours: 12 }
  const H = 3600 * 1000
  assert.equal(w.isFeedDue(sub, null, 0), true)
  assert.equal(w.isFeedDue(sub, { url: 'https://x/a', fetchedAt: 0 }, 11 * H), false)
  assert.equal(w.isFeedDue(sub, { url: 'https://x/a', fetchedAt: 0 }, 12 * H), true)
  assert.equal(w.isFeedDue(sub, { url: 'https://x/old', fetchedAt: 0 }, 1), true)
  assert.equal(w.isFeedDue(sub, { url: 'https://x/a', error: 'x', attemptedAt: 0 }, 2 * H), false)
  assert.equal(w.isFeedDue(sub, { url: 'https://x/a', error: 'x', attemptedAt: 0 }, 3 * H), true)
})

const fakeFetch = (status, body, headers = {}) => async () => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  text: async () => body,
})

test('fetchCalendarText returns a calendar and explains failures', async () => {
  assert.equal(await w.fetchCalendarText('webcal://x.org/c.ics', { fetchImpl: fakeFetch(200, ICS) }), ICS)
  await assert.rejects(w.fetchCalendarText('x.org', { fetchImpl: fakeFetch(404, '') }), /error 404/)
  await assert.rejects(w.fetchCalendarText('x.org', { fetchImpl: fakeFetch(200, '<html>') }), /did not return a calendar/)
  await assert.rejects(w.fetchCalendarText('x.org', { fetchImpl: fakeFetch(200, ICS, { 'content-length': '99999999' }) }), /too large/)
  await assert.rejects(w.fetchCalendarText('x.org', { fetchImpl: async () => { throw new Error('ENOTFOUND') } }), /Could not reach/)
})

test('web calendar events have their own show/hide key', () => {
  const ev = { id: 'web-s1-x', groups: [], subscriptionId: 's1' }
  assert.deepEqual(visibilityKeys(ev), ['sub:s1'])
  assert.equal(isEventVisible(ev, new Set(['sub:s1'])), false)
  assert.equal(isEventVisible(ev, new Set(['personal:default'])), true)
})

test('feedEvents builds read-only events and expands yearly rules', async () => {
  const { feedEvents } = await import('../src/ui-shared/hooks/useWebCalendars.js')
  const evs = feedEvents({ id: 's1', color: '#4BBDCC' }, ICS, new Date(2026, 0, 1))
  const bastille = evs.filter(e => e.title === 'Fête nationale')
  assert.ok(bastille.length >= 2, 'yearly rule expands to more than one year')
  assert.ok(evs.some(e => e.title === 'Noël' && e.date === '2026-12-25'))
  for (const e of evs) {
    assert.equal(e.subscriptionId, 's1')
    assert.equal(e.readOnly, true)
    assert.deepEqual(e.groups, [])
    assert.equal(e.color, '#4BBDCC')
    assert.equal(e.editPermission, 'creator')
  }
  assert.equal(new Set(evs.map(e => e.id)).size, evs.length, 'ids are unique')
  assert.deepEqual(feedEvents({ id: 's1' }, '', new Date()), [])
})

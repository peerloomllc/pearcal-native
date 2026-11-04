// TODO #189: personal calendars and per-device visibility (src/lib/calendars.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const c = require('../src/lib/calendars.js')

const personal = (extra = {}) => ({ id: 'e1', date: '2026-11-04', groups: [], color: '#111', ...extra })

test('events without calendarId belong to the default calendar', () => {
  assert.equal(c.personalCalendarId(personal()), 'default')
  assert.deepEqual(c.visibilityKeys(personal()), ['personal:default'])
  assert.deepEqual(c.visibilityKeys(personal({ calendarId: 'health' })), ['personal:health'])
})

test('group events answer to their groups and ignore calendarId', () => {
  const ev = personal({ groups: ['g1', 'g2'], calendarId: 'health' })
  assert.deepEqual(c.visibilityKeys(ev), ['group:g1', 'group:g2'])
  assert.equal(c.isEventVisible(ev, new Set(['group:g1'])), true)
  assert.equal(c.isEventVisible(ev, new Set(['group:g1', 'group:g2'])), false)
  assert.equal(c.isEventVisible(ev, new Set(['personal:health'])), true)
})

test('hidden personal calendar hides its events only', () => {
  const hidden = new Set(['personal:health'])
  assert.equal(c.isEventVisible(personal({ calendarId: 'health' }), hidden), false)
  assert.equal(c.isEventVisible(personal(), hidden), true)
  assert.equal(c.isEventVisible(personal({ calendarId: 'health' }), new Set()), true)
})

test('holiday events use the keys the UI resolves for them', () => {
  const holidayKeysFor = ev => ev.id.startsWith('holiday-') ? ['holiday:FR', 'holiday:BE'] : []
  const ev = personal({ id: 'holiday-2026-07-14-x' })
  assert.equal(c.isEventVisible(ev, new Set(['holiday:FR']), { holidayKeysFor }), true)
  assert.equal(c.isEventVisible(ev, new Set(['holiday:FR', 'holiday:BE']), { holidayKeysFor }), false)
  // Hiding the default calendar does not hide holidays.
  assert.equal(c.isEventVisible(ev, new Set(['personal:default']), { holidayKeysFor }), true)
})

test('widget filter honours hidden keys and hidden holiday ids', () => {
  const v = c.normalizeVisibility({ hidden: ['personal:health', 'group:g1'], hiddenEventIds: ['holiday-a'] })
  assert.equal(c.widgetEventVisible(personal({ calendarId: 'health' }), v), false)
  assert.equal(c.widgetEventVisible(personal({ groups: ['g1'] }), v), false)
  assert.equal(c.widgetEventVisible(personal({ groups: ['g1', 'g2'] }), v), true)
  assert.equal(c.widgetEventVisible(personal({ id: 'holiday-a' }), v), false)
  assert.equal(c.widgetEventVisible(personal(), v), true)
  assert.equal(c.widgetEventVisible(personal(), null), true)
})

test('normalizeVisibility drops junk and duplicates', () => {
  assert.deepEqual(c.normalizeVisibility(null), { hidden: [], hiddenEventIds: [] })
  assert.deepEqual(c.normalizeVisibility({ hidden: ['a', 'a', 3] }), { hidden: ['a'], hiddenEventIds: [] })
})

test('makeCalendarRecord validates and always moves updatedAt forward', () => {
  assert.throws(() => c.makeCalendarRecord({ id: '' }))
  assert.throws(() => c.makeCalendarRecord({ id: 'a:b', name: 'x' }))
  assert.throws(() => c.makeCalendarRecord({ id: 'x', name: '  ' }))
  assert.throws(() => c.makeCalendarRecord({ id: 'default', deleted: true }))
  const a = c.makeCalendarRecord({ id: 'h', name: '  Health \n ', color: '#f00' }, null, 1000)
  assert.deepEqual(a, { id: 'h', name: 'Health', color: '#f00', createdAt: 1000, updatedAt: 1000 })
  // A clock that went backwards still produces a newer version.
  const b = c.makeCalendarRecord({ id: 'h', name: 'Body' }, a, 500)
  assert.equal(b.updatedAt, 1001)
  assert.equal(b.createdAt, 1000)
  assert.equal(b.color, '#f00')
  const d = c.makeCalendarRecord({ id: 'h', deleted: true }, b, 2000)
  assert.equal(d.deleted, true)
  assert.equal(d.name, 'Body')
})

test('newerCalendar is last-write-wins', () => {
  const old = { id: 'h', updatedAt: 1 }
  const nu = { id: 'h', updatedAt: 2 }
  assert.equal(c.newerCalendar(old, nu), nu)
  assert.equal(c.newerCalendar(nu, old), nu)
  assert.equal(c.newerCalendar(null, old), old)
  assert.equal(c.newerCalendar(old, null), old)
})

test('listCalendars puts the default first and drops deleted rows', () => {
  const list = c.listCalendars([
    { id: 'b', name: 'B', createdAt: 20, updatedAt: 20 },
    { id: 'a', name: 'A', createdAt: 10, updatedAt: 10 },
    { id: 'gone', name: 'Gone', createdAt: 5, updatedAt: 9, deleted: true },
  ])
  assert.deepEqual(list.map(x => x.id), ['default', 'a', 'b'])
  assert.equal(list[0].name, 'Personal')
  assert.equal(list[0].isDefault, true)
  const renamed = c.listCalendars([{ id: 'default', name: 'Main', color: '#0f0', createdAt: 1, updatedAt: 3 }])
  assert.equal(renamed[0].name, 'Main')
  assert.equal(renamed[0].color, '#0f0')
})

test('eventDisplayColor: calendar color unless the event has its own', () => {
  const cals = new Map([['health', { id: 'health', color: '#0a0' }], ['default', { id: 'default', color: null }]])
  assert.equal(c.eventDisplayColor(personal({ calendarId: 'health' }), cals), '#0a0')
  assert.equal(c.eventDisplayColor(personal({ calendarId: 'health', colorCustom: true }), cals), '#111')
  assert.equal(c.eventDisplayColor(personal(), cals), '#111') // legacy, no calendarId
  assert.equal(c.eventDisplayColor(personal({ calendarId: 'default' }), cals), '#111') // no calendar color
  assert.equal(c.eventDisplayColor(personal({ calendarId: 'health', groups: ['g'] }), cals), '#111')
})

test('stripPersonalFields removes calendar metadata for groups', () => {
  const ev = personal({ calendarId: 'health', colorCustom: true, title: 'x' })
  const out = c.stripPersonalFields(ev)
  assert.equal('calendarId' in out, false)
  assert.equal('colorCustom' in out, false)
  assert.equal(out.title, 'x')
  const plain = personal()
  assert.equal(c.stripPersonalFields(plain), plain)
})

test('planCalendarDelete moves or removes only that calendar\'s personal events', () => {
  const events = [
    personal({ id: '1', calendarId: 'health' }),
    personal({ id: '2', calendarId: 'health', groups: ['g'] }),
    personal({ id: '3' }),
    personal({ id: '4', calendarId: 'work' }),
  ]
  const moved = c.planCalendarDelete(events, 'health', 'default')
  assert.deepEqual(moved.move.map(e => [e.id, e.calendarId]), [['1', 'default']])
  assert.deepEqual(moved.remove, [])
  const removed = c.planCalendarDelete(events, 'health', null)
  assert.deepEqual(removed.remove.map(e => e.id), ['1'])
  assert.throws(() => c.planCalendarDelete(events, 'default', null))
})

test('newCalendarId has no colon', () => {
  assert.equal(c.newCalendarId().includes(':'), false)
  assert.notEqual(c.newCalendarId(), c.newCalendarId())
})

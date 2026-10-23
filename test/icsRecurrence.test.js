// Repeat rules through .ics import and export (#184, GitHub issue #367).
// Import maps an RRULE onto PearCal's recurrence fields; export collapses a
// stored series back into one VEVENT with an RRULE.
const test = require('node:test')
const assert = require('node:assert')

let parseIcs, generateIcs, expandRecurring, planForeverExtensions
test.before(async () => {
  const ics = await import('../src/ui-shared/lib/ics.js')
  const rec = await import('../src/ui-shared/lib/recurring.js')
  parseIcs = ics.parseIcs
  generateIcs = ics.generateIcs
  expandRecurring = rec.expandRecurring
  planForeverExtensions = rec.planForeverExtensions
})

const TODAY = new Date(2026, 9, 23)

function file (...lines) {
  return ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
}

function one (...lines) {
  const evs = parseIcs(file(...lines), TODAY)
  assert.strictEqual(evs.length, 1)
  return evs[0]
}

// What saveEvent would store for a freshly imported event.
function stored (ev, id = 'imp1') {
  return expandRecurring({ ...ev, id, recurrenceId: '', groups: [] })
}

test('Yandex yearly with BYMONTH/BYMONTHDAY restating DTSTART repeats forever', () => {
  const ev = one('DTSTART;VALUE=DATE:20260607', 'RRULE:FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=7;INTERVAL=1', 'SUMMARY:Birthday')
  assert.strictEqual(ev.recurrence, 'yearly')
  assert.strictEqual(ev.repeatForever, true)
  assert.strictEqual(ev.date, '2026-06-07')
})

test('a forever yearly series keeps adding later years', () => {
  const ev = one('DTSTART;VALUE=DATE:20260607', 'RRULE:FREQ=YEARLY', 'SUMMARY:Birthday')
  let all = stored(ev)
  // Run the top-up the way the apps do, five years on.
  for (let y = 2027; y <= 2031; y++) all = all.concat(planForeverExtensions(all, new Date(y, 4, 1)))
  const years = all.map(o => o.date.slice(0, 4))
  assert.deepStrictEqual(years, ['2026', '2027', '2028', '2029', '2030', '2031', '2032'])
})

test('a forever series from years back starts this year', () => {
  const ev = one('DTSTART;VALUE=DATE:19900315', 'RRULE:FREQ=YEARLY', 'SUMMARY:Mum')
  assert.strictEqual(ev.date, '2026-03-15')
  assert.strictEqual(ev.repeatForever, true)
})

test('UNTIL stops the series on that date', () => {
  const ev = one('DTSTART;VALUE=DATE:20260607', 'RRULE:FREQ=YEARLY;UNTIL=20301231', 'SUMMARY:Birthday')
  assert.strictEqual(ev.recurrenceEnd, '2030-12-31')
  assert.strictEqual(ev.repeatForever, false)
  assert.deepStrictEqual(stored(ev).map(o => o.date), ['2026-06-07', '2027-06-07', '2028-06-07', '2029-06-07', '2030-06-07'])
})

test('COUNT becomes the date of the last occurrence', () => {
  const ev = one('DTSTART:20261105T090000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Class')
  assert.strictEqual(ev.recurrence, 'weekly')
  assert.strictEqual(ev.recurrenceEnd, '2026-11-19')
  assert.strictEqual(stored(ev).length, 3)
})

test('frequency mapping', () => {
  const r = (rule, dtstart = '20261105') => one('DTSTART;VALUE=DATE:' + dtstart, 'RRULE:' + rule, 'SUMMARY:x')
  assert.strictEqual(r('FREQ=DAILY;INTERVAL=3').recurrence, 'daily')
  assert.strictEqual(r('FREQ=DAILY;INTERVAL=3').recurrenceInterval, 3)
  assert.strictEqual(r('FREQ=WEEKLY;BYDAY=TH').recurrence, 'weekly')
  assert.strictEqual(r('FREQ=WEEKLY;INTERVAL=2').recurrence, 'biweekly')
  assert.strictEqual(r('FREQ=WEEKLY;INTERVAL=3').recurrenceInterval, 3)
  assert.strictEqual(r('FREQ=MONTHLY;BYMONTHDAY=5').recurrence, 'monthly')
  // 5 Nov 2026 is the first Thursday.
  const nth = r('FREQ=MONTHLY;BYDAY=1TH')
  assert.strictEqual(nth.recurrence, 'monthly-nth')
  assert.strictEqual(nth.recurrenceNth, 1)
  assert.strictEqual(nth.recurrenceWeekday, 4)
})

test('rules PearCal cannot represent import as a one-off', () => {
  const none = rule => one('DTSTART;VALUE=DATE:20261105', 'RRULE:' + rule, 'SUMMARY:x').recurrence
  assert.strictEqual(none('FREQ=WEEKLY;BYDAY=MO,WE'), undefined)
  assert.strictEqual(none('FREQ=MONTHLY;BYDAY=-1TH'), undefined)
  assert.strictEqual(none('FREQ=MONTHLY;BYDAY=1MO;BYSETPOS=1'), undefined)
  assert.strictEqual(none('FREQ=HOURLY'), undefined)
  assert.strictEqual(none('FREQ=YEARLY;BYMONTH=7'), undefined)
})

test('a VEVENT with no RRULE stays a one-off', () => {
  const ev = one('DTSTART;VALUE=DATE:20261105', 'SUMMARY:Dentist')
  assert.strictEqual(ev.recurrence, undefined)
  assert.strictEqual(stored(ev).length, 1)
})

test('export writes a series as one VEVENT with an RRULE, and it round-trips', () => {
  const series = expandRecurring({ id: 'abc', title: 'Birthday', date: '2026-06-07', allDay: true,
    recurrence: 'yearly', recurrenceEnd: '2030-12-31', groups: ['g1'] })
  const out = generateIcs(series)
  assert.strictEqual(out.match(/BEGIN:VEVENT/g).length, 1)
  assert.match(out, /UID:abc@pearcal/)
  assert.match(out, /RRULE:FREQ=YEARLY;UNTIL=20301231\r\n/)
  assert.match(out, /X-PEARCAL-GROUPS:g1/)

  const back = parseIcs(out, TODAY)
  assert.strictEqual(back.length, 1)
  assert.strictEqual(back[0].recurrence, 'yearly')
  assert.strictEqual(back[0].recurrenceEnd, '2030-12-31')
  assert.deepStrictEqual(stored(back[0]).map(o => o.date), series.map(o => o.date))
})

test('a forever series exports without UNTIL', () => {
  let all = expandRecurring({ id: 'f', title: 'Bin day', date: '2026-01-06', allDay: false, start: '07:00',
    recurrence: 'weekly', recurrenceInterval: 2, repeatForever: true })
  all = all.concat(planForeverExtensions(all, new Date(2026, 11, 1)))
  const out = generateIcs(all)
  assert.strictEqual(out.match(/BEGIN:VEVENT/g).length, 1)
  assert.match(out, /RRULE:FREQ=WEEKLY;INTERVAL=2\r\n/)
  const back = parseIcs(out, TODAY)[0]
  // Every 2 weeks comes back as the matching preset, same dates.
  assert.strictEqual(back.recurrence, 'biweekly')
  assert.strictEqual(back.repeatForever, true)
})

test('a timed series writes UNTIL as a local date-time', () => {
  const series = expandRecurring({ id: 't', title: 'Standup', date: '2026-11-02', allDay: false,
    start: '09:00', end: '09:15', recurrence: 'daily', recurrenceEnd: '2026-11-06' })
  assert.match(generateIcs(series), /RRULE:FREQ=DAILY;UNTIL=20261106T235959\r\n/)
})

test('monthly-nth exports BYDAY with its ordinal', () => {
  const series = expandRecurring({ id: 'm', title: 'Club', date: '2026-11-09', allDay: true,
    recurrence: 'monthly-nth', recurrenceNth: 2, recurrenceWeekday: 1, recurrenceEnd: '2027-03-31' })
  const out = generateIcs(series)
  assert.match(out, /RRULE:FREQ=MONTHLY;BYDAY=2MO;UNTIL=20270331\r\n/)
  assert.deepStrictEqual(stored(parseIcs(out, TODAY)[0]).map(o => o.date), series.map(o => o.date))
})

test('a series with one occurrence edited apart exports one VEVENT per occurrence', () => {
  const series = expandRecurring({ id: 's', title: 'Gym', date: '2026-11-02', allDay: true,
    recurrence: 'weekly', recurrenceEnd: '2026-11-23' })
  series[2] = { ...series[2], title: 'Gym (moved hall)' }
  const out = generateIcs(series)
  assert.strictEqual(out.match(/BEGIN:VEVENT/g).length, 4)
  assert.doesNotMatch(out, /RRULE/)
})

test('a series with one occurrence deleted exports one VEVENT per occurrence', () => {
  const series = expandRecurring({ id: 's', title: 'Gym', date: '2026-11-02', allDay: true,
    recurrence: 'weekly', recurrenceEnd: '2026-11-23' })
  series.splice(1, 1)
  const out = generateIcs(series)
  assert.strictEqual(out.match(/BEGIN:VEVENT/g).length, 3)
  assert.doesNotMatch(out, /RRULE/)
})

test('a birthday series exports without the age in its title', () => {
  const series = expandRecurring({ id: 'b', title: 'Ana turns 34', date: '2026-04-02', allDay: true,
    recurrence: 'yearly', repeatForever: true, birthday: { name: 'Ana', month: 4, day: 2, year: 1992 } })
  const out = generateIcs(series)
  assert.strictEqual(out.match(/BEGIN:VEVENT/g).length, 1)
  assert.match(out, /SUMMARY:Ana's birthday/)
})

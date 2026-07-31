// Canada / UK Boxing Day was landing on 25 Dec 2026, on top of Christmas Day.
// Cause: the shared `observed()` applied the US Sat->Fri rule, so Sat 26 Dec
// moved BACKWARDS onto the 25th. Canada and the UK substitute forwards instead.
// Two neighbours came out of the same code: hand-built date strings underflowed
// to '2022-01-00' when a holiday on the 1st shifted back, and nothing stopped
// two holidays claiming one date.
// (bugfix/holiday-observed-dates)
const test = require('node:test')
const assert = require('node:assert/strict')

const load = import('../src/ui-shared/lib/holidays.js')

const YEARS = [2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032]
const dateOf = (list, title) => list.find(h => h.title === title)?.date
// 'YYYY-MM-DD' -> local Date, without the UTC shift `new Date(str)` applies.
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
const isWeekend = s => [0, 6].includes(parse(s).getDay())

// ── the reported bug ──────────────────────────────────────────────────────
test('Boxing Day 2026 substitutes forward to Mon 28 Dec, not back onto Christmas', async () => {
  const { getCanadaHolidays, getUKHolidays } = await load
  for (const fn of [getCanadaHolidays, getUKHolidays]) {
    const hs = fn(2026)
    assert.equal(dateOf(hs, 'Christmas Day'), '2026-12-25')  // Fri, stays put
    assert.equal(dateOf(hs, 'Boxing Day'), '2026-12-28')     // Sat 26 -> Mon 28
  }
})

// ── the substitute rule in general ────────────────────────────────────────
test('Canada and UK holidays never land on a weekend', async () => {
  const { getCanadaHolidays, getUKHolidays } = await load
  for (const year of YEARS) {
    for (const fn of [getCanadaHolidays, getUKHolidays]) {
      for (const h of fn(year)) {
        assert.ok(!isWeekend(h.date), `${h.title} ${year} fell on a weekend: ${h.date}`)
      }
    }
  }
})

test('no two holidays in one calendar share a date', async () => {
  const { getCanadaHolidays, getUKHolidays, getUSFederalHolidays } = await load
  for (const year of YEARS) {
    for (const fn of [getCanadaHolidays, getUKHolidays, getUSFederalHolidays]) {
      const dates = fn(year).map(h => h.date)
      assert.equal(new Set(dates).size, dates.length, `duplicate date in ${year}: ${dates}`)
    }
  }
})

test('a weekday holiday keeps its date and the weekend one steps over it', async () => {
  const { getUKHolidays } = await load
  // gov.uk 2022: Boxing Day Mon 26 Dec, Christmas Day substitute Tue 27 Dec.
  // Christmas is listed first, so this only holds if weekday dates are reserved
  // before any substitute is placed.
  const hs = getUKHolidays(2022)
  assert.equal(dateOf(hs, 'Boxing Day'), '2022-12-26')
  assert.equal(dateOf(hs, 'Christmas Day'), '2022-12-27')
})

test('substitutes match the published Canadian federal dates', async () => {
  const { getCanadaHolidays } = await load
  const y2023 = getCanadaHolidays(2023)
  assert.equal(dateOf(y2023, 'Canada Day'), '2023-07-03')          // Sat 1 -> Mon 3
  assert.equal(dateOf(y2023, 'Remembrance Day'), '2023-11-13')     // Sat 11 -> Mon 13
  const y2027 = getCanadaHolidays(2027)
  assert.equal(dateOf(y2027, 'Christmas Day'), '2027-12-27')       // Sat 25 -> Mon 27
  assert.equal(dateOf(y2027, 'Boxing Day'), '2027-12-28')          // Sun 26 -> Tue 28
})

// ── date arithmetic ───────────────────────────────────────────────────────
test('every holiday date is a real calendar date', async () => {
  const { getCanadaHolidays, getUKHolidays, getUSFederalHolidays, getBitcoinHolidays } = await load
  for (const year of YEARS) {
    for (const fn of [getCanadaHolidays, getUKHolidays, getUSFederalHolidays, getBitcoinHolidays]) {
      for (const h of fn(year)) {
        assert.match(h.date, /^\d{4}-\d{2}-\d{2}$/, `${h.title} ${year}: ${h.date}`)
        // Round-tripping catches '2022-01-00', which matches the shape above.
        const d = parse(h.date)
        const back = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        assert.equal(back, h.date, `${h.title} ${year} is not a real date`)
      }
    }
  }
})

test('US federal keeps its own backwards Sat->Fri rule, across the year boundary', async () => {
  const { getUSFederalHolidays } = await load
  // Sat 1 Jan 2022 was observed Fri 31 Dec 2021, per OPM.
  assert.equal(dateOf(getUSFederalHolidays(2022), "New Year's Day"), '2021-12-31')
  assert.equal(dateOf(getUSFederalHolidays(2028), "New Year's Day"), '2027-12-31')
  // Sun 25 Dec 2022 -> Mon 26 Dec.
  assert.equal(dateOf(getUSFederalHolidays(2022), 'Christmas Day'), '2022-12-26')
})

// ── cleaning up events stranded by a corrected date ───────────────────────
const sysEvent = (id, date) => ({ id, date, creatorId: 'system', title: 'x' })

test('strayHolidayEvents finds an event left at the old wrong date', async () => {
  const { strayHolidayEvents, getCanadaHolidays, holidayCalendarIds } = await load
  const years = [2026, 2027]
  const stranded = sysEvent('holiday-2026-12-25-boxing-day', '2026-12-25')
  const correct = sysEvent('holiday-2026-12-28-boxing-day', '2026-12-28')
  const keep = holidayCalendarIds(getCanadaHolidays, years)
  const stray = strayHolidayEvents([stranded, correct], getCanadaHolidays, years, keep)
  assert.deepEqual(stray.map(e => e.id), [stranded.id])
})

test('strayHolidayEvents leaves user events and other calendars alone', async () => {
  const { strayHolidayEvents, getCanadaHolidays, getUSFederalHolidays, holidayCalendarIds } = await load
  const years = [2026, 2027]
  const mine = { id: 'evt-1', date: '2026-12-25', creatorId: 'me', title: 'Boxing Day' }
  const usKept = sysEvent('holiday-2026-12-25-christmas-day', '2026-12-25')
  const outOfWindow = sysEvent('holiday-2024-12-25-boxing-day', '2024-12-25')
  const keep = holidayCalendarIds(getUSFederalHolidays, years)
  const stray = strayHolidayEvents([mine, usKept, outOfWindow], getCanadaHolidays, years, keep)
  assert.deepEqual(stray, [])
})

// ── launch-time repair of dates an older build got wrong (#150) ───────────
const YEARS_26 = [2026, 2027]
// What a pre-fix build stored for Canada: Boxing Day pulled back onto the 25th.
const WRONG_BOXING = { ...sysEvent('holiday-2026-12-25-boxing-day', '2026-12-25'), title: 'Boxing Day', reminder: 60 }
const RIGHT_XMAS = { ...sysEvent('holiday-2026-12-25-christmas-day', '2026-12-25'), title: 'Christmas Day' }

test('planHolidayRepair moves a holiday off the date an older build got wrong', async () => {
  const { planHolidayRepair } = await load
  const { deletes, puts } = planHolidayRepair([WRONG_BOXING, RIGHT_XMAS], ['ca'], YEARS_26, 123)
  assert.deepEqual(deletes.map(e => e.id), ['holiday-2026-12-25-boxing-day'])
  assert.equal(puts.length, 1)
  assert.equal(puts[0].id, 'holiday-2026-12-28-boxing-day')
  assert.equal(puts[0].date, '2026-12-28')
  assert.equal(puts[0].title, 'Boxing Day')
  assert.equal(puts[0].updatedAt, 123)
})

test('the moved event keeps the fields the user set on it', async () => {
  const { planHolidayRepair } = await load
  const { puts } = planHolidayRepair([WRONG_BOXING], ['ca'], YEARS_26, 0)
  assert.equal(puts[0].reminder, 60)
})

test('re-running the repair is a no-op once the dates line up', async () => {
  const { planHolidayRepair, getCanadaHolidays } = await load
  const stored = [2026, 2027].flatMap(y => getCanadaHolidays(y).map(h => ({
    id: 'holiday-' + h.date + '-' + h.title.replace(/\s+/g, '-').toLowerCase(),
    date: h.date, title: h.title, creatorId: 'system',
  })))
  const plan = planHolidayRepair(stored, ['ca'], YEARS_26, 0)
  assert.deepEqual(plan, { deletes: [], puts: [] })
})

test('the repair never resurrects a holiday the user deleted on purpose', async () => {
  const { planHolidayRepair, getCanadaHolidays } = await load
  // Everything correct except Canada Day, which the user removed by hand.
  const stored = [2026, 2027].flatMap(y => getCanadaHolidays(y)
    .filter(h => h.title !== 'Canada Day')
    .map(h => ({
      id: 'holiday-' + h.date + '-' + h.title.replace(/\s+/g, '-').toLowerCase(),
      date: h.date, title: h.title, creatorId: 'system',
    })))
  const plan = planHolidayRepair(stored, ['ca'], YEARS_26, 0)
  assert.deepEqual(plan, { deletes: [], puts: [] })
})

test('the repair drops the stray without duplicating an already-corrected date', async () => {
  const { planHolidayRepair } = await load
  const corrected = sysEvent('holiday-2026-12-28-boxing-day', '2026-12-28')
  const { deletes, puts } = planHolidayRepair([WRONG_BOXING, corrected], ['ca'], YEARS_26, 0)
  assert.deepEqual(deletes.map(e => e.id), ['holiday-2026-12-25-boxing-day'])
  assert.deepEqual(puts, [])
})

test('a shared holiday is moved once when two calendars are both active', async () => {
  const { planHolidayRepair } = await load
  // Canada and the UK both call it Boxing Day and both now put it on the 28th.
  const { deletes, puts } = planHolidayRepair([WRONG_BOXING], ['ca', 'uk'], YEARS_26, 0)
  assert.equal(deletes.length, 1)
  assert.equal(puts.length, 1)
})

test('the repair ignores calendars the user has not subscribed to', async () => {
  const { planHolidayRepair } = await load
  assert.deepEqual(planHolidayRepair([WRONG_BOXING], ['us'], YEARS_26, 0), { deletes: [], puts: [] })
  assert.deepEqual(planHolidayRepair([WRONG_BOXING], [], YEARS_26, 0), { deletes: [], puts: [] })
})

test('the repair leaves user-created events alone', async () => {
  const { planHolidayRepair } = await load
  const mine = { id: 'evt-1', date: '2026-12-25', creatorId: 'me', title: 'Boxing Day' }
  assert.deepEqual(planHolidayRepair([mine], ['ca'], YEARS_26, 0), { deletes: [], puts: [] })
})

test('the repair handles a US date corrected across the year boundary', async () => {
  const { planHolidayRepair } = await load
  // A pre-fix build wrote the impossible '2022-01-00'; the observed date is
  // 31 Dec 2021, so the replacement is filed under the prior year.
  const broken = { ...sysEvent("holiday-2022-01-00-new-year's-day", '2022-01-00'), title: "New Year's Day" }
  const { deletes, puts } = planHolidayRepair([broken], ['us'], [2022, 2023], 0)
  assert.deepEqual(deletes.map(e => e.id), ["holiday-2022-01-00-new-year's-day"])
  assert.equal(puts[0].date, '2021-12-31')
})

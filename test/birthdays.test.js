const test = require('node:test')
const assert = require('node:assert')

test('titles carry the age for each year when the birth year is known', async () => {
  const { birthdayTitle } = await import('../src/ui-shared/lib/birthdays.js')
  assert.strictEqual(birthdayTitle({ name: 'Ana', year: 1992 }, '2026-05-01'), 'Ana turns 34')
  assert.strictEqual(birthdayTitle({ name: 'Ana', year: null }, '2026-05-01'), "Ana's birthday")
  assert.strictEqual(birthdayTitle({ name: 'Baby', year: 2026 }, '2026-05-01'), "Baby's birthday", 'no "turns 0"')
})

test('a new birthday repeats yearly with no end, and each stored year has its own age', async () => {
  const { birthdayEvent } = await import('../src/ui-shared/lib/birthdays.js')
  const { expandRecurring } = await import('../src/ui-shared/lib/recurring.js')
  const ev = birthdayEvent({ name: 'Ana', month: 5, day: 1, year: 1992 }, new Date(2026, 9, 22))
  assert.strictEqual(ev.date, '2026-05-01')
  assert.strictEqual(ev.recurrence, 'yearly')
  assert.strictEqual(ev.repeatForever, true)
  assert.strictEqual(ev.allDay, true)
  assert.deepStrictEqual(ev.groups, [])
  const occ = expandRecurring(ev)
  assert.deepStrictEqual(occ.map(o => o.title), ['Ana turns 34', 'Ana turns 35'])
  assert.deepStrictEqual(occ.map(o => o.date), ['2026-05-01', '2027-05-01'])
})

test('29 February starts in the last leap year', async () => {
  const { birthdayEvent, parseBirthday } = await import('../src/ui-shared/lib/birthdays.js')
  assert.strictEqual(birthdayEvent({ name: 'Leo', month: 2, day: 29, year: null }, new Date(2026, 0, 1)).date, '2024-02-29')
  assert.match(parseBirthday({ name: 'Leo', month: 2, day: 29, year: 2001 }).error, /no 29 February/)
  assert.ok(parseBirthday({ name: 'Leo', month: 2, day: 29, year: 2000 }).birthday)
})

test('typed input is checked', async () => {
  const { parseBirthday } = await import('../src/ui-shared/lib/birthdays.js')
  const today = new Date(2026, 9, 22)
  assert.deepStrictEqual(parseBirthday({ name: ' Ana ', month: '5', day: '1', year: '' }, today), { birthday: { name: 'Ana', month: 5, day: 1, year: null } })
  assert.ok(parseBirthday({ name: '', month: 5, day: 1 }, today).error)
  assert.ok(parseBirthday({ name: 'A', month: 4, day: 31 }, today).error)
  assert.ok(parseBirthday({ name: 'A', month: 4, day: 3, year: 2030 }, today).error)
})

test('the list has one entry per birthday, soonest first', async () => {
  const { birthdayEvent, listBirthdays } = await import('../src/ui-shared/lib/birthdays.js')
  const { expandRecurring } = await import('../src/ui-shared/lib/recurring.js')
  const today = new Date(2026, 9, 22)
  const ana = expandRecurring(birthdayEvent({ name: 'Ana', month: 5, day: 1, year: 1992 }, today))
  const ben = expandRecurring(birthdayEvent({ name: 'Ben', month: 12, day: 3, year: null }, today))
  const list = listBirthdays([...ana, ...ben, { id: 'x', date: '2026-11-01', title: 'Not a birthday' }], today)
  assert.deepStrictEqual(list.map(b => [b.birthday.name, b.next, b.title]), [["Ben", '2026-12-03', "Ben's birthday"], ['Ana', '2027-05-01', 'Ana turns 35']])
})

test('a forever series near its end gets another year, birthdays with their ages (#183)', async () => {
  const { birthdayEvent } = await import('../src/ui-shared/lib/birthdays.js')
  const { expandRecurring, planForeverExtensions } = await import('../src/ui-shared/lib/recurring.js')
  const rows = expandRecurring(birthdayEvent({ name: 'Ana', month: 5, day: 1, year: 1992 }, new Date(2026, 9, 22)))
  // A year on, the last row (2027-05-01) is within 90 days.
  const add = planForeverExtensions(rows, new Date(2027, 2, 15))
  assert.deepStrictEqual(add.map(o => [o.id.replace(/^bday-[a-z0-9]+/, 'bday'), o.date, o.title]), [['bday_r2', '2028-05-01', 'Ana turns 36']])
  assert.deepStrictEqual(planForeverExtensions(rows, new Date(2026, 9, 22)), [], 'not yet near the end')
  assert.deepStrictEqual(planForeverExtensions([...rows, ...add], new Date(2027, 2, 15)), [], 'nothing twice')
})

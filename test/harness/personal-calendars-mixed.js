// TODO #189 compat: a linked device on an older release next to one on this
// code. The older one must ignore personal-calendar ops, keep syncing events,
// and leave an event's calendarId alone when it re-saves the event.
//
//   OLD_BARE=/path/to/v1.0.54/src/bare.js node test/harness/personal-calendars-mixed.js

const { createEngines } = require('./engines.js')

async function main () {
  const oldBare = process.env.OLD_BARE
  if (!oldBare) { console.error('set OLD_BARE to an older src/bare.js'); process.exit(2) }
  const E = await createEngines({ prefix: 'pcal-mixed' })
  const { peers, launch, check, until, finish } = E
  try {
    await launch('OLD', { PEARCAL_E2E_BARE: oldBare })
    await launch('NEW')
    const OLD = peers.OLD
    const NEW = peers.NEW
    await OLD.call('updateProfile', { name: 'Old', onboardingComplete: true })
    await OLD.call('enablePersonalSync')
    const snap = await OLD.call('startPairing')
    await NEW.call('consumePairLink', snap.url)
    const paired = await until(async () => {
      const l = await NEW.call('listLinkedDevices').catch(() => null)
      return Array.isArray(l) && l.length >= 2
    }, 120000)
    check('old and new devices pair', !!paired)
    // Anything written before the new device's personal base turns writable is
    // never sent (true for events too), so wait for it.
    const writable = await until(async () => (await NEW.call('getPersonalSyncStatus'))?.writable, 120000)
    check('new device can write to the personal base', !!writable)

    const cal = await NEW.call('putPersonalCalendar', { name: 'Health', color: '#5DBF8A' })
    const ev = {
      id: 'mixed-ev-1', title: 'Physio', date: '2026-11-21', allDay: true, start: '', end: '',
      groups: [], invitees: [], color: '#5DBF8A', calendarId: cal.id, creatorId: 'x', recurrence: 'none',
    }
    await NEW.call('putEvent', ev)
    const onOld = await until(async () => (await OLD.call('listEvents')).find(e => e.id === ev.id), 60000)
    check('old device still receives the event', !!onOld)
    check('old device keeps calendarId on the event', onOld?.calendarId === cal.id, onOld?.calendarId)

    await OLD.call('ping')
    check('old device survives a personalCalendar op', true)

    // The mobile editor re-saves the stored object with its edits spread on top.
    await OLD.call('putEvent', { ...onOld, title: 'Physio (moved)' })
    const back = await until(async () => (await NEW.call('listEvents')).find(e => e.id === ev.id && e.title === 'Physio (moved)'), 60000)
    check('edit from the old device reaches the new one', !!back)
    check('calendarId survives the old device\'s edit', back?.calendarId === cal.id, back?.calendarId)

    const cals = await NEW.call('listPersonalCalendars')
    check('new device still has its calendar', cals.some(c => c.id === cal.id))
  } catch (e) {
    check('harness ran without throwing', false, e.message)
  }
  await finish()
}

main()

// TODO #189: personal calendars sync between linked devices.
//
// Two real engines (src/bare.js) on a private DHT. A makes a calendar BEFORE
// pairing (so it must arrive through consolidation), pairs B, then both sides
// create, rename and delete calendars and file an event in one.
//
//   node test/harness/personal-calendars-e2e.js
//
// PEARCAL_E2E_ENGINE=desktop runs the desktop's vendored copy instead.

const { createEngines } = require('./engines.js')

async function main () {
  const E = await createEngines({ prefix: 'pcal' })
  const { peers, launch, check, until, finish } = E
  try {
    await launch('A')
    await launch('B')
    const A = peers.A
    const B = peers.B

    await A.call('updateProfile', { name: 'Tim A', onboardingComplete: true })
    const early = await A.call('putPersonalCalendar', { name: 'Health', color: '#5DBF8A' })
    check('A creates a calendar before pairing', !!early?.id, early?.id)

    await A.call('enablePersonalSync')
    const snap = await A.call('startPairing')
    check('A starts pairing', !!snap?.url)
    await B.call('consumePairLink', snap.url)
    const paired = await until(async () => {
      const list = await B.call('listLinkedDevices').catch(() => null)
      return Array.isArray(list) && list.length >= 2 ? list : null
    }, 120000)
    check('B paired with A', !!paired)
    const writable = await until(async () => (await B.call('getPersonalSyncStatus'))?.writable, 120000)
    check('B can write to the personal base', !!writable)

    const hasCal = (rows, pred) => Array.isArray(rows) && rows.some(pred)

    const gotEarly = await until(async () => {
      const rows = await B.call('listPersonalCalendars')
      return hasCal(rows, c => c.id === early.id && c.name === 'Health') ? rows : null
    }, 120000)
    check('calendar made before pairing reaches B', !!gotEarly)

    const work = await A.call('putPersonalCalendar', { name: 'Work', color: '#E5864A' })
    const gotWork = await until(async () => hasCal(await B.call('listPersonalCalendars'), c => c.id === work.id), 60000)
    check('calendar made after pairing reaches B', !!gotWork)

    await B.call('putPersonalCalendar', { id: work.id, name: 'Day job', color: '#E5864A' })
    const renamed = await until(async () => hasCal(await A.call('listPersonalCalendars'), c => c.id === work.id && c.name === 'Day job'), 60000)
    check('rename on B reaches A', !!renamed)

    const ev = {
      id: 'pcal-ev-1', title: 'Dentist', date: '2026-11-20', allDay: true, start: '', end: '',
      groups: [], invitees: [], color: '#5DBF8A', calendarId: early.id, creatorId: 'x', recurrence: 'none',
    }
    await A.call('putEvent', ev)
    const gotEv = await until(async () => {
      const list = await B.call('listEvents')
      return (list ?? []).find(e => e.id === ev.id && e.calendarId === early.id)
    }, 60000)
    check('event keeps its calendar on B', !!gotEv)

    await A.call('deletePersonalCalendar', work.id)
    const gone = await until(async () => {
      const rows = await B.call('listPersonalCalendars')
      return Array.isArray(rows) && !rows.some(c => c.id === work.id) ? true : null
    }, 60000)
    check('delete on A reaches B', !!gone)

    // A stale rename from before the delete must not bring it back.
    const vis = await B.call('setCalendarVisibility', { hidden: ['personal:' + early.id] })
    check('visibility saved on B', vis?.hidden?.includes('personal:' + early.id))
    await new Promise(r => setTimeout(r, 5000))
    const visA = await A.call('getCalendarVisibility')
    check('visibility stays on B only', !(visA?.hidden ?? []).length, JSON.stringify(visA))

    // Phase 2: the subscription list syncs, the downloaded feed does not.
    const sub = await A.call('putSubscription', { url: 'webcal://example.org/fr.ics', name: 'France', color: '#4BBDCC' })
    check('A adds a web calendar', sub?.url === 'https://example.org/fr.ics', sub?.url)
    await A.call('putSubscriptionFeed', sub.id, { url: sub.url, text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' })
    const subOnB = await until(async () => (await B.call('listSubscriptions')).find(x => x.id === sub.id), 60000)
    check('web calendar reaches B', subOnB?.name === 'France')
    const feedsB = await B.call('getSubscriptionFeeds')
    check('A\'s downloaded copy stays on A', !feedsB[sub.id], JSON.stringify(Object.keys(feedsB)))
    const feedsA = await A.call('getSubscriptionFeeds')
    check('A keeps its downloaded copy', !!feedsA[sub.id]?.text)
    await B.call('putSubscriptionFeed', sub.id, { url: sub.url, error: 'offline' })
    const errB = (await B.call('getSubscriptionFeeds'))[sub.id]
    check('a failed download is recorded on B', errB?.error === 'offline' && !errB.text)
    await B.call('deleteSubscription', sub.id)
    const subGone = await until(async () => {
      const l = await A.call('listSubscriptions')
      return l.some(x => x.id === sub.id) ? null : true
    }, 60000)
    check('removing it on B reaches A', !!subGone)
    const feedGone = await until(async () => (await A.call('getSubscriptionFeeds'))[sub.id] ? null : true, 30000)
    check('A drops its downloaded copy too', !!feedGone)

    const defaults = await A.call('listPersonalCalendars')
    check('default calendar listed first', defaults?.[0]?.id === 'default' && defaults[0].name === 'Personal')
  } catch (e) {
    check('harness ran without throwing', false, e.message)
  }
  await finish()
}

main()

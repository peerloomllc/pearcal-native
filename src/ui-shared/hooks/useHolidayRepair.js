import { useEffect, useRef } from 'react'
import { planHolidayRepair } from '../lib/holidays.js'

// One-shot repair for holiday events left at a date an older build computed
// wrongly — Canada and the UK substituted weekend holidays backwards until
// 2026-07-31, which put Boxing Day on top of Christmas Day in 2026.
//
// The Settings toggle already repairs a calendar when you switch it off or back
// on, but someone who subscribed months ago and never touches it would keep the
// wrong dates forever. This closes that gap without asking them to do anything.
//
// Two properties make it safe to run at launch:
//   - It only MOVES events whose date the calendar has since corrected. It never
//     re-adds a missing holiday, because the user may have deleted that one on
//     purpose and a launch-time pass would resurrect it on every boot.
//   - Once the dates line up the plan is empty, so it writes nothing. That is
//     what lets both shells and every linked device run it independently.
//
// Gated on `eventsReady` so it sees the real calendar rather than the empty list
// that exists before the first listEvents() resolves.
export function useHolidayRepair (db, profile, events, setEvents, eventsReady) {
  const done = useRef(false)

  useEffect(() => {
    if (done.current || !db || !profile) return
    if (eventsReady && !eventsReady.current) return
    const codes = profile.holidayCountries ?? []
    done.current = true
    if (!codes.length) return

    const thisYear = new Date().getFullYear()
    const { deletes, puts } = planHolidayRepair(events, codes, [thisYear, thisYear + 1], Date.now())
    if (!deletes.length && !puts.length) return

    let cancelled = false
    ;(async () => {
      for (const ev of deletes) {
        try { await db.localDeleteEvent(ev.date, ev.id) } catch (e) { /* best effort */ }
      }
      for (const ev of puts) {
        try { await db.putEvent(ev) } catch (e) { /* best effort */ }
      }
      if (cancelled) return
      const gone = new Set(deletes.map(e => e.id))
      setEvents(prev => {
        const next = prev.filter(e => !gone.has(e.id))
        for (const ev of puts) if (!next.some(e => e.id === ev.id)) next.push(ev)
        return next
      })
    })()
    return () => { cancelled = true }
  }, [db, profile, events, setEvents, eventsReady])
}

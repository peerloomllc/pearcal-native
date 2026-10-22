import { useEffect, useRef, useState } from 'react'
import { planForeverExtensions } from '../lib/recurring.js'

// TODO #183: tops up "repeat forever" series (birthdays included) with another
// year of occurrences when one is within 90 days of its end. The phone does
// this at launch in App.jsx; the desktop never did, so a desktop-only user's
// forever series ended a year after they were made. The desktop app often
// stays open for weeks, so this also runs about once a day.
//
// Gated on `eventsReady`, like useHolidayRepair, so it plans from the real
// calendar rather than the empty list before the first listEvents().
export function useForeverTopUp (db, events, setEvents, eventsReady) {
  const lastRun = useRef(0)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 6 * 60 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!db || (eventsReady && !eventsReady.current)) return
    if (Date.now() - lastRun.current < 23 * 60 * 60 * 1000) return
    lastRun.current = Date.now()
    const add = planForeverExtensions(events)
    if (!add.length) return
    setEvents((prev) => {
      const ids = new Set(prev.map((e) => e.id))
      return [...prev, ...add.filter((e) => !ids.has(e.id))]
    })
    ;(async () => {
      for (const occ of add) await db.putEvent(occ).catch((e) => console.warn('[FOREVER-EXTEND-ERR]', e?.message))
    })()
  }, [db, events, tick])
}

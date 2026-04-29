import { useState, useEffect, useRef } from 'react'

// Events list. Initial load on mount; the caller drives updates via
// setEvents from the sync subscription effect (full-reload path,
// delta.changedEvents/removedIds patches) and from local mutations
// (saveEvent, deleteEvent, deleteEventSeries, leaveGroup cascades).
//
// `eventsReady` is a ref the caller uses to gate effects that should
// only run after the very first listEvents() resolves — e.g. avoiding
// scheduling default reminders for the initial cold load when those
// events were already in the DB pre-launch. The hook owns it because
// flipping it on the same tick the initial setEvents fires keeps the
// gate tight.
export function useEvents (db) {
  const [events, setEvents] = useState([])
  const eventsReady = useRef(false)

  useEffect(() => {
    if (!db) return
    let cancelled = false
    db.listEvents()
      .then(evts => {
        if (cancelled) return
        setEvents(evts ?? [])
        eventsReady.current = true
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [db])

  return [events, setEvents, eventsReady]
}

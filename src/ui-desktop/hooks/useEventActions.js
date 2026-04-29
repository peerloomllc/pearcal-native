import { useCallback } from 'react'
import { expandRecurring } from '../../ui-shared/index.js'

// Mutation handlers for the desktop renderer. Mirrors the basic flow of
// mobile App.jsx's saveEvent / deleteEvent at src/ui/App.jsx — write to
// local DB, push to per-group sync, schedule reminders. Deliberately
// skips mobile's advanced surfaces (scope='future' patches across
// recurring siblings, busy-time-shadow forwarding, RSVP-aware
// scheduling) — those land in later phases when desktop has the UI to
// trigger them. For D4 the contract is: creating or editing an event
// always treats it as a single occurrence (or a freshly-expanded series).
export function useEventActions ({ db, notifs, sync, profile, events, setEvents }) {

  const saveEvent = useCallback((ev, opts = {}) => {
    const { _prevDate } = opts
    const reminders = opts.reminders ?? []

    // Expand recurring events into individual occurrences (new series only —
    // edit-an-occurrence stays a single record).
    const occurrences = (ev.recurrence && ev.recurrence !== 'none' && ev.recurrenceEnd && !ev.recurrenceId)
      ? expandRecurring(ev)
      : [ev]
    const withAuthor = occurrences.map(occ => ({
      ...occ,
      updatedByName: profile?.name ?? 'Someone',
      updatedById:   profile?.id ?? '',
    }))

    // Optimistic UI update — never block on async persistence.
    setEvents(prev => {
      let next = [...prev]
      if (_prevDate && _prevDate !== ev.date) {
        next = next.filter(e => !(e.id === ev.id && e.date === _prevDate))
      }
      for (const occ of withAuthor) {
        const i = next.findIndex(e => e.id === occ.id)
        if (i >= 0) next[i] = occ
        else next.push(occ)
      }
      return next
    })

    if (!db) return
    if (_prevDate && _prevDate !== ev.date) {
      db.deleteEvent(_prevDate, ev.id).catch(() => {})
    }
    for (const occ of withAuthor) {
      db.putEvent(occ).catch(e => console.warn('[PUT-EVENT-ERR]', e?.message))
      if (reminders.length) db.putReminders(occ.id, reminders).catch(() => {})
      notifs?.cancelForEvent(occ.id).catch(() => {})
      if (reminders.length) notifs?.scheduleForEvent(occ, reminders).catch(() => {})
      const evToSync = (_prevDate && occ.id === ev.id) ? { ...occ, _prevDate } : occ
      for (const gid of occ.groups ?? []) {
        sync?.putEvent(gid, evToSync).catch(e => console.warn('[SYNC-ERR]', e?.message))
      }
    }
  }, [db, notifs, sync, profile, setEvents])

  const deleteEvent = useCallback(async (id) => {
    const ev = events.find(e => e.id === id)
    if (!ev) return
    setEvents(prev => prev.filter(e => e.id !== id))
    if (!db) return
    db.deleteEvent(ev.date, id).catch(() => {})
    notifs?.cancelForEvent(id).catch(() => {})
    for (const gid of ev.groups ?? []) {
      sync?.deleteEvent(gid, id, ev.date,
        profile?.name ?? 'Someone',
        profile?.id ?? '',
        ev.recurrenceId ?? '',
        ev.title ?? '').catch(() => {})
    }
  }, [db, notifs, sync, profile, events, setEvents])

  return { saveEvent, deleteEvent }
}

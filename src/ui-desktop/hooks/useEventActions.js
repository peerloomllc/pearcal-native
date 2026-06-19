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

  // `opts.scope` ('one' | 'future' | 'all') drives recurring-series edits — the
  // EventModal prompts for it when editing an occurrence. Mirrors mobile
  // App.jsx saveEvent: regenerate the series on a cadence / end-date change,
  // propagate a patch for ordinary future/all edits, else write one occurrence.
  const saveEvent = useCallback((ev, opts = {}) => {
    const { _prevDate, scope = 'one' } = opts
    // opts.reminders is set on create (the profile default). On edit it's
    // undefined: re-read any existing reminders so the notification gets
    // rescheduled against the event's new time instead of silently dropped.
    const explicitReminders = opts.reminders

    async function applyReminders (occ) {
      let reminders = explicitReminders
      if (reminders === undefined) {
        reminders = await db.getReminders(occ.id).catch(() => [])
      }
      await notifs?.cancelForEvent(occ.id).catch(() => {})
      if (reminders && reminders.length) {
        await db.putReminders(occ.id, reminders).catch(() => {})
        await notifs?.scheduleForEvent(occ, reminders).catch(() => {})
      }
    }

    const original = events.find(e => e.id === ev.id)
    // A cadence or end-window change can't be a metadata patch — it must add or
    // drop occurrences — so it routes through the tombstone-and-regenerate path.
    const seriesShapeChanged = !!ev.recurrenceId && !!original && (
      original.recurrence !== ev.recurrence ||
      (original.recurrenceNth ?? 0) !== (ev.recurrenceNth ?? 0) ||
      (original.recurrenceWeekday ?? 0) !== (ev.recurrenceWeekday ?? 0) ||
      (original.recurrenceInterval ?? 1) !== (ev.recurrenceInterval ?? 1) ||
      (original.recurrenceEnd ?? '') !== (ev.recurrenceEnd ?? '') ||
      !!original.repeatForever !== !!ev.repeatForever
    )

    let occurrences
    let toDelete = []
    if (ev.recurrence && ev.recurrence !== 'none' && (ev.recurrenceEnd || ev.repeatForever) && !ev.recurrenceId) {
      // First-time series creation.
      occurrences = expandRecurring(ev)
    } else if (seriesShapeChanged && ev.recurrenceId && (scope === 'future' || scope === 'all')) {
      const seriesOccs = events.filter(e => e.recurrenceId === ev.recurrenceId)
      let anchorDate = ev.date
      if (scope === 'all') {
        const sorted = [...seriesOccs].sort((a, b) => a.date.localeCompare(b.date))
        anchorDate = sorted[0]?.date ?? ev.date
        toDelete = [...seriesOccs]
      } else {
        toDelete = seriesOccs.filter(e => e.date >= ev.date)
      }
      let maxVersion = 1
      for (const occ of seriesOccs) {
        const m = occ.id.match(/_v(\d+)/)
        if (m) maxVersion = Math.max(maxVersion, parseInt(m[1], 10))
      }
      const template = { ...ev, id: ev.recurrenceId + '_v' + (maxVersion + 1), date: anchorDate, recurrenceId: '' }
      occurrences = expandRecurring(template).map(o => ({ ...o, recurrenceId: ev.recurrenceId }))
    } else if ((scope === 'future' || scope === 'all') && ev.recurrenceId) {
      // Ordinary edit propagated across the series.
      const PROPAGATE = ['title','allDay','endDate','start','end','color','colors','desc','location',
                         'meetingLink','recurrence','recurrenceEnd','repeatForever','recurrenceNth',
                         'recurrenceWeekday','recurrenceInterval','editPermission','rsvpEnabled','groups','invitees']
      const patch = {}
      for (const k of PROPAGATE) if (k in ev) patch[k] = ev[k]
      occurrences = events
        .filter(e => e.recurrenceId === ev.recurrenceId && (scope === 'all' || e.date >= ev.date))
        .map(e => ({ ...e, ...patch }))
    } else {
      occurrences = [ev]
    }

    const withAuthor = occurrences.map(occ => ({
      ...occ,
      updatedByName: profile?.name ?? 'Someone',
      updatedById:   profile?.id ?? '',
    }))

    // Optimistic UI update — never block on async persistence.
    setEvents(prev => {
      let next = [...prev]
      if (toDelete.length) {
        const delIds = new Set(toDelete.map(e => e.id))
        next = next.filter(e => !delIds.has(e.id))
      }
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
    ;(async () => {
      // Tombstone regenerated occurrences before writing the fresh ones so peers
      // process the deletes first (they live under non-colliding versioned ids).
      for (const occ of toDelete) {
        await db.deleteEvent(occ.date, occ.id).catch(() => {})
        await notifs?.cancelForEvent(occ.id).catch(() => {})
        for (const gid of occ.groups ?? []) {
          sync?.deleteEvent(gid, occ.id, occ.date, profile?.name ?? 'Someone', profile?.id ?? '', occ.recurrenceId ?? '', occ.title ?? '').catch(() => {})
        }
      }
      if (_prevDate && _prevDate !== ev.date) {
        await db.deleteEvent(_prevDate, ev.id).catch(() => {})
      }
      for (const occ of withAuthor) {
        await db.putEvent(occ).catch(e => console.warn('[PUT-EVENT-ERR]', e?.message))
        await applyReminders(occ)
        const evToSync = (_prevDate && occ.id === ev.id) ? { ...occ, _prevDate } : occ
        for (const gid of occ.groups ?? []) {
          sync?.putEvent(gid, evToSync).catch(e => console.warn('[SYNC-ERR]', e?.message))
        }
      }
    })()
  }, [db, notifs, sync, profile, events, setEvents])

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

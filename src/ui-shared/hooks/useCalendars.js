import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { HOLIDAY_COUNTRIES, holidayCalendarIds } from '../lib/holidays.js'
import calendarsLib from '../../lib/calendars.js'

const { DEFAULT_CALENDAR_ID, listCalendars, isEventVisible, eventDisplayColor, planCalendarDelete } = calendarsLib

// Personal calendars + per-device visibility (TODO #189). Shared by the mobile
// and desktop UIs.
//
// - `calendars`: default first, then the user's own, from personalCalendar:*.
// - `holidayCalendars`: one entry per active holiday country, so each gets a
//   switch like any other calendar.
// - `hidden`: Set of visibility keys hidden on THIS device.
// - `filterEvents(events)`: drops hidden events and paints personal events in
//   their calendar's color. Use it for what the views draw, never for the list
//   that saves and deletes act on.
export function useCalendars (db, { activeHolidayCountries = [] } = {}) {
  const [rows, setRows] = useState([])
  const [hiddenList, setHiddenList] = useState([])
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    if (!db?.listPersonalCalendars) return
    try { setRows(await db.listPersonalCalendars()) } catch { /* non-fatal */ }
  }, [db])

  useEffect(() => {
    if (!db?.listPersonalCalendars) return
    let cancelled = false
    Promise.all([
      db.listPersonalCalendars().catch(() => []),
      db.getCalendarVisibility().catch(() => ({ hidden: [] })),
    ]).then(([cals, vis]) => {
      if (cancelled) return
      setRows(cals ?? [])
      setHiddenList(vis?.hidden ?? [])
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [db])

  // A linked device added, renamed or deleted a calendar.
  useEffect(() => {
    const on = () => { reload() }
    window.addEventListener('pear:personalCalendarsChanged', on)
    return () => window.removeEventListener('pear:personalCalendarsChanged', on)
  }, [reload])

  const calendars = useMemo(() => listCalendars(rows), [rows])
  const calendarsById = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars])
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList])

  const activeKey = (activeHolidayCountries ?? []).slice().sort().join(',')
  const holiday = useMemo(() => {
    const thisYear = new Date().getFullYear()
    const years = [thisYear - 1, thisYear, thisYear + 1]
    const byId = new Map()
    const list = []
    for (const c of HOLIDAY_COUNTRIES) {
      if (!(activeHolidayCountries ?? []).includes(c.code)) continue
      const key = 'holiday:' + c.code
      list.push({ key, code: c.code, name: c.label + ' holidays', flag: c.flag, color: c.color ?? '#CF3535' })
      for (const id of holidayCalendarIds(c.fn, years)) {
        const keys = byId.get(id)
        if (keys) keys.push(key); else byId.set(id, [key])
      }
    }
    return { list, byId }
  }, [activeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const holidayKeysFor = useCallback(ev => holiday.byId.get(ev?.id) ?? [], [holiday])

  // Holiday events whose countries are all hidden. Stored next to the hidden
  // keys so bare.js can filter the home-screen widget without the holiday tables.
  const hiddenHolidayIds = useCallback(nextHidden => {
    const out = []
    for (const [id, keys] of holiday.byId) if (keys.every(k => nextHidden.has(k))) out.push(id)
    return out
  }, [holiday])

  const latestHidden = useRef(hiddenList)
  latestHidden.current = hiddenList

  const writeHidden = useCallback(async nextList => {
    setHiddenList(nextList)
    const set = new Set(nextList)
    await db?.setCalendarVisibility?.({ hidden: nextList, hiddenEventIds: hiddenHolidayIds(set) }).catch(() => {})
  }, [db, hiddenHolidayIds])

  // Keep the widget's holiday list current when countries are switched on or off.
  useEffect(() => {
    if (!loaded) return
    writeHidden(latestHidden.current)
  }, [activeKey, loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  const isHidden = useCallback(key => hidden.has(key), [hidden])

  const toggle = useCallback(key => {
    const cur = latestHidden.current
    return writeHidden(cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key])
  }, [writeHidden])

  const setManyHidden = useCallback((keys, on) => {
    const cur = new Set(latestHidden.current)
    for (const k of keys) { if (on) cur.add(k); else cur.delete(k) }
    return writeHidden([...cur])
  }, [writeHidden])

  const filterEvents = useCallback(events => {
    const opts = { holidayKeysFor }
    const out = []
    for (const ev of events ?? []) {
      if (!isEventVisible(ev, hidden, opts)) continue
      const color = eventDisplayColor(ev, calendarsById)
      out.push(color === ev.color ? ev : { ...ev, color, colors: undefined })
    }
    return out
  }, [hidden, holidayKeysFor, calendarsById])

  const createCalendar = useCallback(async ({ name, color }) => {
    const rec = await db.putPersonalCalendar({ name, color })
    await reload()
    return rec
  }, [db, reload])

  const updateCalendar = useCallback(async (id, patch) => {
    const cur = calendarsById.get(id)
    const rec = await db.putPersonalCalendar({ id, name: patch.name ?? cur?.name, color: patch.color ?? cur?.color ?? null })
    await reload()
    return rec
  }, [db, reload, calendarsById])

  // Moves the calendar's events to `moveTo`, or deletes them when it is null,
  // through the caller's own save/delete paths so they sync as usual. Then
  // removes the calendar and its hidden flag.
  const deleteCalendar = useCallback(async (id, { events, moveTo, saveEvent, removeEvent }) => {
    const plan = planCalendarDelete(events, id, moveTo)
    for (const ev of plan.move) await saveEvent(ev)
    for (const ev of plan.remove) await removeEvent(ev)
    await db.deletePersonalCalendar(id)
    if (latestHidden.current.includes('personal:' + id)) {
      await writeHidden(latestHidden.current.filter(k => k !== 'personal:' + id))
    }
    await reload()
    return plan
  }, [db, reload, writeHidden])

  return {
    loaded,
    calendars,
    calendarsById,
    holidayCalendars: holiday.list,
    hidden,
    isHidden,
    toggle,
    setManyHidden,
    filterEvents,
    createCalendar,
    updateCalendar,
    deleteCalendar,
    DEFAULT_CALENDAR_ID,
  }
}

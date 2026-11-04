import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { parseIcs, icsCalendarName } from '../lib/ics.js'
import { expandRecurring } from '../lib/recurring.js'
import webCalLib from '../../lib/webCalendars.js'

const { isFeedDue, normalizeFeedUrl } = webCalLib

// Web calendar subscriptions (TODO #189 phase 2). Shared by the mobile and
// desktop UIs.
//
// The subscription list syncs between linked devices. Each device downloads
// the feeds itself, through the native shell (db.fetchCalendarUrl), and keeps
// the text locally. `events` are built from that text in memory: read-only,
// never saved, never shared with a group.
const CHECK_EVERY_MS = 15 * 60 * 1000
const COLORS = ['#4BBDCC', '#A97FD4', '#F5C842', '#E07B54', '#6C9BF5', '#5DBF8A', '#E5864A', '#D45F7A']

// Ipc errors from Electron arrive wrapped; show only the reason.
function cleanError (e) {
  return String(e?.message ?? e ?? 'Download failed')
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// Read-only PearCal events from one feed's text, recurrences expanded.
export function feedEvents (sub, text, today = new Date()) {
  if (!sub || !text) return []
  let parsed
  try { parsed = parseIcs(text, today) } catch { return [] }
  const out = []
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]
    const base = 'web-' + sub.id + '-' + String(p.uid || i).replace(/[^A-Za-z0-9_.@-]/g, '') + '-' + p.date
    const ev = {
      id: base,
      title: p.title,
      date: p.date,
      endDate: p.endDate ?? '',
      allDay: p.allDay ?? true,
      start: p.start ?? '',
      end: p.end ?? '',
      desc: p.desc ?? '',
      location: p.location ?? '',
      meetingLink: p.meetingLink ?? '',
      groups: [],
      invitees: [],
      color: sub.color || COLORS[0],
      colors: [],
      recurrence: p.recurrence ?? 'none',
      recurrenceEnd: p.recurrenceEnd ?? '',
      repeatForever: !!p.repeatForever,
      recurrenceNth: p.recurrenceNth ?? 0,
      recurrenceWeekday: p.recurrenceWeekday ?? 0,
      recurrenceInterval: p.recurrenceInterval ?? 1,
      recurrenceId: '',
      creatorId: 'web-calendar',
      editPermission: 'creator',
      subscriptionId: sub.id,
      readOnly: true,
    }
    for (const occ of expandRecurring(ev)) out.push(occ)
  }
  return out
}

export function useWebCalendars (db) {
  const [subs, setSubs] = useState([])
  const [feeds, setFeeds] = useState({}) // id -> { url, text, fetchedAt, attemptedAt, error }
  const [busy, setBusy] = useState({})   // id -> true while downloading
  const feedsRef = useRef(feeds)
  feedsRef.current = feeds
  const subsRef = useRef(subs)
  subsRef.current = subs
  const supported = !!db?.listSubscriptions

  const reload = useCallback(async () => {
    if (!supported) return
    try {
      const [s, f] = await Promise.all([db.listSubscriptions(), db.getSubscriptionFeeds()])
      setSubs(s ?? [])
      setFeeds(f ?? {})
    } catch { /* non-fatal */ }
  }, [db, supported])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    const on = () => { reload() }
    window.addEventListener('pear:subscriptionsChanged', on)
    return () => window.removeEventListener('pear:subscriptionsChanged', on)
  }, [reload])

  // One download per feed at a time; a second caller waits for the first.
  const inflight = useRef(new Map())
  const refresh = useCallback((sub) => {
    if (!supported || !sub?.id) return Promise.resolve(null)
    const running = inflight.current.get(sub.id)
    if (running) return running
    const p = refreshOnce(sub).finally(() => inflight.current.delete(sub.id))
    inflight.current.set(sub.id, p)
    return p
  }, [supported]) // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshOnce (sub) {
    setBusy(b => ({ ...b, [sub.id]: true }))
    let saved = null
    try {
      const text = await db.fetchCalendarUrl(sub.url)
      saved = { url: sub.url, text, fetchedAt: Date.now(), attemptedAt: Date.now() }
      await db.putSubscriptionFeed(sub.id, { url: sub.url, text, attemptedAt: saved.attemptedAt })
    } catch (e) {
      const prev = feedsRef.current[sub.id]
      saved = { url: sub.url, attemptedAt: Date.now(), error: cleanError(e),
        ...(prev?.text && prev.url === sub.url ? { text: prev.text, fetchedAt: prev.fetchedAt } : {}) }
      await db.putSubscriptionFeed(sub.id, { url: sub.url, error: saved.error, attemptedAt: saved.attemptedAt }).catch(() => {})
    } finally {
      setBusy(b => { const n = { ...b }; delete n[sub.id]; return n })
    }
    setFeeds(f => ({ ...f, [sub.id]: saved }))
    return saved
  }

  // Download whatever is due, now and every 15 minutes while the app is open.
  const refreshDue = useCallback(async () => {
    for (const s of subsRef.current) {
      if (isFeedDue(s, feedsRef.current[s.id])) await refresh(s)
    }
  }, [refresh])

  useEffect(() => {
    if (!supported || subs.length === 0) return
    refreshDue()
    const t = setInterval(refreshDue, CHECK_EVERY_MS)
    return () => clearInterval(t)
  }, [supported, subs, refreshDue])

  const events = useMemo(() => {
    const today = new Date()
    const out = []
    for (const s of subs) out.push(...feedEvents(s, feeds[s.id]?.text, today))
    return out
  }, [subs, feeds])

  // Adds the subscription, downloads it once, and names it from the file when
  // no name was given. Returns { sub, error }.
  const addSubscription = useCallback(async ({ url, name, color }) => {
    const clean = normalizeFeedUrl(url)
    let sub = await db.putSubscription({
      url: clean, name: (name ?? '').trim(),
      color: color || COLORS[subsRef.current.length % COLORS.length],
    })
    setSubs(prev => [...prev, sub])
    const feed = await refresh(sub)
    if (!sub.name) {
      const fromFile = feed?.text ? icsCalendarName(feed.text) : null
      const host = (() => { try { return new URL(clean).hostname } catch { return 'Web calendar' } })()
      sub = await db.putSubscription({ ...sub, name: fromFile || host })
    }
    await reload()
    return { sub, error: feed?.error ?? null }
  }, [db, refresh, reload])

  const updateSubscription = useCallback(async (id, patch) => {
    const cur = subsRef.current.find(s => s.id === id)
    if (!cur) return null
    const next = await db.putSubscription({ ...cur, ...patch })
    await reload()
    if (patch.url && next.url !== cur.url) await refresh(next)
    return next
  }, [db, reload, refresh])

  const removeSubscription = useCallback(async id => {
    await db.deleteSubscription(id)
    await reload()
  }, [db, reload])

  return {
    supported,
    subscriptions: subs,
    feeds,
    busy,
    events,
    refresh,
    addSubscription,
    updateSubscription,
    removeSubscription,
  }
}

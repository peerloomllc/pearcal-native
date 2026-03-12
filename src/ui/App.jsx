/**
 * PearCal — Root React Component
 *
 * Props (injected from src/index.js):
 *   db     {PearCalDB}           — Hyperbee data layer
 *   notifs {NotificationScheduler}
 *   sync   {SyncManager}
 *
 * All state is loaded from Hyperbee on mount.
 * All mutations write through to Hyperbee (and sync/notifs where needed).
 * A lightweight event emitter wires P2P sync updates back into React state.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { buildInviteLink, handleInviteLink } from '../invite.js'
import QRCode from 'qrcode'
import { FONT_CSS } from './fonts.js'
import {
  CalendarBlank, Users, User, Info,
  ShareNetwork, ArrowSquareOut, MapPin, GearSix,
  Trash, SignOut, Repeat, Lock, Key,
  CaretRight, CaretLeft, QrCode, Plus,
  Check, X, Eye, EyeSlash, Circle,
  Warning, ArrowLeft, DotsThree,
} from '@phosphor-icons/react'

// ─── Simple event emitter for P2P → UI updates ───────────────────────────────
// SyncManager calls emitter.emit('sync', groupId) whenever Autobase
// linearises new remote writes, triggering a selective state refresh.
class Emitter {
  constructor () { this._h = {} }
  on  (e, fn) { (this._h[e] ??= []).push(fn) }
  off (e, fn) { this._h[e] = (this._h[e] ?? []).filter(f => f !== fn) }
  emit (e, ...a) { (this._h[e] ?? []).forEach(fn => fn(...a)) }
}
export const emitter = new Emitter()

// ─── Theme ────────────────────────────────────────────────────────────────────
if (typeof document !== 'undefined' && !document.getElementById('pear-styles')) {
  const style = document.createElement('style')
  style.id = 'pear-styles'
  style.textContent = FONT_CSS + `
    [data-theme="dark"] {
      --color-bg:                #0E0D0C;
      --color-surface:           #1A1916;
      --color-border:            #2C2A26;
      --color-text:              #F2EFE8;
      --color-muted:             #8A8478;
      --color-accent:            #C8922A;
      --color-accent-faint:      rgba(200,146,42,0.12);
      --color-destructive:       #C0504A;
      --color-destructive-faint: rgba(192,80,74,0.12);
      --color-success:           #5DBF8A;
    }
    [data-theme="light"] {
      --color-bg:                #F7F5F0;
      --color-surface:           #FFFFFF;
      --color-border:            #E5E1D8;
      --color-text:              #1A1916;
      --color-muted:             #9A9288;
      --color-accent:            #B07D20;
      --color-accent-faint:      rgba(176,125,32,0.10);
      --color-destructive:       #C0504A;
      --color-destructive-faint: rgba(192,80,74,0.08);
      --color-success:           #4A9E6E;
    }
    :root {
      --space-xs:  4px;
      --space-sm:  8px;
      --space-md:  16px;
      --space-lg:  24px;
      --space-xl:  32px;
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 16px;
      --radius-xl: 20px;
      --font-sans: 'Manrope', -apple-system, BlinkMacSystemFont, sans-serif;
      --duration-fast:   120ms;
      --duration-normal: 200ms;
      --duration-slow:   280ms;
      --easing: cubic-bezier(0.2, 0, 0, 1);
      --safe-area-top:    env(safe-area-inset-top, 0px);
      --safe-area-bottom: env(safe-area-inset-bottom, 0px);
    }
    *, *::before, *::after { box-sizing: border-box; }
    * { -webkit-tap-highlight-color: transparent; }
    input, textarea, select, button { font-family: var(--font-sans); }
    input, textarea { font-size: 16px; }
    button { transition: transform var(--duration-fast) var(--easing); }
    button:active { transform: scale(0.97); }
    input:focus, textarea:focus { border-color: var(--color-accent) !important; }
    * { -webkit-overflow-scrolling: touch; }
    @keyframes pearFadeUp {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0);   }
    }
    @keyframes pearFadeIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes pearPulse {
      0%, 100% { opacity: 0.3; }
      50%       { opacity: 0.7; }
    }
    @keyframes pearShake {
      0%, 100% { transform: translateX(0);   }
      20%, 60% { transform: translateX(-4px); }
      40%, 80% { transform: translateX(4px);  }
    }
    @keyframes pearSpin {
      from { transform: rotate(0deg);   }
      to   { transform: rotate(360deg); }
    }
    @keyframes pearSlideInRight { from { opacity: 0; transform: translateX(32px) } to { opacity: 1; transform: translateX(0) } }
    @keyframes pearSlideInLeft { from { opacity: 0; transform: translateX(-32px) } to { opacity: 1; transform: translateX(0) } }
    @keyframes pearSkeletonPulse { 0%,100% { opacity: 0.4 } 50% { opacity: 0.8 } }
  `
  document.head.appendChild(style)
}

const FONT = `'Manrope', -apple-system, BlinkMacSystemFont, sans-serif`

function setTheme (dark) {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  }
}

function extractURLs (text) {
  if (!text) return []
  const re = /https?:\/\/[^\s<>"']+/gi
  return [...new Set(text.match(re) ?? [])]
}

function PearIcon ({ size = 40, color = 'var(--color-accent)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Stem */}
      <path d="M20 6 C20 6 22 3 24 2" stroke={color} strokeWidth="1.2" strokeLinecap="round" fill="none"/>
      {/* Small leaf on stem */}
      <path d="M21 5 C23 3 26 4 24 6 C22 7 20 6 21 5Z" fill={color} opacity="0.7"/>
      {/* Pear body — teardrop shape */}
      <path d="M20 8 C20 8 14 10 13 17 C12 22 14 28 17 31 C18.5 32.5 21.5 32.5 23 31 C26 28 28 22 27 17 C26 10 20 8 20 8Z"
        stroke={color} strokeWidth="1.2" fill="none" strokeLinejoin="round"/>
    </svg>
  )
}

function formatTime (t, use24h) {
  if (!t) return ''
  const [hStr, mStr] = t.split(':')
  if (use24h) return hStr + ':' + mStr
  const h = parseInt(hStr, 10)
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return h12 + ':' + mStr + ampm
}

const GROUP_COLORS = ['#6C9BF5','#5DBF8A','#E5864A','#D45F7A','#A97FD4','#4BBDCC','#F5C842','#E07B54']
const GROUP_EMOJIS = ['👨‍👩‍👧‍👦','⚽','📚','🎮','🏋️','🎵','🌿','🐾','✈️','🍕','💼','🎨']
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const REMINDER_OPTIONS = [
  {label:'None',value:0},{label:'5 min before',value:5},{label:'10 min before',value:10},
  {label:'15 min before',value:15},{label:'30 min before',value:30},
  {label:'1 hour before',value:60},{label:'2 hours before',value:120},{label:'1 day before',value:1440},
]

function themes () {
  return {
    accent:       'var(--color-accent)',
    accentFaint:  'var(--color-accent-faint)',
    muted:        'var(--color-muted)',
    border:       'var(--color-border)',
    inputBg:      'var(--color-bg)',
    app:          { background: 'var(--color-bg)' },
    bg:           { background: 'var(--color-bg)' },
    headerBg:     { background: 'var(--color-bg)' },
    navBg:        { background: 'var(--color-bg)' },
    text:         { color: 'var(--color-text)' },
    card:         { background: 'var(--color-surface)' },
    iconBtn: {
      background: 'none', border: 'none', cursor: 'pointer',
      padding: '4px 8px', borderRadius: 8, fontFamily: FONT, fontWeight: 400,
      color: 'var(--color-text)',
    },
    pillBtn: {
      background: 'var(--color-accent)', border: 'none',
      borderRadius: 'var(--radius-md)', color: '#fff',
      cursor: 'pointer', fontFamily: FONT, fontWeight: 400,
    },
  }
}

// ─── Root App ─────────────────────────────────────────────────────────────────
export default function App ({ db, notifs, sync }) {
  const [dark,  setDark]  = useState(() => {
    setTheme(true) // default dark until profile loads
    return true
  })
  useEffect(() => { setTheme(dark) }, [dark])
  const [tab,   setTab]   = useState('calendar')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(null)

  const [profile,       setProfile]       = useState(null)
  const [groups,        setGroups]        = useState([])
  const [events,        setEvents]        = useState([])
  const [selectedDate,  setSelectedDate]  = useState(todayStr())
  const [viewDate,      setViewDate]      = useState(() => {
    const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() }
  })
  const [modal,         setModal]         = useState(null)
  const [newGroupOpen,  setNewGroupOpen]  = useState(false)
  const newGroupKeyUpdatedRef = useRef(null)
  const [settingsGroup, setSettingsGroup] = useState(null)
  const [blockedToast,  setBlockedToast]  = useState(false)
  const [qrGroup,       setQrGroup]       = useState(null)  // { group, link }
  const [joinOpen,       setJoinOpen]       = useState(false)
  const [joinPasteMode,  setJoinPasteMode]  = useState(false)
  const [pendingJoin,    setPendingJoin]    = useState(null)  // { url, groupName }
  const closePendingJoinRef = useRef(null)
  const groupsRef = useRef(groups)
  useEffect(() => { groupsRef.current = groups }, [groups])
  const [onboardStep,   setOnboardStep]   = useState(0)
  const showOnboarding = ready && !profile?.onboardingComplete
  const [showDonationReminder, setShowDonationReminder] = useState(false)
  const tabHistoryRef  = useRef([])
  const tabRef         = useRef('calendar')
  const backHandlerRef = useRef(null)
  const closeAboutSheetRef  = useRef(null)
  const closeJoinSheetRef   = useRef(null)
  const closeInviteSheetRef = useRef(null)
  const goTab = (t) => { tabHistoryRef.current.push(tabRef.current); tabRef.current = t; setTab(t) }
  const [readyGroupKeys, setReadyGroupKeys] = useState(() => new Set())

  const th = themes()
  const localeUse24h = !new Intl.DateTimeFormat([], { hour: 'numeric' }).format(0).match(/am|pm/i)
  const use24h    = profile?.use24h ?? localeUse24h
  const weekStart = profile?.weekStart ?? 0

  // ── Bootstrap: load everything from Hyperbee ────────────────────────────────
  useEffect(() => {
    if (!db) { setReady(true); return }   // no DB (e.g. storybook/dev preview)
    let cancelled = false

    async function load () {
      try {
        const [prof, grps, evts] = await Promise.all([
          db.getProfile(),
          db.listGroups(),
          db.listEvents(),
        ])
        if (cancelled) return
        setProfile(prof)
        if (prof?.dark !== undefined) setDark(prof.dark)
        setGroups(grps)
        setReadyGroupKeys(new Set(grps.map(g => g.id)))
        setEvents(evts)
        setReady(true)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    }

    load()
    return () => { cancelled = true }
  }, [db])

  // ── Re-sync state when a P2P peer pushes new data ──────────────────────────
  useEffect(() => {
    if (!db) return

    async function onSync (groupId) {
      // Reload events (group-filtered for efficiency on large datasets)
      const fresh = await db.listEvents()
      setEvents(fresh)

      // Reload the updated group record (membership may have changed)
      const g = await db.getGroup(groupId)
      if (g) setGroups(prev => prev.map(x => x.id === groupId ? g : x))

    }

    emitter.on('sync', onSync)

    function onGroupDeleted (groupId) {
      setGroups(prev => prev.filter(g => g.id !== groupId))
      setEvents(prev => prev
        .map(e => ({ ...e, groups: e.groups.filter(gid => gid !== groupId) }))
        .filter(e => e.groups.length > 0))
    }
    emitter.on('groupDeleted', onGroupDeleted)

    function onInviteBlocked () {
      setBlockedToast(true)
      setTimeout(() => setBlockedToast(false), 4000)
    }
    emitter.on('inviteBlocked', onInviteBlocked)

    async function onGroupJoined(group) {
      setReadyGroupKeys(prev => { const s = new Set(prev); s.add(group.id); return s })
      if (db) {
        const fresh = await db.listGroups()
        setGroups(fresh)
        // Re-mirror Autobase view → local DB in case we previously left
        // and our event cleanup removed entries that Autobase won't re-apply
        await db.resyncGroup(group.id).catch(() => {})
        const evts = await db.listEvents()
        setEvents(evts)
      } else {
        setGroups(prev => {
          if (prev.find(g => g.id === group.id)) return prev
          return [...prev, group]
        })
      }
      setTab('groups')
    }
    emitter.on('group:joined', onGroupJoined)
    // Also listen for DOM event from __pearHandleInvite
    const onDomGroupJoined = (e) => onGroupJoined(e.detail)
    window.addEventListener('pear:groupJoined', onDomGroupJoined)
    const onDomSetTab = (e) => setTab(e.detail)
    window.addEventListener('pear:setTab', onDomSetTab)
    const onDomPendingJoin = (e) => openPendingJoin(e.detail)
    window.addEventListener('pear:pendingJoin', onDomPendingJoin)

    function onGroupKeyUpdated(group) {
      setGroups(prev => prev.map(g => g.id === group.id ? group : g))
      setReadyGroupKeys(prev => { const s = new Set(prev); s.add(group.id); return s })
      if (newGroupKeyUpdatedRef.current) newGroupKeyUpdatedRef.current(group)
    }
    emitter.on('groupKeyUpdated', onGroupKeyUpdated)
    return () => {
      emitter.off('sync', onSync)
      emitter.off('groupDeleted', onGroupDeleted)
      emitter.off('inviteBlocked', onInviteBlocked)
      emitter.off('group:joined', onGroupJoined)
      window.removeEventListener('pear:groupJoined', onDomGroupJoined)
      window.removeEventListener('pear:setTab', onDomSetTab)
      window.removeEventListener('pear:pendingJoin', onDomPendingJoin)
      emitter.off('groupKeyUpdated', onGroupKeyUpdated)
    }
  }, [db])
  useEffect(() => { tabRef.current = tab }, [tab])
  useEffect(() => {
    backHandlerRef.current = () => {
      if (showOnboarding) {
        if (onboardStep > 0) { setOnboardStep(s => s - 1); return }
        return  // step 0 — do nothing, don't exit
      }
      if (closeAboutSheetRef.current?.()) return
      if (qrGroup)      { setQrGroup(null);      return }
      if (closeInviteSheetRef.current?.()) return
      if (closeJoinSheetRef.current?.()) return
      if (closePendingJoinRef.current?.()) return
      if (modal)        { setModal(null);        return }
      if (newGroupOpen) { setNewGroupOpen(false); return }
      if (settingsGroup){ setSettingsGroup(null); return }
      const prev = tabHistoryRef.current.pop()
      if (prev) { tabRef.current = prev; setTab(prev); return }
      window.ReactNativeWebView?.postMessage(JSON.stringify({ method: 'exitApp', id: -1 }))
    }
  }, [modal, newGroupOpen, settingsGroup, qrGroup, pendingJoin, closeAboutSheetRef, showOnboarding, onboardStep])
  useEffect(() => { window.__pearBack = () => backHandlerRef.current?.() }, [])
  useEffect(() => { window.__pearSync = sync }, [sync])
  useEffect(() => {
    function onQrScanResult(url) {
      if (url && db && sync) openPendingJoin(url)
    }
    emitter.on('qrScanResult', onQrScanResult)
    function onCameraResult (base64) {
      if (base64) updateProfile({ avatar: base64 }).catch(() => {})
    }
    emitter.on('cameraResult', onCameraResult)
    return () => { emitter.off('qrScanResult', onQrScanResult); emitter.off('cameraResult', onCameraResult) }
  }, [db, sync])

  // ── Expose global bridge for Android → JS calls ────────────────────────────
  useEffect(() => {
    if (!db || !sync) return
    window.__pearCal = {
      handleLink: url => openPendingJoin(url),
      restoreNotifications: () => notifs?.restoreAll(),
      navigateTo: (type, id) => {
        if (type === 'event') {
          const ev = events.find(e => e.id === id)
          if (ev) { setSelectedDate(ev.date); setTab('calendar') }
        }
      },
    }
    return () => { delete window.__pearCal }
  }, [db, sync, notifs, events])

  // ─── Mutation helpers ───────────────────────────────────────────────────────

  const saveEvent = useCallback(async (ev, scope = 'one', options = {}) => {
    const { _prevDate, ...evClean } = ev
    ev = evClean
    // Expand recurring events into individual occurrences (new series only)
    const occurrences = (ev.recurrence && ev.recurrence !== 'none' && ev.recurrenceEnd && !ev.recurrenceId)
      ? expandRecurring(ev)
      : scope === 'future' && ev.recurrenceId
        ? (() => {
            const PROPAGATE = ['title','allDay','start','end','reminder',
                               ...(options.propagateGroups ? ['groups','invitees'] : []),
                               'color','desc','location','recurrence','recurrenceEnd',
                               'recurrenceNth','recurrenceWeekday','editPermission']
            const patch = {}
            for (const k of PROPAGATE) patch[k] = ev[k]
            return events
              .filter(e => e.recurrenceId === ev.recurrenceId && e.date >= ev.date)
              .map(e => ({ ...e, ...patch }))
          })()
        : [ev]
    if (db) {
      // If date changed, delete old local entry to avoid duplicate
      if (_prevDate && _prevDate !== ev.date) {
        await db.deleteEvent(_prevDate, ev.id).catch(() => {})
        setEvents(prev => prev.filter(e => !(e.id === ev.id && e.date === _prevDate)))
      }
      for (const occ of occurrences) {
        const evWithAuthor = { ...occ, updatedByName: profile?.name ?? 'Someone', updatedById: profile?.id ?? '' }
        await db.putEvent(evWithAuthor)
        await notifs?.scheduleForEvent(evWithAuthor)
        const evToSync = (_prevDate && occ.id === ev.id) ? { ...evWithAuthor, _prevDate } : evWithAuthor
        for (const gid of evWithAuthor.groups ?? []) {
          await sync?.putEvent(gid, evToSync).catch(e => console.warn('[SYNC-ERR]', e?.message))
        }
        // Sync delete for any groups removed from this event
        const original = events.find(e => e.id === occ.id)
        const removedGroups = (original?.groups ?? []).filter(g => !(occ.groups ?? []).includes(g))
        for (const gid of removedGroups) {
          await sync?.deleteEvent(gid, occ.id, occ.date, profile?.name ?? 'Someone', profile?.id ?? '').catch(() => {})
        }
      }
    }
    setEvents(prev => {
      let next = [...prev]
      for (const occ of occurrences) {
        const i = next.findIndex(e => e.id === occ.id)
        if (i >= 0) next[i] = occ
        else next.push(occ)
      }
      return next
    })
    setModal(null)
  }, [db, notifs, sync, profile, events])

  const deleteEvent = useCallback(async id => {
    const ev = events.find(e => e.id === id)
    if (!ev) return
    const isCreator = ev.creatorId && profile?.id && ev.creatorId === profile.id
    if (db) {
      if (isCreator) {
        // Creator: delete for everyone via Autobase broadcast
        await db.deleteEvent(ev.date, id)
        await notifs?.cancelForEvent(id)
        for (const gid of ev.groups ?? []) {
          await sync?.deleteEvent(gid, id, ev.date, profile?.name ?? 'Someone', profile?.id ?? '').catch(() => {})
        }
      } else {
        // Non-creator: local-only delete + tombstone so resync never resurrects it
        await db.localDeleteEvent(ev.date, id)
        await notifs?.cancelForEvent(id)
      }
    }
    setEvents(prev => prev.filter(e => e.id !== id))
    setModal(null)
  }, [db, notifs, sync, events, profile])

  const deleteEventSeries = useCallback(async recurrenceId => {
    if (!recurrenceId || !db) return
    await db.deleteEventSeries(recurrenceId).catch(() => {})
    const seriesEvents = events.filter(e => e.recurrenceId === recurrenceId)
    for (const ev of seriesEvents) {
      await notifs?.cancelForEvent(ev.id)
      const isCreator = ev.creatorId && profile?.id && ev.creatorId === profile.id
      if (isCreator) {
        for (const gid of ev.groups ?? []) {
          await sync?.deleteEvent(gid, ev.id, ev.date, profile?.name ?? 'Someone', profile?.id ?? '').catch(() => {})
        }
      }
    }
    setEvents(prev => prev.filter(e => e.recurrenceId !== recurrenceId))
    setModal(null)
  }, [db, notifs, sync, events, profile])

  function parseGroupIdFromUrl(url) {
    try {
      const u = new URL(url.replace(/^pear:\/\//, 'https://'))
      const raw = u.searchParams.get('group')
      return raw ? atob(raw) : null
    } catch { return null }
  }

  function openPendingJoin(url) {
    const groupName = (() => { try { return new URL(url.replace(/^pear:\/\//, 'https://')).searchParams.get('name') || 'a group' } catch { return 'a group' } })()
    const gid = parseGroupIdFromUrl(url)
    if (gid && groupsRef.current.find(g => g.id === gid)) { setTab('groups'); return }
    setPendingJoin({ url, groupName })
  }

  const joinWithNickname = useCallback(async (url, nickname) => {
    const result = await handleInviteLink(url, db, sync, g => {
      setGroups(prev => prev.find(x => x.id === g.id) ? prev : [...prev, g])
      setTab('groups')
    })
    if (result?.ok && result.group && nickname && nickname !== profile?.name) {
      await db.setMemberNickname(result.group.id, nickname).catch(() => {})
    }
    if (result?.error === 'blocked_from_group') setBlockedToast(true)
    setPendingJoin(null)
    return result
  }, [db, sync, profile])

  const addGroup = useCallback(async (g, opts) => {
    if (db) {
      await db.putGroup(g)
      for (const m of g.members) await db.putMember(g.id, m)
      await sync?.joinGroup(g).catch(() => {})
    }
    if (!opts?.pendingKey) {
      setReadyGroupKeys(prev => { const s = new Set(prev); s.add(g.id); return s })
    }
    setGroups(prev => prev.some(x => x.id === g.id) ? prev : [...prev, g])
  }, [db, sync])

  const updateGroup = useCallback(async updated => {
    if (db) {
      // Diff members: find removed vs added vs unchanged
      const prev   = groups.find(g => g.id === updated.id)
      const oldIds = new Set((prev?.members ?? []).map(m => m.id))
      const newIds = new Set(updated.members.map(m => m.id))

      // Persist updated group record
      await db.putGroup(updated)

      // Sync member table
      for (const m of updated.members) {
        if (!oldIds.has(m.id)) await db.putMember(updated.id, m)
      }
      for (const m of (prev?.members ?? [])) {
        if (!newIds.has(m.id)) await db.removeMember(updated.id, m.id)
      }

      // Broadcast updated group record to peers
      await sync?.putGroup(updated).catch(() => {})
    }
    setGroups(prev => prev.map(g => g.id === updated.id ? updated : g))
    setSettingsGroup(updated)
  }, [db, sync, groups])

  const deleteGroup = useCallback(async (id, action = 'delete') => {
    if (db) {
      const g = groups.find(x => x.id === id)
      const isOwner = g?.ownerId === profile?.id
      if (action === 'delete' && isOwner) {
        // Owner: broadcast delete to all members
        await sync?.deleteGroup(id).catch(() => {})
      } else if (action === 'leave' && !isOwner) {
        // Non-owner leaving: update local DB then broadcast via Protomux (bypasses Autobase writability)
        const updatedMembers = (g?.members ?? []).filter(m => m.id !== profile?.id)
        const updatedGroup = { ...g, members: updatedMembers, updatedAt: Date.now() }
        await db.putGroup(updatedGroup).catch(() => {})
        await sync?.memberLeft(id, profile.id).catch(() => {})
      }
      await db.deleteGroup(id)
      await sync?.leaveGroup(id).catch(() => {})
    }
    setGroups(prev => prev.filter(g => g.id !== id))
    // Scrub group from events; remove events that now belong to no group
    setEvents(prev => prev
      .map(e => ({ ...e, groups: e.groups.filter(gid => gid !== id) }))
      .filter(e => e.groups.length > 0))
    setSettingsGroup(null)
  }, [db, sync, groups, profile])

  const updateProfile = useCallback(async updates => {
    if (db) {
      // Only generate initials if: (a) name changed AND (b) no photo is being set AND (c) no photo already stored
      const hasPhoto = updates.avatar?.startsWith?.('data:') || profile?.avatar?.startsWith?.('data:')
      const settingPhoto = updates.avatar?.startsWith?.('data:')
      if (updates.name && !hasPhoto) {
        updates = { ...updates, avatar: (updates.name ?? '').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0,2) || '?' }
      }
      await db.updateProfile(updates)
      // Update member record in all groups where we appear
      const updatedProfile = { ...profile, ...updates }
      for (const g of groups) {
        const isMember = g.members?.some(m => m.id === updatedProfile.id)
        if (isMember) {
          // For member avatar: use photo if set, otherwise regenerate initials from current name
          const memberAvatar = settingPhoto
            ? updatedProfile.avatar
            : (updatedProfile.avatar?.startsWith?.('data:') ? updatedProfile.avatar
                : (updatedProfile.name ?? '').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0,2) || '?')
          const updatedMember = { id: updatedProfile.id, name: updatedProfile.name, avatar: memberAvatar }
          await db.putMember(g.id, updatedMember).catch(() => {})
          const updatedGroup = { ...g, members: g.members.map(m => m.id === updatedProfile.id ? { ...m, ...updatedMember } : m) }
          // Write updated group to local DB so sync reload gets correct data
          await db.putGroup(updatedGroup).catch(() => {})
          // Retry sync a few times in case Autobase isn't writable yet
          const trySyncGroup = async (attempts = 0) => {
            try {
              await sync?.putGroup(updatedGroup)
}
            catch(e) {
              if (attempts < 5) setTimeout(() => trySyncGroup(attempts + 1), 2000)
            }
          }
          trySyncGroup()
        }
      }
    }
    const updatedProfile2 = { ...profile, ...updates }
    setProfile(prev => ({ ...prev, ...updates }))
    const memberAvatarForState = updatedProfile2.avatar?.startsWith?.('data:')
      ? updatedProfile2.avatar
      : (updatedProfile2.name ?? '').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0,2) || '?'
    setGroups(prev => prev.map(g => ({
      ...g,
      members: g.members?.map(m => m.id === updatedProfile2.id ? { ...m, name: updatedProfile2.name, avatar: memberAvatarForState } : m) ?? []
    })))
  }, [db, profile, groups, sync])

  // ─── Calendar helpers ───────────────────────────────────────────────────────
  const calDays = useMemo(() => {
    const { y, m } = viewDate
    const first    = new Date(y, m, 1).getDay()
    const firstAdj = (first - weekStart + 7) % 7
    const last     = new Date(y, m + 1, 0).getDate()
    const prevLast = new Date(y, m, 0).getDate()
    const cells = []
    const prevM = m === 0 ? 11 : m - 1
    const prevY = m === 0 ? y - 1 : y
    const nextM = m === 11 ? 0 : m + 1
    const nextY = m === 11 ? y + 1 : y
    for (let i = 0; i < firstAdj; i++)
      cells.push({ d: prevLast - firstAdj + 1 + i, y: prevY, m: prevM, type: 'prev' })
    for (let d = 1; d <= last; d++)
      cells.push({ d, y, m, type: 'cur' })
    let nextD = 1
    while (cells.length < 42)
      cells.push({ d: nextD++, y: nextY, m: nextM, type: 'next' })
    return cells
  }, [viewDate, weekStart])

  const eventsOnDate = d => events.filter(e => e.date === d)

  function openCreate (date) {
    const now = new Date()
    const nextHour = new Date(now.getTime() + (60 - now.getMinutes()) * 60000)
    nextHour.setSeconds(0, 0)
    const hh = String(nextHour.getHours()).padStart(2, '0')
    const endHour = String((nextHour.getHours() + 1) % 24).padStart(2, '0')
    const defaultStart = hh + ':00'
    const defaultEnd   = endHour + ':00'
    setModal({ mode:'create', event:{
      id: 'e' + Date.now(), title:'', date: date || selectedDate,
      allDay:false, start:defaultStart, end:defaultEnd, reminder: profile?.defaultReminder ?? 15,
      groups:[], invitees:[], color:'#6C9BF5', desc:'', location:'', creatorId: profile?.id ?? 'unknown', recurrence:'none', recurrenceId:'', recurrenceEnd:'', recurrenceNth:0, recurrenceWeekday:0, editPermission:'everyone',
    }})
  }

  // ─── Loading / error states ─────────────────────────────────────────────────
  if (error) return (
    <div style={{ fontFamily:FONT, display:'flex', alignItems:'center', justifyContent:'center',
      minHeight:'100vh', background:'#111', color:'#D45F7A', flexDirection:'column', gap:12, padding:24 }}>
      <span style={{ fontSize:32 }}>⚠️</span>
      <span style={{ fontSize:16, fontWeight:300 }}>Failed to load PearCal</span>
      <span style={{ fontSize:12, color:'#888', fontFamily:'monospace' }}>{error}</span>
    </div>
  )

  useEffect(() => {
    if (!ready || !profile || !profile.onboardingComplete) return
    if (profile.donationReminderShown) return
    const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000
    if (Date.now() - (profile.createdAt ?? Date.now()) >= TWO_WEEKS) {
      setShowDonationReminder(true)
    }
  }, [ready, profile?.onboardingComplete, profile?.donationReminderShown])

  if (!ready) return (
    <div style={{ fontFamily:FONT, display:'flex', alignItems:'center', justifyContent:'center',
      minHeight:'100vh', background:'#111', color:'#888', flexDirection:'column', gap:16 }}>
      <PearIcon size={36} />
      <span style={{ fontSize:14, fontWeight:300, letterSpacing:'0.06em' }}>Loading PearCal…</span>
    </div>
  )

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily:FONT, fontWeight:300, height:'100dvh', ...th.app,
      display:'flex', flexDirection:'column', alignItems:'center', overflow:'hidden' }}>
      <div style={{ width:'100%', maxWidth:430, height:'100dvh', display:'flex', flexDirection:'column', ...th.bg,
        paddingTop:'var(--sat)', paddingBottom:'var(--sab)' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'16px 20px 8px', ...th.headerBg }}>
          <span style={{ fontSize:20, fontWeight:300, ...th.text, display:'flex', alignItems:'center', gap:6 }}><PearIcon size={20} /> PearCal</span>
        </div>

        {/* Content */}
        <div style={{ flex:1, overflowY: tab === 'calendar' ? 'hidden' : 'auto', paddingBottom: tab === 'calendar' ? 0 : 72, minHeight:0 }}>
          <div key={tab} style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden',
            animation: 'pearFadeIn 100ms var(--easing) both', height: tab === 'calendar' ? '100%' : 'auto' }}>
          {tab === 'calendar' && (
            <CalendarTab th={th} viewDate={viewDate} setViewDate={setViewDate}
              calDays={calDays} selectedDate={selectedDate} setSelectedDate={setSelectedDate}
              eventsOnDate={eventsOnDate} todayStr={todayStr()} dateStr={dateStr}
              selectedEvents={eventsOnDate(selectedDate)} openCreate={openCreate}
              setModal={setModal} events={events} groups={groups} use24h={use24h} weekStart={weekStart} />
          )}
          {blockedToast && (
            <div style={{ position:'fixed', bottom:90, left:'50%', transform:'translateX(-50%)',
              background:'#D45F7A', color:'#fff', borderRadius:12, padding:'12px 18px',
              fontSize:13, fontWeight:300, zIndex:200, whiteSpace:'nowrap',
              boxShadow:'0 4px 20px rgba(0,0,0,0.3)' }}>
              You were removed from this group and cannot rejoin with this link.
            </div>
          )}
          {tab === 'groups' && (
            <GroupsTab th={th} groups={groups} profile={profile} sync={sync} db={db} readyGroupKeys={readyGroupKeys}
              onNewGroup={() => setNewGroupOpen(true)}
              onSettings={g => setSettingsGroup({ ...g })}
              onQrGroup={g => setQrGroup(g)}
              closeInviteSheetRef={closeInviteSheetRef}
              onJoined={g => setGroups(prev => prev.find(x => x.id === g.id) ? prev : [...prev, g])}
              joinOpen={joinOpen} setJoinOpen={setJoinOpen} />
          )}
          {tab === 'profile' && (
            <ProfileTab th={th} profile={profile} groups={groups} onUpdateProfile={updateProfile}
              db={db} events={events} setEvents={setEvents} dark={dark}
              onToggleDark={() => { const nd = !dark; setDark(nd); updateProfile({ dark: nd }) }} />
          )}
          {tab === 'about' && (
            <AboutTab th={th} sync={sync} closeSheetRef={closeAboutSheetRef} />
          )}
          </div>
        </div>

        {/* Bottom Nav */}
        <div style={{
          position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
          width: '100%', maxWidth: 430,
          background: 'var(--color-bg)',
          display: 'flex',
          borderTop: '1px solid var(--color-border)',
          paddingBottom: 'var(--safe-area-bottom)',
          zIndex: 50,
        }}>
          {[
            { key: 'calendar', Icon: CalendarBlank, label: 'Calendar' },
            { key: 'groups',   Icon: Users,         label: 'Groups'   },
            { key: 'profile',  Icon: User,          label: 'Profile'  },
            { key: 'about',    Icon: Info,          label: 'About'    },
          ].map(t => {
            const isActive = tab === t.key
            return (
              <button key={t.key} onClick={() => goTab(t.key)}
                style={{
                  flex: 1, padding: '10px 0 8px', border: 'none', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                  fontFamily: FONT, background: 'none', position: 'relative',
                }}>
                {isActive && (
                  <div style={{
                    position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
                    width: 24, height: 2, borderRadius: 1,
                    background: 'var(--color-accent)',
                  }} />
                )}
                <t.Icon
                  size={20}
                  weight="thin"
                  color={isActive ? 'var(--color-accent)' : 'var(--color-muted)'}
                />
                <span style={{
                  fontSize: 10, fontWeight: 400,
                  color: isActive ? 'var(--color-accent)' : 'var(--color-muted)',
                }}>
                  {t.label}
                </span>
              </button>
            )
          })}
        </div>

        {/* Modals */}
        {showOnboarding && <OnboardingModal th={th} step={onboardStep} setStep={setOnboardStep}
          profile={profile} onUpdateProfile={updateProfile} db={db} sync={sync}
          onComplete={async () => { await db.updateProfile({ onboardingComplete: true }); const p = await db.getProfile(); setProfile(p) }} />}
        {showDonationReminder && !showOnboarding && (
          <DonationReminderModal th={th} sync={sync}
            onDonate={() => {
              updateProfile({ donationReminderShown: true })
              setShowDonationReminder(false)
              goTab('about')
            }}
            onDismiss={() => {
              updateProfile({ donationReminderShown: true })
              setShowDonationReminder(false)
            }}
          />
        )}
        {qrGroup && <QRModal th={th} link={qrGroup.link} onClose={() => setQrGroup(null)} />}
        {modal && (
          <EventModal th={th} modal={modal} setModal={setModal} groups={groups} profile={profile} db={db}
            onSave={saveEvent} onDelete={deleteEvent} onDeleteSeries={deleteEventSeries} REMINDER_OPTIONS={REMINDER_OPTIONS} />
        )}
        {joinOpen && (
          <JoinGroupModal th={th} onClose={() => setJoinOpen(false)}
            closeRef={closeJoinSheetRef} db={db} sync={sync}
            onPendingJoin={pj => { setJoinOpen(false); openPendingJoin(pj.url) }}
            onJoined={g => setGroups(prev => prev.find(x => x.id === g.id) ? prev : [...prev, g])} />
        )}
        {pendingJoin && (
          <NicknameBeforeJoinSheet th={th} groupName={pendingJoin.groupName}
            defaultName={profile?.name ?? ''} closeRef={closePendingJoinRef}
            onConfirm={nickname => joinWithNickname(pendingJoin.url, nickname)}
            onClose={() => setPendingJoin(null)} />
        )}
        {newGroupOpen && (
          <NewGroupModal th={th} onClose={() => { setNewGroupOpen(false); newGroupKeyUpdatedRef.current = null }}
            onAdd={addGroup} onUpdate={updateGroup} me={profile} sync={sync}
            onGroupKeyUpdated={fn => { newGroupKeyUpdatedRef.current = fn }} />
        )}
        {settingsGroup && (
          <GroupSettingsModal th={th} group={settingsGroup} me={profile} db={db} sync={sync}
            onMemberLeft={async (gid, uid) => sync?.memberLeft(gid, uid).catch(() => {})}
            onClose={() => setSettingsGroup(null)}
            onUpdate={updateGroup} onDelete={deleteGroup}
            onNicknameChange={async (groupId, nick) => {
              await db.setMemberNickname(groupId, nick).catch(() => {})
              setGroups(prev => prev.map(g => g.id === groupId
                ? { ...g, members: (g.members ?? []).map(m => m.id === profile?.id ? { ...m, nickname: nick } : m) }
                : g))
            }} />
        )}
      </div>
    </div>
  )
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function todayStr () {
  const t = new Date()
  return dateStr(t.getFullYear(), t.getMonth(), t.getDate())
}
function dateStr (y, m, d) {
  return `${y}-${String(m + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
}

// ─── Shared sub-components ────────────────────────────────────────────────────
function Label ({ th, children }) {
  return <div style={{ fontSize:12, fontWeight:300, color:th.muted, marginBottom:4, letterSpacing:'0.04em' }}>{children}</div>
}

function Toggle ({ val, onChange, accent }) {
  return (
    <div onClick={() => { window.__pearSync?.haptic('light'); onChange(!val) }}
      style={{ width:44, height:24, borderRadius:12, background:val?accent:'#555',
        cursor:'pointer', position:'relative', transition:'background 0.2s' }}>
      <div style={{ position:'absolute', top:2, left:val?22:2, width:20, height:20,
        borderRadius:'50%', background:'#fff', transition:'left 0.2s' }} />
    </div>
  )
}

function InfoRow ({ th, label, val }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:`1px solid ${th.border}` }}>
      <span style={{ fontSize:13, color:th.muted, fontWeight:300 }}>{label}</span>
      <span style={{ fontSize:13, fontWeight:300, ...th.text }}>{val}</span>
    </div>
  )
}

function GroupIcon ({ group, size = 42, radius = 12 }) {
  return (
    <div style={{ width:size, height:size, borderRadius:radius, background:group.color,
      overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center',
      fontSize:size * 0.5, flexShrink:0 }}>
      {group.icon
        ? <img src={group.icon} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
        : group.emoji}
    </div>
  )
}

/**
 * MemberAvatar — renders a member's avatar circle.
 * If avatar is a base64/data URL, renders as an <img>.
 * Otherwise renders initials text.
 */
function MemberAvatar ({ avatar, name = '?', color = '#6C9BF5', size = 34, fontSize = 13 }) {
  const isPhoto = typeof avatar === 'string' && avatar.startsWith('data:')
  return (
    <div style={{ width:size, height:size, borderRadius:'50%', background:color,
      display:'flex', alignItems:'center', justifyContent:'center',
      overflow:'hidden', flexShrink:0 }}>
      {isPhoto
        ? <img src={avatar} alt={name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
        : <span style={{ color:'#fff', fontWeight:300, fontSize, lineHeight:1 }}>{avatar || '?'}</span>
      }
    </div>
  )
}

/**
 * compressAvatar — resize & JPEG-compress a File to a base64 data URL.
 * Target: 80×80px, JPEG quality 0.65 ≈ 10–20 KB.
 */
function compressAvatar (file) {
  // For animated formats, skip canvas compression (canvas strips animation)
  if (file.type === 'image/gif' || file.type === 'image/webp') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = e => resolve(e.target.result)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = ev => {
      const img = new Image()
      img.onload = () => {
        const SIZE = 80
        const canvas = document.createElement('canvas')
        canvas.width = SIZE
        canvas.height = SIZE
        const ctx = canvas.getContext('2d')
        // Centre-crop to square
        const side = Math.min(img.width, img.height)
        const sx = (img.width - side) / 2
        const sy = (img.height - side) / 2
        ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE)
        resolve(canvas.toDataURL('image/jpeg', 0.65))
      }
      img.onerror = reject
      img.src = ev.target.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ─── Calendar Tab ─────────────────────────────────────────────────────────────

// ─── Holiday Helpers ──────────────────────────────────────────────────────────
function computeEaster (year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return { month, day }
}



// ─── US Federal Holidays ──────────────────────────────────────────────────────
function getUSFederalHolidays (year) {
  function pad (n) { return String(n).padStart(2, '0') }
  function ymd (y, m, d) { return `${y}-${pad(m)}-${pad(d)}` }
  // Observed date: Sat→Fri, Sun→Mon
  function observed (y, m, d) {
    const dow = new Date(y, m - 1, d).getDay()
    if (dow === 6) return ymd(y, m, d - 1)
    if (dow === 0) return ymd(y, m, d + 1)
    return ymd(y, m, d)
  }
  // Nth weekday of month: e.g. nthWeekday(year,1,1,3) = 3rd Monday of Jan
  function nthWeekday (y, m, weekday, n) {
    let d = 1
    const first = new Date(y, m - 1, 1).getDay()
    d += (weekday - first + 7) % 7
    d += (n - 1) * 7
    return ymd(y, m, d)
  }
  // Last weekday of month
  function lastWeekday (y, m, weekday) {
    const last = new Date(y, m, 0).getDate()
    const lastDow = new Date(y, m - 1, last).getDay()
    const d = last - ((lastDow - weekday + 7) % 7)
    return ymd(y, m, d)
  }
  return [
    { title: "New Year's Day",               date: observed(year, 1,  1)  },
    { title: 'Martin Luther King Jr. Day',   date: nthWeekday(year, 1, 1, 3) },
    { title: "Presidents' Day",              date: nthWeekday(year, 2, 1, 3) },
    { title: 'Memorial Day',                 date: lastWeekday(year, 5, 1)   },
    { title: 'Juneteenth',                   date: observed(year, 6, 19) },
    { title: 'Independence Day',             date: observed(year, 7,  4) },
    { title: 'Labor Day',                    date: nthWeekday(year, 9, 1, 1) },
    { title: 'Columbus Day',                 date: nthWeekday(year, 10, 1, 2)},
    { title: 'Veterans Day',                 date: observed(year, 11, 11) },
    { title: 'Thanksgiving Day',             date: nthWeekday(year, 11, 4, 4)},
    { title: 'Christmas Day',                date: observed(year, 12, 25) },
  ]
}

function getCanadaHolidays (year) {
  function pad (n) { return String(n).padStart(2, '0') }
  function ymd (y, m, d) { return `${y}-${pad(m)}-${pad(d)}` }
  function observed (y, m, d) {
    const dow = new Date(y, m - 1, d).getDay()
    if (dow === 6) return ymd(y, m, d - 1)
    if (dow === 0) return ymd(y, m, d + 1)
    return ymd(y, m, d)
  }
  function nthWeekday (y, m, weekday, n) {
    const first = new Date(y, m - 1, 1).getDay()
    let d = 1 + (weekday - first + 7) % 7 + (n - 1) * 7
    return ymd(y, m, d)
  }
  const { month: em, day: ed } = computeEaster(year)
  const easter = new Date(year, em - 1, ed)
  function easterOffset (days) {
    const d = new Date(easter); d.setDate(d.getDate() + days)
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())
  }
  function victoriaDay () {
    const dow = new Date(year, 4, 24).getDay()
    return ymd(year, 5, 24 - ((dow - 1 + 7) % 7))
  }
  return [
    { title: "New Year's Day",                            date: observed(year, 1,  1)  },
    { title: 'Good Friday',                               date: easterOffset(-2)       },
    { title: 'Victoria Day',                              date: victoriaDay()          },
    { title: 'Canada Day',                                date: observed(year, 7,  1)  },
    { title: 'Labour Day',                                date: nthWeekday(year, 9, 1, 1) },
    { title: 'National Day for Truth and Reconciliation', date: observed(year, 9, 30)  },
    { title: 'Thanksgiving',                              date: nthWeekday(year, 10, 1, 2) },
    { title: 'Remembrance Day',                           date: observed(year, 11, 11) },
    { title: 'Christmas Day',                             date: observed(year, 12, 25) },
    { title: 'Boxing Day',                                date: observed(year, 12, 26) },
  ]
}

function getUKHolidays (year) {
  function pad (n) { return String(n).padStart(2, '0') }
  function ymd (y, m, d) { return `${y}-${pad(m)}-${pad(d)}` }
  function observed (y, m, d) {
    const dow = new Date(y, m - 1, d).getDay()
    if (dow === 6) return ymd(y, m, d - 1)
    if (dow === 0) return ymd(y, m, d + 1)
    return ymd(y, m, d)
  }
  function nthWeekday (y, m, weekday, n) {
    const first = new Date(y, m - 1, 1).getDay()
    let d = 1 + (weekday - first + 7) % 7 + (n - 1) * 7
    return ymd(y, m, d)
  }
  function lastWeekday (y, m, weekday) {
    const last = new Date(y, m, 0).getDate()
    const lastDow = new Date(y, m - 1, last).getDay()
    return ymd(y, m, last - ((lastDow - weekday + 7) % 7))
  }
  const { month: em, day: ed } = computeEaster(year)
  const easter = new Date(year, em - 1, ed)
  function easterOffset (days) {
    const d = new Date(easter); d.setDate(d.getDate() + days)
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())
  }
  return [
    { title: "New Year's Day",          date: observed(year, 1, 1)     },
    { title: 'Good Friday',             date: easterOffset(-2)         },
    { title: 'Easter Monday',           date: easterOffset(1)          },
    { title: 'Early May Bank Holiday',  date: nthWeekday(year, 5, 1, 1)},
    { title: 'Spring Bank Holiday',     date: lastWeekday(year, 5, 1)  },
    { title: 'Summer Bank Holiday',     date: lastWeekday(year, 8, 1)  },
    { title: 'Christmas Day',           date: observed(year, 12, 25)   },
    { title: 'Boxing Day',              date: observed(year, 12, 26)   },
  ]
}

function CalendarTab ({ th, viewDate, setViewDate, calDays, selectedDate, setSelectedDate,
  eventsOnDate, todayStr, dateStr, selectedEvents, openCreate, setModal, events, groups, use24h, weekStart }) {
  const { y, m } = viewDate
  const [showMonthPicker, setShowMonthPicker] = useState(false)
  const [showYearPicker,  setShowYearPicker]  = useState(false)
  const [slideDir,        setSlideDir]        = useState(0)
  const [isSliding,       setIsSliding]       = useState(false)
  const touchStartX = useRef(null)
  const scrollRef = useRef(null)
  const isProgrammaticScroll = useRef(false)
  const isUserScrolling = useRef(false)
  const userScrollTimer = useRef(null)
  const scrollToDateRef = useRef(null)
  const [filterGroupIds, setFilterGroupIds] = useState(new Set())
  const handleScroll = () => {
    if (isProgrammaticScroll.current) return
    isUserScrolling.current = true
    clearTimeout(userScrollTimer.current)
    userScrollTimer.current = setTimeout(() => { isUserScrolling.current = false }, 400)
    const container = scrollRef.current
    if (!container) return
    const containerTop = container.getBoundingClientRect().top
    const sections = [...container.querySelectorAll('[data-date]')]
    let active = null
    for (const el of sections) {
      if (el.getBoundingClientRect().top - containerTop <= 40) active = el.dataset.date
    }
    if (active && active !== selectedDate) {
      setSelectedDate(active)
      const d = new Date(active + 'T12:00:00')
      const newY = d.getFullYear(); const newM = d.getMonth()
      setViewDate(prev => {
        if (prev.y === newY && prev.m === newM) return prev
        setSlideDir(0); setIsSliding(true)
        setTimeout(() => setIsSliding(false), 220)
        return { y: newY, m: newM }
      })
    }
  }
  const years = Array.from({ length:16 }, (_, i) => 2020 + i)
  const scrollToDate = (date) => {
    const container = scrollRef.current
    if (!container) return
    const el = container.querySelector('[data-date="' + date + '"]')
    if (!el) return
    isProgrammaticScroll.current = true
    const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    container.scrollTo({ top, behavior: 'smooth' })
    setTimeout(() => { isProgrammaticScroll.current = false }, 600)
  }

  function navigate (dir) {
    if (isSliding) return
    setSlideDir(dir)
    setIsSliding(true)
    setTimeout(() => {
      if (dir === -1) setViewDate(v => v.m === 11 ? { y:v.y+1, m:0 } : { y:v.y, m:v.m+1 })
      else            setViewDate(v => v.m === 0  ? { y:v.y-1, m:11 } : { y:v.y, m:v.m-1 })
      setSlideDir(0)
      setIsSliding(false)
    }, 220)
  }

  function prev () { navigate(1) }
  function next () { navigate(-1) }

  function onTouchStart (e) { touchStartX.current = e.touches[0].clientX }
  function onTouchEnd (e) {
    if (touchStartX.current === null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    touchStartX.current = null
    if (Math.abs(dx) < 40) return
    if (dx < 0) next(); else prev()
  }

  const dropStyle = { position:'absolute', top:'calc(100% + 6px)', left:'50%',
    transform:'translateX(-50%)', zIndex:80, borderRadius:12, padding:8,
    boxShadow:'0 8px 24px rgba(0,0,0,0.3)', border:`1px solid ${th.border}` }

  const pickBtn = active => ({
    padding:'7px 4px', borderRadius:8, border:'none', fontSize:12,
    cursor:'pointer', fontFamily:FONT, fontWeight:active ? 400 : 300,
    background:active ? th.accent : 'transparent',
    color:active ? '#fff' : th.text.color,
  })

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>
    <div style={{ padding:'0 16px 8px', flexShrink:0 }}>
      {/* Month / Year nav */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 0 8px' }}>
        <button onClick={prev} style={th.iconBtn}>◀</button>
        <div style={{ display:'flex', gap:4, alignItems:'center' }}>
          {/* Month picker */}
          <div style={{ position:'relative' }}>
            <button onClick={() => { setShowMonthPicker(v => !v); setShowYearPicker(false) }}
              style={{ ...th.iconBtn, fontWeight:300, fontSize:17, padding:'4px 8px',
                border:`1px solid ${showMonthPicker ? th.accent : th.border}`, borderRadius:8 }}>
              {MONTHS[m]} ▾
            </button>
            {showMonthPicker && (
              <div style={{ ...dropStyle, ...th.bg, display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:4, width:216 }}>
                {MONTHS.map((mn, i) => (
                  <button key={mn} style={pickBtn(m === i)}
                    onClick={() => { setViewDate(v => ({ ...v, m:i })); setShowMonthPicker(false) }}>
                    {mn.slice(0,3)}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Year picker */}
          <div style={{ position:'relative' }}>
            <button onClick={() => { setShowYearPicker(v => !v); setShowMonthPicker(false) }}
              style={{ ...th.iconBtn, fontWeight:300, fontSize:17, padding:'4px 8px',
                border:`1px solid ${showYearPicker ? th.accent : th.border}`, borderRadius:8 }}>
              {y} ▾
            </button>
            {showYearPicker && (
              <div style={{ ...dropStyle, ...th.bg, display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:4, width:224 }}>
                {years.map(yr => (
                  <button key={yr} style={pickBtn(y === yr)}
                    onClick={() => { setViewDate(v => ({ ...v, y:yr })); setShowYearPicker(false) }}>
                    {yr}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <button onClick={next} style={th.iconBtn}>▶</button>
      </div>

      {/* Today button */}
      <div style={{ display:'flex', justifyContent:'center', marginBottom:8 }}>
        <button onClick={() => {
          setViewDate({ y:parseInt(todayStr.slice(0,4)), m:parseInt(todayStr.slice(5,7)) - 1 })
          setSelectedDate(todayStr); scrollToDate(todayStr)
        }} style={{ ...th.pillBtn, fontSize:12, padding:'4px 16px', fontWeight:300 }}>⬤ Today</button>
      </div>

      <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
        style={{ overflow:'hidden', position:'relative' }}>
      <div style={{
        transform: slideDir === -1 ? 'translateX(-8%)' : slideDir === 1 ? 'translateX(8%)' : 'translateX(0)',
        opacity: isSliding ? 0 : 1,
        transition: isSliding ? 'transform 0.22s ease, opacity 0.22s ease' : 'none',
      }}>
      {/* Day headers */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', marginBottom:4 }}>
        {[...DAYS.slice(weekStart), ...DAYS.slice(0, weekStart)].map(d => (
          <div key={d} style={{ textAlign:'center', fontSize:12, fontWeight:300, color:th.muted, padding:'4px 0' }}>{d}</div>
        ))}
      </div>

      {/* Calendar grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2 }}>
        {calDays.map((cell, i) => {
          const ds  = dateStr(cell.y, cell.m, cell.d)
          const evs = eventsOnDate(ds)
          const isToday = ds === todayStr
          const isSel   = ds === selectedDate
          const isPast  = ds < todayStr
          const isCur   = cell.type === 'cur'
          return (
            <button key={ds + i} onClick={() => { window.__pearSync?.haptic('light'); setSelectedDate(ds); scrollToDate(ds) }}
              style={{ background:isSel ? th.accent : isToday ? th.accentFaint : 'none',
                border:'none', borderRadius:10, padding:'6px 2px', cursor:'pointer',
                display:'flex', flexDirection:'column', alignItems:'center', gap:2, fontFamily:FONT,
                opacity: isSel ? 1 : !isCur ? 0.25 : isPast ? 0.45 : 1 }}>
              <span style={{ fontSize:14, fontWeight:isToday||isSel ? 400 : isCur ? 300 : 200,
                color:isSel ? '#fff' : isToday ? th.accent : th.text.color }}>{cell.d}</span>
              <div style={{ display:'flex', gap:2, minHeight:6 }}>
                {evs.slice(0,3).map(e => (
                  <div key={e.id} style={{ width:6, height:6, borderRadius:'50%', background:e.colors?.[0] ?? e.color }} />
                ))}
              </div>
            </button>
          )
        })}
      </div>
      </div>
      </div>

    </div>

      {/* Static date header + add button */}
      <div style={{ padding:'8px 16px 8px', borderTop:'1px solid ' + th.border,
        display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
        <span style={{ fontWeight:400, fontSize:15, ...th.text }}>
          {selectedDate === todayStr ? 'Today · ' : ''}
          {selectedDate && new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US',
            { weekday:'long', month:'short', day:'numeric' })}
          {selectedDate < todayStr &&
            <span style={{ fontSize:11, color:th.muted, fontWeight:300, marginLeft:8 }}>past</span>}
        </span>
        <button onClick={() => openCreate(selectedDate)}
          style={{ ...th.pillBtn, fontSize:13, padding:'6px 14px', fontWeight:300, display:'flex', alignItems:'center', gap:4 }}><Plus size={14} weight="thin" color="#fff" /> Event</button>
      </div>
      {/* Group filter pills */}
      {groups && groups.length > 0 && (
        <div style={{ display:'flex', gap:6, overflowX:'auto', padding:'0 16px 10px',
          scrollbarWidth:'none', flexShrink:0 }}>
          <button onClick={() => setFilterGroupIds(new Set())} style={{
            flexShrink:0, fontSize:12, fontWeight:300, padding:'4px 12px',
            borderRadius:20, border:'1.5px solid ' + (filterGroupIds.size === 0 ? th.accent : th.border),
            background: filterGroupIds.size === 0 ? th.accent : 'transparent',
            color: filterGroupIds.size === 0 ? '#fff' : th.muted, cursor:'pointer' }}>
            All
          </button>
          {groups.map(g => (
            <button key={g.id} onClick={() => setFilterGroupIds(prev => {
              const next = new Set(prev)
              next.has(g.id) ? next.delete(g.id) : next.add(g.id)
              return next
            })} style={{
              flexShrink:0, fontSize:12, fontWeight:300, padding:'4px 12px',
              borderRadius:20, border:'1.5px solid ' + (filterGroupIds.has(g.id) ? g.color : th.border),
              background: filterGroupIds.has(g.id) ? g.color : 'transparent',
              color: filterGroupIds.has(g.id) ? '#fff' : th.muted, cursor:'pointer' }}>
              {g.name}
            </button>
          ))}
        </div>
      )}
      {/* Scrollable event list — flat, stable, never restructures */}
      <div ref={scrollRef} onScroll={handleScroll} style={{ flex:1, overflowY:'auto', padding:'0 16px 16px', minHeight:0 }}>
      {(() => {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30)
        const cutoffStr = cutoff.toISOString().slice(0,10)
        const seen = new Map()
        const days = []
        const filteredEvents = filterGroupIds.size > 0
          ? events.filter(e => (e.groups ?? []).some(gid => filterGroupIds.has(gid)))
          : events
        filteredEvents
          .filter(e => e.date >= cutoffStr)
          .sort((a,b) => a.date.localeCompare(b.date))
          .forEach(e => {
            if (!seen.has(e.date)) { seen.set(e.date, []); days.push(e.date) }
            seen.get(e.date).push(e)
          })
        return days.map(date => (
          <div key={date} data-date={date} style={{ marginBottom:20 }}>
            <div style={{ fontSize:12, fontWeight:400, color:th.muted, letterSpacing:'0.05em',
              marginBottom:8, paddingBottom:4, borderBottom:'1px solid ' + th.border }}>
              {date === todayStr ? 'TODAY' : new Date(date + 'T12:00:00').toLocaleDateString('en-US',
                { weekday:'long', month:'short', day:'numeric' }).toUpperCase()}
            </div>
            {seen.get(date).map((ev, i) => (
              <div key={ev.id} style={{ animation: `pearFadeUp 150ms var(--easing) ${i * 30}ms both` }}>
                <EventCard ev={ev} th={th} isPast={date < todayStr}
                  use24h={use24h} onClick={() => setModal({ mode:'edit', event:{ ...ev } })} />
              </div>
            ))}
          </div>
        ))
      })()}
      </div>

    </div>
  )
}

function DonationReminderModal ({ th, sync, onDonate, onDismiss }) {
  return (
    <div style={{ position:'fixed', inset:0, zIndex:490, background:'rgba(0,0,0,0.75)',
      display:'flex', alignItems:'center', justifyContent:'center', padding:'0 28px' }}>
      <div style={{ ...th.bg, borderRadius:20, padding:'32px 24px', width:'100%', maxWidth:360,
        display:'flex', flexDirection:'column', alignItems:'center', gap:16, textAlign:'center' }}>
        <div style={{ fontSize:52 }}>⚡</div>
        <div style={{ fontSize:20, fontWeight:400, ...th.text }}>Enjoying PearCal?</div>
        <div style={{ fontSize:14, fontWeight:300, color:th.muted, lineHeight:'1.7' }}>
          PearCal is free and open source with no ads or subscriptions. If you've received value from it, consider returning value to support development.
        </div>
        <button onClick={onDonate}
          style={{ ...th.pillBtn, width:'100%', padding:'13px', fontSize:15, fontWeight:300,
            display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          Donate
        </button>
        <button onClick={onDismiss}
          style={{ background:'none', border:'none', color:th.muted, fontSize:13,
            fontWeight:300, cursor:'pointer', fontFamily:FONT, padding:'4px' }}>
          Maybe later
        </button>
        <button onClick={onDismiss}
          style={{ background:'none', border:'none', color:th.muted, fontSize:13,
            fontWeight:300, cursor:'pointer', fontFamily:FONT, padding:'4px' }}>
          Already donated ✓
        </button>
      </div>
    </div>
  )
}

function OnboardingModal ({ th, step, setStep, profile, onUpdateProfile, db, sync, onComplete }) {
  const [name, setName] = useState(profile?.name ?? '')
  const [saving, setSaving] = useState(false)
  const [photoSaving, setPhotoSaving] = useState(false)
  const fileRef = useRef(null)
  const total = 5
  const [slideDir, setSlideDir] = useState(1)

  async function handlePhotoChange (e) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    setPhotoSaving(true)
    try {
      const compressed = await compressAvatar(file)
      await onUpdateProfile({ avatar: compressed })
    } catch (err) { console.error('Photo compress failed', err) }
    setPhotoSaving(false)
    e.target.value = ''
  }

  async function saveName () {
    if (!name.trim()) return
    setSaving(true)
    await onUpdateProfile({ name: name.trim() })
    setSaving(false)
    setSlideDir(1); setStep(s => s + 1)
  }

  const hasPhoto = profile?.avatar?.startsWith?.('data:')
  const dots = Array.from({ length: total }, (_, i) => i)

  const slides = [
    // Slide 0 — Welcome
    <div key={0} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:20, flex:1, justifyContent:'center' }}>
      <PearIcon size={56} />
      <div style={{ marginBottom: 0 }} />
      <div style={{ fontSize:24, fontWeight:400, ...th.text, textAlign:'center' }}>Welcome to PearCal</div>
      <div style={{ fontSize:15, fontWeight:300, color:th.muted, textAlign:'center', lineHeight:'1.6', maxWidth:280 }}>
        A private shared calendar that works without servers, accounts, or subscriptions.
      </div>
      <button onClick={() => { setSlideDir(1); setStep(1) }}
        style={{ ...th.pillBtn, padding:'12px 40px', fontSize:16, fontWeight:300, marginTop:8 }}>
        Get Started
      </button>
    </div>,

    // Slide 1 — How P2P works
    <div key={1} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:20, flex:1, justifyContent:'center' }}>
      <div style={{ fontSize:48 }}>🔗</div>
      <div style={{ fontSize:22, fontWeight:400, ...th.text, textAlign:'center' }}>No servers. No accounts.</div>
      <div style={{ fontSize:14, fontWeight:300, color:th.muted, textAlign:'center', lineHeight:'1.7', maxWidth:290 }}>
        PearCal syncs directly between devices using peer-to-peer technology. Your calendar data never touches a server — it lives only on the devices you share it with.
      </div>
      <div style={{ fontSize:13, fontWeight:300, color:th.muted, textAlign:'center', maxWidth:280 }}>
        Share invite links or QR codes to connect with group members.
      </div>
      <button onClick={() => { setSlideDir(1); setStep(2) }}
        style={{ ...th.pillBtn, padding:'12px 40px', fontSize:16, fontWeight:300, marginTop:8 }}>
        Next
      </button>
    </div>,

    // Slide 2 — Name entry
    <div key={2} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:20, flex:1, justifyContent:'center' }}>
      <div style={{ fontSize:48 }}>👤</div>
      <div style={{ fontSize:22, fontWeight:400, ...th.text, textAlign:'center' }}>What's your name?</div>
      <div style={{ fontSize:14, fontWeight:300, color:th.muted, textAlign:'center', maxWidth:280 }}>
        This is how you'll appear to group members in shared groups.
      </div>
      <input value={name} onChange={e => setName(e.target.value)}
        placeholder="Your name"
        style={{ background:th.inputBg, border:`1px solid ${th.border}`, borderRadius:10,
          padding:'12px 16px', color:th.text.color, fontSize:16, fontWeight:300,
          fontFamily:FONT, width:'100%', boxSizing:'border-box', outline:'none', textAlign:'center' }} />

      <button onClick={saveName} disabled={!name.trim() || name.trim().toLowerCase() === 'my name' || saving}
        style={{ ...th.pillBtn, padding:'12px 40px', fontSize:16, fontWeight:300,
          opacity: name.trim() && name.trim().toLowerCase() !== 'my name' ? 1 : 0.4 }}>
        {saving ? 'Saving…' : 'Continue'}
      </button>
    </div>,

    // Slide 3 — Photo upload
    <div key={3} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:20, flex:1, justifyContent:'center' }}>
      <div style={{ width:96, height:96, borderRadius:'50%', background:profile?.color ?? '#6C9BF5',
        display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:40, color:'#fff', fontWeight:300, overflow:'hidden',
        opacity: photoSaving ? 0.5 : 1, transition:'opacity 0.2s' }}>
        {hasPhoto
          ? <img src={profile.avatar} alt="avatar" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
          : (profile?.name ?? '?').slice(0,1).toUpperCase()}
      </div>
      <div style={{ fontSize:22, fontWeight:400, ...th.text, textAlign:'center' }}>Add a photo</div>
      <div style={{ fontSize:14, fontWeight:300, color:th.muted, textAlign:'center', maxWidth:280 }}>
        Optional — helps group members recognise you in shared groups.
      </div>
      <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }} onChange={handlePhotoChange} />
      <div style={{ display:'flex', gap:10 }}>
        <button onClick={() => sync?.takePhoto?.()} disabled={photoSaving}
          style={{ ...th.pillBtn, padding:'12px 20px', fontSize:15, fontWeight:300 }}>
          📷 Camera
        </button>
        <button onClick={() => {
            if (fileRef.current) { fileRef.current.removeAttribute('capture'); fileRef.current.click() }
          }} disabled={photoSaving}
          style={{ ...th.pillBtn, padding:'12px 20px', fontSize:15, fontWeight:300 }}>
          🖼️ Gallery
        </button>
      </div>
      <button onClick={() => { setSlideDir(1); setStep(4) }}
        style={{ ...th.pillBtn, padding:'12px 40px', fontSize:16, fontWeight:300 }}>
        {hasPhoto ? 'Continue' : 'Skip for now'}
      </button>
    </div>,

    // Slide 4 — Groups & Invites
    <div key={4} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:20, flex:1, justifyContent:'center' }}>
      <div style={{ fontSize:48 }}>👥</div>
      <div style={{ fontSize:22, fontWeight:400, ...th.text, textAlign:'center' }}>Sharing with others</div>
      <div style={{ display:'flex', flexDirection:'column', gap:16, width:'100%', maxWidth:300 }}>
        <div style={{ display:'flex', gap:14, alignItems:'flex-start' }}>
          <span style={{ fontSize:22, flexShrink:0, ...th.text }}>＋</span>
          <div style={{ fontSize:14, fontWeight:300, color:th.muted, lineHeight:'1.6' }}>
            Go to the <span style={{ ...th.text, fontWeight:400 }}>Groups tab</span> and tap <span style={{ ...th.text, fontWeight:400 }}>+ New Group</span> to create a group.
          </div>
        </div>
        <div style={{ display:'flex', gap:14, alignItems:'flex-start' }}>
          <ShareNetwork size={22} weight="thin" color="var(--color-muted)" style={{ flexShrink:0 }} />
          <div style={{ fontSize:14, fontWeight:300, color:th.muted, lineHeight:'1.6' }}>
            Share the invite link or QR code from a group to let others join.
          </div>
        </div>
        <div style={{ display:'flex', gap:14, alignItems:'flex-start' }}>
          <span style={{ fontSize:22, flexShrink:0 }}>📅</span>
          <div style={{ fontSize:14, fontWeight:300, color:th.muted, lineHeight:'1.6' }}>
            Tap any day on the calendar, hit <span style={{ ...th.text, fontWeight:400 }}>+ Event</span>, and assign it to a group to share it.
          </div>
        </div>
      </div>
      <button onClick={() => { onComplete?.() }}
        style={{ ...th.pillBtn, padding:'12px 40px', fontSize:16, fontWeight:300, marginTop:4 }}>
        Let's go!
      </button>
    </div>
  ]

  return (
    <div style={{ position:'fixed', inset:0, zIndex:500, ...th.bg,
      display:'flex', flexDirection:'column', padding:'48px 28px 32px',
      animation: 'pearFadeUp 150ms var(--easing) both' }}>
      {/* Back button */}
      {step > 0 && (
        <button onClick={() => { setSlideDir(-1); setStep(s => s - 1) }}
          style={{ position:'absolute', top:48, left:24, background:'none', border:'none',
            color:th.muted, cursor:'pointer', fontFamily:FONT, padding:4 }}>
          <CaretLeft size={24} weight="thin" />
        </button>
      )}
      {/* Slide content */}
      <div key={step} style={{ flex:1, display:'flex', flexDirection:'column',
        animation: `${slideDir >= 0 ? 'pearSlideInRight' : 'pearSlideInLeft'} 0.22s ease` }}>
        {slides[step]}
      </div>
      {/* Dots */}
      <div style={{ display:'flex', gap:6, justifyContent:'center', marginTop:16 }}>
        {dots.map(i => (
          <div key={i} style={{ width: i === step ? 18 : 6, height:6, borderRadius:3,
            background: i === step ? th.accent : th.border,
            transition:'width 0.2s, background 0.2s' }} />
        ))}
      </div>
    </div>
  )
}

function QRModal ({ th, link, onClose }) {
  const canvasRef = useRef(null)
  const [qrError, setQrError] = useState(null)
  useEffect(() => {
    if (!canvasRef.current || !link) return
    try {
      QRCode.toCanvas(canvasRef.current, link, { width: 260, margin: 2 }, (err) => {
        if (err) setQrError(err.message)
      })
    } catch(e) { setQrError(e.message) }
  }, [link])
  return (
    <div style={{ position:'fixed', top:0, left:0, right:0, bottom:0, zIndex:9999,
      background:'rgba(0,0,0,0.55)', display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={onClose}>
      <div style={{ ...th.card, borderRadius:16, padding:24, display:'flex',
        flexDirection:'column', alignItems:'center', gap:16, width:280 }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:16, fontWeight:400, ...th.text }}>Scan to Join</div>
        {qrError
          ? <div style={{ fontSize:11, color:'red' }}>QR error: {qrError}</div>
          : <canvas ref={canvasRef} style={{ borderRadius:8 }} />}
        <div style={{ fontSize:11, color:th.muted, fontWeight:300, textAlign:'center',
          wordBreak:'break-all' }}>{link}</div>
        <button onClick={onClose} style={{ ...th.pillBtn, width:'100%', padding:'10px', fontSize:14 }}>
          Close
        </button>
      </div>
    </div>
  )
}

function EventCard ({ ev, th, onClick, compact, isPast, use24h }) {
  return (
    <div onClick={() => { window.__pearSync?.haptic('light'); onClick?.() }}
      style={{ display:'flex', gap:12, alignItems:'flex-start',
        padding:compact ? '10px 12px' : '12px 14px',
        borderRadius:12, cursor:'pointer', ...th.card,
        borderLeft:`4px solid ${(ev.colors?.[0] ?? ev.color)}`, marginBottom:compact ? 0 : 8,
        opacity: isPast ? 0.5 : 1 }}>
      <div style={{ flex:1 }}>
        <div style={{ fontWeight:300, fontSize:compact ? 13 : 15, ...th.text }}>{ev.title}</div>
        <div style={{ fontSize:12, color:th.muted, marginTop:2, fontWeight:300 }}>
          {ev.allDay ? 'All day' : `${formatTime(ev.start, use24h)} – ${formatTime(ev.end, use24h)}`}
          {compact && ` · ${new Date(ev.date + 'T12:00:00').toLocaleDateString('en-US',
            { month:'short', day:'numeric' })}`}
        </div>
        {!compact && ev.desc ? <div style={{ fontSize:12, color:th.muted, marginTop:4, fontWeight:300,
          overflow:'hidden', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical',
          lineHeight:'1.35' }}>{ev.desc}</div> : null}
      </div>
      {!compact && ev.location ? (
        <>
          <div style={{ width:1, background:th.border, alignSelf:'stretch', marginTop:2, marginBottom:2, flexShrink:0 }} />
          <div onClick={e => { e.stopPropagation(); window.__pearSync?.openURL('geo:0,0?q=' + encodeURIComponent(ev.location)) }}
            style={{ width:96, display:'flex', alignItems:'center', justifyContent:'center',
              cursor:'pointer', flexShrink:0, padding:'0 6px', gap:4 }}>
            <MapPin size={13} weight="thin" color="var(--color-muted)" style={{ flexShrink: 0 }} />
            <div style={{ fontSize:11, color:th.accent, fontWeight:300, textDecoration:'underline',
              textAlign:'left', lineHeight:'1.35',
              overflow:'hidden', display:'-webkit-box', WebkitLineClamp:3, WebkitBoxOrient:'vertical' }}>
              {ev.location}
            </div>
          </div>
        </>
      ) : null}
      <div style={{ display:'flex', flexDirection:'column', gap:3, alignItems:'center', marginTop:2, flexShrink:0 }}>
        {(ev.colors?.length > 0 ? ev.colors : [ev.color]).map((c, i) => (
          <div key={i} style={{ width:8, height:8, borderRadius:'50%', background:c }} />
        ))}
      </div>
    </div>
  )
}

// ─── Event Modal ──────────────────────────────────────────────────────────────
function expandRecurring (ev) {
  if (!ev.recurrence || ev.recurrence === 'none' || !ev.recurrenceEnd) return [ev]
  const fmt = d => String(d.getFullYear()) + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
  const parse = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d) }
  const end = parse(ev.recurrenceEnd)
  let cur = parse(ev.date)
  if (cur > end) return [ev]
  const recurrenceId = ev.id
  const out = []
  let i = 0
  while (cur <= end && i < 500) {
    out.push({ ...ev, id: i === 0 ? ev.id : ev.id + '_r' + i, date: fmt(cur), recurrenceId })
    if (ev.recurrence === 'daily')         cur.setDate(cur.getDate() + 1)
    else if (ev.recurrence === 'weekly')   cur.setDate(cur.getDate() + 7)
    else if (ev.recurrence === 'biweekly') cur.setDate(cur.getDate() + 14)
    else if (ev.recurrence === 'monthly')  cur.setMonth(cur.getMonth() + 1)
    else if (ev.recurrence === 'monthly-nth') {
      cur.setDate(1); cur.setMonth(cur.getMonth() + 1)
      const wd = ev.recurrenceWeekday ?? 0; const nth = ev.recurrenceNth ?? 1
      let count = 0
      while (true) {
        if (cur.getDay() === wd) { count++; if (count === nth) break }
        cur.setDate(cur.getDate() + 1)
      }
    }
    else if (ev.recurrence === 'yearly')   cur.setFullYear(cur.getFullYear() + 1)
    i++
  }
  return out
}

function EventModal ({ th, modal, setModal, groups, profile, onSave, onDelete, onDeleteSeries, REMINDER_OPTIONS, db }) {
  const [ev, setEv] = useState(modal.event)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [scopePending, setScopePending] = useState(null)
  const origDate = modal.mode === 'edit' ? modal.event.date : null
  const set = (k, v) => setEv(e => ({ ...e, [k]:v }))

  function toggleGroup (gid) {
    setEv(e => ({ ...e, groups: e.groups.includes(gid)
      ? e.groups.filter(x => x !== gid) : [...e.groups, gid] }))
  }

  const allMembers = useMemo(() => {
    const seen = {}, res = []
    ev.groups.forEach(gid => {
      const g = groups.find(x => x.id === gid)
      if (g) g.members.forEach(m => {
        if (!seen[m.id] && m.id !== 'u1' && m.id !== profile?.id) { seen[m.id] = true; res.push(m) }
      })
    })
    return res
  }, [ev.groups, groups])

  function toggleInvitee (uid) {
    setEv(e => ({ ...e, invitees: e.invitees.includes(uid)
      ? e.invitees.filter(x => x !== uid) : [...e.invitees, uid] }))
  }

  useEffect(() => {
    const cols = ev.groups.map(gid => groups.find(x => x.id === gid)?.color).filter(Boolean)
    if (cols.length > 0) setEv(e => ({ ...e, color: cols[0], colors: cols }))
    else setEv(e => ({ ...e, colors: [] }))
  }, [ev.groups, groups])

  const [titleErr, setTitleErr] = useState('')
  const [pastTitles, setPastTitles] = useState([])
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  useEffect(() => {
    db.listEvents().then(evts => {
      const seen = new Set()
      const titles = []
      for (const e of (evts ?? [])) {
        if (e.title && !seen.has(e.title)) { seen.add(e.title); titles.push(e.title) }
      }
      setPastTitles(titles)
    }).catch(() => {})
  }, [])

  async function handleSave () {
    if (!ev.title.trim()) { setTitleErr('Event title is required.'); return }
    setTitleErr('')
    const toSave = origDate && origDate !== ev.date ? { ...ev, _prevDate: origDate } : ev
    if (modal.mode === 'edit' && ev.recurrenceId) {
      const origGroups   = [...(modal.event.groups   ?? [])].sort().join(',')
      const newGroups    = [...(toSave.groups         ?? [])].sort().join(',')
      const origInvitees = [...(modal.event.invitees  ?? [])].sort().join(',')
      const newInvitees  = [...(toSave.invitees       ?? [])].sort().join(',')
      if (origGroups !== newGroups || origInvitees !== newInvitees) {
        setSaving(true); await onSave(toSave, 'future', { propagateGroups: true }); setSaving(false); return
      }
      setScopePending(toSave); return
    }
    setSaving(true)
    await onSave(toSave, 'one')
    setSaving(false)
  }

  const bsCloseRef = useRef(null)
  const inp = {
    background: 'var(--color-bg)', border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)', padding: '10px 14px',
    color: 'var(--color-text)', fontSize: 16, fontWeight: 300,
    fontFamily: FONT, width: '100%', boxSizing: 'border-box', outline: 'none',
    transition: 'border-color var(--duration-fast) var(--easing)',
  }

  return (
    <BottomSheet th={th} onClose={() => setModal(null)} zIndex={100} closeRef={bsCloseRef}>
      <div style={{ padding:'12px 20px 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontWeight:300, fontSize:17, ...th.text }}>
            {modal.mode === 'create' ? 'New Event' : 'Edit Event'}
          </span>
          <button onClick={() => bsCloseRef.current?.()} style={{ ...th.iconBtn, fontSize:20 }}>✕</button>
        </div>
                {(() => {
          const _ro = modal.mode === 'edit' && ev.editPermission === 'creator' &&
            !(ev.creatorId && profile?.id && ev.creatorId === profile.id)
          return null
        })()}
        <div style={{ padding:'16px 20px', display:'flex', flexDirection:'column', gap:14,
          animation: 'pearFadeUp 150ms var(--easing) both' }}>
          <div style={{ display:'flex', flexDirection:'column', gap:14,
            opacity: (modal.mode === 'edit' && (ev.creatorId === 'system' || (ev.editPermission === 'creator' &&
              !(ev.creatorId && profile?.id && ev.creatorId === profile.id)))) ? 0.45 : 1,
            pointerEvents: (modal.mode === 'edit' && (ev.creatorId === 'system' || (ev.editPermission === 'creator' &&
              !(ev.creatorId && profile?.id && ev.creatorId === profile.id)))) ? 'none' : 'auto' }}>
          <div style={{ position:'relative' }}>
            <input style={{ ...inp, borderColor: titleErr ? '#D45F7A' : inp.border }}
              placeholder="Event title" value={ev.title}
              onChange={e => {
                const val = e.target.value
                set('title', val)
                if (val.trim()) setTitleErr('')
                if (val.trim().length >= 1) {
                  const q = val.toLowerCase()
                  const matches = pastTitles.filter(t => t.toLowerCase().includes(q) && t !== val).slice(0, 5)
                  setSuggestions(matches)
                  setShowSuggestions(matches.length > 0)
                } else {
                  setShowSuggestions(false)
                }
              }}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)} />
            {showSuggestions && (
              <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:50,
                background:th.inputBg, border:`1px solid ${th.border}`, borderRadius:8,
                marginTop:2, overflow:'hidden', boxShadow:'0 4px 16px rgba(0,0,0,0.3)' }}>
                {suggestions.map((s, i) => (
                  <div key={i}
                    onMouseDown={() => { set('title', s); setShowSuggestions(false) }}
                    onClick={() => { set('title', s); setShowSuggestions(false) }}
                    style={{ padding:'10px 12px', fontSize:14, fontWeight:300, color:th.text.color,
                      cursor:'pointer', borderBottom: i < suggestions.length - 1 ? `1px solid ${th.border}` : 'none' }}>
                    {s}
                  </div>
                ))}
              </div>
            )}
            {titleErr && <div style={{ color:'#D45F7A', fontSize:12, fontWeight:300, marginTop:4 }}>{titleErr}</div>}
          </div>

          <div><Label th={th}>Date</Label>
            <input type="date" style={inp} value={ev.date} onChange={e => set('date', e.target.value)} />
          </div>

          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <span style={{ fontSize:14, fontWeight:300, ...th.text }}>All Day</span>
            <Toggle val={ev.allDay} onChange={v => set('allDay', v)} accent={th.accent} />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10,
            opacity: ev.allDay ? 0.35 : 1, pointerEvents: ev.allDay ? 'none' : 'auto',
            transition:'opacity 0.2s' }}>
              <div><Label th={th}>Start</Label>
                <input type="time" style={inp} value={ev.start} onChange={e => {
                  const newStart = e.target.value
                  set('start', newStart)
                  // Auto-adjust end to 1 hour after new start
                  const [h, mins] = newStart.split(':').map(Number)
                  const endH = String((h + 1) % 24).padStart(2, '0')
                  set('end', endH + ':' + String(mins).padStart(2, '0'))
                }} />
              </div>
              <div><Label th={th}>End</Label>
                <input type="time" style={inp} value={ev.end} onChange={e => set('end', e.target.value)} />
              </div>
            </div>

          <div><Label th={th}>Reminder</Label>
            <select style={{ ...inp, appearance:'none' }} value={ev.reminder}
              onChange={e => set('reminder', Number(e.target.value))}>
              {REMINDER_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>

          {modal.mode === 'create' && <div><Label th={th}>Who can edit?</Label>
            <div style={{ display:'flex', gap:8 }}>
              {[['everyone','Everyone'],['creator','Only me']].map(([val, label]) => (
                <button key={val} onClick={() => set('editPermission', val)}
                  style={{ flex:1, padding:'8px 0', borderRadius:10, fontSize:13, fontWeight:300,
                    cursor:'pointer',
                    border:'1.5px solid ' + (ev.editPermission === val ? th.accent : th.border),
                    background: ev.editPermission === val ? th.accent : 'transparent',
                    color: ev.editPermission === val ? '#fff' : th.muted }}>
                  {label}
                </button>
              ))}
            </div>
          </div>}

          {(modal.mode === 'create' || !ev.recurrenceId) && (
            <div><Label th={th}>Repeat</Label>
              <select style={{ ...inp, appearance:'none' }} value={ev.recurrence ?? 'none'}
                onChange={e => {
                  const val = e.target.value
                  set('recurrence', val)
                  if (val === 'monthly-nth' && ev.date) {
                    const d = new Date(ev.date + 'T12:00:00')
                    const weekday = d.getDay()
                    let nth = 0; const tmp = new Date(d.getFullYear(), d.getMonth(), 1)
                    while (tmp <= d) { if (tmp.getDay() === weekday) nth++; tmp.setDate(tmp.getDate() + 1) }
                    set('recurrenceNth', nth)
                    set('recurrenceWeekday', weekday)
                  }
                  if (val !== 'none' && !ev.recurrenceEnd) {
                    const [y,m,d] = ev.date.split('-').map(Number)
                    const end = new Date(y+1, m-1, d)
                    const fmt = dt => String(dt.getFullYear()) + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0')
                    set('recurrenceEnd', fmt(end))
                  }
                }}>
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every 2 weeks</option>
                <option value="monthly">Monthly (same date)</option>
                <option value="monthly-nth">Monthly (same weekday)</option>
                <option value="yearly">Yearly</option>
              </select>
            </div>
          )}

          {(modal.mode === 'create' || !ev.recurrenceId) && ev.recurrence && ev.recurrence !== 'none' && (
            <div><Label th={th}>Repeat until</Label>
              <input type="date" style={inp} value={ev.recurrenceEnd ?? ''}
                onChange={e => set('recurrenceEnd', e.target.value)} />
            </div>
          )}

          <div>
            <Label th={th}>Share with Peer Group(s)</Label>
            <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginTop:6 }}>
              {groups.map(g => {
                const sel = ev.groups.includes(g.id)
                return (
                  <button key={g.id} onClick={() => toggleGroup(g.id)}
                    style={{ padding:'6px 14px', borderRadius:20, border:`2px solid ${g.color}`, fontFamily:FONT,
                      background:sel ? g.color : 'transparent', color:sel ? '#fff' : g.color,
                      fontSize:13, fontWeight:300, cursor:'pointer',
                      display:'flex', alignItems:'center', gap:6 }}>
                    <span style={{ width:18, height:18, borderRadius:4, overflow:'hidden',
                      display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:14, flexShrink:0 }}>
                      {g.icon
                        ? <img src={g.icon} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                        : g.emoji}
                    </span>
                    {g.name}
                  </button>
                )
              })}
            </div>
          </div>

          {allMembers.length > 0 && (
            <div>
              <Label th={th}>Invite Members</Label>
              <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginTop:6 }}>
                {allMembers.map(m => {
                  const sel = ev.invitees.includes(m.id)
                  const g   = groups.find(x => x.members.some(mb => mb.id === m.id))
                  const col = g ? g.color : '#888'
                  return (
                    <button key={m.id} onClick={() => toggleInvitee(m.id)}
                      style={{ display:'flex', alignItems:'center', gap:6,
                        padding:'5px 12px 5px 6px', borderRadius:20,
                        border:`2px solid ${col}`, background:sel ? col : 'transparent',
                        cursor:'pointer', fontFamily:FONT }}>
                      <MemberAvatar avatar={m.avatar} name={m.nickname || m.name} color={col} size={24} fontSize={11} />
                      <span style={{ fontSize:13, color:sel ? '#fff' : col, fontWeight:300 }}>{m.nickname || m.name}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div><Label th={th}>Notes</Label>
            <textarea style={{ ...inp, resize:'none', minHeight:60 }} placeholder="Optional notes…"
              value={ev.desc} onChange={e => set('desc', e.target.value)} />
            {extractURLs(ev.desc).map(url => (
              <div key={url}
                onClick={e => { e.stopPropagation(); window.__pearSync?.openURL(url) }}
                style={{ pointerEvents:'auto', display:'flex', alignItems:'center', gap:8,
                  marginTop:6, padding:'8px 10px', borderRadius:8, cursor:'pointer',
                  border:`1px solid ${th.border}`, ...th.card }}>
                <ArrowSquareOut size={15} weight="thin" color="var(--color-accent)" style={{ flexShrink: 0 }} />
                <span style={{ fontSize:12, fontWeight:300, color:th.accent,
                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {url}
                </span>
              </div>
            ))}
          </div>

          <div><Label th={th}>Location</Label>
            <input style={inp} placeholder="Address, place, or landmark…"
              value={ev.location ?? ''} onChange={e => set('location', e.target.value)} />
          </div>

          {modal.mode === 'edit' && ev.recurrenceId && (
            <div style={{ fontSize:12, fontWeight:300, color:th.muted,
              display:'flex', alignItems:'center', gap:6 }}>
              <Repeat size={13} weight="thin" color="var(--color-muted)" />
              {' '}Recurring series — editing this occurrence only
            </div>
          )}

          {modal.mode === 'edit' && ev.creatorId !== 'system' && (() => {
            const isCreator = ev.creatorId && profile?.id && ev.creatorId === profile.id
            if (isCreator) return (
              <div><Label th={th}>Who can edit?</Label>
                <div style={{ display:'flex', gap:8 }}>
                  {[['everyone','Everyone'],['creator','Only me']].map(([val, label]) => (
                    <button key={val} onClick={() => set('editPermission', val)}
                      style={{ flex:1, padding:'8px 0', borderRadius:10, fontSize:13, fontWeight:300,
                        cursor:'pointer',
                        border:'1.5px solid ' + (ev.editPermission === val ? th.accent : th.border),
                        background: ev.editPermission === val ? th.accent : 'transparent',
                        color: ev.editPermission === val ? '#fff' : th.muted }}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )
            return null
          })()}

          </div>

          {(() => {
            const isCreator = ev.creatorId && profile?.id && ev.creatorId === profile.id
            const isHoliday = modal.mode === 'edit' && ev.creatorId === 'system'
            const isReadOnly = modal.mode === 'edit' && ev.editPermission === 'creator' && !isCreator
            if (isHoliday) return (
              <div style={{ fontSize:12, fontWeight:300, color:th.muted, textAlign:'center',
                padding:'8px 0', border:'1px solid ' + th.border, borderRadius:10 }}>
                🗓 Public holiday — toggle off in Profile to remove all
              </div>
            )
            if (isReadOnly) return (
              <div style={{ fontSize:12, fontWeight:300, color:th.muted, textAlign:'center',
                padding:'8px 0', border:'1px solid ' + th.border, borderRadius:10 }}>
                <Lock size={13} weight="thin" color="var(--color-muted)" />
                {' '}Read only — only the creator can edit this event
              </div>
            )
            return (
              <button onClick={handleSave} disabled={saving}
                style={{ ...th.pillBtn, width:'100%', padding:'13px', fontSize:15, fontWeight:300,
                  marginTop:4, opacity:saving ? 0.6 : 1 }}>
                {saving ? 'Saving…' : modal.mode === 'create' ? 'Create Event' : 'Save Changes'}
              </button>
            )
          })()}

          {modal.mode === 'edit' && (() => {
            const isCreator = ev.creatorId && profile?.id && ev.creatorId === profile.id
            return (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                <button onClick={() => isCreator ? setConfirm('delete') : onDelete(ev.id)}
                  style={{ background:'transparent', border:`1px solid #D45F7A`, borderRadius:12,
                    padding:'11px', color:'#D45F7A', fontSize:14, fontWeight:300,
                    fontFamily:FONT, cursor:'pointer', width:'100%' }}>
                  {isCreator ? 'Delete' : 'Remove for Me'}
                </button>
                {ev.recurrenceId && (
                  <button onClick={() => isCreator ? setConfirm('deleteSeries') : onDeleteSeries?.(ev.recurrenceId)}
                    style={{ background:'transparent', border:`1px solid #D45F7A`, borderRadius:12,
                      padding:'11px', color:'#D45F7A', fontSize:14, fontWeight:300,
                      fontFamily:FONT, cursor:'pointer', width:'100%' }}>
                    {isCreator ? 'Delete All in Series' : 'Remove All in Series'}
                  </button>
                )}
              </div>
            )
          })()}
        </div>

      {scopePending && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:300,
          display:'flex', alignItems:'center', justifyContent:'center', padding:'0 24px' }}>
          <div style={{ ...th.bg, borderRadius:20, padding:'24px', width:'100%', maxWidth:360, textAlign:'center' }}>
            <div style={{ fontWeight:300, fontSize:17, ...th.text, marginBottom:8 }}>Edit recurring event</div>
            <div style={{ fontSize:14, color:th.muted, marginBottom:20, lineHeight:1.5, fontWeight:300 }}>
              Save changes to just this event, or this and all future events in the series?
            </div>
            <div style={{ display:'flex', gap:8, marginBottom:8 }}>
              <button onClick={async () => { setSaving(true); setScopePending(null); await onSave(scopePending, 'one'); setSaving(false) }}
                style={{ flex:1, padding:'12px', borderRadius:12, border:'none', fontFamily:FONT,
                  background:th.accent, color:'#fff', fontSize:14, fontWeight:300, cursor:'pointer' }}>
                This Event
              </button>
              <button onClick={async () => { setSaving(true); setScopePending(null); await onSave(scopePending, 'future'); setSaving(false) }}
                style={{ flex:1, padding:'12px', borderRadius:12, border:'none', fontFamily:FONT,
                  background:th.accent, color:'#fff', fontSize:14, fontWeight:300, cursor:'pointer' }}>
                This & Future
              </button>
            </div>
            <button onClick={() => setScopePending(null)}
              style={{ width:'100%', padding:'12px', borderRadius:12, border:`1px solid ${th.border}`,
                fontFamily:FONT, background:'transparent', color:th.text.color,
                fontSize:14, fontWeight:300, cursor:'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:300,
          display:'flex', alignItems:'center', justifyContent:'center', padding:'0 24px' }}>
          <div style={{ ...th.bg, borderRadius:20, padding:'24px', width:'100%', maxWidth:360, textAlign:'center' }}>
            <div style={{ fontSize:36, marginBottom:12 }}><Trash size={36} weight="thin" color="var(--color-destructive)" /></div>
            <div style={{ fontWeight:300, fontSize:17, ...th.text, marginBottom:8 }}>
              {confirm === 'delete' ? 'Delete Event?' : 'Delete All in Series?'}
            </div>
            <div style={{ fontSize:14, color:th.muted, marginBottom:20, lineHeight:1.5, fontWeight:300 }}>
              {confirm === 'delete'
                ? 'This event will be permanently deleted for everyone. This cannot be undone.'
                : 'All events in this series will be permanently deleted for everyone. This cannot be undone.'}
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={() => setConfirm(null)}
                style={{ flex:1, padding:'12px', borderRadius:12, border:`1px solid ${th.border}`,
                  fontFamily:FONT, background:'transparent', color:th.text.color,
                  fontSize:14, fontWeight:300, cursor:'pointer' }}>
                Cancel
              </button>
              <button onClick={() => { setConfirm(null); confirm === 'delete' ? onDelete(ev.id) : onDeleteSeries?.(ev.recurrenceId) }}
                style={{ flex:1, padding:'12px', borderRadius:12, border:'none', fontFamily:FONT,
                  background:'#D45F7A', color:'#fff', fontSize:14, fontWeight:300, cursor:'pointer' }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </BottomSheet>
  )
}

// ─── Groups Tab ───────────────────────────────────────────────────────────────
function JoinGroupModal ({ th, onClose, closeRef, db, sync, onJoined, onPendingJoin }) {
  const bsCloseRef = useRef(null)
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteUrl,  setPasteUrl]  = useState('')
  const [pasteErr,  setPasteErr]  = useState('')

  useEffect(() => { if (closeRef) closeRef.current = () => { bsCloseRef.current?.(); return true } }, [])

  function handlePasteJoin () {
    const url = pasteUrl.trim()
    if (!url.startsWith('pear://pearcal/join')) { setPasteErr('Not a valid PearCal invite link.'); return }
    const groupName = (() => { try { return new URL(url).searchParams.get('name') || 'a group' } catch { return 'a group' } })()
    bsCloseRef.current?.()
    onPendingJoin?.({ url, groupName })
  }

  return (
    <BottomSheet th={th} onClose={onClose} zIndex={100} closeRef={bsCloseRef}>
      <div style={{ padding:'0 20px 8px', display:'flex', flexDirection:'column', gap:14 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
          <span style={{ fontSize:17, fontWeight:300, ...th.text }}>Join a Group</span>
          <button onClick={() => bsCloseRef.current?.()} style={{ ...th.iconBtn, fontSize:20 }}>✕</button>
        </div>
        {!pasteMode ? (
          <>
            <button onClick={() => { bsCloseRef.current?.(); setTimeout(() => sync?.qrScan?.(), 50) }}
              style={{ ...th.pillBtn, width:'100%', padding:'14px', fontSize:15, fontWeight:300,
                display:'flex', alignItems:'center', justifyContent:'center', gap:10 }}>
              <span style={{ fontSize:22 }}>📷</span> Scan QR Code
            </button>
            <button onClick={() => setPasteMode(true)}
              style={{ ...th.pillBtn, width:'100%', padding:'14px', fontSize:15, fontWeight:300,
                display:'flex', alignItems:'center', justifyContent:'center', gap:10 }}>
              <ArrowSquareOut size={20} weight="thin" color="#fff" /> Paste Invite Link
            </button>
          </>
        ) : (
          <>
            <textarea value={pasteUrl} onChange={e => { setPasteUrl(e.target.value); setPasteErr('') }}
              placeholder='Paste invite link here…'
              style={{ width:'100%', minHeight:80, borderRadius:10, padding:'10px 12px',
                fontSize:13, fontWeight:300, fontFamily:'inherit', resize:'none', boxSizing:'border-box',
                background: th.input, border:'1px solid ' + (pasteErr ? '#D45F7A' : th.border),
                color:'#111', outline:'none' }} />
            {pasteErr && <div style={{ fontSize:12, color:'#D45F7A', fontWeight:300 }}>{pasteErr}</div>}
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={() => { setPasteMode(false); setPasteUrl(''); setPasteErr('') }}
                style={{ flex:1, padding:'10px', borderRadius:10, fontSize:13, fontWeight:300,
                  background:'transparent', border:'1px solid ' + th.border, color:th.muted, cursor:'pointer' }}>
                Back
              </button>
              <button onClick={handlePasteJoin} disabled={!pasteUrl.trim()}
                style={{ flex:1, ...th.pillBtn, padding:'10px', fontSize:13, fontWeight:300,
                  opacity: !pasteUrl.trim() ? 0.5 : 1 }}>
                Join
              </button>
            </div>
          </>
        )}
      </div>
    </BottomSheet>
  )
}

function NicknameBeforeJoinSheet ({ th, groupName, defaultName, onConfirm, onClose, closeRef }) {
  const bsCloseRef = useRef(null)
  const [nickname, setNickname] = useState(defaultName)
  const [joining,  setJoining]  = useState(false)
  const [err,      setErr]      = useState('')

  useEffect(() => { if (closeRef) closeRef.current = () => { bsCloseRef.current?.(); return true } }, [])

  async function handleJoin () {
    setJoining(true); setErr('')
    const result = await onConfirm(nickname.trim())
    if (result && !result.ok) {
      setJoining(false)
      if (result.error === 'already_member') { bsCloseRef.current?.(); return }
      if (result.error === 'blocked_from_group') { bsCloseRef.current?.(); return }
      setErr('Could not join group. Check the invite link and try again.')
    }
  }

  return (
    <BottomSheet th={th} onClose={onClose} zIndex={110} closeRef={bsCloseRef}>
      <div style={{ padding:'0 20px 16px', display:'flex', flexDirection:'column', gap:14 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
          <span style={{ fontSize:17, fontWeight:300, ...th.text }}>Join {groupName}</span>
          <button onClick={() => bsCloseRef.current?.()} style={{ ...th.iconBtn, fontSize:20 }}>✕</button>
        </div>
        <div style={{ fontSize:13, color:th.muted, fontWeight:300 }}>
          How should group members see your name?
        </div>
        <input
          value={nickname}
          onChange={e => setNickname(e.target.value)}
          placeholder='Your nickname'
          style={{ background:th.inputBg, border:`1px solid ${th.border}`, borderRadius:8,
            padding:'9px 12px', color:th.text.color, fontSize:14, fontWeight:300,
            fontFamily:FONT, width:'100%', boxSizing:'border-box', outline:'none' }}
        />
        {err ? <div style={{ fontSize:12, color:'#e55', fontWeight:300 }}>{err}</div> : null}
        <button
          onClick={handleJoin}
          disabled={joining || !nickname.trim()}
          style={{ ...th.pillBtn, width:'100%', padding:'13px', fontSize:15, fontWeight:300,
            opacity: (joining || !nickname.trim()) ? 0.5 : 1 }}>
          {joining ? 'Joining…' : 'Join Group'}
        </button>
      </div>
    </BottomSheet>
  )
}

function GroupsTab ({ th, groups, profile, sync, db, readyGroupKeys, onNewGroup, onSettings, onQrGroup, onJoined, joinOpen, setJoinOpen, closeInviteSheetRef }) {
  const [copiedId,         setCopiedId]         = useState(null)
  const [inviteModalGroup, setInviteModalGroup] = useState(null)

  async function copyInvite (g, e) {
    e.stopPropagation()
    if (!readyGroupKeys.has(g.id)) return
    // Always fetch fresh from DB to get the real Autobase key, not the placeholder
    const fresh = db ? await db.getGroup(g.id).catch(() => null) : null
    const src = fresh ?? g
    const link = buildInviteLink(src, profile?.publicKey ?? 'unknown')
    navigator.clipboard?.writeText(link)
    setCopiedId(g.id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  return (
    <div style={{ padding:'16px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <span style={{ fontWeight:300, fontSize:17, ...th.text }}>Peer Groups</span>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={() => setJoinOpen(true)}
            style={{ ...th.pillBtn, fontSize:13, padding:'6px 14px', fontWeight:300 }}>
            Join Group
          </button>
          <button onClick={onNewGroup} style={{ ...th.pillBtn, fontSize:13, padding:'6px 14px', fontWeight:300 }}>
            + New Group
          </button>
        </div>
      </div>


      {groups.length === 0 && (
        <div style={{ textAlign:'center', color:th.muted, fontSize:14, fontWeight:300, padding:'48px 0' }}>
          No groups yet — create one or join one!
        </div>
      )}

      <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
        {groups.map(g => (
          <div key={g.id} style={{ ...th.card, borderRadius:14, padding:'16px', borderLeft:`4px solid ${g.color}` }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
              <GroupIcon group={g} />
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:300, fontSize:15, ...th.text }}>{g.name}</div>
                <div style={{ fontSize:12, color:th.muted, fontWeight:300 }}>
                  {g.members.length} member{g.members.length !== 1 ? 's' : ''}
                </div>
              </div>
              <button onClick={() => onSettings(g)}
                style={{ ...th.iconBtn, fontSize:18, padding:'6px', borderRadius:10, border:`1px solid ${th.border}` }}>
                <GearSix size={18} weight="thin" color="var(--color-muted)" />
              </button>
            </div>

            {/* Member avatars */}
            <div style={{ display:'flex', gap:6, marginBottom:12, flexWrap:'wrap' }}>
              {g.members.map(m => (
                <div key={m.id} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
                  <MemberAvatar avatar={m.avatar} name={m.nickname || m.name} color={g.color} size={34} fontSize={13} />
                  <span style={{ fontSize:10, color:th.muted, fontWeight:300 }}>{m.nickname || m.name}</span>
                </div>
              ))}
            </div>

            <button onClick={async e => {
                e.stopPropagation()
                if (!readyGroupKeys.has(g.id)) return
                const fresh = db ? await db.getGroup(g.id).catch(() => null) : null
                setInviteModalGroup(fresh ?? g)
              }}
              disabled={!readyGroupKeys.has(g.id)}
              style={{ width:'100%', padding:'10px', fontSize:13, fontWeight:300, fontFamily:FONT,
                background:'transparent', border:`1px solid ${g.color}44`, borderRadius:10,
                color:readyGroupKeys.has(g.id) ? g.color : th.muted,
                cursor:readyGroupKeys.has(g.id) ? 'pointer' : 'not-allowed',
                opacity:readyGroupKeys.has(g.id) ? 1 : 0.5 }}>
              <ShareNetwork size={16} weight="thin" style={{ display:'inline', verticalAlign:'middle' }} /> Share Group Invite
            </button>
          </div>
        ))}
      </div>
      {inviteModalGroup && (
        <InviteOptionsModal
          th={th}
          group={inviteModalGroup}
          profile={profile}
          sync={sync}
          onQrGroup={onQrGroup}
          onClose={() => setInviteModalGroup(null)}
          closeRef={closeInviteSheetRef}
        />
      )}
    </div>
  )
}

// ─── Invite Options Modal ──────────────────────────────────────────────────────
function InviteOptionsModal ({ th, group, profile, sync, onQrGroup, onClose, closeRef }) {
  const bsCloseRef = useRef(null)
  const link = buildInviteLink(group, profile?.publicKey ?? 'unknown')
  const shareMsg = `You've been invited to join ${group.name} as a peer in PearCal. To join, paste this link into PearCal:\n\n${link}`

  useEffect(() => { if (closeRef) closeRef.current = () => { bsCloseRef.current?.(); return true } }, [])

  const row = (icon, title, subtitle, onClick) => (
    <button onClick={onClick}
      style={{ background:'transparent', border:`1px solid ${th.border}`, borderRadius:12,
        padding:'14px 16px', display:'flex', alignItems:'center', gap:12,
        cursor:'pointer', fontFamily:FONT, width:'100%', textAlign:'left' }}>
      <span style={{ fontSize:22, flexShrink:0 }}>{icon}</span>
      <div>
        <div style={{ fontWeight:300, fontSize:14, ...th.text }}>{title}</div>
        <div style={{ fontSize:12, color:th.muted, fontWeight:300 }}>{subtitle}</div>
      </div>
    </button>
  )

  return (
    <BottomSheet th={th} onClose={onClose} zIndex={300} closeRef={bsCloseRef}>
      <div style={{ padding:'0 16px 8px' }}>
        <div style={{ fontWeight:300, fontSize:16, ...th.text, marginBottom:16 }}>
          Invite to {group.name}
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {row(<ShareNetwork size={22} weight="thin" color="var(--color-text)" />, 'Share Link…', 'Send via messages, email, etc.', () => {
            bsCloseRef.current?.()
            setTimeout(() => sync?.nativeShare(`Join ${group.name} on PearCal`, shareMsg), 50)
          })}
          {row('⬛', 'Show QR Code', 'Scan to join instantly', () => {
            bsCloseRef.current?.()
            setTimeout(() => onQrGroup({ group, link }), 50)
          })}
        </div>
      </div>
    </BottomSheet>
  )
}

// ─── Group Settings Modal ─────────────────────────────────────────────────────
function GroupSettingsModal ({ th, group, me, db, sync, onClose, onUpdate, onDelete, onMemberLeft, onNicknameChange }) {
  const bsCloseRef = useRef(null)
  const [g,       setG]       = useState({ ...group })
  const [nameErr, setNameErr] = useState('')
  const [confirm, setConfirm] = useState(null)
  const [saved,   setSaved]   = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [nickInput, setNickInput] = useState(() => (group.members ?? []).find(m => m.id === me?.id)?.nickname ?? '')
  const [nickSaved, setNickSaved] = useState(false)
  const fileRef = useRef()
  const isOwner  = g.ownerId === me?.id
  const isMember = g.members.some(m => m.id === me?.id)

  function set (k, v) { setG(prev => ({ ...prev, [k]:v })); setSaved(false) }

  function handleImageUpload (e) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = ev => set('icon', ev.target.result)
    reader.readAsDataURL(file)
  }

  async function save () {
    if (!g.name.trim()) { setNameErr('Group name cannot be empty.'); return }
    setNameErr('')
    setSaving(true)
    await onUpdate({ ...g, name:g.name.trim() })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function confirmAction () {
    if (!confirm) return
    if (confirm === 'leave' || confirm === 'delete') { await onDelete(g.id, confirm); return }
    if (confirm.startsWith('remove:')) {
      const uid = confirm.split(':')[1]
      const removedMember = g.members.find(m => m.id === uid)
      const removedMembers = [...(g.removedMembers ?? []), {
        id: uid,
        name: removedMember?.name ?? 'Member',
        avatar: removedMember?.avatar ?? '?'
      }]
      const updatedGroup = { ...g, members: g.members.filter(m => m.id !== uid), removedMembers, updatedAt: Date.now() }
      setG(updatedGroup)
      setConfirm(null)
      setSaved(false)
      await onUpdate(updatedGroup)
      await onMemberLeft(g.id, uid)
    }
  }

  const inp = {
    background: 'var(--color-bg)', border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)', padding: '10px 14px',
    color: 'var(--color-text)', fontSize: 16, fontWeight: 300,
    fontFamily: FONT, width: '100%', boxSizing: 'border-box', outline: 'none',
    transition: 'border-color var(--duration-fast) var(--easing)',
  }

  const section = label => (
    <div style={{ fontSize:11, fontWeight:300, letterSpacing:'0.08em', color:th.muted, marginBottom:8, marginTop:4 }}>
      {label}
    </div>
  )

  return (
    <BottomSheet th={th} onClose={onClose} zIndex={200} closeRef={bsCloseRef}>
      <div style={{ padding:'12px 20px 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontWeight:300, fontSize:17, ...th.text }}>Group Settings</span>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            {saved && <span style={{ fontSize:12, color:'#5DBF8A', fontWeight:300 }}>✓ Saved</span>}
            {isOwner && (
              <button onClick={save} disabled={saving}
                style={{ ...th.pillBtn, fontSize:13, padding:'6px 16px', fontWeight:300, opacity:saving ? 0.6 : 1 }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
            <button onClick={() => bsCloseRef.current?.()} style={{ ...th.iconBtn, fontSize:20 }}>✕</button>
          </div>
        </div>

        <div style={{ padding:'20px 20px 0', display:'flex', flexDirection:'column', gap:20 }}>
          {/* Identity — owner only */}
          {isOwner && (g.pendingInvites ?? []).length > 0 && (
            <div>
              {section('PENDING INVITES')}
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {(g.pendingInvites ?? []).map(m => (
                  <div key={m.id} style={{ display:'flex', alignItems:'center', gap:12,
                    ...th.card, borderRadius:12, padding:'10px 14px' }}>
                    <MemberAvatar avatar={m.avatar} name={m.name} color={g.color} size={38} fontSize={15} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:300, fontSize:14, ...th.text }}>{m.name}</div>
                      <div style={{ fontSize:11, color:th.muted, fontWeight:300 }}>Invite sent</div>
                    </div>
                    <button onClick={() => {
                        const link = window.__pearBuildReinviteLink?.(g, me?.publicKey ?? 'unknown')
                        if (!link) return
                        if (sync) sync.nativeShare(`Join ${g.name} on PearCal`, link)
                        else navigator.clipboard?.writeText(link)
                      }}
                      style={{ background:'transparent', border:`1px solid ${g.color}44`, borderRadius:8,
                        color:g.color, fontSize:12, padding:'5px 10px', cursor:'pointer',
                        fontWeight:300, fontFamily:FONT }}>
                      <ShareNetwork size={14} weight="thin" style={{ display:'inline', verticalAlign:'middle' }} /> Share Again
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {isOwner && (g.removedMembers ?? []).length > 0 && (
            <div>
              {section('REMOVED MEMBERS')}
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {(g.removedMembers ?? []).map(m => (
                  <div key={m.id} style={{ display:'flex', alignItems:'center', gap:12,
                    ...th.card, borderRadius:12, padding:'10px 14px' }}>
                    <MemberAvatar avatar={m.avatar} name={m.name} color={g.color} size={38} fontSize={15} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:300, fontSize:14, ...th.text }}>{m.name}</div>
                      <div style={{ fontSize:11, color:th.muted, fontWeight:300 }}>Removed</div>
                    </div>
                    <button onClick={async () => {
                        await db.reinviteMember(g.id, m.id)
                        const memberRecord = (g.removedMembers ?? []).find(x => x.id === m.id)
                        const updated = { ...g,
                          removedMembers: (g.removedMembers ?? []).filter(x => x.id !== m.id),
                          pendingInvites: [...(g.pendingInvites ?? []), memberRecord] }
                        setG(updated)
                        await onUpdate(updated)
                        const link = window.__pearBuildReinviteLink?.(g, me?.publicKey ?? 'unknown')
                        if (!link) return
                        if (sync) sync.nativeShare(`Join ${g.name} on PearCal`, link)
                        else navigator.clipboard?.writeText(link)
                      }}
                      style={{ background:'transparent', border:`1px solid ${g.color}44`, borderRadius:8,
                        color:g.color, fontSize:12, padding:'5px 10px', cursor:'pointer',
                        fontWeight:300, fontFamily:FONT }}>
                      <ShareNetwork size={14} weight="thin" style={{ display:'inline', verticalAlign:'middle' }} /> Reinvite
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {isOwner && <div>
            {section('GROUP IDENTITY')}
            <div style={{ display:'flex', gap:16, alignItems:'flex-start' }}>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:6, flexShrink:0 }}>
                <GroupIcon group={g} size={72} radius={18} />
                <div style={{ display:'flex', gap:6 }}>
                  <button onClick={() => fileRef.current?.click()}
                    style={{ fontSize:11, padding:'4px 8px', borderRadius:6, border:`1px solid ${th.border}`,
                      background:'transparent', color:th.text.color, cursor:'pointer', fontWeight:300, fontFamily:FONT }}>
                    📷 Photo
                  </button>
                  {g.icon && (
                    <button onClick={() => set('icon', null)}
                      style={{ fontSize:11, padding:'4px 8px', borderRadius:6, border:`1px solid #D45F7A`,
                        background:'transparent', color:'#D45F7A', cursor:'pointer', fontWeight:300, fontFamily:FONT }}>
                      Remove
                    </button>
                  )}
                </div>
                <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }}
                  onChange={handleImageUpload} />
              </div>
              <div style={{ flex:1, display:'flex', flexDirection:'column', gap:8 }}>
                <input style={inp} placeholder="Group name" value={g.name}
                  onChange={e => { set('name', e.target.value); setNameErr('') }} />
                {nameErr && <div style={{ color:'#D45F7A', fontSize:12, fontWeight:300 }}>{nameErr}</div>}
                {!g.icon && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                    {GROUP_EMOJIS.map(em => (
                      <button key={em} onClick={() => set('emoji', em)}
                        style={{ width:34, height:34, borderRadius:8, fontSize:18,
                          border:`2px solid ${g.emoji === em ? g.color : th.border}`,
                          background:g.emoji === em ? g.color + '22' : 'transparent', cursor:'pointer' }}>
                        {em}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>}

          {/* Color — owner only */}
          {isOwner && <div>
            {section('GROUP COLOR')}
            <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
              {GROUP_COLORS.map(c => (
                <button key={c} onClick={() => set('color', c)}
                  style={{ width:34, height:34, borderRadius:'50%', background:c, cursor:'pointer',
                    border:g.color === c ? '3px solid #fff' : '3px solid transparent',
                    boxShadow:g.color === c ? `0 0 0 2px ${c}` : 'none' }} />
              ))}
            </div>
          </div>}

          {/* My Nickname — visible to all members */}
          <div>
            {section('MY NICKNAME IN THIS GROUP')}
            <div style={{ display:'flex', gap:8 }}>
              <input style={{ ...inp, flex:1 }}
                placeholder={me?.name ?? 'Your name'}
                value={nickInput}
                onChange={e => { setNickInput(e.target.value); setNickSaved(false) }} />
              <button onClick={async () => {
                  const nick = nickInput.trim()
                  setG(prev => ({ ...prev, members: (prev.members ?? []).map(m => m.id === me?.id ? { ...m, nickname: nick } : m) }))
                  await onNicknameChange?.(g.id, nick)
                  setNickSaved(true)
                  setTimeout(() => setNickSaved(false), 2000)
                }}
                style={{ ...th.pillBtn, fontSize:13, padding:'6px 16px', fontWeight:300, flexShrink:0 }}>
                {nickSaved ? '✓' : 'Save'}
              </button>
            </div>
            <div style={{ fontSize:11, color:th.muted, fontWeight:300, marginTop:4 }}>
              How you appear to others in this group
            </div>
          </div>

          {/* Members */}
          <div>
            {section(`MEMBERS · ${g.members.length}`)}
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {g.members.map(m => {
                const isMe     = m.id === me?.id
                const canRemove = isOwner && !isMe
                return (
                  <div key={m.id} style={{ display:'flex', alignItems:'center', gap:12,
                    ...th.card, borderRadius:12, padding:'10px 14px' }}>
                    <MemberAvatar avatar={m.avatar} name={m.name} color={g.color} size={38} fontSize={15} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:300, fontSize:14, ...th.text }}>
                        {m.nickname || m.name}
                        {isMe && <span style={{ fontSize:11, color:th.muted, marginLeft:6, fontWeight:300 }}>(you)</span>}
                      </div>
                      {m.nickname && <div style={{ fontSize:11, color:th.muted, fontWeight:300 }}>{m.name}</div>}
                      {g.ownerId === m.id && <div style={{ fontSize:11, color:g.color, fontWeight:300 }}>Owner</div>}
                    </div>
                    {canRemove && (
                      <button onClick={() => setConfirm(`remove:${m.id}`)}
                        style={{ background:'transparent', border:`1px solid #D45F7A44`, borderRadius:8,
                          color:'#D45F7A', fontSize:12, padding:'5px 10px', cursor:'pointer',
                          fontWeight:300, fontFamily:FONT }}>
                        Remove
                      </button>
                    )}
                    {isMe && !isOwner && <span style={{ fontSize:11, color:th.muted, fontWeight:300 }}>Member</span>}
                    {isMe && isOwner && (
                      <span style={{ fontSize:11, color:g.color, background:g.color+'22',
                        padding:'3px 8px', borderRadius:10, fontWeight:300 }}>Owner</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>


          {/* Danger zone */}
          <div>
            {section('DANGER ZONE')}
            <div style={{ border:`1px solid #D45F7A44`, borderRadius:12, overflow:'hidden' }}>
              {isMember && !isOwner && (
                <button onClick={() => setConfirm('leave')}
                  style={{ width:'100%', padding:'14px 16px', background:'transparent', border:'none',
                    fontFamily:FONT, color:'#D45F7A', fontSize:14, fontWeight:300, cursor:'pointer',
                    textAlign:'left', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:6 }}><SignOut size={16} weight="thin" /> Leave Group</span>
                  <span style={{ fontSize:12, color:th.muted, fontWeight:300 }}>You'll lose access to shared events</span>
                </button>
              )}
              {isOwner && (
                <button onClick={() => setConfirm('delete')}
                  style={{ width:'100%', padding:'14px 16px', background:'#D45F7A11', border:'none',
                    fontFamily:FONT, color:'#D45F7A', fontSize:14, fontWeight:300, cursor:'pointer',
                    textAlign:'left', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:6 }}><Trash size={16} weight="thin" /> Delete Group</span>
                  <span style={{ fontSize:12, color:'#D45F7A99', fontWeight:300 }}>Permanent — cannot be undone</span>
                </button>
              )}
            </div>
          </div>
        </div>

      {/* Confirm dialog */}
      {confirm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:300,
          display:'flex', alignItems:'center', justifyContent:'center', padding:'0 24px' }}>
          <div style={{ ...th.bg, borderRadius:20, padding:'24px', width:'100%', maxWidth:360, textAlign:'center' }}>
            <div style={{ fontSize:36, marginBottom:12 }}>
              {confirm === 'delete' ? <Trash size={36} weight="thin" color="var(--color-destructive)" /> : confirm === 'leave' ? <SignOut size={36} weight="thin" color="var(--color-destructive)" /> : <User size={36} weight="thin" color="var(--color-muted)" />}
            </div>
            <div style={{ fontWeight:300, fontSize:17, ...th.text, marginBottom:8 }}>
              {confirm === 'delete' ? 'Delete Group?'
                : confirm === 'leave' ? 'Leave Group?'
                : `Remove ${g.members.find(m => m.id === confirm.split(':')[1])?.name}?`}
            </div>
            <div style={{ fontSize:14, color:th.muted, marginBottom:20, lineHeight:1.5, fontWeight:300 }}>
              {confirm === 'delete' && (() => {
                const otherCount = g.members.length - 1
                return otherCount > 0
                  ? `"${g.name}" and all shared events will be permanently deleted for you and all ${otherCount} other member${otherCount === 1 ? '' : 's'}. This cannot be undone.`
                  : `"${g.name}" and all its events will be permanently deleted. This cannot be undone.`
              })()}
              {confirm === 'leave'  && `You'll be removed from "${g.name}" and lose access to shared events.`}
              {confirm.startsWith('remove:') && `They will be removed from "${g.name}" and lose access to shared events.`}
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={() => setConfirm(null)}
                style={{ flex:1, padding:'12px', borderRadius:12, border:`1px solid ${th.border}`,
                  fontFamily:FONT, background:'transparent', color:th.text.color,
                  fontSize:14, fontWeight:300, cursor:'pointer' }}>
                Cancel
              </button>
              <button onClick={confirmAction}
                style={{ flex:1, padding:'12px', borderRadius:12, border:'none', fontFamily:FONT,
                  background:'#D45F7A', color:'#fff', fontSize:14, fontWeight:300, cursor:'pointer' }}>
                {confirm === 'delete' ? 'Delete' : confirm === 'leave' ? 'Leave' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </BottomSheet>
  )
}

// ─── New Group Modal ──────────────────────────────────────────────────────────
function NewGroupModal ({ th, onClose, onAdd, onUpdate, me, sync, onGroupKeyUpdated }) {
  const bsCloseRef = useRef(null)
  const [step,           setStep]           = useState(1)
  const [name,           setName]           = useState('')
  const [color,          setColor]          = useState(GROUP_COLORS[0])
  const [emoji,          setEmoji]          = useState(GROUP_EMOJIS[0])
  const [icon,           setIcon]           = useState(null)
  const [nameErr,        setNameErr]        = useState('')
  const [group,          setGroup]          = useState(null)
  const [groupKeyReady,  setGroupKeyReady]  = useState(false)
  useEffect(() => {
    if (!onGroupKeyUpdated) return
    onGroupKeyUpdated(updated => {
      setGroup(prev => {
        if (prev?.id === updated.id) {
          setGroupKeyReady(true)
          return updated
        }
        return prev
      })
    })
  }, [onGroupKeyUpdated])
  const [copiedLink,     setCopiedLink]     = useState(false)

  const [creating,       setCreating]       = useState(false)
  const fileRef = useRef()

  function handleImageUpload (e) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = ev => setIcon(ev.target.result)
    reader.readAsDataURL(file)
  }

  function handleCreate () {
    if (!name.trim()) { setNameErr('Group name is required.'); return }
    const newG = {
      id:      'g' + Math.random().toString(36).slice(2, 8),
      name:    name.trim(), color, emoji, icon,
      ownerId: me?.id ?? 'unknown',
      members: [{ id:me?.id, name:me?.name, avatar:me?.avatar ?? me?.name?.slice(0,2).toUpperCase() ?? '??' }],
      groupKey: Array.from({ length:64 }, () => '0123456789abcdef'[Math.floor(Math.random()*16)]).join(''),
      removedMembers: [],
    }
    setGroup(newG)
    setGroupKeyReady(false)
    setStep(2)
    onAdd(newG)
  }

  function genInviteLink (g) {
    return buildInviteLink(g, me?.publicKey ?? 'unknown')
  }

  function copyInvite () {
    if (!group) return
    navigator.clipboard?.writeText(genInviteLink(group))
    setCopiedLink(true)
    setTimeout(() => setCopiedLink(false), 2500)
  }



  async function finish () {
    if (!group) return
    setCreating(true)
    setCreating(false)
    setStep(3)
  }

  const inp = {
    background: 'var(--color-bg)', border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)', padding: '10px 14px',
    color: 'var(--color-text)', fontSize: 16, fontWeight: 300,
    fontFamily: FONT, width: '100%', boxSizing: 'border-box', outline: 'none',
    transition: 'border-color var(--duration-fast) var(--easing)',
  }

  const steps = ['Details','Invite','Done']

  return (
    <BottomSheet th={th} onClose={onClose} zIndex={200} closeRef={bsCloseRef}>
      <div style={{ padding:'12px 20px 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontWeight:300, fontSize:17, ...th.text }}>New Peer Group</span>
          <button onClick={() => bsCloseRef.current?.()} style={{ ...th.iconBtn, fontSize:20 }}>✕</button>
        </div>

        {/* Step indicator */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:'16px 20px 4px' }}>
          {steps.map((s, i) => {
            const num = i + 1, done = step > num, active = step === num
            return (
              <div key={s} style={{ display:'flex', alignItems:'center' }}>
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
                  <div style={{ width:28, height:28, borderRadius:'50%', display:'flex',
                    alignItems:'center', justifyContent:'center', fontWeight:300, fontSize:13,
                    background:done ? '#5DBF8A' : active ? th.accent : th.inputBg,
                    color:done || active ? '#fff' : th.muted,
                    border:`2px solid ${done ? '#5DBF8A' : active ? th.accent : th.border}` }}>
                    {done ? '✓' : num}
                  </div>
                  <span style={{ fontSize:10, color:active ? th.accent : th.muted, fontWeight:300 }}>{s}</span>
                </div>
                {i < steps.length - 1 && (
                  <div style={{ width:40, height:2, background:step > num ? '#5DBF8A' : th.border,
                    margin:'0 4px', marginBottom:16 }} />
                )}
              </div>
            )
          })}
        </div>

        <div style={{ padding:'16px 20px 0' }}>
          {/* Step 1 */}
          {step === 1 && (
            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, padding:'8px 0' }}>
                <div style={{ width:72, height:72, borderRadius:20, background:color, overflow:'hidden',
                  display:'flex', alignItems:'center', justifyContent:'center', fontSize:32,
                  boxShadow:`0 4px 16px ${color}55` }}>
                  {icon ? <img src={icon} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} /> : emoji}
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <button onClick={() => fileRef.current?.click()}
                    style={{ fontSize:12, padding:'5px 12px', borderRadius:8, border:`1px solid ${th.border}`,
                      background:'transparent', color:th.text.color, cursor:'pointer', fontWeight:300, fontFamily:FONT }}>
                    📷 Upload Photo
                  </button>
                  {icon && (
                    <button onClick={() => setIcon(null)}
                      style={{ fontSize:12, padding:'5px 12px', borderRadius:8, border:`1px solid #D45F7A`,
                        background:'transparent', color:'#D45F7A', cursor:'pointer', fontWeight:300, fontFamily:FONT }}>
                      Remove
                    </button>
                  )}
                </div>
                <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }}
                  onChange={handleImageUpload} />
              </div>

              <div>
                <Label th={th}>Group Name</Label>
                <input style={inp} placeholder="e.g. Smith Family" maxLength={40}
                  value={name} onChange={e => { setName(e.target.value); setNameErr('') }} />
                {nameErr && <div style={{ color:'#D45F7A', fontSize:12, marginTop:4, fontWeight:300 }}>{nameErr}</div>}
              </div>

              {!icon && (
                <div>
                  <Label th={th}>Group Icon</Label>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginTop:6 }}>
                    {GROUP_EMOJIS.map(em => (
                      <button key={em} onClick={() => setEmoji(em)}
                        style={{ width:40, height:40, borderRadius:10, fontSize:20,
                          border:`2px solid ${emoji === em ? color : th.border}`,
                          background:emoji === em ? color + '22' : 'transparent', cursor:'pointer' }}>
                        {em}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <Label th={th}>Group Color</Label>
                <div style={{ display:'flex', gap:10, marginTop:6, flexWrap:'wrap' }}>
                  {GROUP_COLORS.map(c => (
                    <button key={c} onClick={() => setColor(c)}
                      style={{ width:32, height:32, borderRadius:'50%', background:c, cursor:'pointer',
                        border:color === c ? '3px solid #fff' : '3px solid transparent',
                        boxShadow:color === c ? `0 0 0 2px ${c}` : 'none' }} />
                  ))}
                </div>
              </div>

              <button onClick={handleCreate}
                style={{ ...th.pillBtn, width:'100%', padding:'13px', fontSize:15, fontWeight:300, marginTop:4 }}>
                Create Group →
              </button>
            </div>
          )}

          {/* Step 2 */}
          {step === 2 && group && (
            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:12, ...th.card,
                borderRadius:12, padding:'12px 14px', borderLeft:`4px solid ${group.color}` }}>
                <GroupIcon group={group} size={40} radius={10} />
                <div>
                  <div style={{ fontWeight:300, ...th.text }}>{group.name}</div>
                  <div style={{ fontSize:12, color:th.muted, fontWeight:300 }}>Just created · 1 member (you)</div>
                </div>
              </div>

              <div>
                <Label th={th}>Share Invite Link</Label>
                <div style={{ ...th.card, borderRadius:10, padding:'10px 12px', display:'flex',
                  alignItems:'center', gap:8, border:`1px solid ${th.border}`, marginTop:6 }}>
                  <span style={{ fontSize:11, color:th.muted, flex:1, overflow:'hidden',
                    textOverflow:'ellipsis', whiteSpace:'nowrap', fontFamily:'monospace', fontWeight:300 }}>
                    {genInviteLink(group)}
                  </span>
                </div>
                <div style={{ display:'flex', gap:8, marginTop:8 }}>

                  <button onClick={() => {
                      const link = genInviteLink(group)
                      if (sync) sync.nativeShare(`Join ${group.name} on PearCal`, link)
                      else navigator.clipboard?.writeText(link)
                    }}
                    style={{ flex:1, padding:'10px', fontSize:13, fontWeight:300, fontFamily:FONT,
                      background:'transparent', border:`1px solid ${th.border}`, borderRadius:10,
                      color:th.text.color, cursor:'pointer' }}>
                    <ShareNetwork size={16} weight="thin" style={{ display:'inline', verticalAlign:'middle' }} /> Share…
                  </button>

                </div>
              </div>



              <div style={{ display:'flex', gap:8, marginTop:4 }}>
                <button onClick={() => { setSlideDir(1); setStep(1) }}
                  style={{ flex:1, padding:'12px', fontSize:14, fontWeight:300, fontFamily:FONT,
                    background:'transparent', border:`1px solid ${th.border}`, borderRadius:10,
                    color:th.text.color, cursor:'pointer' }}>
                  ← Back
                </button>
                <button onClick={finish} disabled={creating}
                  style={{ ...th.pillBtn, flex:2, padding:'12px', fontSize:15, fontWeight:300,
                    opacity:creating ? 0.6 : 1 }}>
                  {creating ? 'Creating…' : 'Finish'}
                </button>
              </div>
            </div>
          )}

          {/* Step 3 */}
          {step === 3 && group && (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:16, padding:'16px 0 8px' }}>
              <div style={{ width:80, height:80, borderRadius:24, background:group.color, overflow:'hidden',
                display:'flex', alignItems:'center', justifyContent:'center', fontSize:38,
                boxShadow:`0 6px 24px ${group.color}55` }}>
                {group.icon
                  ? <img src={group.icon} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                  : group.emoji}
              </div>
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize:22, fontWeight:300, ...th.text, marginBottom:6 }}>{group.name}</div>
                <div style={{ fontSize:14, color:th.muted, fontWeight:300 }}>Your group is ready 🎉</div>
              </div>
              <div style={{ ...th.card, borderRadius:14, padding:'16px', width:'100%', display:'flex', flexDirection:'column', gap:10 }}>
                <InfoRow th={th} label="Members" val={String(group.members.length)} />
                <InfoRow th={th} label="Sync" val="Hyperswarm DHT" />
                <InfoRow th={th} label="Storage" val="Local · Hyperbee" />
                <InfoRow th={th} label="Data collected" val="None" />
              </div>
              <button onClick={onClose}
                style={{ ...th.pillBtn, width:'100%', padding:'13px', fontSize:15, fontWeight:300 }}>
                Go to Groups
              </button>
            </div>
          )}
        </div>
    </BottomSheet>
  )
}

// ─── Profile Tab ──────────────────────────────────────────────────────────────
function SkeletonCard ({ th, height = 64, radius = 12 }) {
  return (
    <div style={{ width:'100%', height, borderRadius:radius, background:th.border,
      animation:'pearSkeletonPulse 1.4s ease-in-out infinite' }} />
  )
}

function SkeletonList ({ th, count = 3, height = 64 }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10, padding:'8px 0' }}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} th={th} height={height} />
      ))}
    </div>
  )
}

function BottomSheet ({ th, onClose, children, zIndex = 200, closeRef }) {
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)
  const touchStartY = useRef(null)
  const DURATION = 280

  useEffect(() => {
    const id = setTimeout(() => setVisible(true), 20)
    return () => clearTimeout(id)
  }, [])
  useEffect(() => { if (closeRef) closeRef.current = close }, [closing])

  function close () {
    if (closing) return
    setClosing(true)
    setTimeout(() => onClose(), DURATION)
  }

  function onHandleTouchStart (e) {
    touchStartY.current = e.touches[0].clientY
  }
  function onHandleTouchMove (e) {
    if (touchStartY.current === null) return
    const dy = e.touches[0].clientY - touchStartY.current
    if (dy > 60) { touchStartY.current = null; close() }
  }

  const translateY = (!visible || closing) ? '100%' : '0%'

  return (
    <div style={{ position:'fixed', inset:0, zIndex, display:'flex', alignItems:'flex-end',
      justifyContent:'center', background: visible && !closing ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0)',
      transition:`background ${DURATION}ms ease` }}
      onClick={close}>
      <div onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 430,
          background: 'var(--color-bg)',
          borderRadius: '20px 20px 0 0',
          maxHeight: '80dvh', overflowY: 'auto',
          paddingBottom: 32,
          transform: `translateY(${translateY})`,
          transition: `transform ${DURATION}ms cubic-bezier(0.32,0.72,0,1)`,
          WebkitOverflowScrolling: 'touch',
        }}>
        <div onTouchStart={onHandleTouchStart} onTouchMove={onHandleTouchMove}
          style={{ display:'flex', justifyContent:'center', padding:'16px 0 8px', cursor:'pointer' }}
          onClick={close}>
          <div style={{
            width: 32, height: 3, borderRadius: 2,
            background: 'var(--color-border)',
            margin: '12px auto 4px',
            flexShrink: 0,
          }} />
        </div>
        {children}
      </div>
    </div>
  )
}

function AboutTab ({ th, sync, closeSheetRef }) {
  const LIGHTNING_ADDRESS = 'timmy2383@strike.me'
  const lsBsCloseRef = useRef(null)
  const [lightningModal, setLightningModal] = useState(false)
  useEffect(() => {
    if (closeSheetRef) closeSheetRef.current = () => {
      if (lightningModal) { setLightningModal(false); return true }
      return false
    }
    return () => { if (closeSheetRef) closeSheetRef.current = null }
  }, [lightningModal])

  async function handleDonate () {
    if (!sync) return
    sync.canOpenLightning()
    const result = await new Promise(resolve => {
      const handler = (e) => {
        window.removeEventListener('pear:canOpenLightning', handler)
        resolve(e.detail)
      }
      window.addEventListener('pear:canOpenLightning', handler)
      setTimeout(() => { window.removeEventListener('pear:canOpenLightning', handler); resolve(false) }, 3000)
    })
    if (result) {
      sync.openLightning(LIGHTNING_ADDRESS)
    } else {
      setLightningModal(true)
    }
  }

  const wallets = [
    { name: 'Strike',   url: 'https://strike.me',          desc: 'Simple Lightning payments' },
    { name: 'Cash App', url: 'https://cash.app',           desc: 'Send Bitcoin via Lightning' },
    { name: 'Wallet of Satoshi', url: 'https://walletofsatoshi.com', desc: 'Beginner-friendly Lightning wallet' },
    { name: 'Phoenix',  url: 'https://phoenix.acinq.co',   desc: 'Self-custodial Lightning wallet' },
  ]

  return (
    <div style={{ padding:'16px 20px 0', overflowY:'auto', flex:1,
      paddingBottom:'calc(16px + env(safe-area-inset-bottom))' }}>
      {/* App info */}
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4, marginBottom:16 }}>
        <PearIcon size={44} />
        <div style={{ fontSize:18, fontWeight:400, ...th.text }}>PearCal</div>
        <div style={{ fontSize:12, fontWeight:300, color:th.muted }}>Decentralized. Private. No servers.</div>
      </div>

      {/* P2P explainer */}
      <div style={{ ...th.card, borderRadius:14, padding:'12px 14px', marginBottom:10 }}>
        <div style={{ fontSize:11, fontWeight:400, ...th.text, marginBottom:6, letterSpacing:'0.04em', textAlign:'center' }}>HOW IT WORKS</div>
        <div style={{ fontSize:12, fontWeight:300, color:th.muted, lineHeight:'1.6' }}>
          PearCal syncs directly between devices using peer-to-peer technology powered by Hypercore Protocol.
          Your calendar data never touches a server — it lives only on the devices in your groups.
          No accounts. No subscriptions. No data collection.
        </div>
      </div>

      {/* Donate */}
      <div style={{ ...th.card, borderRadius:14, padding:'12px 14px', marginBottom:10 }}>
        <div style={{ fontSize:11, fontWeight:400, ...th.text, marginBottom:6, letterSpacing:'0.04em', textAlign:'center' }}>SUPPORT DEVELOPMENT</div>
        <div style={{ fontSize:12, fontWeight:300, color:th.muted, lineHeight:'1.6', marginBottom:10 }}>
          PearCal is free and open source. If you receive value from it, please consider returning value via Bitcoin Lightning.
        </div>
        <button onClick={handleDonate}
          style={{ ...th.pillBtn, width:'100%', padding:'10px', fontSize:14, fontWeight:300,
            display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          ⚡ Donate with Lightning ⚡
        </button>
      </div>

      {/* Bitcoin learning card */}
      <div style={{ ...th.card, borderRadius:14, padding:'12px 14px', marginBottom:10 }}>
        <div style={{ fontSize:11, fontWeight:400, ...th.text, marginBottom:6, letterSpacing:'0.04em', textAlign:'center' }}>LEARN ABOUT BITCOIN</div>
        <div style={{ fontSize:12, fontWeight:300, color:th.muted, lineHeight:'1.6', marginBottom:10 }}>
          New to Bitcoin? The Satoshi Nakamoto Institute has a free, concise crash course explaining how Bitcoin works and why it matters.
        </div>
        <button onClick={() => sync?.openURL('https://nakamotoinstitute.org/crash-course/')}
          style={{ ...th.pillBtn, width:'100%', padding:'10px', fontSize:14, fontWeight:300,
            display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          📖 Bitcoin Crash Course ↗
        </button>
      </div>

      {/* Contact */}
      <div style={{ ...th.card, borderRadius:14, padding:'12px 14px', marginBottom:10 }}>
        <div style={{ fontSize:11, fontWeight:400, ...th.text, marginBottom:10, letterSpacing:'0.04em', textAlign:'center' }}>CONTACT</div>
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          <button onClick={() => sync?.openURL('mailto:peerloomllc@proton.me?subject=%5BPearCal%5D%20Feedback')}
            style={{ ...th.pillBtn, width:'100%', padding:'10px', fontSize:14, fontWeight:300,
              display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
            ✉ Send Email ↗
          </button>
          <button onClick={() => sync?.openURL('https://github.com/peerloomllc/pearcal-native/issues')}
            style={{ ...th.pillBtn, width:'100%', padding:'10px', fontSize:14, fontWeight:300,
              display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
            🐛 Report Issue on GitHub ↗
          </button>
        </div>
      </div>

      {/* Lightning wallet info modal */}
      {lightningModal && (
        <BottomSheet th={th} onClose={() => setLightningModal(false)} zIndex={300} closeRef={lsBsCloseRef}>
          <div style={{ padding:'8px 20px 0' }}>
            <div style={{ display:'flex', justifyContent:'center', marginBottom:12 }}>
              <div style={{ width:36, height:4, borderRadius:2, background:th.border }} />
            </div>
            <div style={{ fontSize:18, fontWeight:400, ...th.text, marginBottom:6, textAlign:'center' }}>⚡ Bitcoin Lightning ⚡</div>
            <div style={{ fontSize:13, fontWeight:300, color:th.muted, lineHeight:'1.6', marginBottom:20 }}>
              No Lightning wallet was detected on your device. Bitcoin Lightning is a fast, low-fee payment network built on top of Bitcoin. To send a tip, install one of these wallets:
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {wallets.map(w => (
                <button key={w.name} onClick={() => sync?.openURL(w.url)}
                  style={{ ...th.card, borderRadius:12, padding:'12px 14px', border:`1px solid ${th.border}`,
                    display:'flex', alignItems:'center', gap:12, cursor:'pointer', width:'100%',
                    fontFamily:FONT, textAlign:'left' }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:14, fontWeight:400, ...th.text }}>{w.name}</div>
                    <div style={{ fontSize:12, fontWeight:300, color:th.muted }}>{w.desc}</div>
                  </div>
                  <div style={{ fontSize:13, color:th.muted }}>↗</div>
                </button>
              ))}
            </div>
            <div style={{ fontSize:12, fontWeight:300, color:th.muted, textAlign:'center', marginTop:16 }}>
              After installing, return here and tap Donate again.
            </div>
            <button onClick={() => lsBsCloseRef.current?.()}
              style={{ ...th.pillBtn, width:'100%', padding:'12px', fontSize:14, marginTop:16 }}>
              Close
            </button>
          </div>
        </BottomSheet>
      )}

      <div style={{ textAlign:'center', fontSize:11, fontWeight:300, color:th.muted,
        paddingTop:16, paddingBottom:4 }}>
        v{window.__PEARCAL_VERSION__ ?? '1.0.0'}
      </div>
    </div>
  )
}

function ProfileTab ({ th, profile, groups, onUpdateProfile, db, events, setEvents, dark, onToggleDark }) {
  const [name,       setName]       = useState(profile?.name ?? '')
  const [editing,    setEditing]    = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [photoSaving, setPhotoSaving] = useState(false)
  const [holidayWorking,    setHolidayWorking]    = useState(false)
  const [holidaysOpen,      setHolidaysOpen]      = useState((profile?.holidayCountries ?? []).length > 0)
  const [appearanceOpen,    setAppearanceOpen]    = useState(false)
  const [timeFormatOpen,    setTimeFormatOpen]    = useState(false)
  const [weekStartOpen,     setWeekStartOpen]     = useState(false)
  const [defaultRemOpen,    setDefaultRemOpen]    = useState(false)
  const localeUse24h = !new Intl.DateTimeFormat([], { hour: 'numeric' }).format(0).match(/am|pm/i)
  const use24h    = profile?.use24h    ?? localeUse24h
  const weekStart = profile?.weekStart ?? 0
  const fileRef = useRef()

  async function saveName () {
    setSaving(true)
    await onUpdateProfile({ name })
    setSaving(false)
    setEditing(false)
  }

  async function handlePhotoChange (e) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    setPhotoSaving(true)
    try {
      const compressed = await compressAvatar(file)
      await onUpdateProfile({ avatar: compressed })
    } catch (err) {
      console.error('Photo compress failed', err)
    }
    setPhotoSaving(false)
    // Reset input so same file can be picked again
    e.target.value = ''
  }

  async function removePhoto () {
    const initials = (profile?.name ?? '').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0,2) || '?'
    setPhotoSaving(true)
    await onUpdateProfile({ avatar: initials })
    setPhotoSaving(false)
  }

  const hasPhoto = profile?.avatar?.startsWith?.('data:')
  const publicKey = profile?.publicKey ?? '—'

  return (
    <div style={{ padding:'24px 20px' }}>
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:12, marginBottom:28 }}>

        {/* Avatar — tap to change */}
        <div style={{ position:'relative' }}>
          <div style={{ width:88, height:88, borderRadius:'50%', background:profile?.color ?? '#6C9BF5',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:36, color:'#fff', fontWeight:300, overflow:'hidden',
            opacity: photoSaving ? 0.5 : 1, transition:'opacity 0.2s' }}>
            {hasPhoto
              ? <img src={profile.avatar} alt="avatar"
                  style={{ width:'100%', height:'100%', objectFit:'cover' }} />
              : (profile?.name ?? '?').slice(0,1).toUpperCase()
            }
          </div>
          {photoSaving && (
            <div style={{ position:'absolute', inset:0, borderRadius:'50%',
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>
              ⏳
            </div>
          )}
        </div>

        {/* Photo action buttons */}
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={() => window.__pearSync?.takePhoto?.()} disabled={photoSaving}
            style={{ fontSize:12, padding:'5px 14px', borderRadius:8,
              border:`1px solid ${th.border}`, background:'transparent',
              color:th.text.color, cursor:'pointer', fontWeight:300, fontFamily:FONT,
              opacity: photoSaving ? 0.5 : 1 }}>
            📷 Camera
          </button>
          <button onClick={() => fileRef.current?.click()} disabled={photoSaving}
            style={{ fontSize:12, padding:'5px 14px', borderRadius:8,
              border:`1px solid ${th.border}`, background:'transparent',
              color:th.text.color, cursor:'pointer', fontWeight:300, fontFamily:FONT,
              opacity: photoSaving ? 0.5 : 1 }}>
            🖼️ Gallery
          </button>
          {hasPhoto && (
            <button onClick={removePhoto} disabled={photoSaving}
              style={{ fontSize:12, padding:'5px 14px', borderRadius:8,
                border:`1px solid #D45F7A`, background:'transparent',
                color:'#D45F7A', cursor:'pointer', fontWeight:300, fontFamily:FONT,
                opacity: photoSaving ? 0.5 : 1 }}>
              Remove
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }}
          onChange={handlePhotoChange} />

        {editing
          ? <input autoFocus style={{ fontSize:18, fontWeight:300, textAlign:'center', background:'transparent',
              fontFamily:FONT, border:`1px solid ${th.border}`, borderRadius:8, padding:'6px 12px',
              color:th.text.color, outline:'none' }}
              value={name} onChange={e => setName(e.target.value)} />
          : <span style={{ fontSize:20, fontWeight:300, ...th.text }}>{profile?.name ?? 'My Name'}</span>
        }
        <button
          onClick={editing ? saveName : () => setEditing(true)}
          disabled={saving}
          style={{ ...th.pillBtn, fontSize:13, padding:'5px 16px', fontWeight:300, opacity:saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : editing ? 'Save Name' : 'Edit Name'}
        </button>
      </div>

      <div style={{ ...th.card, borderRadius:12, padding:'14px 16px', marginBottom:16 }}>
        <div style={{ fontSize:12, fontWeight:300, color:th.muted, marginBottom:6, letterSpacing:'0.06em' }}>
          MY PUBLIC KEY
        </div>
        <div style={{ fontSize:11, color:th.text.color, wordBreak:'break-all',
          fontFamily:'monospace', fontWeight:300, lineHeight:1.6 }}>
          {publicKey}
        </div>
        <div style={{ display:'flex', justifyContent:'center', marginTop:10 }}>
          <button onClick={() => navigator.clipboard?.writeText(publicKey)}
            style={{ ...th.pillBtn, fontSize:12, padding:'5px 14px', fontWeight:300 }}>
            Copy Key
          </button>
        </div>
      </div>

      <div style={{ fontSize:12, fontWeight:300, color:th.muted, letterSpacing:'0.06em',
        marginBottom:12, marginTop:4, textAlign:'center' }}>
        SETTINGS
      </div>

      {/* Appearance */}
      <div style={{ ...th.card, borderRadius:12, marginBottom:16, overflow:'hidden' }}>
        <div onClick={() => { window.__pearSync?.haptic('light'); setAppearanceOpen(o => !o) }}
          style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'14px 16px', cursor:'pointer' }}>
          <div style={{ fontSize:12, fontWeight:300, color:th.muted, letterSpacing:'0.06em' }}>
            APPEARANCE
          </div>
          <CaretRight size={16} weight="thin" color="var(--color-muted)"
            style={{ transition: 'transform 0.3s', transform: appearanceOpen ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }} />
        </div>
        <div style={{ maxHeight: appearanceOpen ? '200px' : '0px', overflow:'hidden',
          transition:'max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1)' }}>
          <div style={{ padding:'0 16px 14px', display:'flex', alignItems:'center',
            justifyContent:'space-between' }}>
            <div style={{ fontSize:13, fontWeight:300, ...th.text }}>Dark mode</div>
            <Toggle val={dark} onChange={onToggleDark} accent={th.accent} />
          </div>
        </div>
      </div>

      {/* First Day of Week */}
      <div style={{ ...th.card, borderRadius:12, marginBottom:16, overflow:'hidden' }}>
        <div onClick={() => { window.__pearSync?.haptic('light'); setWeekStartOpen(o => !o) }}
          style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'14px 16px', cursor:'pointer' }}>
          <div style={{ fontSize:12, fontWeight:300, color:th.muted, letterSpacing:'0.06em' }}>
            FIRST DAY OF WEEK
          </div>
          <CaretRight size={16} weight="thin" color="var(--color-muted)"
            style={{ transition: 'transform 0.3s', transform: weekStartOpen ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }} />
        </div>
        <div style={{ maxHeight: weekStartOpen ? '200px' : '0px', overflow:'hidden',
          transition:'max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1)' }}>
          <div style={{ padding:'0 16px 14px', display:'flex', gap:8 }}>
            {[['Sunday', 0], ['Monday', 1]].map(([label, val]) => (
              <button key={val} onClick={() => { window.__pearSync?.haptic('light'); onUpdateProfile({ weekStart: val }) }}
                style={{ flex:1, padding:'8px 0', borderRadius:10, fontSize:13, fontWeight:300,
                  cursor:'pointer', fontFamily:FONT,
                  border:'1.5px solid ' + (weekStart === val ? th.accent : th.border),
                  background: weekStart === val ? th.accent : 'transparent',
                  color: weekStart === val ? '#fff' : th.muted }}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Default Reminder */}
      <div style={{ ...th.card, borderRadius:12, marginBottom:16, overflow:'hidden' }}>
        <div onClick={() => { window.__pearSync?.haptic('light'); setDefaultRemOpen(o => !o) }}
          style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'14px 16px', cursor:'pointer' }}>
          <div style={{ fontSize:12, fontWeight:300, color:th.muted, letterSpacing:'0.06em' }}>
            DEFAULT REMINDER
          </div>
          <CaretRight size={16} weight="thin" color="var(--color-muted)"
            style={{ transition: 'transform 0.3s', transform: defaultRemOpen ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }} />
        </div>
        <div style={{ maxHeight: defaultRemOpen ? '200px' : '0px', overflow:'hidden',
          transition:'max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1)' }}>
          <div style={{ padding:'0 16px 14px' }}>
            <select value={profile?.defaultReminder ?? 15}
              onChange={e => { window.__pearSync?.haptic('light'); onUpdateProfile({ defaultReminder: Number(e.target.value) }) }}
              style={{ width:'100%', padding:'10px 12px', borderRadius:10, fontSize:13, fontWeight:300,
                border:`1px solid ${th.border}`, background:th.inputBg, color:th.text.color,
                fontFamily:FONT, appearance:'none' }}>
              {REMINDER_OPTIONS.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Time Format */}
      <div style={{ ...th.card, borderRadius:12, marginBottom:16, overflow:'hidden' }}>
        <div onClick={() => { window.__pearSync?.haptic('light'); setTimeFormatOpen(o => !o) }}
          style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'14px 16px', cursor:'pointer' }}>
          <div style={{ fontSize:12, fontWeight:300, color:th.muted, letterSpacing:'0.06em' }}>
            TIME FORMAT
          </div>
          <span style={{ fontSize:16, color:th.muted, transition:'transform 0.3s',
            transform: timeFormatOpen ? 'rotate(90deg)' : 'rotate(0deg)',
            display:'inline-block' }}><CaretRight size={16} weight="thin" color="var(--color-muted)" /></span>
        </div>
        <div style={{ maxHeight: timeFormatOpen ? '200px' : '0px', overflow:'hidden',
          transition:'max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1)' }}>
          <div style={{ padding:'0 16px 14px', display:'flex', alignItems:'center',
            justifyContent:'space-between' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:300, ...th.text }}>24-hour time</div>
              <div style={{ fontSize:11, color:th.muted, fontWeight:300, marginTop:2 }}>
                {use24h ? 'e.g. 14:30' : 'e.g. 2:30pm'}
              </div>
            </div>
            <Toggle val={use24h} onChange={v => onUpdateProfile({ use24h: v })} accent={th.accent} />
          </div>
        </div>
      </div>

      {/* Holidays */}
      {(() => {
        const thisYear = new Date().getFullYear()
        const slug = t => t.replace(/\s+/g, '-').toLowerCase()
        const makeId = h => 'holiday-' + h.date + '-' + slug(h.title)
        const allCountries = [
          { code:'us', flag:'🇺🇸', label:'United States', fn: getUSFederalHolidays },
          { code:'ca', flag:'🇨🇦', label:'Canada',         fn: getCanadaHolidays   },
          { code:'uk', flag:'🇬🇧', label:'United Kingdom', fn: getUKHolidays       },
        ]
        // Toggle state tracked explicitly in profile to avoid shared-ID false positives
        const activeCountries = new Set(profile?.holidayCountries ?? [])

        async function toggleCountry (code, fn, on) {
          setHolidayWorking(true)
          const newActive = new Set(activeCountries)
          if (on) {
            newActive.add(code)
            // Import holidays; skip any already in calendar by shared ID or same date+title
            const existingIds = new Set((events ?? []).map(e => e.id))
            const existingKeys = new Set((events ?? []).map(e => e.date + '|' + e.title))
            for (const yr of [thisYear, thisYear + 1]) {
              for (const h of fn(yr)) {
                const id = makeId(h)
                const key = h.date + '|' + h.title
                if (existingIds.has(id) || existingKeys.has(key)) continue
                const ev = {
                  id, title: h.title, date: h.date, allDay: true,
                  start: '00:00', end: '00:00', reminder: -1,
                  groups: [], invitees: [], color: '#CF3535',
                  desc: 'Public Holiday', location: '',
                  creatorId: 'system', recurrence: 'none',
                  recurrenceId: '', recurrenceEnd: '', recurrenceNth: 0, recurrenceWeekday: 0,
                  editPermission: 'everyone', updatedAt: Date.now(),
                }
                await db?.putEvent(ev).catch(() => {})
                setEvents(prev => prev.find(e => e.id === ev.id) ? prev : [...prev, ev])
                existingIds.add(id)
                existingKeys.add(key)
              }
            }
          } else {
            newActive.delete(code)
            // Keep IDs still needed by other still-active countries
            const keepIds = new Set()
            for (const { code: otherCode, fn: otherFn } of allCountries) {
              if (otherCode === code || !newActive.has(otherCode)) continue
              for (const yr of [thisYear, thisYear + 1]) {
                for (const h of otherFn(yr)) keepIds.add(makeId(h))
              }
            }
            for (const yr of [thisYear, thisYear + 1]) {
              for (const h of fn(yr)) {
                const id = makeId(h)
                if (keepIds.has(id)) continue
                const ev = (events ?? []).find(e => e.id === id)
                if (ev) {
                  await db?.localDeleteEvent(ev.date, ev.id).catch(() => {})
                  setEvents(prev => prev.filter(e => e.id !== id))
                }
              }
            }
          }
          await onUpdateProfile({ holidayCountries: [...newActive] }).catch(() => {})
          setHolidayWorking(false)
        }

        const anyEnabled = activeCountries.size > 0
        return (
          <div style={{ ...th.card, borderRadius:12, marginBottom:16, overflow:'hidden',
            opacity: holidayWorking ? 0.6 : 1, transition:'opacity 0.2s' }}>

            {/* Collapsible header */}
            <div onClick={() => { window.__pearSync?.haptic('light'); setHolidaysOpen(o => !o) }}
              style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                padding:'14px 16px', cursor:'pointer' }}>
              <div style={{ fontSize:12, fontWeight:300, color:th.muted, letterSpacing:'0.06em' }}>
                HOLIDAYS
              </div>
              <span style={{ fontSize:16, color:th.muted, transition:'transform 0.3s',
                transform: holidaysOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                display:'inline-block' }}><CaretRight size={16} weight="thin" color="var(--color-muted)" /></span>
            </div>

            {/* Collapsible body */}
            <div style={{ maxHeight: holidaysOpen ? '600px' : '0px', overflow:'hidden',
              transition:'max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1)' }}>
              <div style={{ padding:'0 16px 14px' }}>
                {allCountries.map(({ code, flag, label, fn }, i) => (
                  <div key={code} style={{ display:'flex', alignItems:'center', gap:10,
                    padding:'10px 0', borderBottom: i < allCountries.length - 1 ? `1px solid ${th.border}` : 'none' }}>
                    <span style={{ fontSize:20 }}>{flag}</span>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, fontWeight:300, ...th.text }}>{label}</div>
                      <div style={{ fontSize:11, color:th.muted, fontWeight:300 }}>
                        {fn(thisYear).length} holidays · {thisYear}–{thisYear + 1}
                      </div>
                    </div>
                    <Toggle val={activeCountries.has(code)}
                      onChange={v => !holidayWorking && toggleCountry(code, fn, v)} accent={th.accent} />
                  </div>
                ))}
                {anyEnabled && (
                  <div style={{ fontSize:11, color:th.muted, fontWeight:300, marginTop:10 }}>
                    Added to your personal calendar. Toggle off to remove.
                  </div>
                )}
              </div>
            </div>

          </div>
        )
      })()}
    </div>
  )
}

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
if (typeof document !== 'undefined' && !document.getElementById('pear-anims')) {
  const style = document.createElement('style')
  style.id = 'pear-anims'
  style.textContent = `
    @keyframes pearFadeIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }
    @keyframes pearSlideInRight { from { opacity: 0; transform: translateX(32px) } to { opacity: 1; transform: translateX(0) } }
    @keyframes pearSlideInLeft { from { opacity: 0; transform: translateX(-32px) } to { opacity: 1; transform: translateX(0) } }
    @keyframes pearSkeletonPulse { 0%,100% { opacity: 0.4 } 50% { opacity: 0.8 } }
  `
  document.head.appendChild(style)
}

const FONT = `"Segoe UI Light","Helvetica Neue Light","Helvetica Neue",Helvetica,Arial,sans-serif`
const GROUP_COLORS = ['#6C9BF5','#5DBF8A','#E5864A','#D45F7A','#A97FD4','#4BBDCC','#F5C842','#E07B54']
const GROUP_EMOJIS = ['👨‍👩‍👧‍👦','⚽','📚','🎮','🏋️','🎵','🌿','🐾','✈️','🍕','💼','🎨']
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const REMINDER_OPTIONS = [
  {label:'None',value:0},{label:'5 min before',value:5},{label:'10 min before',value:10},
  {label:'15 min before',value:15},{label:'30 min before',value:30},
  {label:'1 hour before',value:60},{label:'2 hours before',value:120},{label:'1 day before',value:1440},
]

function themes (dark) {
  const accent = '#6C9BF5'
  const base = {
    accent,
    accentFaint: 'rgba(108,155,245,0.15)',
    iconBtn: { background:'none',border:'none',cursor:'pointer',padding:'4px 8px',borderRadius:8,fontFamily:FONT,fontWeight:300 },
    pillBtn: { background:accent,border:'none',borderRadius:10,color:'#fff',cursor:'pointer',fontFamily:FONT },
  }
  return dark ? {
    ...base,
    app:{background:'#111'},bg:{background:'#111'},headerBg:{background:'#111'},
    text:{color:'#F0F0F0'},muted:'#888',border:'#2A2A2A',
    card:{background:'#1C1C1C'},inputBg:'#1C1C1C',navBg:{background:'#111'},
    iconBtn:{...base.iconBtn,color:'#F0F0F0'},
  } : {
    ...base,
    app:{background:'#F5F6FA'},bg:{background:'#F5F6FA'},headerBg:{background:'#fff'},
    text:{color:'#111'},muted:'#999',border:'#E5E5E5',
    card:{background:'#fff',boxShadow:'0 1px 4px rgba(0,0,0,0.06)'},
    inputBg:'#F5F6FA',navBg:{background:'#fff'},
    iconBtn:{...base.iconBtn,color:'#111'},
  }
}

// ─── Root App ─────────────────────────────────────────────────────────────────
export default function App ({ db, notifs, sync }) {
  const [dark,  setDark]  = useState(true)
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
  const [onboardStep,   setOnboardStep]   = useState(0)
  const showOnboarding = ready && !profile?.onboardingComplete
  const [showDonationReminder, setShowDonationReminder] = useState(false)
  const tabHistoryRef  = useRef([])
  const tabRef         = useRef('calendar')
  const backHandlerRef = useRef(null)
  const closeAboutSheetRef = useRef(null)
  const goTab = (t) => { tabHistoryRef.current.push(tabRef.current); tabRef.current = t; setTab(t) }
  const [readyGroupKeys, setReadyGroupKeys] = useState(() => new Set())

  const th = themes(dark)

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
      if (modal)        { setModal(null);        return }
      if (newGroupOpen) { setNewGroupOpen(false); return }
      if (settingsGroup){ setSettingsGroup(null); return }
      const prev = tabHistoryRef.current.pop()
      if (prev) { tabRef.current = prev; setTab(prev); return }
      window.ReactNativeWebView?.postMessage(JSON.stringify({ method: 'exitApp', id: -1 }))
    }
  }, [modal, newGroupOpen, settingsGroup, qrGroup, closeAboutSheetRef, showOnboarding, onboardStep])
  useEffect(() => { window.__pearBack = () => backHandlerRef.current?.() }, [])
  useEffect(() => { window.__pearSync = sync }, [sync])
  useEffect(() => {
    function onQrScanResult(url) {
      if (url && db && sync) {
        handleInviteLink(url, db, sync, g => {
          setGroups(prev => prev.find(x => x.id === g.id) ? prev : [...prev, g])
          setTab('groups')
        })
      }
    }
    emitter.on('qrScanResult', onQrScanResult)
    return () => emitter.off('qrScanResult', onQrScanResult)
  }, [db, sync])

  // ── Expose global bridge for Android → JS calls ────────────────────────────
  useEffect(() => {
    if (!db || !sync) return
    window.__pearCal = {
      handleLink: url => handleInviteLink(url, db, sync, g => {
        setGroups(prev => [...prev, g])
        setTab('groups')
      }),
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

  const saveEvent = useCallback(async ev => {
    const { _prevDate, ...evClean } = ev
    ev = evClean
    if (db) {
      // If date changed, delete old local entry to avoid duplicate
      if (_prevDate && _prevDate !== ev.date) {
        await db.deleteEvent(_prevDate, ev.id).catch(() => {})
        setEvents(prev => prev.filter(e => !(e.id === ev.id && e.date === _prevDate)))
      }
      const evWithAuthor = { ...ev, updatedByName: profile?.name ?? 'Someone' }
      await db.putEvent(evWithAuthor)
      await notifs?.scheduleForEvent(evWithAuthor)
      // Include _prevDate in sync payload so peers can clean up old date entry
      const evToSync = _prevDate ? { ...evWithAuthor, _prevDate } : evWithAuthor
      for (const gid of evWithAuthor.groups ?? []) {
        await sync?.putEvent(gid, evToSync).catch(e => console.warn('[SYNC-ERR]', e?.message))
      }
    }
    setEvents(prev => {
      const i = prev.findIndex(e => e.id === ev.id)
      if (i >= 0) { const n = [...prev]; n[i] = ev; return n }
      return [...prev, ev]
    })
    setModal(null)
  }, [db, notifs, sync, profile])

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
          await sync?.deleteEvent(gid, id, ev.date, profile?.name ?? 'Someone').catch(() => {})
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
    const first   = new Date(y, m, 1).getDay()
    const last    = new Date(y, m + 1, 0).getDate()
    const prevLast = new Date(y, m, 0).getDate()
    const cells = []
    const prevM = m === 0 ? 11 : m - 1
    const prevY = m === 0 ? y - 1 : y
    const nextM = m === 11 ? 0 : m + 1
    const nextY = m === 11 ? y + 1 : y
    for (let i = 0; i < first; i++)
      cells.push({ d: prevLast - first + 1 + i, y: prevY, m: prevM, type: 'prev' })
    for (let d = 1; d <= last; d++)
      cells.push({ d, y, m, type: 'cur' })
    let nextD = 1
    while (cells.length < 42)
      cells.push({ d: nextD++, y: nextY, m: nextM, type: 'next' })
    return cells
  }, [viewDate])

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
      allDay:false, start:defaultStart, end:defaultEnd, reminder:15,
      groups:[], invitees:[], color:'#6C9BF5', desc:'', creatorId: profile?.id ?? 'unknown',
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
      <span style={{ fontSize:36 }}>🍐</span>
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
          <span style={{ fontSize:20, fontWeight:300, ...th.text }}>🍐 PearCal</span>
          <button onClick={() => setDark(d => !d)} style={{ ...th.iconBtn, fontSize:18 }}>
            {dark ? '☀️' : '🌙'}
          </button>
        </div>

        {/* Content */}
        <div style={{ flex:1, overflowY:'auto', paddingBottom:72, minHeight:0 }}>
          <div key={tab} style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden',
            animation:'pearFadeIn 0.22s ease' }}>
          {tab === 'calendar' && (
            <CalendarTab th={th} viewDate={viewDate} setViewDate={setViewDate}
              calDays={calDays} selectedDate={selectedDate} setSelectedDate={setSelectedDate}
              eventsOnDate={eventsOnDate} todayStr={todayStr()} dateStr={dateStr}
              selectedEvents={eventsOnDate(selectedDate)} openCreate={openCreate}
              setModal={setModal} events={events} />
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
              onQrGroup={g => setQrGroup(g)} />
          )}
          {tab === 'profile' && (
            <ProfileTab th={th} profile={profile} groups={groups} onUpdateProfile={updateProfile} />
          )}
          {tab === 'about' && (
            <AboutTab th={th} sync={sync} closeSheetRef={closeAboutSheetRef} />
          )}
          </div>
        </div>

        {/* Bottom Nav */}
        <div style={{ position:'fixed', bottom:0, left:'50%', transform:'translateX(-50%)',
          width:'100%', maxWidth:430, ...th.navBg, display:'flex',
          borderTop:`1px solid ${th.border}`, zIndex:50,
          paddingBottom:'env(safe-area-inset-bottom, 0px)' }}>
          {[
            { key:'calendar', icon:'📅', label:'Calendar' },
            { key:'groups',   icon:'👥', label:'Groups'   },
            { key:'profile',  icon:'👤', label:'Profile'  },
            { key:'about',    icon:'ℹ️',  label:'About'    },
          ].map(t => {
            const isActive = tab === t.key
            return (
              <button key={t.key} onClick={() => goTab(t.key)}
                style={{ flex:1, padding:'10px 0 8px', border:'none', cursor:'pointer',
                  display:'flex', flexDirection:'column', alignItems:'center', gap:3, fontFamily:FONT,
                  background: isActive ? th.accent + '18' : 'none',
                  borderTop: isActive ? `3px solid ${th.accent}` : '3px solid transparent',
                  transition:'background 0.15s' }}>
                <span style={{ fontSize:22 }}>{t.icon}</span>
                <span style={{ fontSize:11, fontWeight:isActive ? 400 : 300,
                  color:isActive ? th.accent : th.muted }}>{t.label}</span>
              </button>
            )
          })}
        </div>

        {/* Modals */}
        {showOnboarding && <OnboardingModal th={th} step={onboardStep} setStep={setOnboardStep}
          profile={profile} onUpdateProfile={updateProfile} db={db} />}
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
          <EventModal th={th} modal={modal} setModal={setModal} groups={groups} profile={profile}
            onSave={saveEvent} onDelete={deleteEvent} REMINDER_OPTIONS={REMINDER_OPTIONS} />
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
            onUpdate={updateGroup} onDelete={deleteGroup} />
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
    <div onClick={() => onChange(!val)}
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
function CalendarTab ({ th, viewDate, setViewDate, calDays, selectedDate, setSelectedDate,
  eventsOnDate, todayStr, dateStr, selectedEvents, openCreate, setModal, events }) {
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
        {DAYS.map(d => (
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
          style={{ ...th.pillBtn, fontSize:13, padding:'6px 14px', fontWeight:300 }}>+ Event</button>
      </div>
      {/* Scrollable event list — flat, stable, never restructures */}
      <div ref={scrollRef} onScroll={handleScroll} style={{ flex:1, overflowY:'auto', padding:'0 16px 16px', minHeight:0 }}>
      {(() => {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30)
        const cutoffStr = cutoff.toISOString().slice(0,10)
        const seen = new Map()
        const days = []
        events
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
            {seen.get(date).map(ev => (
              <EventCard key={ev.id} ev={ev} th={th} isPast={date < todayStr}
                onClick={() => setModal({ mode:'edit', event:{ ...ev } })} />
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
          PearCal is free, open source, and has no ads or subscriptions. If it's been useful to you, consider sending a small tip via Bitcoin Lightning to support development.
        </div>
        <button onClick={onDonate}
          style={{ ...th.pillBtn, width:'100%', padding:'13px', fontSize:15, fontWeight:300,
            display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          Donate with Bitcoin over Lightning ⚡
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

function OnboardingModal ({ th, step, setStep, profile, onUpdateProfile, db }) {
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
      <div style={{ fontSize:56 }}>🍐</div>
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
      <button onClick={() => fileRef.current?.click()} disabled={photoSaving}
        style={{ ...th.pillBtn, padding:'12px 40px', fontSize:16, fontWeight:300 }}>
        {photoSaving ? 'Uploading…' : hasPhoto ? '📷 Change Photo' : '📷 Choose Photo'}
      </button>
      <button onClick={() => { setSlideDir(1); setStep(4) }}
        style={{ ...th.pillBtn, padding:'12px 40px', fontSize:16, fontWeight:300 }}>
        {hasPhoto ? 'Continue' : 'Skip for now'}
      </button>
    </div>,

    // Slide 4 — Groups & Invites
    <div key={4} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:20, flex:1, justifyContent:'center' }}>
      <div style={{ fontSize:48 }}>👥</div>
      <div style={{ fontSize:22, fontWeight:400, ...th.text, textAlign:'center' }}>Sharing with others</div>
      <div style={{ display:'flex', flexDirection:'column', gap:12, width:'100%', maxWidth:300 }}>
        <div style={{ ...th.card, borderRadius:12, padding:'14px 16px', display:'flex', gap:12, alignItems:'center' }}>
          <span style={{ fontSize:22 }}>＋</span>
          <div>
            <div style={{ fontSize:14, fontWeight:400, ...th.text, marginBottom:4, textAlign:'left' }}>Create a group</div>
            <div style={{ fontSize:13, fontWeight:300, color:th.muted, lineHeight:'1.5' }}>
              Tap the Groups tab and hit "+New Group" to create a shared calendar with a name and colour.
            </div>
          </div>
        </div>
        <div style={{ ...th.card, borderRadius:12, padding:'14px 16px', display:'flex', gap:12, alignItems:'center' }}>
          <span style={{ fontSize:22 }}>📤</span>
          <div>
            <div style={{ fontSize:14, fontWeight:400, ...th.text, marginBottom:4, textAlign:'left' }}>Invite people</div>
            <div style={{ fontSize:13, fontWeight:300, color:th.muted, lineHeight:'1.5' }}>
              Share the invite link or QR code from the group card. Anyone who opens the link joins instantly.
            </div>
          </div>
        </div>
        <div style={{ ...th.card, borderRadius:12, padding:'14px 16px', display:'flex', gap:12, alignItems:'center' }}>
          <span style={{ fontSize:22 }}>📅</span>
          <div>
            <div style={{ fontSize:14, fontWeight:400, ...th.text, marginBottom:4, textAlign:'left' }}>Add events</div>
            <div style={{ fontSize:13, fontWeight:300, color:th.muted, lineHeight:'1.5' }}>
              Tap any day on the calendar and hit "+Event". Assign it to one or more groups to share it.
            </div>
          </div>
        </div>
      </div>
      <button onClick={() => onUpdateProfile({ name: profile?.name ?? name.trim(), onboardingComplete: true })}
        style={{ ...th.pillBtn, padding:'12px 40px', fontSize:16, fontWeight:300, marginTop:4 }}>
        Let's go!
      </button>
    </div>
  ]

  return (
    <div style={{ position:'fixed', inset:0, zIndex:500, ...th.bg,
      display:'flex', flexDirection:'column', padding:'48px 28px 32px' }}>
      {/* Back button */}
      {step > 0 && (
        <button onClick={() => { setSlideDir(-1); setStep(s => s - 1) }}
          style={{ position:'absolute', top:48, left:24, background:'none', border:'none',
            color:th.muted, fontSize:22, cursor:'pointer', fontFamily:FONT, padding:4 }}>
          ‹
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

function EventCard ({ ev, th, onClick, compact, isPast }) {
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
          {ev.allDay ? 'All day' : `${ev.start} – ${ev.end}`}
          {compact && ` · ${new Date(ev.date + 'T12:00:00').toLocaleDateString('en-US',
            { month:'short', day:'numeric' })}`}
        </div>
        {!compact && ev.desc ? <div style={{ fontSize:12, color:th.muted, marginTop:4, fontWeight:300,
          overflow:'hidden', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical',
          lineHeight:'1.35' }}>{ev.desc}</div> : null}
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:3, alignItems:'center', marginTop:2, flexShrink:0 }}>
        {(ev.colors?.length > 0 ? ev.colors : [ev.color]).map((c, i) => (
          <div key={i} style={{ width:8, height:8, borderRadius:'50%', background:c }} />
        ))}
      </div>
    </div>
  )
}

// ─── Event Modal ──────────────────────────────────────────────────────────────
function EventModal ({ th, modal, setModal, groups, profile, onSave, onDelete, REMINDER_OPTIONS }) {
  const [ev, setEv] = useState(modal.event)
  const [saving, setSaving] = useState(false)
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

  async function handleSave () {
    if (!ev.title.trim()) { setTitleErr('Event title is required.'); return }
    setTitleErr('')
    setSaving(true)
    const toSave = origDate && origDate !== ev.date ? { ...ev, _prevDate: origDate } : ev
    await onSave(toSave)
    setSaving(false)
  }

  const bsCloseRef = useRef(null)
  const inp = { background:th.inputBg, border:`1px solid ${th.border}`, borderRadius:8,
    padding:'9px 12px', color:th.text.color, fontSize:14, fontWeight:300,
    fontFamily:FONT, width:'100%', boxSizing:'border-box', outline:'none' }

  return (
    <BottomSheet th={th} onClose={() => setModal(null)} zIndex={100} closeRef={bsCloseRef}>
      <div style={{ padding:'12px 20px 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontWeight:300, fontSize:17, ...th.text }}>
            {modal.mode === 'create' ? 'New Event' : 'Edit Event'}
          </span>
          <button onClick={() => bsCloseRef.current?.()} style={{ ...th.iconBtn, fontSize:20 }}>✕</button>
        </div>
        <div style={{ padding:'16px 20px', display:'flex', flexDirection:'column', gap:14 }}>
          <div>
            <input style={{ ...inp, borderColor: titleErr ? '#D45F7A' : inp.border }}
              placeholder="Event title" value={ev.title}
              onChange={e => { set('title', e.target.value); if (e.target.value.trim()) setTitleErr('') }} />
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
                      <MemberAvatar avatar={m.avatar} name={m.name} color={col} size={24} fontSize={11} />
                      <span style={{ fontSize:13, color:sel ? '#fff' : col, fontWeight:300 }}>{m.name}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div><Label th={th}>Notes</Label>
            <textarea style={{ ...inp, resize:'none', minHeight:60 }} placeholder="Optional notes…"
              value={ev.desc} onChange={e => set('desc', e.target.value)} />
          </div>

          <button onClick={handleSave} disabled={saving}
            style={{ ...th.pillBtn, width:'100%', padding:'13px', fontSize:15, fontWeight:300,
              marginTop:4, opacity:saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : modal.mode === 'create' ? 'Create Event' : 'Save Changes'}
          </button>

          {modal.mode === 'edit' && (() => {
            const isCreator = ev.creatorId && profile?.id && ev.creatorId === profile.id
            return (
              <button onClick={() => onDelete(ev.id)}
                style={{ background:'transparent', border:`1px solid #D45F7A`, borderRadius:12,
                  padding:'11px', color:'#D45F7A', fontSize:14, fontWeight:300,
                  fontFamily:FONT, cursor:'pointer', width:'100%' }}>
                {isCreator ? 'Delete for Everyone' : 'Delete for Me'}
              </button>
            )
          })()}
        </div>
    </BottomSheet>
  )
}

// ─── Groups Tab ───────────────────────────────────────────────────────────────
function GroupsTab ({ th, groups, profile, sync, db, readyGroupKeys, onNewGroup, onSettings, onQrGroup }) {
  const [copiedId, setCopiedId] = useState(null)


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

  function previewInvite (g) {
    return buildInviteLink(g, profile?.publicKey ?? 'unknown')
  }

  return (
    <div style={{ padding:'16px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <span style={{ fontWeight:300, fontSize:17, ...th.text }}>Peer Groups</span>
        <button onClick={onNewGroup} style={{ ...th.pillBtn, fontSize:13, padding:'6px 14px', fontWeight:300 }}>
          + New Group
        </button>
      </div>

      {groups.length === 0 && (
        <div style={{ textAlign:'center', color:th.muted, fontSize:14, fontWeight:300, padding:'48px 0' }}>
          No groups yet — create one!
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
                ⚙️
              </button>
            </div>

            {/* Member avatars */}
            <div style={{ display:'flex', gap:6, marginBottom:12, flexWrap:'wrap' }}>
              {g.members.map(m => (
                <div key={m.id} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
                  <MemberAvatar avatar={m.avatar} name={m.name} color={g.color} size={34} fontSize={13} />
                  <span style={{ fontSize:10, color:th.muted, fontWeight:300 }}>{m.name}</span>
                </div>
              ))}
            </div>

            {/* Invite link row */}
            <div style={{ background:th.inputBg, borderRadius:8, padding:'8px 10px',
              display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ fontSize:11, color:th.muted, overflow:'hidden', textOverflow:'ellipsis',
                whiteSpace:'nowrap', flex:1, fontFamily:'monospace', fontWeight:300 }}>
                {previewInvite(g)}
              </span>

              <button onClick={async e => {
                  e.stopPropagation()
                  if (!readyGroupKeys.has(g.id)) return
                  const fresh = db ? await db.getGroup(g.id).catch(() => null) : null
                  const src = fresh ?? g
                  const link = buildInviteLink(src, profile?.publicKey ?? 'unknown')
                  if (sync) sync.nativeShare(`Join ${src.name} on PearCal`, link)
                  else navigator.clipboard?.writeText(link)
                }}
                disabled={!readyGroupKeys.has(g.id)}
                style={{ background:'transparent', border:`1px solid ${g.color}44`,
                  borderRadius:6, fontFamily:FONT, color:readyGroupKeys.has(g.id) ? g.color : th.muted,
                  fontSize:12, fontWeight:300, padding:'5px 10px',
                  cursor:readyGroupKeys.has(g.id) ? 'pointer' : 'not-allowed',
                  flexShrink:0, opacity:readyGroupKeys.has(g.id) ? 1 : 0.5 }}>
                📤
              </button>
              <button onClick={async e => { e.stopPropagation(); if (!readyGroupKeys.has(g.id)) return
                  const fresh = db ? await db.getGroup(g.id).catch(() => null) : null
                  const src = fresh ?? g
                  const link = buildInviteLink(src, profile?.publicKey ?? 'unknown')
                  onQrGroup({ group: src, link }) }}
                disabled={!readyGroupKeys.has(g.id)}
                style={{ background:'transparent', border:`1px solid ${g.color}44`,
                  borderRadius:6, fontFamily:FONT, color:readyGroupKeys.has(g.id) ? g.color : th.muted,
                  fontSize:12, fontWeight:300, padding:'5px 10px',
                  cursor:readyGroupKeys.has(g.id) ? 'pointer' : 'not-allowed',
                  flexShrink:0, opacity:readyGroupKeys.has(g.id) ? 1 : 0.5 }}>
                ⬛
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Group Settings Modal ─────────────────────────────────────────────────────
function GroupSettingsModal ({ th, group, me, db, sync, onClose, onUpdate, onDelete, onMemberLeft }) {
  const bsCloseRef = useRef(null)
  const [g,       setG]       = useState({ ...group })
  const [nameErr, setNameErr] = useState('')
  const [confirm, setConfirm] = useState(null)
  const [saved,   setSaved]   = useState(false)
  const [saving,  setSaving]  = useState(false)
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

  const inp = { background:th.inputBg, border:`1px solid ${th.border}`, borderRadius:8,
    padding:'9px 12px', color:th.text.color, fontSize:14, fontWeight:300,
    fontFamily:FONT, width:'100%', boxSizing:'border-box', outline:'none' }

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
                      📤 Share Again
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
                      📤 Reinvite
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
                        {m.name}
                        {isMe && <span style={{ fontSize:11, color:th.muted, marginLeft:6, fontWeight:300 }}>(you)</span>}
                      </div>
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
              {isMember && (
                <button onClick={() => setConfirm('leave')}
                  style={{ width:'100%', padding:'14px 16px', background:'transparent', border:'none',
                    fontFamily:FONT, borderBottom:isOwner ? `1px solid #D45F7A44` : 'none',
                    color:'#D45F7A', fontSize:14, fontWeight:300, cursor:'pointer',
                    textAlign:'left', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span>🚪 Leave Group</span>
                  <span style={{ fontSize:12, color:th.muted, fontWeight:300 }}>You'll lose access to shared events</span>
                </button>
              )}
              {isOwner && (
                <button onClick={() => setConfirm('delete')}
                  style={{ width:'100%', padding:'14px 16px', background:'#D45F7A11', border:'none',
                    fontFamily:FONT, color:'#D45F7A', fontSize:14, fontWeight:300, cursor:'pointer',
                    textAlign:'left', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span>🗑 Delete Group</span>
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
              {confirm === 'delete' ? '🗑' : confirm === 'leave' ? '🚪' : '👤'}
            </div>
            <div style={{ fontWeight:300, fontSize:17, ...th.text, marginBottom:8 }}>
              {confirm === 'delete' ? 'Delete Group?'
                : confirm === 'leave' ? 'Leave Group?'
                : `Remove ${g.members.find(m => m.id === confirm.split(':')[1])?.name}?`}
            </div>
            <div style={{ fontSize:14, color:th.muted, marginBottom:20, lineHeight:1.5, fontWeight:300 }}>
              {confirm === 'delete' && `"${g.name}" will be permanently removed for you.`}
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

  const inp = { background:th.inputBg, border:`1px solid ${th.border}`, borderRadius:8,
    padding:'9px 12px', color:th.text.color, fontSize:14, fontWeight:300,
    fontFamily:FONT, width:'100%', boxSizing:'border-box', outline:'none' }

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
                    📤 Share…
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
  const DURATION = 420

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
        style={{ width:'100%', maxWidth:430, ...th.bg, borderRadius:'20px 20px 0 0',
          maxHeight:'92vh', overflowY:'auto', paddingBottom:32,
          transform:`translateY(${translateY})`,
          transition:`transform ${DURATION}ms cubic-bezier(0.32,0.72,0,1)` }}>
        <div onTouchStart={onHandleTouchStart} onTouchMove={onHandleTouchMove}
          style={{ display:'flex', justifyContent:'center', padding:'16px 0 8px', cursor:'pointer' }}
          onClick={close}>
          <div style={{ width:40, height:5, borderRadius:3, background:th.border }} />
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
    <div style={{ padding:'24px 20px', overflowY:'auto', flex:1 }}>
      {/* App info */}
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, marginBottom:28 }}>
        <div style={{ fontSize:52 }}>🍐</div>
        <div style={{ fontSize:22, fontWeight:400, ...th.text }}>PearCal</div>
        <div style={{ fontSize:13, fontWeight:300, color:th.muted }}>Decentralized. Private. No servers.</div>
      </div>

      {/* P2P explainer */}
      <div style={{ ...th.card, borderRadius:14, padding:'16px 18px', marginBottom:16 }}>
        <div style={{ fontSize:13, fontWeight:400, ...th.text, marginBottom:8, letterSpacing:'0.04em', textAlign:'center' }}>HOW IT WORKS</div>
        <div style={{ fontSize:13, fontWeight:300, color:th.muted, lineHeight:'1.7' }}>
          PearCal syncs directly between devices using peer-to-peer technology powered by Hypercore Protocol.
          Your calendar data never touches a server — it lives only on the devices in your groups.
          No accounts. No subscriptions. No data collection.
        </div>
      </div>

      {/* Donate */}
      <div style={{ ...th.card, borderRadius:14, padding:'16px 18px', marginBottom:16 }}>
        <div style={{ fontSize:13, fontWeight:400, ...th.text, marginBottom:8, letterSpacing:'0.04em', textAlign:'center' }}>SUPPORT DEVELOPMENT</div>
        <div style={{ fontSize:13, fontWeight:300, color:th.muted, lineHeight:'1.7', marginBottom:14 }}>
          PearCal is free and open source. If you receive value from it, please consider returning value via Bitcoin Lightning.
        </div>
        <button onClick={handleDonate}
          style={{ ...th.pillBtn, width:'100%', padding:'12px', fontSize:15, fontWeight:300,
            display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          ⚡ Donate with Lightning ⚡
        </button>
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
    </div>
  )
}

function ProfileTab ({ th, profile, groups, onUpdateProfile }) {
  const [name,       setName]       = useState(profile?.name ?? '')
  const [editing,    setEditing]    = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [photoSaving, setPhotoSaving] = useState(false)
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
          <button onClick={() => fileRef.current?.click()} disabled={photoSaving}
            style={{ fontSize:12, padding:'5px 14px', borderRadius:8,
              border:`1px solid ${th.border}`, background:'transparent',
              color:th.text.color, cursor:'pointer', fontWeight:300, fontFamily:FONT,
              opacity: photoSaving ? 0.5 : 1 }}>
            📷 {hasPhoto ? 'Change Photo' : 'Add Photo'}
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

      <div style={{ ...th.card, borderRadius:12, padding:'14px 16px', marginBottom:16 }}>
        <div style={{ fontSize:12, fontWeight:300, color:th.muted, marginBottom:10, letterSpacing:'0.06em' }}>
          MY PEER GROUPS
        </div>
        {groups.length === 0 && (
          <div style={{ fontSize:13, color:th.muted, fontWeight:300, padding:'8px 0' }}>
            No groups yet.
          </div>
        )}
        {groups.map(g => (
          <div key={g.id} style={{ display:'flex', alignItems:'center', gap:10,
            padding:'6px 0', borderBottom:`1px solid ${th.border}` }}>
            <GroupIcon group={g} size={28} radius={8} />
            <span style={{ fontSize:14, fontWeight:300, ...th.text, flex:1 }}>{g.name}</span>
            <span style={{ fontSize:12, color:th.muted, fontWeight:300 }}>{g.members.length} members</span>
          </div>
        ))}
      </div>

      <div style={{ ...th.card, borderRadius:12, padding:'14px 16px' }}>
        <div style={{ fontSize:12, fontWeight:300, color:th.muted, marginBottom:8, letterSpacing:'0.06em' }}>ABOUT</div>
        <InfoRow th={th} label="App"            val="PearCal v0.1.0" />
        <InfoRow th={th} label="Network"        val="Holepunch DHT" />
        <InfoRow th={th} label="Storage"        val="Local · Hyperbee" />
        <InfoRow th={th} label="Sync"           val="Autobase · Hyperswarm" />
      </div>
    </div>
  )
}

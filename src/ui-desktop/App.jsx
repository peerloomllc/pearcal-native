// PearCal Desktop renderer — Apple-Calendar-shaped layout. Phases:
//   D2 — scaffold + Day view (read-only)
//   D3 — sidebar mini-month + group toggles + Week/Month views
//   D4 — mouse interactions (click/right-click), EventModal, Inspector
//   D5 — global keyboard shortcuts + Cmd+K command palette
//   D6 — density + hover polish
//   D7.1 — Profile / Settings / Group Settings modals
// Mobile renderer (src/ui/App.jsx) is untouched.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  useProfile, useGroups, useEvents, useRsvps,
  emitter,
} from '../ui-shared/index.js'
import { Sidebar } from './components/Sidebar/index.jsx'
import { Toolbar } from './components/Toolbar.jsx'
import { DayView } from './components/DayView.jsx'
import { WeekView } from './components/WeekView.jsx'
import { MonthView } from './components/MonthView.jsx'
import { EventModal } from './components/EventModal.jsx'
import { EventInspector } from './components/EventInspector.jsx'
import { ContextMenu } from './components/ContextMenu.jsx'
import { CommandPalette } from './components/CommandPalette.jsx'
import { ProfileModal } from './components/ProfileModal.jsx'
import { SettingsModal } from './components/SettingsModal.jsx'
import { GroupSettingsModal } from './components/GroupSettingsModal.jsx'
import { NewGroupModal } from './components/NewGroupModal.jsx'
import { JoinGroupModal } from './components/JoinGroupModal.jsx'
import { LinkedDevicesModal } from './components/LinkedDevicesModal.jsx'
import { OnboardingScreen } from './components/OnboardingScreen.jsx'
import { useViewState } from './hooks/useViewState.js'
import { useVisibleGroups } from './hooks/useVisibleGroups.js'
import { useEventActions } from './hooks/useEventActions.js'
import { useKeyboard } from './hooks/useKeyboard.js'

const DARK_TOKENS = {
  bg:        '#0E0D0C',
  surface:   '#1A1916',
  border:    '#2C2A26',
  text:      '#F2EFE8',
  muted:     '#8A8478',
  accent:    '#C8922A',
  font:      "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
}

export default function App ({ db, notifs, sync }) {
  const [profile, setProfile] = useProfile(db, emitter)
  const [groups, setGroups] = useGroups(db)
  const [events, setEvents] = useEvents(db)
  const [myRsvps] = useRsvps(db)
  const view      = useViewState()
  const visibleGroups = useVisibleGroups(groups)
  const { saveEvent, deleteEvent } = useEventActions({
    db, notifs, sync, profile, events, setEvents,
  })

  // Interaction state: at most one of these is open at a time
  // (modal | inspector | contextMenu | palette | profileOpen | settingsOpen | groupSettings).
  const [modal,         setModal]         = useState(null)        // { mode, initial }
  const [inspector,     setInspector]     = useState(null)        // { ev, x, y }
  const [contextMenu,   setContextMenu]   = useState(null)        // { x, y, items }
  const [paletteOpen,   setPaletteOpen]   = useState(false)
  const [profileOpen,   setProfileOpen]   = useState(false)
  const [settingsOpen,  setSettingsOpen]  = useState(false)
  const [groupSettings, setGroupSettings] = useState(null)        // group object or null
  const [newGroupOpen,  setNewGroupOpen]  = useState(false)
  const [joinGroupOpen, setJoinGroupOpen] = useState(false)
  const [linkedDevicesOpen, setLinkedDevicesOpen] = useState(false)

  const groupsById = useMemo(() => {
    const map = new Map()
    for (const g of groups) map.set(g.id, g)
    return map
  }, [groups])

  const visibleEvents = useMemo(() => {
    if (visibleGroups.hiddenIds.size === 0) return events
    return events.filter(ev => {
      const ids = ev.groups ?? []
      if (ids.length === 0) return true
      return ids.some(id => visibleGroups.isVisible(id))
    })
  }, [events, visibleGroups])

  // Profile may be null on first render (the bare backend hasn't replied
  // to getProfile yet). Don't early-return here: every hook below this
  // point — closeAllTransient, commands useMemo, useKeyboard — must
  // run unconditionally to satisfy the Rules of Hooks. The loading state
  // is rendered inline at the bottom of the function instead.
  const use24h    = profile?.use24h ?? !new Intl.DateTimeFormat([], { hour: 'numeric' }).format(0).match(/am|pm/i)
  const weekStart = profile?.weekStart ?? 0

  // Interaction handlers — passed down to views. allDay defaults OFF;
  // EventModal computes smart-default start/end times when none are
  // passed (matches mobile App.jsx's openCreate semantics).
  // The optional `anchor` carries click coords ({x, y}) so EventModal
  // can position itself adjacent to the click instead of dead-center —
  // matches Apple Calendar's "popover stays out of your way" behavior.
  // Falls back to centered when no anchor is provided ("+ New", N key,
  // palette command, etc.).
  function openCreateAt (date, start, end, anchor) {
    setInspector(null); setContextMenu(null); setPaletteOpen(false)
    setModal({ mode: 'create', initial: { date, start, end, allDay: false }, anchor: anchor ?? null })
  }
  function openInspector (ev, x, y) {
    setContextMenu(null); setModal(null); setPaletteOpen(false)
    setInspector({ ev, x, y })
  }
  function openContextMenu (x, y, items) {
    setInspector(null); setModal(null); setPaletteOpen(false)
    setContextMenu({ x, y, items })
  }
  function openEditModal (ev, anchor) {
    setInspector(null); setContextMenu(null); setPaletteOpen(false)
    setModal({ mode: 'edit', initial: ev, anchor: anchor ?? null })
  }
  // Close any transient layer — the universal Esc handler. EventModal,
  // EventInspector, ContextMenu, CommandPalette, ProfileModal,
  // SettingsModal, and GroupSettingsModal each also bind Esc locally,
  // but this fallback covers focus-elsewhere edge cases.
  const closeAllTransient = useCallback(() => {
    setModal(null); setInspector(null); setContextMenu(null); setPaletteOpen(false)
    setProfileOpen(false); setSettingsOpen(false); setGroupSettings(null)
    setNewGroupOpen(false); setJoinGroupOpen(false)
    setLinkedDevicesOpen(false)
  }, [])

  function openSettings ()           { closeAllTransient(); setSettingsOpen(true) }
  function openProfile  ()           { closeAllTransient(); setProfileOpen(true) }
  function openGroupSettings (group) { closeAllTransient(); setGroupSettings(group) }
  function openNewGroup  ()          { closeAllTransient(); setNewGroupOpen(true) }
  function openJoinGroup ()          { closeAllTransient(); setJoinGroupOpen(true) }
  function openLinkedDevices ()      { closeAllTransient(); setLinkedDevicesOpen(true) }

  // Group create/join hand-off — mirrors mobile's addGroup
  // (src/ui/App.jsx:1021). The owner-create path skips the redundant
  // db.putGroup + sync.joinGroup since sync.createGroup already wrote
  // the group + members + base on the bare side.
  const addGroup = useCallback(async (g, opts) => {
    if (!opts?.alreadyJoined) {
      await db.putGroup(g).catch(() => {})
      for (const m of (g.members ?? [])) await db.putMember(g.id, m).catch(() => {})
      await sync?.joinGroup?.(g).catch(() => {})
    }
    setGroups(prev => prev.some(x => x.id === g.id) ? prev : [...prev, g])
  }, [db, sync, setGroups])

  // Profile updates: bare's `pear:profileChanged` only fires on
  // sibling-device sync, not local writes (bare.js:1555). Mirror mobile's
  // pattern (src/ui/App.jsx:1116) — write to bare AND optimistically update
  // local state so the UI refreshes immediately. Kept thinner than mobile's
  // version: no auto-initials avatar generation (the modal handles that
  // explicitly) and no group-member ripple (the desktop renderer doesn't
  // expose member-avatar editing yet — D7.2 territory).
  const updateProfile = useCallback(async (updates) => {
    await db.updateProfile(updates).catch(e => { throw e })
    setProfile(prev => ({ ...(prev ?? {}), ...updates }))
  }, [db, setProfile])

  // Sync-event subscriptions — mirrors mobile (src/ui/App.jsx:418-590).
  // useGroups/useEvents only do an initial listGroups/listEvents on mount;
  // post-mount changes (autobase apply replicating the joiner's writer key,
  // owner pushing the authoritative member list, group rekeys, etc.) need
  // these to land back into local state.
  //
  // 'sync' fires after each autobase apply: full-reload re-fetches events
  // and the touched group; delta path patches events + refreshes the group
  // record when groupChanged is set (member-list changes set this).
  useEffect(() => {
    if (!db) return

    function refreshGroupRecord (groupId) {
      if (!groupId) return
      db.getGroup(groupId).then(g => {
        if (!g) return
        setGroups(prev => {
          const idx = prev.findIndex(x => x.id === groupId)
          if (idx === -1) return [...prev, g]
          const next = prev.slice()
          next[idx] = g
          return next
        })
      }).catch(() => {})
    }

    async function onSync (payload) {
      const groupId = typeof payload === 'string' ? payload : payload?.groupId
      const delta   = (payload && typeof payload === 'object') ? payload.delta : null
      if (!delta || delta.fullReload) {
        const fresh = await db.listEvents().catch(() => null)
        if (fresh) setEvents(fresh)
        refreshGroupRecord(groupId)
        return
      }
      const changed = delta.changedEvents ?? []
      const removed = delta.removedIds   ?? []
      if (changed.length || removed.length) {
        setEvents(prev => {
          const removedSet = new Set(removed)
          const changedMap = new Map(changed.map(e => [e.id, e]))
          const next = []
          const seen = new Set()
          for (const e of prev) {
            if (removedSet.has(e.id)) continue
            seen.add(e.id)
            next.push(changedMap.get(e.id) ?? e)
          }
          for (const e of changed) {
            if (!seen.has(e.id)) next.push(e)
          }
          return next
        })
      }
      if (delta.groupChanged) refreshGroupRecord(groupId)
    }

    function onGroupKeyUpdated (g) {
      if (!g?.id) return
      setGroups(prev => prev.map(x => x.id === g.id ? g : x))
    }

    function onGroupDeleted (gid) {
      if (!gid) return
      setGroups(prev => prev.filter(x => x.id !== gid))
      setEvents(prev => prev
        .map(e => ({ ...e, groups: (e.groups ?? []).filter(id => id !== gid) }))
        .filter(e => (e.groups ?? []).length > 0))
    }

    async function onGroupJoined (g) {
      if (!g) return
      const fresh = await db.listGroups().catch(() => null)
      if (fresh) setGroups(fresh)
      await db.resyncGroup?.(g.id).catch(() => {})
      const evts = await db.listEvents().catch(() => null)
      if (evts) setEvents(evts)
    }
    const onDomGroupJoined = (e) => onGroupJoined(e.detail)

    emitter.on('sync',            onSync)
    emitter.on('groupKeyUpdated', onGroupKeyUpdated)
    emitter.on('groupDeleted',    onGroupDeleted)
    emitter.on('group:joined',    onGroupJoined)
    window.addEventListener('pear:groupJoined', onDomGroupJoined)
    return () => {
      emitter.off('sync',            onSync)
      emitter.off('groupKeyUpdated', onGroupKeyUpdated)
      emitter.off('groupDeleted',    onGroupDeleted)
      emitter.off('group:joined',    onGroupJoined)
      window.removeEventListener('pear:groupJoined', onDomGroupJoined)
    }
  }, [db, setGroups, setEvents])

  // Group mutations — same db.putGroup + sync.putGroup pattern mobile uses
  // (src/ui/App.jsx:1045-1056). Kept inline here rather than a hook because
  // the surface is just three actions and they all touch local groups state.
  const updateGroup = useCallback(async (updated) => {
    await db.putGroup(updated).catch(() => {})
    await sync?.putGroup(updated).catch(() => {})
    setGroups(prev => prev.map(g => g.id === updated.id ? updated : g))
  }, [db, sync, setGroups])

  const leaveGroup = useCallback(async (id) => {
    const g = groups.find(x => x.id === id)
    if (!g) return
    const updatedMembers = (g.members ?? []).filter(m => m.id !== profile?.id)
    const updatedGroup   = { ...g, members: updatedMembers, updatedAt: Date.now() }
    await db.putGroup(updatedGroup).catch(() => {})
    await sync?.memberLeft?.(id, profile?.id).catch(() => {})
    await db.deleteGroup(id).catch(() => {})
    await sync?.leaveGroup?.(id).catch(() => {})
    setGroups(prev => prev.filter(x => x.id !== id))
  }, [db, sync, groups, profile, setGroups])

  const deleteGroupAction = useCallback(async (id) => {
    await sync?.deleteGroup?.(id).catch(() => {})
    await db.deleteGroup(id).catch(() => {})
    await sync?.leaveGroup?.(id).catch(() => {})
    setGroups(prev => prev.filter(x => x.id !== id))
  }, [db, sync, setGroups])

  function buildEventContextItems (ev, anchorX, anchorY) {
    const anchor = (anchorX != null && anchorY != null) ? { x: anchorX, y: anchorY } : null
    return [
      { label: 'Edit',      onClick: () => openEditModal(ev, anchor) },
      { label: 'Duplicate', onClick: () => {
        const copy = { ...ev, id: undefined, recurrence: 'none', recurrenceId: '' }
        setModal({ mode: 'create', initial: copy, anchor })
      }},
      { divider: true },
      { label: 'Delete', danger: true, onClick: () => deleteEvent(ev.id) },
    ]
  }

  function buildSlotContextItems (date, start, anchorX, anchorY) {
    const anchor = (anchorX != null && anchorY != null) ? { x: anchorX, y: anchorY } : null
    return [
      { label: 'New event here', onClick: () => openCreateAt(date, start, start ? bumpHalfHour(start) : '', anchor) },
    ]
  }

  // Drag-commit: View hands back the dragged event with mode + delta-min;
  // we compute the new start/end (preserving duration on move, clamping
  // resize to a 30-min minimum and the day boundary), then ship it through
  // saveEvent — same path the modal uses, so per-group sync fires too.
  function commitEventDrag ({ ev, mode, deltaMin }) {
    const startMin = toMin(ev.start || '00:00')
    const endMin   = toMin(ev.end   || ev.start || '00:00')
    const duration = Math.max(30, endMin - startMin)
    let newStart, newEnd
    if (mode === 'move') {
      newStart = Math.max(0, Math.min(24 * 60 - duration, startMin + deltaMin))
      newEnd   = newStart + duration
    } else {
      newStart = startMin
      newEnd   = Math.max(startMin + 30, Math.min(24 * 60, endMin + deltaMin))
    }
    saveEvent({ ...ev, start: fromMin(newStart), end: fromMin(newEnd) }, {})
  }

  const interactions = {
    onSlotClick:        (date, start, end, x, y) => openCreateAt(date, start, end, (x != null && y != null) ? { x, y } : null),
    onEventClick:       openInspector,
    onEventContextMenu: (ev, x, y) => openContextMenu(x, y, buildEventContextItems(ev, x, y)),
    onSlotContextMenu:  (date, start, x, y) => openContextMenu(x, y, buildSlotContextItems(date, start, x, y)),
    onEventDragCommit:  commitEventDrag,
  }

  // While a create-mode EventModal is open with a non-all-day time
  // range, project a ghost block onto the timeline at that range so the
  // calendar context stays visible behind the popover. Apple Calendar
  // does the same — the placeholder you see during drag-to-create
  // doesn't disappear when the form opens.
  const pendingCreateRange = (() => {
    if (modal?.mode !== 'create') return null
    const i = modal.initial ?? {}
    if (i.allDay) return null
    if (!i.date || !i.start) return null
    const fromMin_ = toMin(i.start)
    const toMin_ = i.end ? toMin(i.end) : Math.min(24 * 60, fromMin_ + 60)
    if (toMin_ <= fromMin_) return null
    return { date: i.date, from: fromMin_, to: toMin_, title: i.title || '(new event)' }
  })()

  const viewProps = {
    tokens: DARK_TOKENS,
    events: visibleEvents,
    groupsById,
    myRsvps,
    selectedDate: view.selectedDate,
    setSelectedDate: view.setSelectedDate,
    use24h,
    weekStart,
    interactions,
    pendingCreateRange,
  }

  // Command list for the palette. Includes static commands, group
  // visibility toggles, group-settings entries, and one entry per event
  // so users can jump-to-event by typing a title fragment.
  const commands = useMemo(() => {
    const out = [
      { id: 'view:day',   icon: '☷', label: 'View: Day',   hint: 'Switch to day view',   shortcut: '1',     action: () => view.setMode('day') },
      { id: 'view:week',  icon: '▥', label: 'View: Week',  hint: 'Switch to week view',  shortcut: '2',     action: () => view.setMode('week') },
      { id: 'view:month', icon: '▦', label: 'View: Month', hint: 'Switch to month view', shortcut: '3',     action: () => view.setMode('month') },
      { id: 'goto:today', icon: '◉', label: 'Today',       hint: 'Jump to today',        shortcut: 'T',     action: () => view.goToToday() },
      { id: 'create:new', icon: '+', label: 'New Event',   hint: 'Create an event on the selected date', shortcut: 'N', action: () => openCreateAt(view.selectedDate, '', '') },
      { id: 'open:profile',   icon: '◐', label: 'Profile…',   hint: 'Edit your name + avatar', action: openProfile  },
      { id: 'open:settings',  icon: '⚙', label: 'Settings…',  hint: 'Display preferences + about', shortcut: '⌘,', action: openSettings },
      { id: 'group:new',      icon: '+', label: 'New Group…', hint: 'Create a group and invite people', action: openNewGroup },
      { id: 'group:join',     icon: '↘', label: 'Join Group…', hint: 'Paste an invite link to join', action: openJoinGroup },
      { id: 'open:devices',   icon: '⎌', label: 'Linked Devices…', hint: 'Pair another device or manage paired ones', action: openLinkedDevices },
    ]
    for (const g of groups) {
      const visible = visibleGroups.isVisible(g.id)
      out.push({
        id: 'toggle:' + g.id,
        icon: visible ? '☑' : '☐',
        label: (visible ? 'Hide ' : 'Show ') + (g.emoji ? g.emoji + ' ' : '') + g.name,
        hint: 'Toggle group visibility',
        action: () => visibleGroups.toggle(g.id),
      })
      out.push({
        id: 'group:' + g.id,
        icon: '⚙',
        label: 'Group settings: ' + (g.emoji ? g.emoji + ' ' : '') + g.name,
        hint: 'Edit name, color, members, leave/delete',
        action: () => openGroupSettings(g),
      })
    }
    for (const ev of events) {
      out.push({
        id: 'event:' + ev.id,
        icon: '·',
        label: ev.title || '(untitled)',
        hint: ev.date + (ev.allDay ? ' · all-day' : (ev.start ? ' · ' + ev.start : '')),
        action: () => {
          view.setSelectedDate(ev.date)
          view.setMode('day')
        },
      })
    }
    return out
  }, [groups, events, visibleGroups, view])

  useKeyboard({
    selectedDate:    view.selectedDate,
    setSelectedDate: view.setSelectedDate,
    mode:            view.mode,
    setMode:         view.setMode,
    navigate:        view.navigateBy,
    goToToday:       view.goToToday,
    onCreate:        () => openCreateAt(view.selectedDate, '', ''),
    onOpenPalette:   () => setPaletteOpen(true),
    onOpenSettings:  openSettings,
    onCloseTransient: closeAllTransient,
  })

  if (!profile) {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: DARK_TOKENS.bg, color: DARK_TOKENS.muted,
        fontFamily: DARK_TOKENS.font, fontSize: 14,
      }}>
        Loading PearCal…
      </div>
    )
  }

  // First-launch onboarding gate. Bare seeds an empty profile with no
  // onboardingComplete flag (bare.js:5837); flipping it via updateProfile
  // (either inline here or via a successful pair handshake) drops the
  // user into the calendar.
  if (!profile.onboardingComplete) {
    return (
      <OnboardingScreen
        tokens={DARK_TOKENS}
        profile={profile}
        db={db}
        updateProfile={updateProfile}
      />
    )
  }

  return (
    <div style={{
      height: '100vh', display: 'flex',
      background: DARK_TOKENS.bg, color: DARK_TOKENS.text,
      fontFamily: DARK_TOKENS.font,
    }}>
      <Sidebar
        tokens={DARK_TOKENS}
        profile={profile}
        groups={groups}
        selectedDate={view.selectedDate}
        setSelectedDate={view.setSelectedDate}
        miniCursor={view.miniCursor}
        setMiniCursor={view.setMiniCursor}
        visibleGroups={visibleGroups}
        onOpenProfile={openProfile}
        onOpenSettings={openSettings}
        onNewGroup={openNewGroup}
        onJoinGroup={openJoinGroup}
        onGroupContextMenu={(g, x, y) => {
          openContextMenu(x, y, [
            { label: 'Group settings…', onClick: () => openGroupSettings(g) },
            { label: visibleGroups.isVisible(g.id) ? 'Hide events' : 'Show events',
              onClick: () => visibleGroups.toggle(g.id) },
            { divider: true },
            g.ownerId === profile.id
              ? { label: 'Delete group', danger: true, onClick: async () => {
                  if (confirm('Delete "' + g.name + '" for everyone?')) await deleteGroupAction(g.id)
                }}
              : { label: 'Leave group', danger: true, onClick: async () => {
                  if (confirm('Leave "' + g.name + '"?')) await leaveGroup(g.id)
                }},
          ])
        }}
      />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Toolbar
          tokens={DARK_TOKENS}
          selectedDate={view.selectedDate}
          setSelectedDate={view.setSelectedDate}
          mode={view.mode}
          setMode={view.setMode}
          navigateBy={view.navigateBy}
          goToToday={view.goToToday}
          isFullyToday={view.isFullyToday}
          onCreate={() => openCreateAt(view.selectedDate, '', '')}
        />
        {view.mode === 'day'   && <DayView   {...viewProps} />}
        {view.mode === 'week'  && <WeekView  {...viewProps} navDir={view.navDir} />}
        {view.mode === 'month' && <MonthView {...viewProps} navDir={view.navDir} setMode={view.setMode} />}
      </main>

      {modal && (
        <EventModal
          tokens={DARK_TOKENS}
          mode={modal.mode}
          initial={modal.initial}
          anchor={modal.anchor}
          groups={groups}
          profile={profile}
          use24h={use24h}
          onSave={(ev, opts) => { saveEvent(ev, opts); setModal(null) }}
          onDelete={(id) => { deleteEvent(id); setModal(null) }}
          onClose={() => setModal(null)}
        />
      )}
      {inspector && (
        <EventInspector
          tokens={DARK_TOKENS}
          ev={inspector.ev}
          anchor={{ x: inspector.x, y: inspector.y }}
          groupsById={groupsById}
          use24h={use24h}
          onEdit={() => openEditModal(inspector.ev, { x: inspector.x, y: inspector.y })}
          onDelete={() => { deleteEvent(inspector.ev.id); setInspector(null) }}
          onDuplicate={() => {
            const copy = { ...inspector.ev, id: undefined, recurrence: 'none', recurrenceId: '' }
            const anchor = { x: inspector.x, y: inspector.y }
            setInspector(null)
            setModal({ mode: 'create', initial: copy, anchor })
          }}
          onClose={() => setInspector(null)}
        />
      )}
      {contextMenu && (
        <ContextMenu
          tokens={DARK_TOKENS}
          x={contextMenu.x} y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          tokens={DARK_TOKENS}
          commands={commands}
          onJumpToDate={(d) => view.setSelectedDate(d)}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {profileOpen && (
        <ProfileModal
          tokens={DARK_TOKENS}
          profile={profile}
          updateProfile={updateProfile}
          onClose={() => setProfileOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          tokens={DARK_TOKENS}
          profile={profile}
          updateProfile={updateProfile}
          db={db}
          sync={sync}
          onOpenLinkedDevices={openLinkedDevices}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {linkedDevicesOpen && (
        <LinkedDevicesModal
          tokens={DARK_TOKENS}
          db={db}
          profile={profile}
          onClose={() => setLinkedDevicesOpen(false)}
        />
      )}
      {groupSettings && (
        <GroupSettingsModal
          tokens={DARK_TOKENS}
          group={groups.find(g => g.id === groupSettings.id) ?? groupSettings}
          profile={profile}
          db={db}
          onUpdate={updateGroup}
          onLeave={leaveGroup}
          onDelete={deleteGroupAction}
          onClose={() => setGroupSettings(null)}
        />
      )}
      {newGroupOpen && (
        <NewGroupModal
          tokens={DARK_TOKENS}
          profile={profile}
          sync={sync}
          addGroup={addGroup}
          onClose={() => setNewGroupOpen(false)}
        />
      )}
      {joinGroupOpen && (
        <JoinGroupModal
          tokens={DARK_TOKENS}
          profile={profile}
          db={db}
          sync={sync}
          onJoined={(g) => setGroups(prev => prev.some(x => x.id === g.id) ? prev : [...prev, g])}
          onClose={() => setJoinGroupOpen(false)}
        />
      )}
    </div>
  )
}

function todayLocal () {
  const t = new Date()
  return t.getFullYear() + '-' +
    String(t.getMonth() + 1).padStart(2, '0') + '-' +
    String(t.getDate()).padStart(2, '0')
}

function bumpHalfHour (hhmm) {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + 30
  const nh = Math.floor(total / 60) % 24
  const nm = total % 60
  return String(nh).padStart(2, '0') + ':' + String(nm).padStart(2, '0')
}

function toMin (hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}
function fromMin (mins) {
  const m = ((mins % 1440) + 1440) % 1440
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
}

// PearCal Desktop renderer — Apple-Calendar-shaped layout. Phases:
//   D2 — scaffold + Day view (read-only)
//   D3 — sidebar mini-month + group toggles + Week/Month views
//   D4 — mouse interactions (click/right-click), EventModal, Inspector
//   D5 — global keyboard shortcuts + Cmd+K command palette
//   D6 — density + hover polish
//   D7.1 — Profile / Settings / Group Settings modals
// Mobile renderer (src/ui/App.jsx) is untouched.

import { useCallback, useMemo, useState } from 'react'
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
  function openCreateAt (date, start, end) {
    setInspector(null); setContextMenu(null); setPaletteOpen(false)
    setModal({ mode: 'create', initial: { date, start, end, allDay: false } })
  }
  function openInspector (ev, x, y) {
    setContextMenu(null); setModal(null); setPaletteOpen(false)
    setInspector({ ev, x, y })
  }
  function openContextMenu (x, y, items) {
    setInspector(null); setModal(null); setPaletteOpen(false)
    setContextMenu({ x, y, items })
  }
  function openEditModal (ev) {
    setInspector(null); setContextMenu(null); setPaletteOpen(false)
    setModal({ mode: 'edit', initial: ev })
  }
  // Close any transient layer — the universal Esc handler. EventModal,
  // EventInspector, ContextMenu, CommandPalette, ProfileModal,
  // SettingsModal, and GroupSettingsModal each also bind Esc locally,
  // but this fallback covers focus-elsewhere edge cases.
  const closeAllTransient = useCallback(() => {
    setModal(null); setInspector(null); setContextMenu(null); setPaletteOpen(false)
    setProfileOpen(false); setSettingsOpen(false); setGroupSettings(null)
  }, [])

  function openSettings ()           { closeAllTransient(); setSettingsOpen(true) }
  function openProfile  ()           { closeAllTransient(); setProfileOpen(true) }
  function openGroupSettings (group) { closeAllTransient(); setGroupSettings(group) }

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

  function buildEventContextItems (ev) {
    return [
      { label: 'Edit',      onClick: () => openEditModal(ev) },
      { label: 'Duplicate', onClick: () => {
        const copy = { ...ev, id: undefined, recurrence: 'none', recurrenceId: '' }
        setModal({ mode: 'create', initial: copy })
      }},
      { divider: true },
      { label: 'Delete', danger: true, onClick: () => deleteEvent(ev.id) },
    ]
  }

  function buildSlotContextItems (date, start) {
    return [
      { label: 'New event here', onClick: () => openCreateAt(date, start, start ? bumpHalfHour(start) : '') },
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
    onSlotClick:        openCreateAt,
    onEventClick:       openInspector,
    onEventContextMenu: (ev, x, y) => openContextMenu(x, y, buildEventContextItems(ev)),
    onSlotContextMenu:  (date, start, x, y) => openContextMenu(x, y, buildSlotContextItems(date, start)),
    onEventDragCommit:  commitEventDrag,
  }

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
  }

  // Command list for the palette. Includes static commands, group
  // visibility toggles, group-settings entries, and one entry per event
  // so users can jump-to-event by typing a title fragment.
  const commands = useMemo(() => {
    const out = [
      { id: 'view:day',   icon: '☷', label: 'View: Day',   hint: 'Switch to day view',   shortcut: '1',     action: () => view.setMode('day') },
      { id: 'view:week',  icon: '▥', label: 'View: Week',  hint: 'Switch to week view',  shortcut: '2',     action: () => view.setMode('week') },
      { id: 'view:month', icon: '▦', label: 'View: Month', hint: 'Switch to month view', shortcut: '3',     action: () => view.setMode('month') },
      { id: 'goto:today', icon: '◉', label: 'Today',       hint: 'Jump to today',        shortcut: 'T',     action: () => view.setSelectedDate(todayLocal()) },
      { id: 'create:new', icon: '+', label: 'New Event',   hint: 'Create an event on the selected date', shortcut: 'N', action: () => openCreateAt(view.selectedDate, '', '') },
      { id: 'open:profile',  icon: '◐', label: 'Profile…',  hint: 'Edit your name + avatar', action: openProfile  },
      { id: 'open:settings', icon: '⚙', label: 'Settings…', hint: 'Display preferences + about', shortcut: '⌘,', action: openSettings },
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
        visibleGroups={visibleGroups}
        onOpenProfile={openProfile}
        onOpenSettings={openSettings}
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
          onCreate={() => openCreateAt(view.selectedDate, '', '')}
        />
        {view.mode === 'day'   && <DayView   {...viewProps} />}
        {view.mode === 'week'  && <WeekView  {...viewProps} />}
        {view.mode === 'month' && <MonthView {...viewProps} setMode={view.setMode} />}
      </main>

      {modal && (
        <EventModal
          tokens={DARK_TOKENS}
          mode={modal.mode}
          initial={modal.initial}
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
          onEdit={() => openEditModal(inspector.ev)}
          onDelete={() => { deleteEvent(inspector.ev.id); setInspector(null) }}
          onDuplicate={() => {
            const copy = { ...inspector.ev, id: undefined, recurrence: 'none', recurrenceId: '' }
            setInspector(null)
            setModal({ mode: 'create', initial: copy })
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
          sync={sync}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {groupSettings && (
        <GroupSettingsModal
          tokens={DARK_TOKENS}
          group={groupSettings}
          profile={profile}
          onUpdate={updateGroup}
          onLeave={leaveGroup}
          onDelete={deleteGroupAction}
          onClose={() => setGroupSettings(null)}
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

// Sidebar composer — mini month picker, group list, profile footer.
// Width is fixed at 240px; scrolls independently of the main grid.
// The actual interactivity lives in the sub-components.
//
// No top-level "PearCal" header — the toolbar's date label is the
// natural orientation cue, and the Apple-Calendar style starts the
// sidebar with the mini-month directly.

import { MiniMonth } from './MiniMonth.jsx'
import { GroupList } from './GroupList.jsx'
import { CalendarList } from './CalendarList.jsx'
import { useState } from 'react'

const GROUPS_FOLDED_KEY = 'pearcal.sidebar.groupsFolded'
function readFolded () { try { return localStorage.getItem(GROUPS_FOLDED_KEY) === '1' } catch { return false } }
import { ProfileFooter } from './ProfileFooter.jsx'

const SIDEBAR_WIDTH = 240

export function Sidebar ({
  tokens, profile, groups,
  selectedDate, setSelectedDate,
  miniCursor, setMiniCursor,
  visibleGroups,
  cal, onNewCalendar, onCalendarContextMenu,
  pendingApprovalGroups,
  onOpenProfile, onOpenSettings, onOpenAbout, onGroupContextMenu,
  onNewGroup, onJoinGroup,
}) {
  // Folding Groups away is a per-window convenience, so localStorage is enough.
  const [groupsFolded, setGroupsFolded] = useState(readFolded)
  const toggleFolded = () => setGroupsFolded(f => {
    try { localStorage.setItem(GROUPS_FOLDED_KEY, f ? '0' : '1') } catch {}
    return !f
  })
  return (
    <aside style={{
      width: SIDEBAR_WIDTH, flexShrink: 0,
      background: tokens.surface, borderRight: `1px solid ${tokens.border}`,
      display: 'flex', flexDirection: 'column',
    }}>
      <div data-tour="sidebar-mini-month">
        <MiniMonth tokens={tokens}
                   selectedDate={selectedDate} setSelectedDate={setSelectedDate}
                   cursor={miniCursor} setCursor={setMiniCursor} />
      </div>

      <div data-tour="sidebar-groups" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' }}>
        {cal && (
          <CalendarList tokens={tokens} cal={cal}
                        onNewCalendar={onNewCalendar} onCalendarContextMenu={onCalendarContextMenu} />
        )}
        <GroupList tokens={tokens} groups={groups}
                   collapsed={groupsFolded} onToggleCollapsed={toggleFolded}
                   isVisible={visibleGroups.isVisible} toggle={visibleGroups.toggle}
                   pendingApprovalGroups={pendingApprovalGroups}
                   onContextMenu={onGroupContextMenu}
                   onNewGroup={onNewGroup} onJoinGroup={onJoinGroup} />
      </div>

      <div data-tour="sidebar-profile">
        <ProfileFooter tokens={tokens} profile={profile}
                       onClick={onOpenProfile}
                       onOpenSettings={onOpenSettings}
                       onOpenAbout={onOpenAbout} />
      </div>
    </aside>
  )
}

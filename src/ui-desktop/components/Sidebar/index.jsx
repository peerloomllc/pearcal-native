// Sidebar composer — mini month picker, group list, profile footer.
// Width is fixed at 240px; scrolls independently of the main grid.
// The actual interactivity lives in the sub-components.
//
// No top-level "PearCal" header — the toolbar's date label is the
// natural orientation cue, and the Apple-Calendar style starts the
// sidebar with the mini-month directly.

import { MiniMonth } from './MiniMonth.jsx'
import { GroupList } from './GroupList.jsx'
import { ProfileFooter } from './ProfileFooter.jsx'

const SIDEBAR_WIDTH = 240

export function Sidebar ({
  tokens, profile, groups,
  selectedDate, setSelectedDate,
  miniCursor, setMiniCursor,
  visibleGroups,
  onOpenProfile, onOpenSettings, onGroupContextMenu,
  onNewGroup, onJoinGroup,
}) {
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

      <div data-tour="sidebar-groups" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <GroupList tokens={tokens} groups={groups}
                   isVisible={visibleGroups.isVisible} toggle={visibleGroups.toggle}
                   onContextMenu={onGroupContextMenu}
                   onNewGroup={onNewGroup} onJoinGroup={onJoinGroup} />
      </div>

      <div data-tour="sidebar-profile">
        <ProfileFooter tokens={tokens} profile={profile}
                       onClick={onOpenProfile}
                       onOpenSettings={onOpenSettings} />
      </div>
    </aside>
  )
}

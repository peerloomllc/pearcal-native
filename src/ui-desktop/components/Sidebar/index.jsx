// Sidebar composer — header, mini month picker, group list, profile
// footer. Width is fixed at 240px; scrolls independently of the main
// grid. The actual interactivity lives in the sub-components.

import { MiniMonth } from './MiniMonth.jsx'
import { GroupList } from './GroupList.jsx'
import { ProfileFooter } from './ProfileFooter.jsx'

const SIDEBAR_WIDTH = 240

export function Sidebar ({
  tokens, profile, groups,
  selectedDate, setSelectedDate,
  visibleGroups,
  onOpenProfile, onOpenSettings, onGroupContextMenu,
}) {
  return (
    <aside style={{
      width: SIDEBAR_WIDTH, flexShrink: 0,
      background: tokens.surface, borderRight: `1px solid ${tokens.border}`,
      display: 'flex', flexDirection: 'column',
    }}>
      <header style={{
        padding: '14px 14px 10px', borderBottom: `1px solid ${tokens.border}`,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', flex: 1 }}>🍐 PearCal</div>
        {onOpenSettings && (
          <button onClick={onOpenSettings} title="Settings (Ctrl+,)"
            aria-label="Settings"
            style={{
              background: tokens.bg, border: `1px solid ${tokens.border}`,
              fontSize: 16, cursor: 'pointer', color: tokens.text,
              padding: '4px 8px', borderRadius: 5, fontFamily: tokens.font,
              lineHeight: 1,
            }}>⚙</button>
        )}
      </header>

      <MiniMonth tokens={tokens} selectedDate={selectedDate} setSelectedDate={setSelectedDate} />

      <GroupList tokens={tokens} groups={groups}
                 isVisible={visibleGroups.isVisible} toggle={visibleGroups.toggle}
                 onContextMenu={onGroupContextMenu} />

      <ProfileFooter tokens={tokens} profile={profile} onClick={onOpenProfile} />
    </aside>
  )
}

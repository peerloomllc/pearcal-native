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
}) {
  return (
    <aside style={{
      width: SIDEBAR_WIDTH, flexShrink: 0,
      background: tokens.surface, borderRight: `1px solid ${tokens.border}`,
      display: 'flex', flexDirection: 'column',
    }}>
      <header style={{ padding: '14px 14px 10px', borderBottom: `1px solid ${tokens.border}` }}>
        <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>🍐 PearCal</div>
      </header>

      <MiniMonth tokens={tokens} selectedDate={selectedDate} setSelectedDate={setSelectedDate} />

      <GroupList tokens={tokens} groups={groups}
                 isVisible={visibleGroups.isVisible} toggle={visibleGroups.toggle} />

      <ProfileFooter tokens={tokens} profile={profile} />
    </aside>
  )
}

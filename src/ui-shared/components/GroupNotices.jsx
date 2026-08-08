// The three notices that tell a user their calendar is in trouble, built once
// and rendered by both hosts.
//
// #163 audit (proposals/2026-08-08-desktop-ui-parity.md): all three existed on
// mobile only. Checked against the shipped v1.0.43 desktop build, none of
// "This group can't sync on this device", "hasn't synced in" or "Waiting for
// owner approval" appeared anywhere in it — so on desktop a broken calendar
// simply went quiet. That is the failure #155 was written to end, reintroduced
// on the other host by omission.
//
// They are SHARED rather than ported because they are pure presentation over
// data both UIs already receive: `group.keyless` and `group.syncHealth` come
// from listGroups/getGroup, and pendingApproval arrives as an event both hosts
// already bridge. Porting them twice would repeat the mistake that created the
// gap.
//
// Host-neutral by construction:
//   - colours arrive as a `theme` object, since mobile has `colors.text.primary`
//     and desktop has `tokens.text`. Neither vocabulary wins.
//   - NO icon import. Mobile has @phosphor-icons and desktop has no icon
//     library at all, so an icon is an optional node the host passes in. The
//     notice must read correctly with none, and it does.
//   - no BottomSheet, no modal, no host layout primitive. Each returns a plain
//     block the caller drops into its own list.

const RED    = { fg: '#E5484D', bg: '#E5484D1A', border: '#E5484D55' }
const AMBER  = { fg: '#F5A623', bg: '#F5A62333', border: '#F5A62366' }
const NEUTRAL = { fg: '#F5C474', bg: '#F5C47422', border: '#F5C47466' }

// Coarse on purpose (#155). The judgement is "has this been quiet for days", so
// minutes and seconds would imply a precision the 48h threshold does not have.
export function fmtSyncAge (ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return 'a while'
  const days = Math.floor(ms / 86400000)
  if (days >= 14) return Math.floor(days / 7) + ' weeks'
  if (days >= 2) return days + ' days'
  const hours = Math.floor(ms / 3600000)
  return hours >= 1 ? hours + ' hours' : 'a while'
}

function Notice ({ tone, theme, icon, title, children, footer }) {
  return (
    <div style={{
      background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 10,
      padding: '10px 12px', marginBottom: 12,
      display: 'flex', gap: 10, alignItems: 'flex-start',
    }}>
      {icon ? <span style={{ flexShrink: 0, marginTop: 1, lineHeight: 1, color: tone.fg }}>{icon}</span> : null}
      <div style={{ flex: 1, fontSize: 12, color: theme.text, lineHeight: 1.4 }}>
        <div style={{ fontWeight: 400, marginBottom: 2 }}>{title}</div>
        <div style={{ color: theme.muted }}>{children}</div>
        {footer ? <div style={{ color: theme.muted, marginTop: 4, fontSize: 11 }}>{footer}</div> : null}
      </div>
    </div>
  )
}

/**
 * TODO #124 — this device holds no block-encryption key for an encrypted group,
 * so it sits on the raw-groupKey swarm topic while every keyed peer is on the
 * domain-separated one. It will never sync, and every invite it mints omits
 * `enc=`, quietly breaking whoever accepts it. A fresh invite from a current
 * member is the only cure and nothing used to say so.
 *
 * Renders nothing unless the group is actually flagged, so callers can drop it
 * in unconditionally.
 */
export function KeylessNotice ({ group, theme, icon = null }) {
  if (!group?.keyless) return null
  const certain = group.keyless.certainty === 'certain'
  return (
    <Notice tone={RED} theme={theme} icon={icon} footer={'Group ID: ' + group.id}
      title={certain ? "This group can't sync on this device" : "This group hasn't synced since you joined"}>
      {certain
        ? 'It is encrypted and this device is missing the key, so it cannot reach the other members.'
        : 'It may be encrypted with a key this device is missing, or the others may simply be offline.'}
      {' '}Ask a member to send you a fresh invite link, then paste it into Join Group to repair it.
    </Notice>
  )
}

/**
 * #155 — a shared calendar going quiet used to be completely invisible.
 * Reported from the field: a five-member group stopped syncing, the app said
 * nothing, and the user repaired it by creating a NEW group and moving every
 * event across, which meant re-inviting everyone.
 *
 * Suppressed when KeylessNotice is already saying it, so the two cannot stack.
 */
export function SyncHealthNotice ({ group, theme, icon = null }) {
  if (!group || group.keyless) return null
  if (group.syncHealth?.state !== 'stale') return null
  const never = group.syncHealth.reason === 'never-synced'
  return (
    <Notice tone={AMBER} theme={theme} icon={icon}
      title={never
        ? "This calendar hasn't synced yet"
        : "This calendar hasn't synced in " + fmtSyncAge(group.syncHealth.sinceMs)}>
      {never
        ? 'Nothing has arrived from the other members since you joined.'
        : 'Nothing has arrived from the other members for a while.'}
      {' '}They may simply be offline. If they are using it and you still see this,
      ask one of them to send you a fresh invite link and paste it into Join Group.
    </Notice>
  )
}

/** Joiner is waiting on the owner to approve a return (rejoin gating). */
export function PendingApprovalNotice ({ pending, theme, icon = null }) {
  if (!pending) return null
  return (
    <Notice tone={NEUTRAL} theme={theme} icon={icon} title="Waiting for owner approval">
      The owner must approve your return before you'll see the group's members and events.
    </Notice>
  )
}

/**
 * All three in the order they should appear, for a host with nothing special to
 * say. `icons` is optional: { keyless, stale, pending }.
 */
export function GroupNotices ({ group, pendingApproval, theme, icons = {} }) {
  return (
    <>
      <PendingApprovalNotice pending={pendingApproval} theme={theme} icon={icons.pending} />
      <KeylessNotice group={group} theme={theme} icon={icons.keyless} />
      <SyncHealthNotice group={group} theme={theme} icon={icons.stale} />
    </>
  )
}

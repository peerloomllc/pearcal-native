// Shared UI utilities consumed by both the mobile renderer (src/ui/)
// and the desktop renderer (src/ui-desktop/). Pure functions only —
// no React, no DOM. React hooks live alongside in ./hooks/ once D1
// extracts them.

export { parseIcs, generateIcs } from './lib/ics.js'
export {
  MAX_COLOR_SEGMENTS,
  MEMBER_PALETTE,
  eventColors,
  memberColorFor,
  memberColorIndexed,
  derivedEventColors,
  stripeBackground,
  leftStripeStyle,
  dotBackground,
} from './lib/colors.js'
export { expandRecurring } from './lib/recurring.js'
export { formatTime, formatRelativeTime, todayStr, dateStr } from './lib/time.js'

export { useProfile } from './hooks/useProfile.js'
export { useRsvps } from './hooks/useRsvps.js'
export { useGroups } from './hooks/useGroups.js'
export { useEvents } from './hooks/useEvents.js'

export { emitter } from './emitter.js'

# Multiple Reminders Per Event — Design Spec

**Date:** 2026-03-23
**Status:** Approved

---

## Overview

Allow users to set up to 3 reminders per event. Reminders are personal and local — they are never synced to group peers. Two new reminder types added: "Morning of (9 AM)" and "Day before (9 AM)", which fire at a fixed 9 AM time anchored to the event date rather than a relative offset from the event start time.

---

## Architecture Note

All alarm scheduling happens in `app/index.tsx` (the React Native shell), not in `src/notifications.js`. `src/notifications.js` exists but is only used as a development fallback (Web Notifications API); production alarm scheduling uses `PearCalNotifications` directly from `app/index.tsx`. `src/notifications.js` is not a touchpoint for this feature.

---

## Data Model

### Local reminder store

Reminders are stored in the bare worklet's local Hyperbee at key:

```
reminders:{eventId}  →  number[]   (JSON-encoded)
```

Two sentinel constants represent calendar-anchored reminder types:

```javascript
const MORNING_OF = -1   // 9:00 AM on the event date
const DAY_BEFORE = -2   // 9:00 AM the day before the event date
```

All other values are positive integers (minutes before event start). Maximum 3 entries. Empty array or missing key = no reminders. Deduplication applies to the full value set including sentinels.

### Existing `reminder` field on event

The `reminder: number` field stays on the event object and keeps syncing to peers for backward compatibility. PearCal stops using it for scheduling. In legacy data, valid values are non-negative integers (0 = no reminder, positive = minutes). One exception: holiday events are created with `reminder: -1` as a system sentinel meaning "no reminder". This is safe: the migration guard `event.reminder > 0` correctly skips holiday events (since -1 is not > 0), and the new `MORNING_OF = -1` sentinel only appears in the local `reminders:{eventId}` array, never in the legacy `reminder` field.

**Migration:** On first access of `reminders:{eventId}`, if the key is missing and `event.reminder > 0`, seed the key as `[event.reminder]`. If `event.reminder` is 0 or negative, leave the key absent (treated as empty array — no reminder).

### Updated `REMINDER_OPTIONS`

The `{ label: 'None', value: 0 }` entry is removed. Absence of rows conveys "no reminder."

```javascript
const REMINDER_OPTIONS = [
  { label: '5 min before',       value: 5    },
  { label: '10 min before',      value: 10   },
  { label: '15 min before',      value: 15   },
  { label: '30 min before',      value: 30   },
  { label: '1 hour before',      value: 60   },
  { label: '2 hours before',     value: 120  },
  { label: 'Morning of (9 AM)',  value: -1   },  // MORNING_OF
  { label: 'Day before (9 AM)',  value: -2   },  // DAY_BEFORE
  { label: '1 day before',       value: 1440 },
]
```

**Note on `1440` vs `DAY_BEFORE` for all-day events:** For all-day events, `eventStartMs` is 9 AM on the event date. `1440` (24 hours before = 9 AM the prior day) and `DAY_BEFORE` (-2, also 9 AM the prior day) fire at the same time. A user selecting both would get a duplicate notification. Since deduplication in the UI is value-based and `1440 ≠ -2`, both can be selected. This overlap is accepted as a known edge case — it's unlikely a user deliberately selects both.

---

## UI

The single reminder `<select>` in the event editor is replaced with a multi-reminder list component:

- Each row: reminder dropdown + `×` remove button
- "Add reminder" button shown when < 3 rows; hidden at 3
- Duplicate values are prevented — options already selected in another row are disabled. This applies to the full value set including sentinel values (`-1`, `-2`)
- Empty list = no reminders
- When creating a new event, if `profile.defaultReminder > 0`, one row is pre-populated with that value; if 0, the list starts empty
- When "Add reminder" is tapped, the new row is pre-set to `profile.defaultReminder` (or `15` if unset), skipping values already selected
- **Validation is UI-only.** The 3-reminder cap and deduplication are enforced in the UI. `putReminders` in `src/bare.js` stores whatever is passed.

### Save path (ordered sequence)

On event save, the UI performs these steps in order:

1. `db.putEvent(ev)` — save event to bare worklet
2. `db.putReminders(ev.id, reminders)` — save reminders array to bare worklet
3. `notifs.cancelForEvent(ev.id)` — cancel all existing alarms for this event (IDs `base+0` through `base+3`)
4. `notifs.scheduleForEvent(ev, reminders)` — schedule new alarms

`notifs.scheduleForEvent` in `main.jsx` is updated to accept and forward the reminders array:
```javascript
scheduleForEvent: (ev, reminders) => window.__pearDB.call('scheduleForEvent', ev, reminders)
```

`putReminders` does not schedule alarms. The caller is always responsible for the cancel → schedule sequence.

---

## Notification Scheduling

### Notification IDs

`base = notifId(eventId) = Math.abs(polynomial_hash(eventId))` — unchanged.

Current slots: `base` (reminder), `base+1` (start-time).

New slots — 4 per event:

| Slot | Purpose |
|------|---------|
| `base + 0` | Reminder alarm 1 |
| `base + 1` | Reminder alarm 2 |
| `base + 2` | Reminder alarm 3 |
| `base + 3` | Start-time alarm (non-all-day events only) |

`cancelForEvent` is updated to cancel all 4 IDs (`base+0` through `base+3`) unconditionally.

### Upgrade behavior for existing events

For events not edited after upgrade, the old start-time alarm at `base+1` continues to fire at the event's start time with the original "starting now" message — this is correct behavior, not a regression. For events that are saved or edited after upgrade, `cancelForEvent` cancels all 4 slots (including old `base+1`) before rescheduling under the new scheme. No explicit migration step is needed.

### IPC message shape

IPC args are positional:

```javascript
// WebView (main.jsx)
window.__pearDB.call('scheduleForEvent', ev, reminders)
// → msg.args[0] = ev, msg.args[1] = reminders

// app/index.tsx
const ev        = msg.args[0]
const reminders = msg.args[1] ?? []
```

`cancelForEvent` is unchanged: `msg.args[0]` = eventId string.

### Fire time calculation

`event.date` is an ISO date string (`'YYYY-MM-DD'`).

**For all-day events**, the base start time is 9 AM on the event date:
```javascript
const [y, mo, d] = event.date.split('-').map(Number)
eventStartMs = new Date(y, mo - 1, d, 9, 0, 0, 0).getTime()
```

**For timed events**, the base start time is the event's start field:
```javascript
const [y, mo, d] = event.date.split('-').map(Number)
const [h, m] = event.start.split(':').map(Number)
eventStartMs = new Date(y, mo - 1, d, h, m, 0, 0).getTime()
```

**Positive offset reminders** (both all-day and timed):
```javascript
fireAt = eventStartMs - reminder * 60 * 1000
```

**Sentinel values** (ignore `eventStartMs`; always use calendar date):
```javascript
// MORNING_OF (-1): 9:00 AM on the event date
const [y, mo, d] = event.date.split('-').map(Number)
fireAt = new Date(y, mo - 1, d, 9, 0, 0, 0).getTime()

// DAY_BEFORE (-2): 9:00 AM the day before the event date
// JavaScript's Date constructor normalises out-of-range day values correctly
const [y, mo, d] = event.date.split('-').map(Number)
fireAt = new Date(y, mo - 1, d - 1, 9, 0, 0, 0).getTime()
```

If `fireAt <= Date.now()`, the alarm is skipped (existing behavior, unchanged).

### `restoreAll`

`restoreAll` remains a no-op stub. Alarm persistence across device reboots is out of scope.

---

## Implementation Touchpoints

| File | Change |
|------|--------|
| `src/ui/App.jsx` | Replace reminder `<select>` with multi-reminder list component; add `MORNING_OF`/`DAY_BEFORE` constants; remove `{ value: 0 }` from `REMINDER_OPTIONS`; call `db.getReminders(eventId)` on event editor open (with migration fallback from `event.reminder`); call `db.putReminders` → `notifs.cancelForEvent` → `notifs.scheduleForEvent(ev, reminders)` on save |
| `src/ui/main.jsx` | Update `notifs.scheduleForEvent` to `(ev, reminders) => window.__pearDB.call('scheduleForEvent', ev, reminders)`; add `getReminders: (id) => window.__pearDB.call('getReminders', id)` and `putReminders: (id, r) => window.__pearDB.call('putReminders', id, r)` to the `db` object |
| `src/bare.js` | Add `getReminders(eventId)` — reads `reminders:{eventId}`, applies migration from `event.reminder` if key missing and `event.reminder > 0`; add `putReminders(eventId, reminders[])` — writes `reminders:{eventId}`; update `deleteEvent` to also `db.del('reminders:' + id)`; update `deleteEventSeries` to also delete `reminders:{eventId}` for each occurrence in the series |
| `app/index.tsx` | Update `scheduleForEvent` handler: read `msg.args[1]` as reminders array; loop and schedule up to 3 reminder alarms at `base+0`, `base+1`, `base+2`; schedule start-time alarm at `base+3`; update `cancelForEvent` handler to cancel `base+0` through `base+3` |

---

## Out of Scope

- Syncing reminders to group peers (reminders are always personal)
- Per-user "morning" time configuration (fixed at 9 AM)
- More than 3 reminders per event
- `restoreAll` / alarm persistence across device reboots

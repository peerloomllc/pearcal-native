# Multiple Reminders Per Event — Design Spec

**Date:** 2026-03-23
**Status:** Approved

---

## Overview

Allow users to set up to 3 reminders per event. Reminders are personal and local — they are never synced to group peers. Two new reminder types are added: "Morning of (9 AM)" and "Day before (9 AM)", which fire at a fixed 9 AM time anchored to the event date rather than a relative offset from the event start time.

---

## Data Model

### Local reminder store

Reminders are stored in the local Hyperbee (not the Autobase group store) at key:

```
reminders:{eventId}  →  number[]
```

Values are minutes-before offsets, with two sentinel constants for the new calendar-anchored types:

```javascript
const MORNING_OF = -1   // 9:00 AM on the event date
const DAY_BEFORE = -2   // 9:00 AM the day before the event date
```

Maximum 3 entries per array. An empty array (or missing key) means no reminders.

### Existing `reminder` field on event

The `reminder: number` field remains on the event object and continues to sync to peers (for backward compatibility with older clients). PearCal itself stops using it for scheduling. On first access of `reminders:{eventId}`, if the key is missing and `event.reminder > 0`, the value is seeded as `[event.reminder]` — a one-time silent migration per event.

### Updated `REMINDER_OPTIONS`

```javascript
const REMINDER_OPTIONS = [
  { label: 'None',                value: 0    },
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

`1 day before` (exactly 24 hours before event start) is kept alongside `Day before (9 AM)` — they are meaningfully different for events that don't start at 9 AM.

---

## UI

The single reminder `<select>` in the event editor is replaced with a multi-reminder list component:

- Each row: reminder dropdown + `×` remove button
- "Add reminder" button shown below the list when fewer than 3 reminders are present; hidden at 3
- Duplicate values are prevented — options already selected in another row are disabled
- Empty list = no reminders (no "None" row shown; absence of rows conveys no reminder)
- When creating a new event, `profile.defaultReminder` pre-populates the first row (same as today)

---

## Notification Scheduling

### Notification ID block

Each event reserves a block of 4 notification IDs:

| Slot | Purpose |
|------|---------|
| `base + 0` | Reminder alarm 1 |
| `base + 1` | Reminder alarm 2 |
| `base + 2` | Reminder alarm 3 |
| `base + 3` | Start-time alarm (non-all-day events only) |

The `notifId` multiplier changes from 2 → 4. Since IDs are derived from a hash of `eventId`, this is a one-line change with no collision risk.

`cancelForEvent` cancels all 4 IDs unconditionally on every call.

### Fire time calculation

For standard minute-offset values (≥ 0):
```
fireTime = eventStartMs - reminder * 60 * 1000
```

For sentinel values:
```javascript
MORNING_OF (-1):  new Date(eventDate).setHours(9, 0, 0, 0)
DAY_BEFORE (-2):  new Date(eventDate - 1 day).setHours(9, 0, 0, 0)
```

If a computed fire time is in the past, the alarm is skipped (existing behavior, unchanged).

For all-day events, the event start is treated as 9 AM on the event date (existing behavior). `MORNING_OF` on an all-day event therefore fires at the same time as the event's default start — still valid and useful.

### `scheduleForEvent` signature change

```javascript
// Before
scheduleForEvent(event)

// After
scheduleForEvent(event, reminders)   // reminders: number[]
```

The `reminders` array is loaded from `reminders:{eventId}` in the bare store and passed alongside the event in the IPC payload from the WebView to React Native.

---

## Implementation Touchpoints

| File | Change |
|------|--------|
| `src/ui/App.jsx` | Replace reminder `<select>` with multi-reminder list component; add `MORNING_OF`/`DAY_BEFORE` constants; update `REMINDER_OPTIONS`; load reminders via `getReminders` on event editor open; save via `putReminders` on event save |
| `src/notifications.js` | `scheduleForEvent(event, reminders[])` loops array, branches on sentinel values for fire time; `notifId` multiplier 2→4; `cancelForEvent` cancels IDs `base` through `base+3` |
| `src/bare.js` | Add `getReminders(eventId)` and `putReminders(eventId, reminders[])` using `reminders:{eventId}` Hyperbee key; auto-migrate from `event.reminder` on first read |
| `app/index.tsx` | Include `reminders` array in `scheduleForEvent` IPC payload |

No changes to native Android (`NotificationsModule`) or iOS code — the existing `schedule()` / `cancel()` native APIs handle multiple independent calls without modification.

---

## Out of Scope

- Syncing reminders to group peers (reminders are always personal)
- Per-user "morning" time configuration (fixed at 9 AM)
- More than 3 reminders per event

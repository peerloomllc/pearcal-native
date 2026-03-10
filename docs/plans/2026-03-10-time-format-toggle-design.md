# Time Format Toggle Design

**Date:** 2026-03-10

## Goal

Add a 12-hour/24-hour time format toggle to the Profile tab Settings section, defaulting to the device locale preference.

## Data

`profile.use24h` — `true` | `false` | `undefined`

- `undefined`: derive default from locale at runtime via `!new Intl.DateTimeFormat([], { hour: 'numeric' }).format(0).match(/am|pm/i)`
- `true`: force 24-hour
- `false`: force 12-hour
- Saved to profile on first explicit toggle via `onUpdateProfile({ use24h: value })`

## formatTime

Add a second parameter: `formatTime(t, use24h)`.
- 24-hour branch: return `hStr + ':' + mStr`
- 12-hour branch: existing logic unchanged
- The one call site in `EventCard` passes the flag through

## Settings Card

A new collapsible "TIME FORMAT" card added beneath the HOLIDAYS card in the Profile tab Settings section. Same pattern as Holidays:
- Chevron header, `maxHeight` animation, `overflow: hidden`, haptic on tap
- Default: collapsed
- Body: single toggle row — "24-hour time" label + Toggle component

## Propagation

`use24h` (effective boolean) derived at the `App` level from `profile.use24h ?? localeDefault` and passed as a prop to `EventCard`.

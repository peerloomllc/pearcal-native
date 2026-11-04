# Personal calendars, show/hide and web calendar subscriptions

TODO #189, GitHub issue #394.

## Goal

Let one person keep several personal calendars (Main, Health and so on), switch
any calendar or group on and off, and follow outside `.ics` / webcal feeds.

## Tier

T2. New persisted fields, a new key family and a new personal-base op type.
Nothing changes on the group wire, invites or keys.

## Scope

Two phases, two PRs. Phase 2 starts after Phase 1 is merged and released.

### Phase 1 - personal calendars and visibility

**Data.**

- New key `personalCalendar:{id}` in the local Hyperbee, value
  `{ id, name, color, createdAt, updatedAt }`.
- Mirrored to linked devices as a new personal-base op,
  `{ op: 'put' | 'del', type: 'personalCalendar', key, value }`, applied
  last-write-wins by `updatedAt`, like `note` and `reminders`.
- New optional event field `calendarId`, read only when `groups` is empty. A
  personal event without it belongs to the implicit default calendar, id
  `default`, named "Personal". That calendar needs no row until it is renamed
  or recoloured, so no migration runs and existing data is untouched.
- `calendarId` is personal metadata. It is stripped from every payload that goes
  to a group base (`sync.putEvent` and the busy-time shadows), so group members
  never see a calendar id.
- Calendar color is the default for its events. An event's own `color` still
  wins when set, same as today.
- Deleting a calendar asks whether to move its events to another calendar or
  delete them. The default calendar can be renamed but not deleted.

**Visibility.** One per-device list of hidden calendars, stored locally under
`ui:hiddenCalendars` and not synced, so hiding Health on the desktop does not
hide it on the phone. It covers personal calendars and groups. Hidden events
drop out of every view, search and the home-screen widget. Reminders still fire.

**Mobile UI.** A calendars sheet listing personal calendars, then groups, each
with its color and an on/off switch, plus "New calendar". The event editor gets
a calendar picker for personal events. Existing BottomSheet component.

**Desktop UI.** The sidebar gets a Personal section above Groups with the same
checkboxes. The Groups heading folds away. `useVisibleGroups` already filters
groups in-session (`src/ui-desktop/hooks/useVisibleGroups.js`); it is extended
to personal calendars and persisted through `ui:hiddenCalendars`.

**Import.** The `.ics` import destination list gains each personal calendar plus
"New calendar", which is pre-named from the file's `X-WR-CALNAME`. The current
"personal" choice becomes the default calendar.

**Export.** Automatic `.ics` export (TODO #187) already writes one file per
chosen calendar; personal calendars become choices there too.

### Phase 2 - web calendar subscriptions

- New key `subscription:{id}`, value `{ id, url, name, color, refreshHours,
  updatedAt }`, mirrored to linked devices through a new personal-base op type
  `subscription`, so every device follows the same feeds.
- Each device fetches the feed itself. `webcal://` is rewritten to `https://`.
  Fetched in the RN shell on mobile and in the Electron main process on desktop,
  on launch and every `refreshHours` (default 12) while the app is open.
- Fetched events are stored locally under `subEvent:{subId}:{date}:{uid}`,
  read-only, and are never written to the personal base or a group. A refresh
  replaces the set. They show as one more calendar with its own switch.
- Adding a feed tells the user that the app will contact that website, which can
  see their IP address. The privacy wording on the site and in the store
  listings, which says PearCal uses no servers, gets a line for this.

### Not changing

Group sync, invites, how holidays are computed (still offline), birthdays, and anything about how group events are stored.

## Compat

- **Old app version on a linked device.** The personal-base apply in `src/bare.js`
  skips op types it does not know, so `personalCalendar` and `subscription` ops
  are ignored there. Events still arrive with `calendarId` and show in the one
  personal calendar. Editing one on old code keeps the field, since the editor
  spreads the stored event (`src/ui/App.jsx:1092`). An old device cannot move an
  event between calendars, and a series edit there does not carry `calendarId`
  across occurrences, which only matters if it differs between them.
- **Old app version in a shared group.** No change, the field never reaches them.
- **Downgrade.** The fields are ignored and every personal event shows in one
  calendar again. Nothing is lost.

## Verify

- Unit tests for calendar CRUD, last-write-wins merge, the default calendar,
  stripping `calendarId` from group payloads, delete-and-move, and import routing.
- Headless two-peer harness (`src/bare.js` under Node): a calendar created on one
  linked device appears on the other; a group member's copy of a shared event
  has no `calendarId`.
- Old-sibling check: one peer on the 1.0.54 bundle, one on the new one. The old
  one shows the events, edits one, and the new one keeps its calendar.
- Emulator: create calendars, import an Apple `.ics` into a new calendar, hide
  and show, restart and confirm the hidden list survived.
- Desktop: sidebar order, folding Groups, hidden state survives a restart.
- Phase 2: subscribe to a public holiday feed, check refresh replaces rather than
  duplicates, check nothing from it reaches the personal base or a group.
- `npm run verify` green.

## Rollback

Revert the PR. The new keys and fields stay on disk and are ignored, as in the
downgrade case. No cleanup is needed.

## Decisions (Tim, 2026-11-04)

1. A hidden calendar is also hidden from the home-screen widget. The widget
   follows the same list.
2. Reminders still fire for events in a hidden calendar. Hiding is a view filter.
3. Each chosen holiday country becomes a calendar with its own switch, in
   Phase 1. Birthdays stay as they are.

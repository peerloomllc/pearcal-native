# How far the desktop UI has drifted, and what to do about each piece

TODO #163. Written 2026-08-08 after #162, where the desktop let a user edit an
event locked to its creator and fanned the change out to the whole group. That
was not a one-off bug. It was the first symptom anyone happened to notice of a
structural gap, and the point of this document is to find the rest of it before
they are noticed the same way.

## The short version

`electron/scripts/bundle-ui.sh` builds `src/ui-desktop/main.jsx`, not
`src/ui/main.jsx` — its own header comment still says the latter, which is stale
and actively misleading. The two are separate implementations of the calendar
screens.

**The data layer underneath them is genuinely shared and is not the problem.**
Both UIs take `useProfile`, `useGroups`, `useEvents`, `useRsvps`,
`useHolidayRepair`, `Tour`, the holiday tables, the colour helpers, the time
formatters and the ICS codec from `src/ui-shared/`, and both take the invite
protocol from `src/lib/`. The engine is not duplicated at all:
`electron/vendor/src/bare.js` is byte-identical to `src/bare.js` via
`prepack.js`.

The drift is entirely in the layer above: **what the app lets you do, and what
it tells you when something is wrong.**

## The objective measure

Every capability the UI has comes through one narrow door: `window.__pearDB.call`.
Diffing the two proxies is therefore a complete, mechanical list of what each
host can and cannot ask the engine for.

```
mobile: 98 methods    desktop: 70 methods
```

**29 the desktop cannot reach:**

```
analyzeStorage auditStorage storageBreakdown reclaimStorage
purgeOrphanDataRanges purgeMigratedGroup purgeAllMigratedGroups rebuildLocalDb
listBlindPeers removeBlindPeer renameBlindPeer setSeederAutoFollow
mintSeedInvite mintSeedBundle seederPairScan cancelSeederPairScan
transferOwnership claimOwnership rekeyGroup commitRekey
resetAppData debugGroup keylessGroupStatus computeUpcomingReminders
reconcileSchedule qrScan haptic copyText canOpenLightning openLightning
```

**2 the mobile cannot**, both correct: `desktopGetLaunchAtLogin`,
`desktopSetLaunchAtLogin`.

One of those 29 is a false positive: `computeUpcomingReminders` is called from
`electron/src/main/`, so desktop reminders work. The other 28 are genuinely
unreachable from the desktop app.

## What the user actually loses

Checked against the **shipped v1.0.43 AppImage**, not the source tree — none of
these strings exist inside its `app.asar`:

| Missing on desktop | What it is | Why it matters |
| --- | --- | --- |
| "This group can't sync on this device" | the #124 keyless banner | the one thing that tells a user their calendar is broken rather than quiet |
| "hasn't synced in …" | the #155 sync-health banner | same, for the slow version |
| "Waiting for owner approval" | pending-approval notice | desktop bridges the event (`src/ui-desktop/main.jsx:55`) and then displays nothing |
| "Reclaim Storage" | the whole storage section | a desktop is the always-on device and accumulates the most; it is the one host that cannot clean up |
| "Share Group Invite" | wording only | mobile and desktop word the same action differently |

Plus, from the proxy diff: no blind-peer management, no seeder pairing, no
ownership transfer or claim, no rekey, no reset-app-data, and no ICS import or
export (`parseIcs` / `generateIcs` are exported from `src/ui-shared/` and
imported only by mobile).

The silence is the worst of it. Three of the five rows above exist purely to
tell a user something is wrong, and on desktop the app says nothing at all.
During the 2026-08-08 investigation the desktop was the machine with the whole
history on it and it was the machine least able to describe its own state.

## Per feature: port, share, or drop

**SHARE — build once in `src/ui-shared/components/`, render in both.**
These are pure presentation over data both UIs already receive (`g.keyless`,
`g.syncHealth`, the `pendingApproval` events), so porting them twice would be
the same mistake again.

- keyless banner (#124)
- sync-health banner (#155)
- pending-approval notice

**PORT — real capability the desktop lacks, in rough priority order.**

1. **Storage: reclaim, breakdown, analyze, audit, purge, rebuild.** The
   always-on host with the biggest store is the one with no way to shrink it.
2. **Blind-peer management and seeder pairing.** Tim runs two seeders; the
   desktop cannot list, rename, remove or pair one, or mint a seed invite.
3. **ICS import and export.** The codec is already shared; only the sheet is
   missing, and a desktop is where people move calendars around.
4. **Reset app data.** The support escape hatch, absent on the host most likely
   to need it.
5. **Ownership transfer and claim.** Owner recovery is impossible from desktop.
6. **Rekey group.** Blocked behind #157, which says Rekey fails outright for
   profiles like Tim's. Do #157 first or this ports a broken button.

**DROP — deliberate, and worth writing down so it is not re-raised.**
Consistent with `project_desktop_scope`: desktop drops widgets and the
QR-*scanning* camera path (QR *generation* stays). So `qrScan` and `haptic` are
correctly absent. `canOpenLightning` / `openLightning` could be a shell-out but
have no desktop caller today.

**ALREADY DONE.** The event edit lock, #162, PR #304.

## Why it happened, and the one guard that would have caught it

Nothing anywhere fails when the desktop simply omits something. A missing proxy
entry reads as `undefined`; a missing banner renders as nothing.

`test/dbProxyParity.test.js` already exists and is the right idea, deliberately
narrow: *the two proxies may differ, but every db method that SHARED code calls
must exist in both.* It was written for #146, where `repairKeylessGroup` was
absent from the desktop proxy and the shared `handleInviteLink` silently fell
through to the dead end #124 exists to remove.

Its `SHARED_MODULES` list covers only `src/invite.js`. Since then
`src/ui-shared/` has become a second body of shared code — its hooks call
`getProfile`, `listGroups`, `listEvents`, `putEvent` and `localDeleteEvent` — and
is not covered. Those five all happen to be present in both proxies today, so
extending the test is a guard rather than a fix. That is the point: the gap
should be closed while it is still cheap.

This proposal ships that extension. It does not ship a full-parity test, for the
reason the original gives: the proxies are legitimately different, and a test
demanding they match would be deleted the first time it got in the way.

## What this does not cover

Only `window.__pearDB` reachability and a spot check of shipped strings. It says
nothing about visual or interaction differences, which are legitimate — a
desktop should have a command palette, context menus and drag-to-reschedule, and
a phone should not. Those are not drift.

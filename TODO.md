# PearCal To-Do List

Items are categorized by type, priority, and complexity. Completed items remain in the list with a completion date for historical reference.

---

## Features — High Priority / Medium Complexity
- [x] Editing recurring events: ask to edit all events in series or just this occurrence — completed 2026-03-11
- [x] Converting a single event into a recurring series — completed 2026-03-10

## Features — High Priority / High Complexity
- [ ] Seed word backup and restore capability (also prerequisite for ownership transfer)
- [ ] iOS port

## Features — Medium Priority / Medium Complexity
- [ ] Group admin roles: add `admins: [memberId]` to group record; owner can promote/demote admins in Group Settings; admins get remove-member, reinvite, and blocklist UI permissions; writer handshake authorization stays owner-only
- [ ] Ownership transfer: transfer Autobase bootstrap keypair to another member via Protomux; requires seed word backup as a prerequisite; update `ownerId` on group record and broadcast to all members (prerequisite: seed word backup)

## Features — Medium Priority / Low Complexity
- [x] Contact Developer button on About tab — completed 2026-03-10
- [x] 12-hour/24-hour time format toggle (under Settings section on Profile tab) — completed 2026-03-10
- [x] First day of week setting (Sunday / Monday) under Settings on Profile tab — completed 2026-03-10
- [x] Default reminder time setting under Settings on Profile tab — completed 2026-03-10
- [x] Confirmation dialog for Delete Group: warn user of consequences, require confirm/cancel — completed 2026-03-10

## Features — Medium Priority / High Complexity
- [x] Enforce invitee-based event visibility: events shared with specific members should only appear on those members' calendars — completed 2026-03-11

## Features — Medium Priority / Low Complexity
- [x] Set nickname before group join: prompt user to set their display name before joining a group via invite link — completed 2026-03-11

## Features — Medium Priority / Low Complexity (Bug Fix)
- [x] Unsharing an event from a group (owner deselects group) does not remove it from that group's members' calendars — completed 2026-03-11
- [x] Adding a user/group to a converted recurring event only updates that single occurrence, not the whole series — completed 2026-03-11
- [x] Users see group join notifications for pre-existing members (not the owner) when they join a group — completed 2026-03-11
- [x] Persist dark/light mode preference to profile (currently resets on restart) — completed 2026-03-10

## UI / UX — Medium Priority / Low Complexity
- [x] Update Lightning Address on About page to peerloomllc@strike.me — completed 2026-03-11
- [x] Add USD donation option on About page — completed 2026-03-11
- [x] Clarify event deletion button text and flow — completed 2026-03-10

## UI / UX — Medium Priority / Medium Complexity
- [x] UI redesign: revisit color scheme and replace default emojis (share, QR, etc.) with custom images — completed 2026-03-12

## UI / UX — Medium Priority / Low Complexity (Polish)
- [x] Stale invite link creates ghost group: user can join with an old link, group card appears, but Leave Group button is missing from Group Settings (no leave action available) — completed 2026-03-12
- [x] Back gesture does not dismiss the Group Settings bottom sheet — completed 2026-03-12
- [x] Remove "Peer Groups" header label on Groups tab (redundant with nav) — completed 2026-03-12
- [x] "New Peer Group" title on New Group bottom sheet → "New Group" — completed 2026-03-12
- [x] Hide "My Public Key" field on Profile page (not currently used) — completed 2026-03-12
- [x] Share Group Invite button disabled for non-owner members — non-issue, button is gated on group readiness only, not ownership — removed 2026-03-12
- [x] Profile tab Camera and Gallery buttons still use emoji icons — replace with Phosphor icons (Camera, Image) — completed 2026-03-12
- [x] Replace "Today" pill on Calendar tab header with a relevant icon — completed 2026-03-12
- [x] Replace app loading screen Pear emoji with the Pear icon used throughout the app — completed 2026-03-12
- [x] Month back/forward arrows on Calendar tab — replace with Phosphor icons — completed 2026-03-12
- [x] New Group bottom sheet: remove Icon section, replace with "Group Avatar" section using Camera and Gallery options — completed 2026-03-12

## Features — Medium Priority / Low Complexity
- [x] Group Settings (owner only): restore "Removed Members" list and per-member Reinvite link capability — completed 2026-03-13

## UI / UX — Medium Priority / Low Complexity
- [x] Edit recurring event confirmation dialog should be a bottom sheet (consistent with rest of app) — completed 2026-03-12

## Bugs — Medium Priority / Low Complexity
- [x] Receiving notifications for deleted events at event time (but not at reminder time) — deleted events fire the event-time alarm even after deletion — completed 2026-03-12
- [x] When a user joins a group, all existing events appear on their calendar and trigger a notification for each one — completed 2026-03-13
- [x] New or edited recurring event series fires a separate notification for each occurrence instead of a single notification for the series — completed 2026-03-13
- [x] When a user joins a group, the group color is sometimes changed unexpectedly — completed 2026-03-13

## Bugs — Low Priority / High Complexity
- [ ] Autobase late-joiner replay: when a member wipes app data and rejoins, Autobase replays the full operation log — firing historical notifications, briefly churning the member list, and accumulating duplicate member records across wipe cycles. Mostly a dev/testing artifact (repeated wipes); real production impact is limited to mild notification spam (~N notifications) when a user reinstalls and rejoins an active group. Root cause: no reliable "catchup complete" signal in Autobase/Hypercore — blocks replicate asynchronously so a simple flag cleared after first base.update() fires too early. Defer until a clean solution presents itself.

## UI / UX — Medium Priority / Low Complexity
- [x] Add USD donation button to About page — completed 2026-03-12
- [x] About page: add "Learn about P2P" button (links to a resource explaining peer-to-peer technology) — completed 2026-03-12
- [x] About page: version number should dynamically reflect the current build version — completed 2026-03-13

## Legal / Web — Medium Priority / Low Complexity
- [x] Privacy policy HTML page hosted on GitHub Pages — completed 2026-03-10

## DevOps / Release — High Priority / Low Complexity
- [ ] Resolve GitHub account flagged by abuse detection: Actions disabled, release asset downloads blocked programmatically — contact support ticket open

## DevOps / Release — Low Priority / Low Complexity
- [x] Update zapstore.yaml to include metadata_sources and app metadata — completed 2026-03-10
- [x] GitHub releases: auto-generate release notes from PR "Summary" sections of all merged PRs since last release — completed 2026-03-10

---

## Completed
- [x] Invite options modal: single "Share Group Invite" button opens BottomSheet with Share Link and Show QR Code — completed 2026-03-10
- [x] Invite message template: pre-filled share message with group name and invite link — completed 2026-03-10
- [x] US, Canada, and UK holiday imports on Profile tab with per-country toggles — completed 2026-03-10
- [x] Holiday toggle state stored in profile.holidayCountries (not inferred from events) to prevent shared-ID false positives — completed 2026-03-10
- [x] Holiday events read-only in event modal; only "Delete for Me" available — completed 2026-03-10
- [x] Signed APK release pipeline via GitHub Actions → GitHub Releases → Zapstore — completed 2026-03-10
- [x] App version auto-derived from git tag (vX.Y.Z) — completed 2026-03-10
- [x] Member nicknames: set per-member display name within a group — completed 2026-03-10
- [x] Fix duplicate member on group rejoin (resyncGroup stale-view merge logic) — completed 2026-03-10
- [x] Fix late-joiner sync: call base.update() immediately on peer connect — completed 2026-03-10
- [x] Remove redundant My Peer Groups card from Profile tab — completed 2026-03-10
- [x] Profile tab: collapsible Settings section with Holidays card — completed 2026-03-10
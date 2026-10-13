# 2026-10-13 - Back groups up to PeerLoom Seeder

**Status**: Approved 2026-10-13 (Tim).

## Goal

A PearCal member pairs a phone with PeerLoom Seeder (the shared seeder for every
PeerLoom app) and every member of their groups backs those groups up to it.

## Tier

T2. A new group record type and a new pairing client. No change to existing records,
topics or the group protocol; old app versions ignore the new record.

## Background

Suite plan: `proposals/2026-10-12-generic-seeder.md` phase 3 and
`proposals/2026-10-12-peerloom-seeder-product.md` (both approved). PearCal has two
seeders today:

- Its own seeder (`src/seed.js`, Umbrel/Start9/launcher packages). It joins each
  group's topic and is admitted by QR pairing plus seed bundles.
- A hand-entered blind-peer key (`blindPeerKey`, `initBlindPeering`,
  `bare.js:1444`), which registers every group base with `blind-peering`. Its
  settings field is no longer visible.

Groups are block-encrypted with a key separate from the topic
(`bare.js:2470-2485`, `groupSwarmTopic` `bare.js:4000`), so a blind box can hold
their cores without reading them. The personal (device-link) base is not encrypted
and stays out of every seeder.

## Scope

1. **Pairing.** Settings > Blind peers gets "Pair PeerLoom Seeder": paste the link
   from the seeder's dashboard (or scan its QR). The worklet calls `pair({ swarm,
   link, app: 'PearCal' })` from `@peerloom/seeder`'s client, copied into
   `src/peerloom-seeder/` by a vendor script (as `@peerloom/core` does), and keeps
   `peerloomSeeder:{seederKey}` in the local db.
2. **Sharing with groups.** Pairing backs up every group the person is in, with a
   list to untick groups (answer 2). For each chosen group the device appends a
   new record:
   `pseeder:{seederKey}` -> `{ type: 'pseeder', seederKey, addedBy, addedAt,
   updatedAt, v: 1, revoked?, revokedAt?, revokedBy? }`, LWW on `updatedAt`, like
   `seeder:{pubkey}` (`src/lib/seederRecord.js`). A new type, not `seeder:`,
   because old versions would treat a `seeder:` row as a PearCal seeder and try to
   send it seed bundles.
3. **Backing up.** Every member registers each group base with the group's
   non-revoked `pseeder` keys through `blind-peering`
   (`addAutobaseBackground(base, { keys, pick: keys.length })`), and registers again
   when a seeder is added or a writer joins. Same as `@peerloom/core`'s
   `src/seeding.js`, which this ports. The old `blindPeerKey` path keeps working.
4. **Removing.** "Stop using" on a group writes `revoked: true`. Only the group
   owner or the row's `addedBy` may (answer 1). A device can also unpair locally, which stops it backing up and
   asks the seeder to drop groups nobody else backs up there (`drop` request, 7 days).
5. **UI copy.** The seeder is named "PeerLoom Seeder" with its key; the text says it
   keeps groups in sync while phones sleep, stores them scrambled, and cannot add a
   new member.

Not in scope: retiring `seed.js` or its packages (product phase 6, with an in-app
prompt); desktop UI (TODO #163); the personal base.

## Compat

- Old PearCal versions mirror records by `type` and have no `pseeder` branch, so they
  ignore the rows (to confirm in the spike). They do not back up to the new seeder;
  any upgraded member's registration covers every writer core of the base, so the
  group is still held.
- Existing `seeder:` rows, `seed.js` seeders and the `blindPeerKey` are untouched.
- Deps: `blind-peering` moves from `^2.0.1` to the version `peerloom-seeder` tests
  against (2.10.x) with `protomux-wakeup`; `autobase` stays pinned at 7.25.1.
  Spike first: register a 7.25.1 base with a PeerLoom Seeder and catch up from it.

## Verify

- Unit tests for the `pseeder` record (shape, LWW, who may revoke) beside
  `seederRecord.test`.
- Spike: autobase 7.25.1 + blind-peering 2.10 against PeerLoom Seeder.
- Two devices (emulator + TCL, suite rule 15): pair one with a seeder; both back the
  group up (dashboard shows a PearCal section); one writes and goes offline, the
  other catches up from the seeder alone.
- An old-version PearCal in the same group keeps syncing and shows no errors.
- Seeder folder scan finds no event text.

## Rollback

Ship behind the Settings entry. Removing the code leaves `pseeder` rows that nothing
reads; the seeder drops groups after the 7-day grace once nobody registers them.

## Answers (Tim, 2026-10-13)

1. **Owner or adder.** Only the group owner and the member who added a seeder can mark
   it revoked; the apply rule checks the writer, as PearCircle's does.
2. **All groups by default.** Pairing backs up every group the person is in, with a
   list to untick groups.

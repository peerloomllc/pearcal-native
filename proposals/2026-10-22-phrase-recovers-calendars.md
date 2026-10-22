# 2026-10-22 - The recovery phrase brings your calendars back (TODO #176)

## Goal

Someone who loses every device can type their 12 words into a fresh install
and get their shared calendars back, using the PeerLoom Seeder they paired,
the way PearOffice already does for files.

## Tier

T3. Key management and recovery: the phrase starts unlocking calendar keys
that today it cannot reach, and the phrase becomes visible to the user again.

## What happens today

- Every identity has a 12-word phrase (`ensureMnemonic`, `src/bare.js`, BIP39
  from 16 bytes). keet-identity-key derives the identity from it;
  `profile.id` derives from the identity (`deriveProfileIdFromIdentity`).
- `restoreMnemonic` brings back the identity, so ownership and membership
  match again. It is unreachable from the UI: PR #282 removed the phrase
  screen and the cloud backup after the seed was found uploaded to Apple and
  Google with no working toggle.
- Nothing else comes back. The group list, group keys and encryption keys live
  only in the local DB (`groups:*`) and, for linked devices, the personal
  base, whose key is random and stored only on those devices. After a wipe
  every calendar needs a fresh invite, and a member without one (#88) is
  stuck.
- Once invited back, readmission already works: writer-announce matches the
  identity (`src/bare.js`, identity rebind) and any online member grants
  write access; the owner's restored device can run the signer policy
  without being a signer (#159 follow-up, PR #350).

## Design

Same two parts as PearOffice (`pearoffice/proposals/2026-10-07-phrase-recovers-files.md`):
an encrypted list of your calendars on your seeders, and a restore that uses it.

### 1. The keyring

Each device keeps a keyring: for every calendar it is in, `groupId`, name,
`groupKey`, `encryptionKey`, `encrypted`, `ownerId`, and the keys of the
seeders it is paired with. About 250 bytes a calendar; the seeder's limit is
1 MB.

Keys come from the phrase with keyed BLAKE2b, one purpose string each, under
a `pearcal/` namespace so a PearCal phrase never opens a PearOffice keyring or
the other way round:

| Name | Derived as | Used for |
| --- | --- | --- |
| root `R` | `H(bip39 entropy, 'pearcal/keyring/root/1')` | everything below |
| locator `L` | `H(R, 'pearcal/keyring/locator/1')` | the keyring's address at a seeder |
| sign key `S` | Ed25519 from `H(R, 'pearcal/keyring/sign/1')` | signs each version |
| box key `B` | `H(R, 'pearcal/keyring/box/1')` | encrypts it (XChaCha20-Poly1305) |
| topic `T` | `topicOf(L)` from `peerloom-seeder/src/keyringRecord.js` | where a restoring device finds the seeders |

The seeder side needs no change. `keyring-put`, `keyring-get` and
`keyring-claim` already exist on `peerloom/seeder/1`, PearCal's vendored client
already lists them, and the seeder's own namespaces (`pearoffice/keyring/topic`,
`sig`, `claim`) stay as they are: they are protocol constants, signed into
records already stored. PearCal vendors `keyringRecord.js` beside the client.

A device writes the keyring when its calendars change (created, joined, left,
removed, key repaired), at most once a minute: fetch the current version,
merge (calendars from both; leaves kept as tombstones for 30 days so a stale
device cannot bring a left calendar back), encrypt with `B`, sign with `S`,
put to each seeder this device is paired with. Linked devices of one
identity share the same `L`, so they merge into one keyring.

### 2. Showing the phrase again

A **Recovery phrase** screen in Settings, mobile and desktop: the 12 words
behind a device-unlock prompt, with the warning "Anyone with these words can
read every calendar your seeders keep". No copy to clipboard by default, no
cloud backup, nothing uploaded. The PR #282 scrub of old cloud copies stays.

### 3. Restore

Onboarding gets "I already use PearCal → Enter my 12 words": one word at a
time on phones with BIP39 suggestions (4 letters pick a word), a grid on
desktop, pasting fills all 12. Then:

1. `restoreMnemonic` as today (refuses if this device already has calendars
   under another identity).
2. Derive `L`, `T`, `S`, `B`; join `T`; ask every seeder found for
   `keyring-get` for up to 90 s; keep the highest `seq` that verifies with `S`
   and decrypts with `B`; merge if several.
3. `keyring-claim` to each seeder that holds it, so they treat this device as
   paired and it can back up there again.
4. For each calendar: save the group record with its key (`putGroup`), then
   `joinGroup`. Saving first matters: `joinGroup` alone does not persist the
   key, and the calendar comes back keyless after the next restart (found
   while testing #159). The device then announces; any online member admits
   it by identity.
5. Each recovered calendar shows one of:
   - "Back" once a member's device has let this one in;
   - "Waiting for another member to come online";
   - "Nobody else can let you back in" for a calendar only you were in, with
     **Make a copy you own** (open question 3).

Without a seeder nothing changes from today.

### 4. Personal events, notes and reminders (second step)

These live outside any shared calendar, in the personal base, which is not
encrypted and so is never given to a seeder. The plan is a second keyring at
a second locator (`'pearcal/keyring/personal/1'`) holding a snapshot of them,
written on change at most every 10 minutes, with the same 1 MB cap; the
seeder allows 4 keyrings per device. Past events older than a year are
dropped from the snapshot first if it nears the cap. See open question 1.

## Limits

- **No seeder, no calendars.** Without a seeder that holds the keyring, the
  words bring back only who you are, as today.
- **Only for people who paired a seeder.** The seeder accepts a keyring only
  from a device paired with it by QR. A member who only uses someone else's
  seeder (through the calendar's `pseeder:` row) has no keyring there.
- **A leaked phrase reads every calendar your seeders keep.** Today it lets
  someone act as you but they still need an invite.
- **A calendar only you were in** can be read back from the seeder but not
  written to, since a seeder cannot grant write access. Hence the copy.
- **A calendar whose only signer was your lost device** stops finalising
  (#159 scenario F). Members still see each other's changes. The signer
  policy cannot replace a signer without a quorum, so this one also offers
  the copy.
- **Changes in the last minute** before the device was lost may be missing.
- **Removed from a calendar:** the keyring may still hold that calendar's keys,
  but the identity is in `removedMembers`, so the rejoin waits for the owner
  to approve it, as a re-invite does today. Leaving a calendar removes it from
  the keyring.

## Compat

- Members see no change: nothing in a calendar's format or wire protocol
  changes. Older builds of other members admit a restored device exactly as
  they admit a re-invited one.
- The PeerLoom Seeder already supports keyrings (PearOffice). The old PearCal
  seeder (`src/seed.js`, no longer published) does not; on it the app shows
  "This seeder can't keep your calendar list" and recovery uses the others.
- Older PearCal builds never write keyrings; their calendars are recoverable
  only after a device on this build has written one.
- No migration: no keyrings exist yet.

## Verify

- Unit: derivations stable and distinct per purpose; seal/open round trip;
  merge with tombstones; size cap.
- Engines on a local DHT with a real PeerLoom Seeder (extend
  `test/harness/signer-policy-e2e.js`):
  - Ana loses her only device and restores from her words; her calendars come
    back; Ben's calendar admits her new device while Ben is online.
  - Her own solo calendar offers a copy she owns, with the same events.
  - A device without the words cannot read or replace the keyring.
  - The seeder holds only ciphertext.
  - Two linked devices writing at once both end up in the merged keyring.
- Devices: wipe the TCL, restore it from its words with the seeder on the
  Umbrel; the emulator owns one of its calendars.

## Rollback

Stop writing keyrings and hide the restore entry and the phrase screen.
Seeders keep what they hold until the device is forgotten; nothing else reads
it.

## Order

1. Derivations, keyring format, merge (no network).
2. Write keyrings to paired seeders; Settings shows "Your calendar list is
   backed up to N seeders".
3. Recovery phrase screen.
4. Restore flow and the per-calendar states, including the copy.
5. Personal data keyring (section 4).

## Open questions

1. **Personal events, notes and reminders:** include them in this work as the
   second keyring (section 4), or ship calendars first and decide later?
   Recommended: calendars first, personal data as step 5 of the same work.
2. **On by default once you pair a seeder?** PearOffice decided yes, with the
   stronger phrase warning. Recommended: the same.
3. **A calendar nobody else can let you back into:** offer "Make a copy you
   own" (new keys, same events, members re-invited by hand), or leave it
   read-only? Recommended: the copy, as in PearOffice.
4. **Seeing the phrase:** behind the device unlock prompt only, or also
   offered once right after first setup? PR #282's lesson was that nobody
   should be surprised by where the words went. Recommended: Settings only,
   behind the unlock prompt.

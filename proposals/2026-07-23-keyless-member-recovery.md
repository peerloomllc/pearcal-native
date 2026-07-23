# 2026-07-23 - Keyless member detection and recovery (TODO #124)

## Goal

Give a plain member whose group `encryptionKey` has gone missing a way to find
out and a way back, instead of failing silently forever and quietly spreading
the breakage to everyone it invites.

## Tier

**T2.** Adds one new persisted field to the local group record and one new
local-only decision at an existing choke point. No wire change, no new swarm
topic, no change to invite format, no key material on the wire. Old peers see
nothing new and behave exactly as today.

Deliberately NOT the T3 option. A member-to-member key request would put the
group's block-encryption key on the wire and needs its own threat model,
rollback and RCA readiness. Decided against on 2026-07-23.

## The bug

`backfillMissingGroupEncryptionKeys` (`src/bare.js:3221`) repairs a missing key
by reading the personal-base `personalGroups:` fan-out. That keyspace exists
only for paired sibling devices of the same identity. A plain member of someone
else's group has no personal-base row for it, so `reconcileGroupEncryptionKey`
finds nothing to back-fill and the device stays keyless permanently.

The consequences compound, because the encrypted and unencrypted swarm topics
are disjoint. `groupSwarmTopic` (`src/bare.js:3557`) sends an encrypted group to
`blake2b("pearcal-enc-topic-v1:" + groupKey)` and a keyless one to the raw
`groupKey`. A keyless device is therefore not merely unable to decrypt, it never
meets a keyed peer at all.

### Reproduced 2026-07-23

Headless two-peer harness driving the real worklet over Hyperswarm (see
[Verify](#verify)). Peer A creates an encrypted group, peer B joins the same
group with the `encryptionKey` stripped, which is exactly the TCL's observed
state: joined via a link that carried `enc=`, holding a record that does not.

```
A created "Alpha"  encryptionKey=0f695f078fce49b4...
B joins the SAME group with encryptionKey stripped

[1] B local record: encryptionKey=MISSING  members=0
[2] event reached B: NO (never syncs)
[3] A invite would carry &enc= : YES
    B invite would carry &enc= : NO  <-- spreads the breakage
[4] A sees 1 member(s) - B did NOT reach the owner
```

Every symptom from the field report is present. B never learned a single member,
never received an event and would mint invites that break whoever accepts them.
B and A were never on the same topic, so nothing in the existing protocol could
have told either side anything was wrong.

### Two things this changes about the problem

**The keyless device is not unreachable.** The encrypted topic is derived from
`groupKey` alone. The `encryptionKey` selects the branch, it does not enter the
hash. A keyless device holds `groupKey`, so it can compute the encrypted topic
and connect to keyed peers whenever we want it to. Hypercore block encryption
does not prevent replication of ciphertext, which is the whole basis of the
blind seeder. Every recovery option is therefore technically available. The
question is which one we should want, not which one is possible.

**Nothing local distinguishes "damaged" from "legacy".** A legacy unencrypted
group and a damaged encrypted group look identical on disk: a group record with
no `encryptionKey`. So a device cannot currently tell, offline, that it is the
broken one. That is the actual gap to close.

## Scope

### 1. A one-way `encrypted` latch on the local group record

Add a non-secret boolean `encrypted` to the local group record. Set it the first
time we ever see an `encryptionKey` for that group and never unset it.

Implement it inside `putGroupRecord` (`src/bare.js:1840`), the choke point PR
#231 already funnels all sixteen local group-record writes through, with the
decision in `src/lib/groupRecord.js` next to `resolveGroupEncryptionKey` and
unit-tested the same way.

This is the important half. Because the latch is monotonic and lives at the same
guard that already refuses to drop a key, it survives the key's loss by
construction. `encrypted === true && !encryptionKey` is then a definitive,
offline, instant "this device is the broken one", for any damage occurring after
this ships.

The field must stay local-only, like `encryptionKey` itself. A flag carried in
the Autobase view would be worthless here: the view of an encrypted group is
encrypted, so the one device that needs to read the flag is the one device that
cannot.

### 2. A never-synced heuristic for already-damaged devices

The latch cannot help a device that lost its key before the latch existed, which
includes the TCL. For those, use what the repro shows: a keyless group that has
been joined for a meaningful period, still has zero members and has never
received view data is almost certainly damaged rather than legacy.

This is a heuristic and must be worded as one. A group whose other members
simply have not been online looks the same. So it drives a soft, non-blocking
notice, not an error.

### 3. Surface it, and make the fix one paste

Where a group is flagged, say plainly what is wrong and what fixes it: ask any
current member for a fresh invite link and paste it in. Show the group id so the
user can name the group when they ask.

Consuming that link must route into the repair path rather than the join path.
`joinGroup` (`src/bare.js:2133`) returns immediately when `bases.has(group.id)`,
and the group IS already present, just keyless. So an invite carrying `enc=` for
a group we already hold keyless must call `reconcileGroupEncryptionKey`
(`src/bare.js:1862`), which already does exactly the right thing: back-fill the
key, close the base opened on the wrong topic, leave that topic and rejoin
encrypted. That function is written, shipped and proven. This is wiring, not new
machinery.

### Out of scope

- **Member-to-member key transfer.** T3, rejected above.
- **Probe-joining the encrypted topic to detect damage definitively.** Viable,
  and it would replace the heuristic in item 2 with a certain answer. Left out
  because a naive probe reintroduces precisely the hazard the topic separation
  was built to remove: keyless peers connecting to an encrypted group is the
  EncTestv incident, where they triggered owner-recovery on a false "owner
  offline" reading and emitted member removals over the plaintext control
  channel. A probe would have to be provably inert, attaching no group protomux
  channels and no replication, and that is a separate change with its own risk.
  See [Open questions](#open-questions).
- Anything that changes the invite format or the topic derivation.

## Compat

No wire change at all. `encrypted` is local-only and never appended to a view,
so no peer, old or new, ever observes it. Invite links keep their existing
shape and the existing `enc=` parameter is the recovery vehicle.

An old-code peer is unaffected in both directions: it does not write the latch,
and a new-code peer reading a record written by old code simply finds the latch
absent and falls back to the heuristic in item 2.

No migration step. The latch sets itself on the next group-record write for any
device that still holds its key, which is every healthy device.

## Verify

The harness that produced the evidence above is the verification vehicle. It
runs `src/bare.js` under plain Node via the Electron BareKit shim, two processes
as two genuine Hyperswarm peers, no device and no display. Recipe in
`feedback_headless_bare_two_peer_harness`.

Cases:

1. **Damage is detected.** Keyless member of an encrypted group is flagged, via
   the latch where present and via the never-synced heuristic where not.
2. **A fresh invite repairs it.** Pasting a link carrying `enc=` for the
   already-held keyless group back-fills the key, reopens the base on the
   encrypted topic, syncs, populates members and restores `&enc=` on the invites
   that device mints afterwards. Assert all five, not just the key.
3. **No false positive on a legacy group.** A genuinely unencrypted group is
   never flagged, with or without peers online.
4. **No false positive on a healthy member.** A keyed member of an encrypted
   group is never flagged.
5. **The latch is monotonic.** A record write that omits `encrypted` cannot
   clear it, mirroring the existing `resolveGroupEncryptionKey` tests.

Unit tests for the pure latch decision in `src/lib/groupRecord.js`, alongside
the seven that already cover the key guard.

Real-device confirmation on the TCL, which is a genuinely damaged device and
therefore the only true test of item 2. Its group "Alpha" should be flagged, and
a fresh invite from a keyed member should restore sync.

## Rollback

Revert the commit. The field is additive and unread by everything else, so
devices that already latched `encrypted: true` keep one harmless extra boolean
on a local record. No view data, no peer state and no invite ever carried it, so
there is nothing to unwind on the network and no flag day.

The repair path is `reconcileGroupEncryptionKey`, which ships today and is not
modified by this proposal, so rolling back removes the prompt without removing
the cure.

## Open questions

1. **Do we want the probe after all?** It turns item 2 from a heuristic into a
   certainty for exactly the devices we cannot otherwise help. The cost is
   proving the probe inert against the EncTestv failure mode. Recommend shipping
   without it, then reassessing if the heuristic proves too noisy or too quiet in
   practice.
2. **Threshold for the never-synced heuristic.** Long enough that a group whose
   members are merely offline does not get flagged, short enough to be useful.
   No data yet on how long a healthy group can legitimately sit at zero members.
3. **Should a keyless device refuse to mint invites?** It currently mints links
   that break whoever accepts them, which is how one damaged device becomes
   several. Blocking that is arguably a separate and smaller fix worth doing
   regardless of which recovery path we choose. Flagged rather than folded in,
   because it changes behaviour for legacy unencrypted groups too, which share
   the same "no key" state.

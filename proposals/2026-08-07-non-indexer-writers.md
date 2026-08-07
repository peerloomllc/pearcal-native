# 2026-08-07 - Paired devices and members become plain writers, not indexers (TODO #159)

## Goal

Stop every device that joins a calendar from also becoming a signer, so that a
group's signed view can advance without most of its members happening to be
awake at the same moment.

## Tier

**T3.** It changes who may sign the Autobase view, which is the group's
consensus rule. Old-code and new-code peers apply the same `addWriter` op to
different effect, so a naive rollout forks the system view. Needs a rollback
plan and RCA readiness.

## The bug

Advancing the signed view needs a **majority of indexers** to ack
(`autobase/lib/consensus.js:15`). Both apply paths grant indexer rights to
everyone:

- `src/bare.js:2758` - personal base, every linked device
- `src/bare.js:5677` - group base, every member and every linked device

So each device that ever pairs raises the signing bar permanently, for everyone.

### Measured on Tim's live group, 2026-08-07

Read offline from a copy of the desktop's store
(`scratchpad/indexers.js`, read-only, no writes to the real store):

```
=== Hudgins (gry5nws) ===
  members on the group record : 5
  INDEXERS in the system view : 7  -> majority needed to sign: 4
  base length                 : 69269
  base indexedLength (SIGNED) : 2825  -> stranded in the un-indexed tail: 66444
  member names                : Benjamin, Leah, Rachel, Sarah, Tim
   - b0cd02268768cb60… [Tim]           declaredLen=17378
   - 57426c07a6eb9f9b… [THIS DESKTOP]  declaredLen=17183
   - abab1f6e8a71fe0f… [identity fc8589944e… not a listed member]  declaredLen=4
   - cc34f9c6c9da9845… [UNIDENTIFIED]  declaredLen=23
   - 60d837785a9a3c61… [UNIDENTIFIED]  declaredLen=19
   - 8af2926d2a397fdf… [UNIDENTIFIED]  declaredLen=23
   - 9bc070929ed19d73… [UNIDENTIFIED]  declaredLen=2
```

**96% of the group's history has never been signed.** Five people, seven
signers, and four of the seven must be online together for anything to advance.
Two of the seven are Tim's own devices, so the other households have to supply
two simultaneously awake phones. That is routinely false among perfectly
healthy devices.

**Nothing has to be dead for this to bite.** An earlier version of this
diagnosis blamed wiped devices, inferred from writers showing `nodes: 0`. That
inference was wrong - `nodes: 0` only means no blocks were held in memory at
that instant. Every one of the seven above is contiguous and healthy today. The
bar is simply too high.

## What it actually costs

Stated carefully, because the group still works day to day and overclaiming
here would be dishonest.

Peers keep applying new nodes **optimistically**, so members see each other's
events. What is lost is the safety net underneath:

1. **The un-indexed tail can never be compacted.** It only shrinks via a group
   rekey (`project_autobase_history_unreclaimable`), and rekey is itself broken
   (#157). So storage grows without bound.
2. **Recovery paths degrade.** A device that cannot reach a peer holding the
   tail cannot fast-forward from the signed view, because the signed view is
   two thousand entries behind reality.
3. **It fed the drain spin.** `_ensureNodeDependencies` re-queued against
   writers that could not supply the required length and pinned a core at ~106%
   CPU for 16 minutes (`project_autobase_drain_spin`). That specific symptom is
   fixed (#154 / PR #293, delivered to desktop by #158 / PR #297), but the
   condition that provoked it is still here.

## Evidence: `test/harness/indexer-model.js`

Deterministic, no devices, no display. Six scenarios; A-D existed, **E and F
are added by this proposal**.

| | Question | Result |
|---|---|---|
| **A** | All-indexers, one device goes quiet - does the signed view freeze? | **YES**, `indexed 14` and stays 14 while `length` reaches 46 |
| **B** | Non-indexer writers - does it keep advancing? | **YES**, `indexed 24 -> 44`, tracks length exactly |
| **C** | Does `removeWriter` un-stick an already-frozen base? | **NO**, `indexed 14 -> 14` |
| **D** | Does shipping the update repair an already-frozen base? | **NO**, `indexed 16 -> 16`. The indexer set lives in the base's own history; an update cannot retroactively demote anyone |
| **E** | Does a frozen view starve a *freshly paired* device? | **NO**. Owner and newcomer both see 25 entries with 50 stranded. The newcomer applies the un-indexed tail optimistically from a peer that holds it |
| **F** | Under the fix, the sole indexer goes away - what then? | Member can still **author** writes, but `indexed 14` never moves again. **This is the blocker** |
| **G** | Does redundancy appear at 2 indexers, or 3? | **3.** 2-lose-1 frozen; **3-lose-1 keeps signing**; 3-lose-2 frozen |
| **H** | Can a survivor hand indexer rights to itself after the sole indexer is gone? | **NO.** `system.indexers` changes optimistically (1 -> 2 -> 1) but `linearizer.indexers` stays 1 and `indexed` stays pinned at 14. Both orderings tried |

**E is a correction.** Before running it I expected a frozen view to be the
explanation for the 2026-08-07 field report ("you can see the group, but thats
it. No dates."). It is not. That report is much better explained by the missing
Autobase patches on the desktop build (#158), which wedged the apply loop
before it linearized any events - the same wedge reproduced on Tim's own
desktop, which recovered fully and showed all 128 events once patched.

### Two harness defects found and fixed while adding G

Both would have sent this proposal the wrong way, and one had already produced
a "FIX VALIDATED" that had not been earned.

1. **The harness used Autobase's default `ackInterval` of 10,000ms while
   `src/bare.js` uses 1,000.** An indexer only signs a majority into place via
   that background ack, so every scenario that settled for under 10s reported
   `FROZEN` for a base that was merely still waiting to ack. Aligned to 1,000.
2. **The pass criterion was "did `indexedLength` move?"** It moves anyway,
   working through history a departed device had already acked before leaving.
   Under the corrected ack interval that turned scenario A into a false PASS.
   The opposite bar, "did it reach `length`?", is a false FAIL - the newest
   nodes are always unsigned until the next ack round even on a healthy base.
   The criterion is now: **was any work authored AFTER the loss signed?**

With both corrected, A/B/C/D land where they did before, so the earlier
conclusions survive - but they survive on evidence rather than on luck.

## How many indexers, then?

"Fewer" is the right direction but the wrong frame. The rule is that a
**majority of the declared indexers must be reachable**, so what matters is
whether a majority is attainable, not the count itself.

`test/harness/indexer-quorum-math.js` computes the instantaneous probability
that a majority is online, given per-device uptime `p`:

```
indexers | majority | can lose |   phone   |  phone   |  laptop  |always-on
                                  p=0.30     p=0.50     p=0.70     p=0.99
       1 |        1 |        0 |     30.0% |    50.0% |    70.0% |    99.0%
       2 |        2 |        0 |      9.0% |    25.0% |    49.0% |    98.0%
       3 |        2 |        1 |     21.6% |    50.0% |    78.4% |   100.0%
       5 |        3 |        2 |     16.3% |    50.0% |    83.7% |   100.0%
       7 |        4 |        3 |     12.6% |    50.0% |    87.4% |   100.0%
```

Three things fall out, and the third is the one that matters:

1. **Even counts are strictly worse than the odd count below them.** Majority of
   2 is 2, same as majority of 3, so a second indexer adds a thing that can fail
   and buys nothing. Confirmed in G: 2-lose-1 is frozen.
2. **Redundancy starts at 3**, not 2. Confirmed in G: 3-lose-1 keeps signing.
3. **The 50% threshold decides the direction.** Above 50% per-device uptime more
   indexers is better; below it fewer is. Phones are far below it. **So the real
   defect is not the count, it is that the indexers are phones.** With always-on
   indexers you would want 3; with phones you want as few as possible.

Caveat on the table: it is an instantaneous snapshot, and the signed view only
has to advance *eventually*. Over a whole day a 3-of-which-2-needed set overlaps
far more often than 21.6% suggests, so this understates counts above 1. It is
directionally right, not a service-level prediction.

### The four options

| | Availability with phones | Survives losing a device | Needs new design |
|---|---|---|---|
| **A. Everyone (today)** | worst, and degrades as the group grows | in principle yes | none |
| **B. Owner only** | best | **no - permanent** | handoff |
| **C. Fixed set of 3 members** | worse than B | one | handoff + a fork-safe selection rule |
| **D. Owner + always-on keyed device** | best, and stays best | yes | seeder must hold the group key |

**A - everyone is an indexer (today).** For: no migration, no fork risk, no
privileged device, and authority is everywhere. Against: the bar rises with
every device that ever pairs and can never be lowered again - C says
`removeWriter` will not demote, D says an update will not either. Availability
gets *worse* as a group grows, which is backwards. Tim's group is at 7 signers
and 96% unsigned.

**B - owner only.** For: highest availability of any phone-based option,
simplest rule, every peer derives it identically from the bootstrap key, and the
signed view tracks reality so history can finally be compacted. Against: a
single point of failure with a permanent failure mode - F measured it, the
remaining members keep writing and nothing is ever signed again. Also puts all
the indexing work on one phone.

**C - a fixed set of three member devices.** For: real redundancy, survives one
loss, and stays bounded as the group grows. Against: for phones it is *worse*
than B on availability, because two must be awake instead of one; it still dies
on two losses; and it needs a selection rule every peer computes identically
from the view or it forks. "Which three" is a policy decision with security
weight, not a detail.

**D - owner plus an always-on device that holds the key.** For: this is the only
option that fixes the actual problem rather than trading around it. Three
indexers where two are effectively always up puts quorum near 100%, and it
dissolves most of the handoff problem because the always-on device outlives the
phone. Tim already runs the hardware. Against: **that device must hold the
group's encryption key, so it can read the calendar.** Today's seeder is a blind
peer that deliberately cannot (`project_blind_peer_terminology`), so this is a
real privacy change and has to be an informed per-group opt-in, not a default.
It also only helps groups that have such a device, so it is an upgrade on top of
B, never a replacement for it.

**Superseded by scenario H - see "The finding that reverses the recommendation"
above.** This comparison optimised instantaneous availability; H showed quorum
loss is permanent and unrecoverable, which makes tolerance to permanent loss the
objective instead. The recommendation is now three indexers, not owner-only.

## The finding that reverses the recommendation

Scenario H was written to de-risk owner-only. It did the opposite.

```
   before handover:      linearizer.indexers=1 system.indexers=1 indexed=14/24
   after promote-self:   linearizer.indexers=1 system.indexers=2 indexed=14/26
   after remove-owner:   linearizer.indexers=1 system.indexers=1 indexed=14/29
   after reverse order:  linearizer.indexers=1 system.indexers=1 indexed=14/33
```

The promotion op **is** applied - `system.indexers` moves, because `apply()`
runs optimistically. But `linearizer.indexers`, which is what actually decides
signing, never picks it up, because it derives from the **indexed** system
state, and that is frozen. **To change who may sign, the change must itself be
signed.** Nothing can be signed. Both orderings were tried.

So there is no in-band handover. Combined with C (`removeWriter` does not
recover) and D (an update does not recover), the general rule is:

> **Once a group can no longer reach indexer quorum, it can never recover.
> There is no repair from inside the protocol.**

### What that changes

The earlier recommendation optimised for the highest *instantaneous* quorum
probability, which favoured owner-only. That was the wrong objective:

- **Unavailability is temporary.** A quorum that is unreachable right now is
  reached later when devices come online, and the signed view catches up. The
  21.6% in the table is an instant, not an outage.
- **Loss is permanent and unfixable.** A quorum that can never be reached again
  is the end of the group's signed history, forever.

Optimising a permanent, unrecoverable failure against a temporary one is
backwards. The objective is **tolerance to permanent device loss**, and on that
axis owner-only is the *worst* option: it tolerates zero.

And the most likely loss is precisely the one it cannot survive - the owner
replacing, losing or wiping their phone. Worth confirming separately whether a
wipe-and-restore yields a new writer key, because if it does, owner-only breaks
on an ordinary phone upgrade.

### Revised recommendation: three indexers

| indexers | permanent losses survived | quorum reachable (phones) | recoverable if exceeded |
|---|---|---|---|
| 1 (owner only) | **0** | 30% | **never** |
| 2 | **0** | 9% | never |
| **3** | **1** | 21.6% | never |
| 7 (today) | 3 | 12.6%, and measured at 96% unsigned | never |

**Three.** It is the smallest set that survives a permanent loss, and small
enough that quorum is actually reached - unlike seven, which tolerates three
losses on paper and in Tim's real group has signed 4% of history.

This is option C, which the previous revision of this proposal argued against.
That argument was wrong because it weighed the instantaneous number and ignored
that there is no recovery.

**Option D (an always-on key-holding device) is now an upgrade, not an
alternative.** Two indexers is worse than one, so a single always-on device does
not help; owner plus *two* always-on devices, or owner plus one always-on plus
one other member, gives three with two of them effectively permanent. Tim runs
two seeders, so that configuration is available to him - at the cost of those
machines being able to read the calendar.

### Still open

Choosing "three" needs a policy, which is worked out below under "The selection
rule". It turned out to be a smaller problem than this paragraph originally
claimed - see the retraction there.

## The selection rule

### First, a retraction: there is nothing to derive

The previous revision called this the blocking problem - "every peer must derive
the same three from the view or the group forks". That was wrong, and it made
the work look harder than it is.

**The indexer set is already explicit state.** It is whatever `addWriter` and
`removeWriter` ops are in the log. Peers do not *compute* it, they *replay* it,
exactly as they do today. So there is no distributed computation to diverge and
no fork risk from disagreement about who should be an indexer.

What is needed is not a derivation rule but a **local policy for when one device
appends a promotion**. That is a much smaller problem.

### What the mechanics permit (`test/harness/indexer-rule.js`)

```
=== I (sequential 1->2->3) ===          === I (atomic 1->3) ===
  after joins (plain writers): 1          after joins:        1
  after promoting ONE:         2          after promotion(s): 3
  after promotion(s):          3          => reached 3: YES | still signing: YES
  => reached 3: YES | signing: YES

=== J: lose one of three, then replace it ===
  3 minus 1 (majority 2):  indexers=3  => 2 of 3 still signs: YES
  after atomic swap:       indexers=3  => back to 3: YES | signing: YES
```

Three indexers can be established, survive a loss, and have the loss replaced
without the declared set ever dipping to two.

### The policy

1. **The declared set is only ever 1 or 3. Never 2.** Two is strictly worse than
   one - same majority requirement, one more thing that can fail. A calendar
   stays at one until it can go straight to three. I shows a single batched
   append does exactly that, and that the sequential path also works provided
   both candidates are online while it happens.

2. **Only one device proposes.** The owner while present; otherwise the
   surviving indexer with the lowest writer key. This is the one genuine hazard
   in the whole design: two indexers each promoting a different replacement
   yields four declared, majority three, which is worse than the state they were
   trying to fix.

3. **Promote only a candidate that is connected and acking right now**, and that
   has been a member for a stability window. Prefer always-on devices, then
   desktops, then phones. Per the 50% threshold, an indexer that is rarely up
   actively harms the group.

4. **Replace, never shrink.** When an indexer has been unreachable beyond a long
   window, append promote-replacement and remove-departed as ONE batch, so the
   declared set never passes through two. J verifies this.

5. **Never propose while quorum is currently unreachable.** H shows the op
   cannot take effect, so it would be noise at best.

6. **Surface the margin.** At three you can lose one, and the moment you are
   down to two reachable the calendar is one device away from being permanently
   unfinalisable with no recovery. The #155 sync-health banner already exists
   and is the natural place to say so.

Bootstrap follows from rule 1: a solo calendar has one indexer and is correct
and stable; a two-device calendar stays at one; three or more eligible devices
jump to three. The personal base (linked devices) takes the same policy.

## Existing groups are NOT doomed

The previous revision said installs already in this state need a rebuild, on the
strength of C, D and H. That was too pessimistic, and scenario K shows why.

```
=== K: repair a 7-indexer group down to 3, in one coordinated moment ===
   today: everyone an indexer     indexers=7 indexed=97/111
   3 of 7 asleep (need 4):        indexers=7 indexed=123/135
   => still signing with 4 of 7 awake: YES
   repairing: removing 4 indexers in one batch
   after the repair batch:        indexers=3 indexed=152/157
   after repair + a further loss: indexers=3 indexed=171/175
   => repaired set still signs: YES
```

H's rule was "a group that **cannot reach quorum** can never recover". That is
still true. But an over-indexed group is not necessarily past that point - it is
merely a group whose quorum is rarely assembled, not never. **If a majority of
the current indexers can be brought online together ONCE, a single batched
removal takes the set down to three and the group is permanently healthy after.**

For Tim's calendar that means 4 of the 7 devices online at the same moment, once.
Two of the seven are his own, so it needs two other households to open the app at
an agreed time. That is a coordinated moment, not a rebuild, and it keeps the
history, the members and the invites.

This is a far better answer than #156's "create a fresh group and move every
event across", and it should be folded into that item.

**Caveat, and it decides who can be helped:** this only works while a majority
is still assemblable. A group that has genuinely lost that many devices for good
is past recovery, and there is no way back. The repair should therefore be
offered early and prominently rather than held as a last resort - every device
that leaves makes it less likely to be possible.

## Confirmed on real hardware, 2026-08-07

Everything above rests on a deterministic harness. This section is the same
questions asked of three real peers: the TCL (arm64 phone), an Android emulator
(x86_64, this box) and Tim's Pixel 9 - three separate machines, joined to one
throwaway group over a real network. Counts read from each device's own store.

**Every paired device really does become an indexer.** Watched live as the group
grew:

```
2 members (TCL + emulator)          INDEXERS: 2  -> majority needed to sign: 2
3 members (+ Pixel)                 INDEXERS: 3  -> majority needed to sign: 2
```

Two members lands exactly on the degenerate case the proposal warns about -
majority of 2 is 2, both must be online, zero redundancy.

**Three indexers tolerate losing one - scenario G, now on hardware.** With all
three joined, the emulator's app was force-stopped and an event was then created
on the TCL:

```
at the moment of loss   length 73   indexed 57
after the loss          length 81   indexed 77   <- signed PAST 73
```

The signed view advanced past the point of loss, so work authored *after* a
device went away was still finalised by the remaining two. The Pixel also
received the event (`[APPLY] event put incoming ... win: true`), so ordinary
sync continued throughout. Under the old 2-indexer shape the same loss would
have frozen it, which is scenario A.

**The even-number penalty, also on hardware.** Tim's iPhone SE later joined the
same group, taking it to four real machines:

```
3 members (TCL, emulator, Pixel)   INDEXERS: 3  -> majority needed to sign: 2
4 members (+ iPhone SE)            INDEXERS: 4  -> majority needed to sign: 3
```

Adding a fourth device made the group **less** resilient, not more - three must
now be online where two sufficed. That is the arithmetic in the table above
happening to a real calendar, and it is the clearest demonstration of why "more
indexers is safer" is exactly backwards below the 50% uptime threshold.

**Two more field instances found incidentally**, both on the TCL:

```
TCL owner    members: 2   INDEXERS: 3   indexed 24 / 253   <- 90% unsigned
SyncProof    members: 2   INDEXERS: 2   indexed 176 / 182
```

`TCL owner` is a two-member group carrying three indexers, presumably from a
linked device, and it has signed 9% of its history. This is not confined to
Tim's large calendar.

**The negative half too - losing TWO of three freezes it.** Tim took the Pixel
offline himself so this could be run. With the emulator also stopped, one of
three alive, an event was created on the TCL:

```
baseline, all three alive   length 109   indexed 105
after losing two            length 127   indexed 109   <- stuck AT the loss point
```

Note the signed length *did* move, 105 -> 109. It advanced only as far as work
already acknowledged before the loss and then stopped dead, 18 entries stranded.
That is the exact signature the harness criterion was rebuilt to detect, and
seeing it reproduce on hardware validates the criterion as well as the model.

**And it recovers when quorum returns.** Restarting the emulator - back to two of
three - resumed signing immediately:

```
after one peer returns      length 145   indexed 133   <- past the frozen 109
```

This is the load-bearing evidence for the argument that reversed this proposal's
recommendation: **unavailability is temporary and catches up, permanent loss is
not.** A group below quorum is paused, not destroyed, and resumes the moment
enough devices are back. What cannot be undone is losing the devices for good.

### Not tested on hardware, and why

**The iPhone Simulator cannot be a peer at all.** It was joined to the group as
a fourth device and never connected to the other three - zero worklet network
output in 50s, no new writer seen on any Android device over ~6 minutes. That is
the documented limitation in rules 7 and 15 (a Simulator is not a separate host
for discovery or holepunching), not a defect. Any future multi-peer work needs
real devices.

## Scope

**Changes:** the two `addWriter` call sites pass `{ indexer: false }`. The
bootstrap device (personal base: the first device; group base: the owner) stays
an indexer by construction, so majority becomes 1.

**Does not change:** invite format, swarm topics, encryption, Hyperbee key
layout, IPC shapes, who may *write*. A plain writer has exactly the same write
authority as today. Removal and blocking semantics are untouched.

**Now in scope, on the strength of K:** repairing already-affected groups, by
batch-removing surplus indexers during one coordinated moment while a majority
can still be assembled. This supersedes the earlier claim that those installs
need a rebuild. It belongs with #156 and is NOT blocked on #157.

## Compat

This is the part that closed PR #291, and it has two halves.

### Halves that must not be conflated

**Divergence.** An old peer applying `{ addWriter: k }` grants an indexer; a new
peer applying the same op grants a plain writer. Two peers producing different
system views from the same op is a fork. So the rollout **must not** be "change
the constant and ship":

1. **Release N:** teach apply to *read* an explicit `indexer` field on the op,
   defaulting to `true` when absent. Behaviour unchanged. Nothing writes the
   field yet.
2. **Release N+1**, once installs have rolled past N: start *writing*
   `{ addWriter: k, indexer: false }`. Old peers ignore the unknown field and
   still grant an indexer, so they diverge - which is why N must land first and
   be given time.

Gating on a per-group version field read from the view is **not** viable: the
group record is produced by apply, so apply cannot depend on it without a
circularity.

### The handoff gap (scenario F)

With the owner as sole indexer, majority is 1 and nothing can freeze - but if
that device is lost the group can never sign again. F confirms this: the
remaining member writes happily and `indexedLength` never moves.

Today's all-indexers behaviour is, in this one narrow respect, more forgiving.
That is the honest trade and it is why this proposal does **not** recommend
shipping the two-line change on its own.

**Blind seeders cannot backstop the quorum.** An indexer must run `apply()` and
produce the view, which needs the group's encryption key. A blind peer
replicates ciphertext it deliberately cannot read
(`project_blind_peer_terminology`), so Tim's two always-on seeders can hold and
serve every block but can never sign one. Any handoff has to move authority
between *members*.

## Verify

- `test/harness/indexer-model.js` - all six scenarios, expected results as
  tabulated above.
- A new scenario **G** before implementation: two peers, one on release N and
  one on N+1, applying the same `addWriter` op. Assert their system views agree.
  If G fails the staged rollout is wrong and this proposal is wrong.
- `npm run verify` (392 tests).
- Real-device pairing on the TCL against the emulator: pair, confirm the new
  device is `writable`, confirm `indexers.length` stays 1, confirm events sync
  both directions.

## Rollback

Release N is behaviour-preserving, so it rolls back by reverting the commit.

Release N+1 is **not** cleanly reversible: writers already granted as
non-indexers stay non-indexers, because the grant is in the base's own history
(same reason as D). Reverting the code restores the old behaviour for *future*
grants only. Before N+1 ships, we should be able to state what a group looks
like if we have to stop halfway - a mix of indexers and plain writers, with
majority computed over the indexers only, which is still strictly better than
all-indexers.

## Open questions

1. **Who holds indexer authority after the owner?** The obvious hook is the
   existing ownership-transfer path (`claimOwnership`, and TODO #3's "claim
   ownership after 30d inactivity"), promoting the new owner to indexer as part
   of the same authenticated op. Needs the same owner-auth treatment as the
   other self-destructive control messages (`project_self_destruct_guards`).
2. ~~Should there be more than one indexer on purpose?~~ **Answered above.**
   Yes, but only if the extras are always-on - below 50% per-device uptime more
   indexers is strictly worse. Hence option D. Remaining sub-question: is a
   key-holding seeder an acceptable privacy trade to offer, and how is that
   consent presented?
3. **What do the four UNIDENTIFIED writers in Tim's group represent?** They have
   no `writerIdentity` record, and one identity is not on the member list at
   all. Worth resolving before designing promotion, since a promotion rule
   cannot rank writers it cannot name.
4. **Do already-affected groups get a repair, or only new groups get the fix?**
   Currently the latter by default, since C and D both say no. Folding a repair
   into #156 is the alternative, and it is blocked on #157.

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

### Still open, and now blocking

Choosing "three" is not yet a design. Every peer must derive the same three from
the view or the group forks, and the rule has to handle members joining and
leaving. That selection rule is the remaining work, and it is a harder problem
than the two-line change this branch started from.

## Scope

**Changes:** the two `addWriter` call sites pass `{ indexer: false }`. The
bootstrap device (personal base: the first device; group base: the owner) stays
an indexer by construction, so majority becomes 1.

**Does not change:** invite format, swarm topics, encryption, Hyperbee key
layout, IPC shapes, who may *write*. A plain writer has exactly the same write
authority as today. Removal and blocking semantics are untouched.

**Explicitly out of scope:** repairing already-affected groups. D says an update
cannot, and C says `removeWriter` cannot. Those installs need a rebuild, which
belongs with #156 and is blocked on #157.

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

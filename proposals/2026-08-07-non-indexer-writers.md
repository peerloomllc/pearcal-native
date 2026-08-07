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

**E is a correction.** Before running it I expected a frozen view to be the
explanation for the 2026-08-07 field report ("you can see the group, but thats
it. No dates."). It is not. That report is much better explained by the missing
Autobase patches on the desktop build (#158), which wedged the apply loop
before it linearized any events - the same wedge reproduced on Tim's own
desktop, which recovered fully and showed all 128 events once patched.

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
2. **Should there be more than one indexer on purpose?** Two or three, chosen
   from the most active members, gives redundancy at a majority of 2. That is
   still far below 4-of-7 and survives one loss. It needs a selection rule that
   every peer computes identically from the view, or it forks.
3. **What do the four UNIDENTIFIED writers in Tim's group represent?** They have
   no `writerIdentity` record, and one identity is not on the member list at
   all. Worth resolving before designing promotion, since a promotion rule
   cannot rank writers it cannot name.
4. **Do already-affected groups get a repair, or only new groups get the fix?**
   Currently the latter by default, since C and D both say no. Folding a repair
   into #156 is the alternative, and it is blocked on #157.

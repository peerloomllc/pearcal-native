# 2026-04-24 — Fork A: deterministic personal-base discovery + blind-peer hosting

## Goal

Make "restore from seed words" actually recover a user's personal calendar data when no sibling device is live, by giving every identity a deterministically-discoverable personal Autobase that a trusted blind peer pins and replicates on their behalf.

## Tier

**T3.** New wire protocol (blind-peer anchor RPCs), new key-management derivation path off the mnemonic, new auth gate (identity-signed addWriter), and it changes the trust boundary of the blind peer (today pure replicator; after this, also an admission oracle for writer admission into identity-scoped Autobases).

## Scope

### In

- **Identity-derived pointer keypair.** Add a `personalAnchorKeyPair` derivation off the mnemonic via a PearCal-scoped HKDF context. Its public key (`personalAnchorPublicKey`) is the anchor lookup key on blind peers — kept distinct from `identityPublicKey` so an attacker who learns the latter (via shared-group metadata) cannot enumerate anchors. The secret key signs anchor writes and addWriter authorizations.
- **Anchor registry on blind peer.** Extend the seed-peer code (Mac Mini `~/pearcal-seed/`) with a small signed-key-value store: `anchors:{personalAnchorPublicKey} → {bootstrapKey, createdAt, signature}`. Two RPCs (`getAnchor`, `putAnchor`) on the existing control channel. First-write-wins per identity; subsequent writes require the original anchor's identity signature.
- **Personal-base hosting by blind peer.** Blind peer pins the Autobase referenced by each anchor (`blind.addAutobaseBackground`) so cores remain available when no device is online.
- **Delegated addWriter via blind peer.** Blind peer holds a writer slot on each hosted personal Autobase and appends anchor-signed addWriter ops on RPC (`registerWriter`). Each device's personal-base apply function verifies the anchor signature against the expected `personalAnchorPublicKey` before admitting the new writer, so a compromised blind peer cannot grant write access without a valid signature from the identity's mnemonic.
- **Client-side discovery flow.** On boot, if `personalMeta:bootstrap` is missing, compute `personalAnchorPublicKey` from mnemonic → RPC blind peer for anchor → if found, open Autobase; if not found, create one and publish anchor. On first write from a newly-restored device, RPC `registerWriter` before attempting appends.
- **Publish-on-upgrade.** Already-paired installs that have a random `personalMeta:bootstrap` but no anchor yet publish their anchor on first boot of the new code, so subsequent mnemonic restores work.

### Out (deferred to later PRs)

- At-rest encryption of personal-base contents on blind peer (V1 accepts that the blind peer can read calendar data in plaintext — same trust model as today's group hosting).
- Multi-blind-peer redundancy (V1 is single blind peer; user configures one, loses data if it's down permanently).
- Anchor portability between blind peers (V1 anchor is keyed to one blind peer; migrating users to a different peer is a future UX).
- Identity rotation / mnemonic re-derivation (Fork B follow-up territory).
- Blind-peer quota enforcement by identity (V1 trusts well-behaved clients).

## Compat

**Old clients (no Fork A):**
- Never query anchor RPCs, never publish anchors. Behaviour unchanged — pair-based multi-device still works.
- Cannot be recovered from mnemonic alone. Acceptable: users see recovery only after upgrading.

**Old blind peer (no anchor registry):**
- New clients detect absence of anchor RPC via feature probe and fall back to pair-based flow with a warning toast ("Mnemonic-alone recovery not available — update your blind peer").

**Migration path (already-paired installs):**
- On first boot of the new code, if `personalBase` is open and no `personalMeta:anchorPublished` flag is set, compute anchor → `putAnchor` → flip flag. One-shot, idempotent.

**Data-model additions (all additive, no old-code readers to break):**
- Local DB: `personalMeta:anchorPublished`, `personalMeta:forkAVersion`.
- Personal-base apply: new recognised field `identitySignedAddWriter` on addWriter ops. Old code ignores unknown fields, so a new-code sibling's signed addWriter still carries the plain `addWriter` field for legacy clients.
- Blind peer: new `anchors:` keyspace, new RPC methods — purely additive.

## Rollback

**Client-side kill switch.** Gate all anchor RPC + identity-signed addWriter behaviour behind `forkAEnabled` flag in `app.json` (hardcoded, shippable as a no-release client-only toggle). Default: off in first release build. Flip on after blind-peer side is deployed and smoke-tested. If the anchor RPC path wedges, cut a point release with the flag back off — clients fall back to pair-only flow. Anchors already written to blind peer are harmless (they can be read or overwritten later).

**Server-side rollback.** Seed-peer anchor store is a flat `anchors.json` alongside `groups.json`. To roll back, stop the service, rename the file, unload the new RPC handlers (config flag on seed peer). Clients see "no anchor found" and fall back.

**RCA readiness.** Log (on seed peer): anchor hit/miss rate, signature verification failures, `registerWriter` latency p50/p99. Log (on client): anchor lookup result, bootstrap-key mismatch between anchor and local state. First-hit of any of: forged anchor signature from a known identity, anchor conflict (two distinct bootstrap keys for one identity), or >5% `registerWriter` failure rate triggers an RCA at `pearcal-native/rca/`.

## Phased delivery

1. **Phase 1 — Anchor read path.** Seed peer RPC + client boot-time discovery. New devices restored from mnemonic can READ personal data via blind peer. Write still requires a live sibling. Ship behind flag.
2. **Phase 2 — Delegated addWriter.** Seed peer as writer slot + identity-signed addWriter verification in apply. New devices can WRITE without a live sibling. Flip flag on.
3. **Phase 3 — Migration & UX polish.** Upgrade-publish of anchors for existing installs; Profile screen shows anchor status ("Cloud backup: active on {blind peer}"); error states for anchor not found vs RPC unreachable.

## Open design questions

- **Anchor write conflicts.** If two devices lose connectivity to the blind peer and both try to initiate an anchor, the blind peer sees two conflicting `putAnchor` calls. First-write-wins means device #2's personal Autobase is orphaned. Resolution: device #2 detects `putAnchor` → "already exists" response, compares its local bootstrap to the anchor's bootstrap, and if different, initiates a personal-base-level merge (append its own events into the winning Autobase). V1: refuse and surface an error to the user — rare enough in practice (requires concurrent first-init) that we can punt.
- **Anchor rewrites.** Should an anchor ever be re-written after creation? Use case: user wants to migrate personal base between blind peers, or a compromised bootstrap needs rotation. V1: no rewrites. Revisit when we have multi-blind-peer.
- **Blind peer's own writer slot as compromise vector.** Blind peer has append capability on every hosted personal Autobase. A compromised blind peer can append arbitrary bytes (subject to apply's identity-signed addWriter filter). Worst case: bloat-attack / DoS via forced replication. Quota limit enforcement is V1.1.
- **Which blind peer?** V1 assumes the user has already configured a blind peer key (today's Settings → Seed Peer). Users who haven't configured one get today's behaviour (no recovery). UX question: default to a PeerLoom-operated blind peer out of the box? Deferred — product decision.

## References

- Constitution §3 (this template)
- `docs/superpowers/plans/2026-04-24-fork-a-personal-base.md` — detailed implementation plan (untracked)
- TODO #11 entry — history of the Fork A deferral
- `docs/research/keet-identity.md:237` — `identityKeyPair` / `profileDiscoveryKeyPair` derivation pattern we're extending
- `src/bare.js:617-630` — existing `initBlindPeering` surface, reuses `blind-peering` npm module

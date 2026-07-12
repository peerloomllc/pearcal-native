# Device-pair `hello` over a reused connection

## Goal
Fix pairing a second personal device stalling when the secondary already shares an open swarm connection with the primary (e.g. both are in the same group). TODO #113.

## Tier
T3 (pairing flow). **No wire change** — the `hello` message shape, handshake, and all pair-channel messages are byte-identical; this only changes *when* the secondary emits its existing `hello`. No migration.

## Problem
The device-pair Protomux channel (`pearcal/device-pair`) is created once per swarm connection, inside `swarm.on('connection')`. Its `onopen` sends the pairing `hello` **only if `_pairSession` exists at onopen time**. When the secondary already has a connection to the primary (shared group), that channel's `onopen` fired at connection-establishment — before the user started pairing — so no session existed and no `hello` went out. `consumePairLink` then arms `_pairSession` and `swarm.join`s the pair topic, but the existing connection is reused (no new `onopen`), so the `hello` never sends and the pair stalls until an unrelated reconnect re-creates the channel. This is the same failure class the `@peerloom/core` `mux.pair` lazy-open cured for group joins (pearlist proposal 2026-07-01-pairing-reused-connection).

(PearCal's `pearcal/writer-announce` group-pairing channel is already robust — single symmetric constant-id channel + re-broadcast — so only the device-pair channel needs this.)

## Scope
- `_pairChannels: Set` of live `pairMsg` senders, one per open device-pair channel. `onopen` adds; `onclose` removes.
- `broadcastPairHello()` sends the `hello` over every open channel, guarded to a secondary mid-pair (`role === 'secondary' && !granted`).
- `consumePairLink` calls `broadcastPairHello()` right after arming `_pairSession` + `swarm.join`, so a reused connection gets the `hello`. The fresh-connection path is unchanged: `onopen` now registers the channel then calls the same helper (equivalent to the prior inline send).

Out of scope: per-(conn,group) tracking / re-open-on-close (core deliberately skipped it too; `createChannel` uses a constant id so there is one channel per connection, and the listener re-registers on any later connection).

## Compat
Byte-identical wire. A new-code secondary simply also emits its `hello` over connections an old-code secondary would have left silent. Old-code primaries handle it normally (it is the same `hello`). Mixed installs are safe both ways.

## Verify
- **No regression (done):** boot + group-join clean on TCL; the connection/pair-channel setup runs on every connection with no error. Happy-path fresh pairing is behavior-equivalent (onopen registers + broadcasts the same `hello`).
- **Reused-connection (needs a two-device trace):** device A (primary, multi-device on) and device B (secondary) both in the same group so they hold an open connection; on B, consume a pair link for A's identity; confirm B becomes a personal-base writer within a few seconds WITHOUT waiting for a reconnect. Trace `broadcastPairHello` → primary `_handlePairHello` → `granted`.

## Rollback
Revert the branch. No persisted state, no wire artifact — `_pairChannels` is in-memory and `broadcastPairHello` only re-sends an existing message.

## Open questions
- Duplicate `hello` if the secondary somehow holds multiple open connections to the primary: harmless — the primary handshake-gates on `_pairSession.handshakeHex` and `granted` is idempotent. Not worth de-duping.

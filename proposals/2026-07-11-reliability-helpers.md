# Reliability-helper backport — wedge/fork/WAL hardening

## Goal
Wire the five pure reliability helpers PearCal predates (already lifted from PearCircle into `src/lib/` on `feature/pearcal-reliability-helpers`, commit `a5d2986`) into the worklet so a corrupt/forked/truncated base can no longer freeze the IPC dispatcher, crash-loop the worklet, self-fork a writer core, wedge cold start on an oversized WAL, or double-open the writer on bring-up. TODO #110.

## Tier
T2. No Hyperbee key/value, IPC message, invite, or swarm-topic change — old-code and new-code peers talk identically, so no migration is needed. Classified T2 rather than T1 because the fork/rewind paths change replication-affecting write behavior on the shared multi-writer Autobase (a self-fork on your own writer core can make a group unsyncable for every member), which is a cross-peer correctness surface on a shipped install base. Mirrors PearCircle's `2026-06-27-fork-conflict-recovery` and `2026-06-03-autobase-append-hang`, which shipped this exact mechanism.

## Background
Audit 2026-07-11 (memory `project_pearcal_core_audit.md`) found PearCal wraps **none** of its 30 `base.append` sites in a timeout, has no fork-conflict seatbelt, no rewind guard, no WAL flush cadence, and guards worklet bring-up with a non-atomic boolean. Each gap has a matching on-device failure already seen in PearCircle. The helpers are proven code; this proposal is the wiring only.

## Scope

### Part 1 — `safeAppend` wraps every awaited append (appendTimeout)
Add a module-level helper in `src/bare.js` mirroring PearCircle `bare.js:2813`:

```js
const { raceAppend, APPEND_TIMEOUT_MS } = require('./lib/appendTimeout')
async function safeAppend (base, op, label) {
  // rewind pre-check (Part 3) runs here first
  const { ok, timedOut } = await raceAppend(base.append(op), APPEND_TIMEOUT_MS)
  if (timedOut) { /* flag group for repair, warn, skip further appends to it */ return false }
  return ok
}
```

Route the **awaited** append sites through it, passing a short `label` for diagnostics. Confirmed sites (`src/bare.js`): 403, 416, 931, 2006, 2014, 2018, 2023, 2029, 2076, 2176, 2182, 2192, 2213, 2219, 2240, 2249, 2275, 2345, 2397, 2521, 2941, 3001, 3226 (group + personal-base writes). Returns a boolean callers already pattern-match on; a `false` means the write did not land and the caller must not assume success (most sites are followed by a `mirrorToLocal`/`emitSync` that becomes conditional).

**Owner writer-admission appends** (`bare.js:1327`, `1418`, `3001` — `base.append({ addWriter })`): shape-agnostic, so `safeAppend` accepts them, but `1418` is currently fire-and-forget (`.catch()`, not awaited). Route it through `safeAppend` without `await` to preserve the non-blocking admission semantics; do not turn it into a blocking call.

### Part 2 — Post-conflict worklet seatbelt (conflictSeatbelt)
Mirror PearCircle `bare.js:210, 2653-2726`:
- Module-level `let _lastConflictAt = 0`.
- Install once at worklet start: `Bare.on('uncaughtException', ...)` + `Bare.on('unhandledRejection', ...)` → `onWorkletFault(err)` which calls `shouldSwallowFault(err, _lastConflictAt, Date.now())`; swallow (log + continue) when true, re-throw/abort when false so real bugs still fail fast with their stack.
- Override `console.log` once at start to run `parseConflictLog(args[0])` on every line and stamp `_lastConflictAt = Date.now()` when it matches hypercore's `conflict detected in <disc>` line, then delegate to the original. This arms the seatbelt source-agnostically (a remote member's fork logs but fires no local `'conflict'` event).
- Attach `core.on('conflict', ...)` per writer core (local + admitted writers) at/after the 4 `new Autobase` sites (`bare.js:1276, 1371, 1884, 1957`, which already carry a sibling `base.on('error')`), stamping `_lastConflictAt`.

### Part 3 — Writer rewind guard (rewindGuard)
Inside `safeAppend`, before `base.append`, when appending to our own writable core: compute `writerRewindStatus({ localLength: base.local.length, networkLength })` where `networkLength = max(peer.remoteLength)` over peers replicating `base.local`. If `behind`, `await base.local.download({ start: downloadFrom, end: downloadTo })` and re-check before appending — never append past a truncated tip. Matches PearCircle `bare.js:2839`.

### Part 4 — WAL flush cadence + compactor reuse (storeFlush)
- `const flushStore = createStoreFlusher({ getStore: () => store, warn: console.warn })` (PearCal's Corestore is the module-level `let store`, `bare.js:76/5891`).
- `setInterval(() => flushStore('interval'), STORE_FLUSH_INTERVAL_MS)` (unref'd), plus a `flushStore('background')` on the existing app-background path, and an opportunistic `flushStore('writer-append')` after writer appends. Bounds the RocksDB WAL so cold-start replay never trips Android's ANR watchdog.
- `const compactStore = createStoreCompactor({ getStore: () => store, warn: console.warn })` and route the three existing raw `store.storage.db.compactRange(null, null, opts)` calls (`bare.js:5682, 5744, 5750`) through it for the coalesce/read-only/error-swallow contract. Existing `blobGarbageCollectionAgeCutoff: 1.0` opts are preserved by keeping those call sites' opts; the helper's default `compactRange()` is used only for the new cadence path (never on cold start).

### Part 5 — Single-writer bring-up lock (backendBootstrap)
In `app/index.tsx`, replace the non-atomic `_workletStarted` boolean (`:30`, checked `:642`, set `:646`) with `makeStartLock`: wrap the worklet bring-up body in `ensureBackendStarted = makeStartLock(async () => { ... })` so a near-simultaneous Activity mount and any headless/resume path await the same in-flight promise and `new Worklet()` + `_worklet.start(...)` run exactly once. `autostartGateValue` is unused (PearCal has no autostart gate yet) and stays dormant.

### Out of scope
- iOS Local Network module (#111), storage retention (#112), device-pair reused-connection fix (#113) — separate items.
- Appends issued from **inside** `apply()` are not wrapped (apply must stay synchronous-ish and is already inside the base's own advance loop); only caller-initiated appends are routed through `safeAppend`.
- No new trace/`mark()` facility — helpers are wired with `warn` only.

## Compat
- No wire change: keys, values, `addWriter` ops, pair messages, invite links, and swarm topics are byte-identical. A new-code peer and an old-code peer replicate and pair exactly as before.
- No persisted-field change and no local schema migration. The seatbelt, timeouts, rewind pull, flush cadence, and start lock are all process-local behavior.
- Mixed installs are safe in both directions. Rolling back to old code on any single device changes nothing other peers can observe.

## Verify
Canonical gate first (`bundle:bare` + `bundle:ui` build clean; PearCal has no unit runner, so the helpers ship with their PearCircle test provenance). Then on-device (Pixel owner + TCL joiner + iPhone), install-over-top (never uninstall):
1. **Happy-path regression** — create group on Pixel, join from TCL and iPhone, add/edit/delete events, RSVP, pair a second device: all must behave exactly as master. No new latency on writes (safeAppend adds only a race wrapper).
2. **Append timeout** — temporarily force one `safeAppend` to see a never-resolving `base.append` (mock). Confirm the dispatcher does NOT freeze: a following `getProfile`/`putEvent` IPC still returns, and the group is flagged for repair, `warn` logged.
3. **Conflict seatbelt** — simulate a fork-conflict `'Closed'` rejection within the grace window (inject a rejected promise after stamping `_lastConflictAt`); confirm the worklet stays alive (no 17x relaunch). Then inject an UNRELATED rejection with no recent conflict; confirm it still aborts (fail-fast preserved).
4. **Rewind guard** — on a writer whose local tip was truncated (or simulate via `networkLength > localLength`), confirm `safeAppend` downloads `[local, network)` before appending and no self-fork line appears in logs.
5. **WAL flush** — confirm the interval flush runs (log), the WAL stays small across a busy session, and cold start after a force-kill is not janky.
6. **Start lock** — trigger a near-simultaneous double bring-up (rapid background/foreground or resume); confirm `new Worklet()` runs once and there is no double writer-open / local-view corruption.

Manual smoke (owner+joiner event sync + reminder fire) on top of the green build.

## Rollback
Each Part is its own commit on `feature/pearcal-reliability-helpers`; revert any Part independently. No data migration to reverse — every change is process-local. Worst case, revert the whole branch and PearCal is byte-for-byte the prior worklet (the helper files can stay in `src/lib/` unused). No peer sees anything.

## Open questions
- Should `safeAppend`'s repair flag trigger an automatic group-store rebuild, or just skip-and-warn until the user reopens? **Start with skip-and-warn** (matches PearCircle); auto-rebuild is a heavier follow-up.
- Flush cadence interval value — PearCircle's `STORE_FLUSH_INTERVAL_MS`. **Adopt the same value** unless device testing shows PearCal's write pattern wants a different one.
- Do the fire-and-forget owner-admission appends (`1418`) need the rewind guard? **No** — they append `addWriter` to the group base, not our own truncated writer tip; rewind only guards self-core appends.

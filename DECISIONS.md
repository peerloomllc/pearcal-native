# DECISIONS

Per-app decision log for PearCal. Append-only, newest on top. See `/home/tim/peerloomllc/CONSTITUTION.md` §4 for the entry format.

## 2026-04-26 — deviceMeta apply skips view.put; row seeded lazily on user rename
Tier: T2
Context: TODO #95 v1 added a `deviceMeta:{writerKey}` keyspace to the personal Autobase for the linked-devices list. Initial implementation seeded each device's row on boot inside `ensurePersonalBase` and put new rows into both the linearized view and local DB. Integration testing on TCL surfaced a recurring `HypercoreError: INVALID_OPERATION: Truncation breaks prologue` from Autobase `_drain` → `ApplyState.undo` → `view.core.truncate`, killing the bare runtime ~7s after open. After much chasing this turned out to be corrupt state in a separate test group's Autobase, not the personal base — recreating the group cleared the crash. But two of the workarounds tried during the chase were kept because they're harmless and reduce blast radius for similar bugs.
Choice: (a) `deviceMeta` apply branch writes only to local DB (`db.put`), not to the linearized view (`view.put`). (b) The local writer's row is appended lazily — first append happens when the user calls `setDeviceNickname`; until then `listLinkedDevices` injects a synthetic placeholder so the UI always shows "This device".
Alternatives considered: keep `view.put` for parity with other apply branches; keep boot-seed for symmetry with `seedIdentityProfileIfNeeded`. Both rejected as net-zero benefit given the tiny data footprint and the soft margin against future Autobase drain weirdness.
Consequences: cross-device sync still converges via apply-on-every-peer; freshly-paired devices learn existing `deviceMeta` rows via writer-hypercore replay (no view fast-path). Other apply branches (event/reminders/note/identityProfile/groupMembership) keep the standard `view.put` pattern. Followup TODO to revisit if and when the Autobase truncate-vs-prologue bug has an upstream fix.


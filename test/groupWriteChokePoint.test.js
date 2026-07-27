// TODO #123 - the choke point is only a choke point if nothing can write past it.
//
// PR #231 routed sixteen local group-record writes through putGroupRecord and
// verified the result by searching for `db.put(NS.groups`. That search returned
// zero, and the conclusion drawn was "every write is guarded". It was wrong: a
// seventeenth write existed in resyncGroup as `db.put(key, mergedGroup)`, where
// `key` came from an Autobase view read-stream and was dispatched on its prefix.
// Textually it looks like any other mirror write, so the audit could not see it,
// it carried no tag, and it could therefore never log a BLOCKED line. It ran on
// every join and on the #124 keyless repair, and it is the site that actually
// destroyed keys in the wild.
//
// A unit test on a pure decision cannot catch that class, because the defect is
// which function was called, not what the function computed. So this test reads
// src/bare.js and enforces the invariant directly on the source. It is the check
// that would have failed in July.
//
// What it can and cannot see, stated plainly: it catches a raw db.put whose key
// is built from NS.groups, and a raw db.put with a variable key inside a
// function that prefix-dispatches on the group namespace (the resyncGroup
// shape). It cannot see a variable key in a function that never mentions the
// namespace at all - nothing short of running the code can. That residue is
// covered by the guard itself, which is why the fix carries the key across AND
// routes through putGroupRecord rather than relying on either alone.
// (bugfix/resync-drops-encryption-key)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { GROUP_KEY_PREFIX } = require('../src/lib/groupRecord.js')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'bare.js'), 'utf8')

// The one function allowed to write the namespace. Everything else must call it.
const CHOKE_POINT = 'putGroupRecord'
// The dispatcher for keys that come out of a read-stream: it is the only other
// place a bare db.put with a variable key is correct, because it is the thing
// deciding, from the key, whether the write is a group record at all.
const DISPATCHER = 'putStreamedRecord'

// Split the source into top-level function bodies. bare.js declares every
// function at column zero, so this is exact rather than heuristic: a body runs
// from its `function` line to the next one.
function topLevelFunctions (src) {
  const lines = src.split('\n')
  const starts = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(lines[i])
    if (m) starts.push({ name: m[1], line: i })
  }
  return starts.map((s, i) => ({
    name: s.name,
    startLine: s.line + 1,
    body: lines.slice(s.line, i + 1 < starts.length ? starts[i + 1].line : lines.length).join('\n'),
  }))
}

// Pull the first argument of every `db.put(...)` in a body, depth-aware so that
// nested calls and object literals do not truncate it, and newline-tolerant
// because several call sites wrap.
function dbPutKeyArgs (body) {
  const out = []
  const needle = 'db.put('
  let idx = body.indexOf(needle)
  while (idx !== -1) {
    let depth = 1
    let i = idx + needle.length
    const from = i
    while (i < body.length && depth > 0) {
      const c = body[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') depth--
      else if (c === ',' && depth === 1) break
      i++
    }
    out.push({ arg: body.slice(from, i).trim(), at: idx })
    idx = body.indexOf(needle, idx + needle.length)
  }
  return out
}

const FUNCTIONS = topLevelFunctions(SRC)

test('bare.js NS.groups matches the prefix the decision module uses', () => {
  // isGroupRecordKey hardcodes the prefix so it stays pure. If bare.js ever
  // renames the namespace, every routing decision here silently stops matching
  // and group writes quietly go raw again.
  const m = /groups:\s*'([^']+)'/.exec(SRC)
  assert.ok(m, 'could not find the NS.groups declaration in bare.js')
  assert.equal(m[1], GROUP_KEY_PREFIX)
})

test('no function builds a group key and writes it with db.put', () => {
  const offenders = []
  for (const fn of FUNCTIONS) {
    if (fn.name === CHOKE_POINT) continue
    for (const { arg } of dbPutKeyArgs(fn.body)) {
      if (/\bNS\.groups\b/.test(arg)) offenders.push(`${fn.name}: db.put(${arg}, …)`)
    }
  }
  assert.deepEqual(offenders, [], `raw group-record writes must call ${CHOKE_POINT}()`)
})

test('no function that dispatches on the group prefix writes with a bare db.put', () => {
  // This is the resyncGroup shape, and the one the original audit was blind to:
  // the key is a variable, so the write mentions no namespace at all, while the
  // branch it sits in is guarded by a group-prefix test a few lines above.
  const dispatches = /isGroupRecordKey\s*\(|startsWith\s*\(\s*NS\.groups|startsWith\s*\(\s*'groups:'/
  const bareIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/
  const offenders = []
  for (const fn of FUNCTIONS) {
    if (fn.name === CHOKE_POINT || fn.name === DISPATCHER) continue
    if (!dispatches.test(fn.body)) continue
    for (const { arg } of dbPutKeyArgs(fn.body)) {
      if (bareIdentifier.test(arg)) offenders.push(`${fn.name}: db.put(${arg}, …)`)
    }
  }
  assert.deepEqual(offenders, [],
    'a function that prefix-dispatches on group keys must route its writes through ' +
    `${CHOKE_POINT}() - a bare db.put(key, …) there cannot tell a group record from any other row`)
})

test('the stream-key dispatcher sends group keys to the choke point', () => {
  // The dispatcher is the only bare db.put with a variable key that is allowed,
  // so it has to actually do the routing that earns the exemption.
  const fn = FUNCTIONS.find(f => f.name === DISPATCHER)
  assert.ok(fn, `${DISPATCHER} not found - rename? update this test`)
  assert.match(fn.body, /isGroupRecordKey\s*\(\s*key\s*\)/, 'it must decide from the key')
  assert.match(fn.body, new RegExp(`${CHOKE_POINT}\\(`), 'and send group records to the guard')
})

test('resyncGroup routes its group-record write through the dispatcher', () => {
  // Positive assertion, so deleting the call is a failure rather than a silent
  // pass of the two negative tests above.
  const fn = FUNCTIONS.find(f => f.name === 'resyncGroup')
  assert.ok(fn, 'resyncGroup not found - rename? update this test')
  assert.match(fn.body, new RegExp(`${DISPATCHER}\\(`),
    'resyncGroup merges the keyless view record over the local one; it must write it through the dispatcher')
})

test('resyncGroup carries the local encryptionKey across the view merge', () => {
  // Belt as well as braces. The guard alone would preserve the key, but it would
  // also log a BLOCKED line on every single resync, turning the one diagnostic
  // that names a culprit into noise. Carrying the key means the guard stays
  // silent unless something is genuinely wrong.
  const fn = FUNCTIONS.find(f => f.name === 'resyncGroup')
  assert.match(fn.body, /encryptionKey:\s*ev\?\.encryptionKey/,
    'the merged record must take the local key, or every resync trips the guard')
})

test('the view append still strips the key it is stripping for', () => {
  // The whole hazard rests on this: view records are keyless, so any merge of a
  // view record over a local one is a key drop unless it says otherwise. If this
  // ever stops being true the reasoning above changes completely.
  const fn = FUNCTIONS.find(f => f.name === 'appendGroupWithAvatarSplit')
  assert.ok(fn, 'appendGroupWithAvatarSplit not found')
  assert.match(fn.body, /encryptionKey:\s*_ek/, 'the key must be destructured out before the append')
})

test('the view append also strips the encrypted latch (TODO #147)', () => {
  // groupRecord.js documents the latch as "deliberately LOCAL-only, never
  // appended to a view", and for a while only the comment said so. The verdict
  // that rests on it - classifyKeylessGroup returning 'certain' - is what tells
  // a device it is the broken one, so it should hold by design rather than by
  // the accident that a keyless device cannot decrypt the view to receive it.
  const fn = FUNCTIONS.find(f => f.name === 'appendGroupWithAvatarSplit')
  assert.match(fn.body, /encrypted:\s*_enc/, 'the latch must be destructured out before the append')
})

test('every view-to-local merge carries the latch across, not just the key', () => {
  // Stripping the latch from the view means a merged record no longer has it
  // while the local one does. Both merge sites compare before writing, so
  // without carrying it they would never compare equal: every mirror and every
  // resync would rewrite the record and emit a change that changed nothing.
  for (const name of ['mirrorToLocal', 'resyncGroup']) {
    const fn = FUNCTIONS.find(f => f.name === name)
    assert.ok(fn, name + ' not found')
    assert.match(fn.body, /encrypted:\s*(existing\?\.value\?\.encrypted|ev\?\.encrypted)/,
      name + ' must carry the local latch into its merged record')
  }
})

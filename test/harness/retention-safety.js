// Can retentionSweep delete a block the engine later needs? (#112 vs #154)
//
// src/bare.js:retainBase keeps the last RETENTION_KEEP_RECENT (256) entries of
// each writer and clears everything older, every 30 minutes:
//
//     const consumed = w.length
//     const upto = consumed - keepRecent
//     if (upto > 0) await w.core.clear(0, upto)
//
// `w.length` is how far the LINEARIZER has consumed that writer. The question is
// whether Autobase can later ask to read a position BELOW that watermark. If it
// can, the rule is unsafe by construction and the 30-minute timer eventually
// finds the case.
//
// This is deliberately a property test, not an attempt to recreate one incident.
// It reproduces the ordinary situation where a peer is offline for a while and
// then appends: its node's heads reference positions from when it last synced,
// which by then may be far behind everyone else.
//
//   node test/harness/retention-safety.js
//
// Reports every block the engine asks for that retention had already deleted.
//
// CONCLUSION 2026-08-06: RETENTION IS EXONERATED, and the run is not even the
// strongest part of the argument. The arithmetic settles it.
//
// The decline that wedged the real device was:
//
//     needs block 576 | that writer has 124 | its core length 17178
//
// `_ensureNodeDependencies` declines when the head writer has not CONSUMED far
// enough (`headWriter.length < rawHead.length`), i.e. 124 < 576. Retention only
// ever clears BELOW the consumed watermark (`0 .. consumed - 256`), and with
// consumed at 124 the rule skips that writer entirely (`upto <= 0`). It cannot
// have removed block 576, because 576 is ABOVE the consumed point and retention
// never touches anything above it. Same reasoning exonerates any other case
// where the needed position is beyond what has been consumed.
//
// So the gap was never a deletion. Those blocks were simply NEVER DOWNLOADED:
// the device had the core's metadata (length 17178) but not its contents, and
// nothing ever asked for them. Autobase fetches lazily as it linearizes, so the
// request that would fill the gap is itself blocked on the gap. That deadlock,
// not any pruning feature, is #154 - and it means the patch's "request the
// missing range" half is aimed correctly.
//
// This run also failed to produce a single decline, so it does not exercise the
// case and cannot support a conclusion on its own. Kept for the instrumentation
// and so the question is not asked a third time.

const Autobase = require('autobase')
const Corestore = require('corestore')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { tmpDir } = require('../helpers/tmpdir')

const KEEP_RECENT = 256          // src/bare.js RETENTION_KEEP_RECENT
const BUSY_APPENDS = Number(process.argv[2] || 900)

const root = tmpDir('retain-')
const open = store => store.get('view', { valueEncoding: 'json' })

// --- instrument: what did retention delete, and what does the engine ask for?
const clearedRanges = new Map()   // coreKeyHex -> [{start, end}]
const asks = []                   // { key, position }

const Writer = require('autobase/lib/writer.js')
const realEnsure = Writer.prototype._ensureNodeDependencies
Writer.prototype._ensureNodeDependencies = async function (boot) {
  const before = this.node && this.node.dependencies ? this.node.dependencies.size : 0
  const head = this.node && this.node.heads ? this.node.heads[before] : null
  const ok = await realEnsure.call(this, boot)
  if (ok === false && head) {
    asks.push({ key: head.key.toString('hex'), position: head.length })
  }
  return ok
}

async function apply (nodes, view, host) {
  for (const node of nodes) {
    const v = node.value
    if (!v) continue
    if (v.addWriter) { await host.addWriter(Buffer.from(v.addWriter, 'hex'), { indexer: true }); continue }
    if (v.key) await view.append({ k: v.key })
  }
}

async function mk (name, key) {
  const store = new Corestore(path.join(root, name))
  await store.ready()
  const base = new Autobase(store, key, { open, apply, valueEncoding: 'json' })
  await base.ready()
  return { store, base }
}

async function settle (list, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    for (const x of list) await x.base.update().catch(() => {})
    await new Promise(r => setTimeout(r, 40))
  }
}

// The exact rule from src/bare.js:retainBase.
async function retainBase (base, keepRecent = KEEP_RECENT) {
  try { await base.update() } catch (e) {}
  let cleared = 0
  for (const w of (base.activeWriters || [])) {
    if (!w || !w.core) continue
    const consumed = typeof w.length === 'number' ? w.length : 0
    const upto = consumed - keepRecent
    if (upto <= 0) continue
    try {
      await w.core.clear(0, upto)
      const k = w.core.key.toString('hex')
      if (!clearedRanges.has(k)) clearedRanges.set(k, [])
      clearedRanges.get(k).push({ start: 0, end: upto })
      cleared += upto
    } catch (e) {}
  }
  return cleared
}

async function main () {
  const a = await mk('a', null)
  const b = await mk('b', a.base.key)

  let s1 = a.store.replicate(true)
  let s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  await a.base.append({ addWriter: b.base.local.key.toString('hex') })
  await settle([a, b], 2500)

  // Both write for a while, so each has real history and each references the
  // other's positions.
  for (let i = 0; i < 60; i++) {
    await a.base.append({ key: 'a-early-' + i })
    await b.base.append({ key: 'b-early-' + i })
  }
  await settle([a, b], 4000)
  console.log('both synced. A consumed-per-writer:',
    [...a.base.activeWriters].map(w => w.length).join(', '))

  // B drops off the network, still knowing the state as of now.
  s1.destroy(); s2.destroy()
  await new Promise(r => setTimeout(r, 400))

  // Life goes on without B, well past the 256 keep-window.
  console.log('B offline; A writing', BUSY_APPENDS, 'more ...')
  for (let i = 0; i < BUSY_APPENDS; i++) await a.base.append({ key: 'a-busy-' + i })
  await settle([a], 5000)

  // A's device runs its 30-minute sweep.
  const cleared = await retainBase(a.base)
  console.log('retention swept', cleared, 'blocks on A')
  for (const [k, rs] of clearedRanges) {
    console.log('   cleared', k.slice(0, 12) + '…', rs.map(r => r.start + '-' + r.end).join(','))
  }

  // B, having been away, now appends. Its heads point at where things were when
  // it last synced - which is now far behind A's watermark.
  for (let i = 0; i < 5; i++) await b.base.append({ key: 'b-return-' + i })

  // B comes back.
  s1 = a.store.replicate(true)
  s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  await settle([a, b], 12000)

  // Did A's engine ask to read anything retention had deleted?
  const violations = asks.filter(q => {
    const rs = clearedRanges.get(q.key)
    if (!rs) return false
    return rs.some(r => q.position > r.start && q.position <= r.end)
  })

  console.log('\n---------------- RESULT ----------------')
  console.log('positions the engine asked for and could not resolve:', asks.length)
  const uniq = new Map()
  for (const q of asks) uniq.set(q.key.slice(0, 12) + '…@' + q.position, (uniq.get(q.key.slice(0, 12) + '…@' + q.position) || 0) + 1)
  for (const [k, n] of [...uniq.entries()].slice(0, 8)) console.log('   ', k, 'x' + n)
  console.log('of those, inside a range retention had DELETED:', violations.length)
  console.log('')
  console.log(violations.length
    ? 'PROVEN: retention deletes blocks the engine later asks to read.'
    : asks.length
      ? 'Declines happened, but none fell inside a swept range. Retention not implicated by this run.'
      : 'No declines at all - this scenario did not exercise the case. Tune it before concluding anything.')

  s1.destroy(); s2.destroy()
  await a.base.close().catch(() => {}); await b.base.close().catch(() => {})
  await a.store.close().catch(() => {}); await b.store.close().catch(() => {})
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(0)
}

main().catch(e => { console.error('harness error:', e); process.exit(1) })

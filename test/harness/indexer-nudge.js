// Autobase stalls on plain-writer entries when a signer is missing (TODO #159).
//
//   node test/harness/indexer-nudge.js
//
// Found by signer-policy-e2e.js: with three signers (owner + two others), one
// signer offline and a PLAIN writer adding entries, the two remaining signers
// never sign those entries. Both decide there is nothing to ack
// (linearizer.shouldAck false, heads=1) and a forced ack changes nothing. The
// entries still replicate and apply, only `indexedLength` stays put.
//
// It ends the moment a signer appends any real value, which is what
// runSignNudgeTick in bare.js does. It never showed while every device was a
// signer, because then every entry is signer-authored.
//
// Expected:
//   stall:   plain-writer entries with one signer gone   -> NOT signed
//   nudge:   a signer appends one entry                  -> signed past them
//   control: same entries written by a signer            -> signed
//   control: every device a signer                       -> signed
const M = '/home/tim/peerloomllc/pearcal-native/node_modules/'
const Autobase = require(M + 'autobase')
const Corestore = require(M + 'corestore')
const os = require('os'), path = require('path'), fs = require('fs')
// Test data goes on disk, not os.tmpdir(): /tmp is a RAM disk on Tim's machine.
// PEARCAL_TEST_TMP overrides.
const testTmp = process.env.PEARCAL_TEST_TMP || path.join(os.homedir(), '.cache', 'pearcal-tests')
fs.mkdirSync(testTmp, { recursive: true })
const root = fs.mkdtempSync(path.join(testTmp, 'nudge-'))
const open = s => s.get('view', { valueEncoding: 'json' })

async function apply (nodes, view, host) {
  for (const node of nodes) {
    const v = node.value
    if (!v) continue
    if (v.addWriter) { await host.addWriter(Buffer.from(v.addWriter, 'hex'), { indexer: v.indexer !== false }); continue }
    if (v.key) await view.append({ k: v.key })
    // { nudge } has no branch, as in bare.js
  }
}
let n = 0
async function mk (name, key) {
  const store = new Corestore(path.join(root, name + '-' + (++n)))
  await store.ready()
  const base = new Autobase(store, key, { open, apply, valueEncoding: 'json', ackInterval: 1000 })
  await base.ready()
  return { name, store, base }
}
function link (a, b) {
  const s1 = a.store.replicate(true), s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)
}
async function settle (bs, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { for (const b of bs) await b.base.update().catch(() => {}); await new Promise(r => setTimeout(r, 80)) }
}
const hex = o => o.base.local.key.toString('hex')
const close = async o => { await o.base.close().catch(() => {}); await o.store.close().catch(() => {}) }

let failed = 0
function check (label, got, want) {
  const ok = got === want
  if (!ok) failed++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label.padEnd(56) + (got ? 'signed' : 'NOT signed'))
}

// Owner + a, b, c. allSign: today's model. Otherwise a and c sign, b is plain.
async function scenario (allSign) {
  const owner = await mk('owner', null)
  const a = await mk('a', owner.base.key), b = await mk('b', owner.base.key), c = await mk('c', owner.base.key)
  const all = [owner, a, b, c]
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) link(all[i], all[j])
  await owner.base.append(allSign
    ? [{ addWriter: hex(a) }, { addWriter: hex(b) }, { addWriter: hex(c) }]
    : [{ addWriter: hex(a), indexer: true }, { addWriter: hex(b), indexer: false }, { addWriter: hex(c), indexer: true }])
  await settle(all, 8000)
  await close(c)
  return { owner, a, b, live: [owner, a, b] }
}
async function writeAndWait (writer, s, tag, ms = 20000) {
  for (let i = 0; i < 3; i++) await writer.base.append({ key: tag + '-' + i })
  const target = s.owner.base.length
  await settle(s.live, ms)
  return s.owner.base.indexedLength >= target
}

;(async () => {
  let s = await scenario(false)
  check('stall: plain writer, one of three signers gone', await writeAndWait(s.b, s, 'plain'), false)
  const target = s.owner.base.length + 1
  await s.owner.base.append({ nudge: Date.now() })
  await settle(s.live, 15000)
  check('nudge: one entry from a signer unblocks it', s.owner.base.indexedLength >= target, true)
  for (const o of s.live) await close(o)

  s = await scenario(false)
  check('control: the same entries written by a signer', await writeAndWait(s.owner, s, 'signer'), true)
  for (const o of s.live) await close(o)

  s = await scenario(true)
  check('control: every device a signer, plain-style write', await writeAndWait(s.b, s, 'allsign'), true)
  for (const o of s.live) await close(o)

  fs.rmSync(root, { recursive: true, force: true })
  console.log('\n' + (failed ? 'FAILED: ' + failed : 'ALL AS EXPECTED'))
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('error:', e.stack); process.exit(1) })

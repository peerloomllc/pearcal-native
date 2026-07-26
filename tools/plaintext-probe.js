// TODO #138 - is any group's data sitting on disk in the clear?
//
// PearCircle proved (its #176/#177) that a join-time race let members write
// their blocks UNENCRYPTED for over a month - readable by anyone replicating
// them, including the blind seeder, which exists precisely because it is not
// supposed to read content. The lesson from that investigation was "prove it
// rather than reason about it": three plausible theories were wrong, and what
// settled it was opening the cores with no encryption key and looking at the
// bytes.
//
// This is that probe for PearCal. It opens every core belonging to a group with
// NO encryptionKey, so hypercore hands back exactly what is stored, and reports
// whether those bytes parse as plaintext. A group that holds an encryption key
// (or whose `encrypted` latch is set) must come back UNREADABLE. Anything
// readable is a live leak.
//
// Read-only: opens cores, reads blocks, never appends and never writes.
//
// Usage:  node tools/plaintext-probe.js [dataDir]
//   dataDir defaults to the Electron desktop profile on this box.
//   env: BLOCKS (default 8) how many blocks to sample per core

const os = require('os')
const path = require('path')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const Hyperbee = require('hyperbee')
const Corestore = require('corestore')

const DATA_DIR = process.argv[2] || path.join(os.homedir(), '.config', 'pearcal-electron', 'pearcal')
const SAMPLE = Number(process.env.BLOCKS || 8)

// A stream cipher's output is indistinguishable from noise, so "does this parse
// as the JSON we write" is a sound plaintext test in both directions: readable
// means unencrypted, unreadable means we could not read it without the key.
// Reported separately from the JSON check so a partially-printable block cannot
// be mistaken for a clean negative.
function classify (buf) {
  if (!buf || !buf.length) return { readable: false, why: 'empty' }
  const s = b4a.toString(buf, 'utf8')
  const t = s.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try { JSON.parse(t); return { readable: true, why: 'parses as JSON', sample: t.slice(0, 90) } }
    catch { /* fall through - looked structured but is not */ }
  }
  let printable = 0
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++
  }
  const ratio = printable / buf.length
  if (ratio > 0.85) return { readable: true, why: 'mostly printable text', sample: s.slice(0, 90) }
  return { readable: false, why: 'binary/ciphertext (printable ' + Math.round(ratio * 100) + '%)' }
}

async function main () {
  const localCore = new Hypercore(path.join(DATA_DIR, 'core'), { valueEncoding: 'json' })
  const db = new Hyperbee(localCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await db.ready()

  // Group records carry the key and the encrypted latch; knownWriter rows carry
  // every peer writer core the device has ever seen for that group. Both are
  // needed - the view core alone would miss the members' own append cores,
  // which is where PearCircle's plaintext actually was.
  const groups = []
  for await (const { value } of db.createReadStream({ gt: 'groups:', lt: 'groups:\xff' })) {
    if (value?.id) groups.push(value)
  }
  const writersByGroup = new Map()
  for await (const { key } of db.createReadStream({ gt: 'knownWriter:', lt: 'knownWriter:\xff' })) {
    const rest = key.slice('knownWriter:'.length)
    const i = rest.indexOf(':')
    if (i < 0) continue
    const gid = rest.slice(0, i)
    const wk = rest.slice(i + 1)
    if (!writersByGroup.has(gid)) writersByGroup.set(gid, [])
    writersByGroup.get(gid).push(wk)
  }

  // readOnly also skips hypercore-storage's CORESTORE device-file check, which
  // otherwise refuses a store copied off the machine that wrote it ("Invalid
  // device file, was modified"). Probing a copy is the normal case here, and a
  // read-only open is what this tool should be doing regardless.
  const store = new Corestore(path.join(DATA_DIR, 'store'), { readOnly: true })
  await store.ready()

  let leaks = 0, checked = 0
  for (const g of groups) {
    const expectEncrypted = !!g.encryptionKey || !!g.encrypted
    const targets = [{ label: 'group bootstrap/view core', key: g.groupKey }]
    for (const wk of (writersByGroup.get(g.id) || [])) targets.push({ label: 'writer core', key: wk })

    console.log('\n=== group ' + g.id + '  "' + (g.name || '?') + '"')
    console.log('    holds key: ' + !!g.encryptionKey + '   encrypted latch: ' + !!g.encrypted +
                '   => expected on disk: ' + (expectEncrypted ? 'CIPHERTEXT' : 'plaintext (legacy group)'))

    for (const t of targets) {
      if (!t.key || t.key.length !== 64) continue
      // No encryptionKey on purpose: hypercore returns exactly what is stored.
      const core = store.get({ key: b4a.from(t.key, 'hex') })
      try {
        await core.ready()
        if (!core.length) { console.log('    - ' + t.label + ' ' + t.key.slice(0, 12) + ': no blocks stored'); continue }
        // Only read blocks this store actually holds. A bare get() on a missing
        // block waits for a peer to serve it, which hangs a probe that is meant
        // to be a pure on-disk question - and would also put the probe on the
        // network, which it must never be.
        const readable = []
        let n = 0
        for (let i = 0; i < core.length && n < SAMPLE; i++) {
          if (!(await core.has(i))) continue
          n++
          let blk = null
          try { blk = await core.get(i, { valueEncoding: 'binary', wait: false }) } catch { continue }
          const c = classify(blk)
          checked++
          if (c.readable) readable.push({ i, ...c })
        }
        if (!n) { console.log('    - ' + t.label + ' ' + t.key.slice(0, 12) + ': ' + core.length + ' blocks known, none held locally'); continue }
        if (readable.length) {
          leaks++
          const verdict = expectEncrypted ? 'LEAK' : 'plaintext (expected for a legacy group)'
          console.log('    - ' + t.label + ' ' + t.key.slice(0, 12) + ': ' + readable.length + '/' + n +
                      ' blocks READABLE with no key  <-- ' + verdict)
          console.log('      block ' + readable[0].i + ' (' + readable[0].why + '): ' + JSON.stringify(readable[0].sample))
        } else {
          console.log('    - ' + t.label + ' ' + t.key.slice(0, 12) + ': ' + n + '/' + n + ' blocks unreadable without the key (good)')
        }
      } catch (e) {
        console.log('    - ' + t.label + ' ' + t.key.slice(0, 12) + ': could not open (' + e.message + ')')
      }
    }
  }

  console.log('\nblocks sampled: ' + checked + '   cores with readable blocks: ' + leaks)
  await store.close()
  await localCore.close()
}

main().catch(e => { console.error('PROBE ERROR:', e); process.exit(1) })

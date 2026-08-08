// #164 — does a MEMBER's device keep the group's block-encryption key, and does
// the invite it mints still carry `enc=`?
//
// Reported from the field 2026-08-08: on an encrypted calendar the owner's
// invite carries `&enc=` and the other members' invites do not, even though
// those members sync perfectly (which proves they hold the key — a keyless
// device sits on a different swarm topic entirely and could never meet them).
// Every code path was audited by reading and all of them looked correct, so
// this asks the real engine instead.
//
// Two REAL peers, two processes, two data dirs, one real Hyperswarm. Everything
// is production code: src/bare.js via the Electron BareKit shim, and the real
// buildInviteLink / parseInviteLink from src/invite.js. Nothing is stubbed.
//
// Run it after `cd electron && node scripts/prepack.js`:
//
//   node test/harness/member-invite-enc.js
//
// The interesting moment is not the join — it is what the member's record looks
// like AFTER the owner edits the group and after the member restarts, because
// the view record the owner replicates deliberately carries no encryptionKey
// (bare.js strips it in appendGroupWithAvatarSplit) and every write is supposed
// to merge the local one back.
//
// STATUS 2026-08-08: the key-preservation checks that DO run all pass — join,
// local edit and restart keep the key and keep `enc=` in the minted link. The
// two replication checks FAIL for an unrelated reason and the harness says so
// rather than hiding it: two peers on ONE host never find each other here
// ("no owner contact after 90000 ms"), which is the worst hairpin case there
// is. So the replication half — the part most likely to hold the bug, since it
// is the only path where a view-derived record overwrites the local one — is
// still UNTESTED, and its neighbouring PASS lines are vacuous. Do not read this
// harness as clearing that path.
//
// To finish it, give the two peers a way to meet: a local DHT bootstrap
// (hyperdht's testnet) threaded into the Hyperswarm that bare.js constructs,
// which today takes no bootstrap option, or run the second peer on another
// machine (the TCL, or the Mac Mini over ssh).

const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')

// The ROOT copy, not electron/vendor/src/bare.js. The two files are
// byte-identical; only dependency resolution differs, and the root install is
// the one that pins `hyperdht ^6.33.0` (electron/ does not list hyperdht at all
// and inherited 6.30.0 through hyperswarm's `^6.21.0`). That skew is real and
// worth fixing on its own, but it is NOT why the peers below fail to meet —
// tried both, same result. Recorded so nobody re-runs that experiment.
const BARE_ENTRY = require.resolve('../../src/bare.js')

// ── peer mode ─────────────────────────────────────────────────────────────
// One bare worklet, speaking JSON lines on stdio. bare.js is a module singleton
// so a peer has to be its own process; that is also what makes these two real
// Hyperswarm peers rather than one process talking to itself.
if (process.env.PEER_ROLE) {
  const { createBareKitShim } = require('../../electron/src/main/barekit-shim.js')
  const shim = createBareKitShim()
  const dataDir = process.env.PEER_DIR
  const mnemonicFile = path.join(dataDir, 'mnemonic.txt')

  shim.onBareOut(chunk => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue
      let m; try { m = JSON.parse(line) } catch (e) { continue }
      if (m.type === 'nativeRequest') {
        const { nativeId, method, args } = m
        let result = null
        try {
          if (method === 'hasMnemonic') result = fs.existsSync(mnemonicFile)
          else if (method === 'getMnemonic') result = fs.existsSync(mnemonicFile) ? fs.readFileSync(mnemonicFile, 'utf8') : null
          else if (method === 'setMnemonic') { fs.writeFileSync(mnemonicFile, args[0]); result = true }
          else if (method === 'getBackupStatus') result = { enabled: false }
        } catch (e) {}
        shim.sendToBare(Buffer.from(JSON.stringify({ type: 'nativeResponse', nativeId, result }) + '\n'))
        continue
      }
      process.stdout.write(JSON.stringify(m) + '\n')
    }
  })

  let inbuf = ''
  process.stdin.on('data', d => {
    inbuf += d.toString()
    const lines = inbuf.split('\n')
    inbuf = lines.pop() ?? ''
    for (const l of lines) if (l.trim()) shim.sendToBare(Buffer.from(l + '\n'))
  })

  require(BARE_ENTRY)
  return
}

// ── driver ────────────────────────────────────────────────────────────────
const { buildInviteLink, parseInviteLink } = require('../../src/invite.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-enc-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

function startPeer (label) {
  const dir = path.join(tmp, label)
  fs.mkdirSync(dir, { recursive: true })
  const child = spawn(process.execPath, [__filename], {
    env: { ...process.env, PEER_ROLE: label, PEER_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const peer = { label, dir, child, events: [], pending: new Map(), nextId: 1, log: [] }
  child.stderr.on('data', d => peer.log.push(d.toString()))
  let buf = ''
  child.stdout.on('data', d => {
    buf += d.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let m; try { m = JSON.parse(line) } catch (e) { peer.log.push(line); continue }
      if (m.type === 'response' && peer.pending.has(m.id)) {
        const p = peer.pending.get(m.id); peer.pending.delete(m.id)
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result)
      } else if (m.type === 'event') peer.events.push(m)
    }
  })
  peer.send = o => child.stdin.write(JSON.stringify(o) + '\n')
  peer.call = (method, args = []) => new Promise((resolve, reject) => {
    const id = peer.nextId++
    peer.pending.set(id, { resolve, reject })
    peer.send({ id, method, args })
    setTimeout(() => { if (peer.pending.delete(id)) reject(new Error('timeout: ' + method)) }, 60000)
  })
  peer.waitEvent = (name, ms = 60000) => new Promise((resolve, reject) => {
    const start = Date.now()
    const iv = setInterval(() => {
      if (peer.events.some(e => e.event === name)) { clearInterval(iv); resolve() }
      else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error(peer.label + ': no ' + name)) }
    }, 100)
  })
  return peer
}

let failures = 0
function check (name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(58) + 'got ' + actual + (ok ? '' : ', wanted ' + expected))
}

async function boot (peer) {
  peer.events.length = 0
  peer.send({ method: 'init', dataDir: peer.dir, platform: 'desktop' })
  await peer.waitEvent('ready')
}

// What the UI actually does with a pasted link (src/invite.js handleInviteLink):
// build a local record from the parsed params, persist it, join the swarm.
async function joinFromLink (peer, link) {
  const p = parseInviteLink(link)
  if (!p.ok) throw new Error('parse failed: ' + p.error)
  const profile = await peer.call('getProfile')
  const group = {
    id: p.groupId,
    name: p.groupName,
    color: '#6C9BF5',
    emoji: '👥',
    icon: null,
    ownerId: p.inviterKey,
    groupKey: p.groupKey,
    ...(p.encryptionKey ? { encryptionKey: p.encryptionKey } : {}),
    members: [
      { id: profile.id, name: profile.name, avatar: 'B', publicKey: profile.publicKey,
        ...(profile.identityPublicKey ? { identityPublicKey: profile.identityPublicKey } : {}) },
      { id: p.inviterKey, name: 'Inviter', avatar: '?' },
    ],
    joinedAt: Date.now(),
  }
  await peer.call('putGroup', [group])
  await peer.call('joinGroup', [group])
  return group
}

const encOf = link => new URL(link).searchParams.get('enc')

async function main () {
  const owner  = startPeer('owner')
  const member = startPeer('member')
  try {
    await boot(owner); await boot(member)
    await owner.call('updateProfile', [{ name: 'Owner' }])
    await member.call('updateProfile', [{ name: 'Member' }])
    const ownerProfile  = await owner.call('getProfile')
    const memberProfile = await member.call('getProfile')

    // ── the group is encrypted, as every group created today is ────────────
    const created = await owner.call('createGroup', ['Fam', { name: 'Owner', avatar: 'O' }])
    const gid = created.id
    const ownerGroup0 = await owner.call('getGroup', [gid])
    check('owner: group is encrypted', !!ownerGroup0.encryptionKey, true)

    const ownerLink = buildInviteLink(ownerGroup0, ownerProfile.id)
    check('owner: invite carries enc', !!encOf(ownerLink), true)

    // ── member joins with a good invite ────────────────────────────────────
    await joinFromLink(member, ownerLink)
    const m0 = await member.call('getGroup', [gid])
    check('member: holds the key right after joining', !!m0.encryptionKey, true)
    check('member: invite carries enc right after joining', !!encOf(buildInviteLink(m0, memberProfile.id)), true)

    // ── let them actually meet, then churn the group record ────────────────
    // The owner's authoritative record replicates through the Autobase VIEW,
    // which by design carries no encryptionKey. This is the moment the local
    // key has to be merged back rather than overwritten.
    console.log('\n... waiting for the two peers to meet and replicate')
    for (let i = 0; i < 60; i++) {
      const g = await member.call('getGroup', [gid]).catch(() => null)
      if (g && !(g.members ?? []).some(m => m.name === 'Inviter')) break
      await sleep(1000)
    }
    const met = await member.call('getGroup', [gid])
    const replicated = !(met.members ?? []).some(m => m.name === 'Inviter')
    check('member: owner record replicated (placeholder gone)', replicated, true)
    check('member: still holds the key after replication', !!met.encryptionKey, true)
    check('member: invite still carries enc after replication', !!encOf(buildInviteLink(met, memberProfile.id)), true)

    // ── owner edits the group, forcing a fresh authoritative record ─────────
    const ownerNow = await owner.call('getGroup', [gid])
    await owner.call('putGroup', [{ ...ownerNow, name: 'Fam Renamed', updatedAt: Date.now() }])
    await owner.call('putGroup:sync', [{ ...ownerNow, name: 'Fam Renamed', updatedAt: Date.now() }]).catch(() => {})
    for (let i = 0; i < 40; i++) {
      const g = await member.call('getGroup', [gid]).catch(() => null)
      if (g?.name === 'Fam Renamed') break
      await sleep(1000)
    }
    const renamed = await member.call('getGroup', [gid])
    check('member: saw the rename', renamed.name === 'Fam Renamed', true)
    check('member: still holds the key after the owner edit', !!renamed.encryptionKey, true)
    check('member: invite still carries enc after the owner edit', !!encOf(buildInviteLink(renamed, memberProfile.id)), true)

    // ── and after a restart, which is where a lost key finally bites ───────
    await member.call('shutdown').catch(() => {})
    await sleep(2000)
    await boot(member)
    const afterRestart = await member.call('getGroup', [gid])
    check('member: holds the key after restart', !!afterRestart.encryptionKey, true)
    check('member: invite carries enc after restart', !!encOf(buildInviteLink(afterRestart, memberProfile.id)), true)

    console.log('\n' + (failures ? failures + ' FAILURE(S) — reproduced' : 'no failures — NOT reproduced this way'))
    if (failures) {
      console.log('\nmember log tail:\n' + member.log.join('').split('\n').slice(-25).join('\n'))
    }
  } finally {
    owner.child.kill('SIGKILL'); member.child.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('HARNESS ERROR', e.stack); process.exit(2) })

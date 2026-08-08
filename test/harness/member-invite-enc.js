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
// STATUS 2026-08-08: NOT REPRODUCED, with the replication half genuinely
// exercised. Run it with the member on a second machine:
//
//   REMOTE_MEMBER=Tims-Mac-mini.local node test/harness/member-invite-enc.js
//
// (sync src/, test/harness/ and electron/src/main/barekit-shim.js there first).
// Two peers on ONE host never find each other - the worst hairpin case there is,
// and it is NOT the hyperdht 6.30.0 vs 6.33.0 skew, both were tried. Across a
// real two-host pair the member keeps the key and mints `enc=` through joining,
// through the owner's authoritative record replicating in, through an owner
// edit, through Resync and through a restart. Resync matters most: it walks the
// VIEW and merges every row back into the local database
// (`resyncGroup:view-merge`, src/bare.js:5732), and view rows carry no
// encryptionKey by construction, so it was the best remaining candidate. It is
// clean.
//
// So a clean-room member does not lose the key. Whatever is happening to the
// real members involves something in their history this does not recreate.
// Worth trying next: a member joining from an invite that never had `enc`, an
// owner that rekeys, a member removed and re-invited, and a group that predates
// encryption entirely.
//
// One quirk to expect: the two "replicated" checks can FAIL on a slow round
// even when replication worked - they poll for a fixed window and the peers
// sometimes meet after it closes. Check the member log tail the harness prints;
// `[APPLY] group put ... win: true` lines mean it did replicate and the failure
// is the timer, not the engine.

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

// A peer runs here, or on another machine over ssh. The remote option exists
// because two peers on ONE host never find each other (see the header) — the
// member has to be a genuinely separate machine for the replication half of
// this harness to mean anything. The Mac Mini is the convenient one: it already
// has the repo and node_modules, so it needs no build and no device.
//
//   REMOTE_MEMBER=Tims-Mac-mini.local node test/harness/member-invite-enc.js
//
// Sync src/, test/harness/ and electron/src/main/barekit-shim.js there first.
const REMOTE_MEMBER = process.env.REMOTE_MEMBER || null
const REMOTE_REPO = process.env.REMOTE_REPO || '~/peerloomllc/pearcal-native'

function startPeer (label, remoteHost, fixedDir) {
  let dir = fixedDir || path.join(tmp, label)
  let child
  if (remoteHost) {
    // `bash -lc` so the remote login profile puts node on PATH (Homebrew node
    // is not on a non-interactive ssh PATH by default).
    const remoteDir = fixedDir || ('/tmp/pearcal-harness-' + label + '-' + process.pid)
    dir = remoteDir   // the dataDir `init` is told must be the REMOTE path
    const cmd = 'mkdir -p ' + remoteDir + ' && cd ' + REMOTE_REPO +
      ' && PEER_ROLE=' + label + ' PEER_DIR=' + remoteDir +
      ' node test/harness/member-invite-enc.js'
    child = spawn('ssh', ['-o', 'BatchMode=yes', remoteHost, 'bash -lc ' + JSON.stringify(cmd)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } else {
    fs.mkdirSync(dir, { recursive: true })
    child = spawn(process.execPath, [__filename], {
      env: { ...process.env, PEER_ROLE: label, PEER_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }
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
  const member = startPeer('member', REMOTE_MEMBER)
  console.log('member runs on: ' + (REMOTE_MEMBER || 'this host (peers will NOT meet — see header)') + '\n')
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

    // ── Resync, the path #123 says destroyed keys for months ───────────────
    // resyncGroup walks the Autobase VIEW and merges every row back into the
    // local database (`resyncGroup:view-merge`, src/bare.js:5732). View rows
    // carry no encryptionKey by construction, so this is the single most
    // likely place for a member's key to be dropped — and it is user-triggered,
    // which fits a bug that shows up on some devices and not others.
    await member.call('resyncGroup', [gid]).catch(() => {})
    await sleep(3000)
    const afterResync = await member.call('getGroup', [gid])
    check('member: holds the key after Resync', !!afterResync.encryptionKey, true)
    check('member: invite carries enc after Resync', !!encOf(buildInviteLink(afterResync, memberProfile.id)), true)

    // ── and after a restart, which is where a lost key finally bites ───────
    // The peer process ends with its shutdown (over ssh, the connection closes
    // with it), so restarting means respawning against the SAME data dir.
    await member.call('shutdown').catch(() => {})
    await sleep(2000)
    member.child.kill('SIGKILL')
    const revived = startPeer('member', REMOTE_MEMBER, member.dir)
    await boot(revived)
    const afterRestart = await revived.call('getGroup', [gid])
    check('member: holds the key after restart', !!afterRestart.encryptionKey, true)
    check('member: invite carries enc after restart', !!encOf(buildInviteLink(afterRestart, memberProfile.id)), true)

    console.log('\n' + (failures ? failures + ' FAILURE(S) — reproduced' : 'no failures — NOT reproduced this way'))
    if (failures) {
      console.log('\nmember log tail:\n' + member.log.join('').split('\n').slice(-25).join('\n'))
    }
  } finally {
    owner.child.kill('SIGKILL'); member.child.kill('SIGKILL')
    if (REMOTE_MEMBER) {
      try { require('child_process').execSync('ssh -o BatchMode=yes ' + REMOTE_MEMBER + " 'rm -rf /tmp/pearcal-harness-member-*'") } catch (e) {}
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('HARNESS ERROR', e.stack); process.exit(2) })

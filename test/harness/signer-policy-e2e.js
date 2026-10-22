// Does the signer policy (TODO #159 release N+1) work in the REAL engine?
//
// Four copies of src/bare.js, each in its own process (BareKit is a
// singleton), on a private local DHT so nothing depends on NAT or the internet
// (TODO #133). Production code throughout; the one thing faked is the passage
// of time, by backdating timestamps in a stopped peer's real database the way
// sync-health-e2e.js does.
//
// Run it from the repo root:
//
//   node test/harness/signer-policy-e2e.js
//   STOP_AFTER_4B=1 node test/harness/signer-policy-e2e.js   (skips step 5)
//
// Checks:
//   1. Three members join an owner's calendar as PLAIN writers: one signer.
//   1b. Owner and cal are firewalled from each other for the rest of the run;
//      the owner still sees cal as online through ana and ben.
//   2. Once they have been around past the stability window, the owner
//      promotes two in one batch: three signers, and every peer agrees.
//   3. Reconnecting does not undo it (no re-grant on announce).
//   4. The calendar still signs new entries with three signers.
//   4b. With one promoted signer stopped, the other two still sign.
//   5. The owner disappears for two weeks. A member who signs stands in and
//      swaps the owner's device for the member who did not sign, and the
//      calendar keeps signing without the owner.

const { createEngines } = require('./engines.js')

const DAY = 24 * 60 * 60 * 1000

main().catch(e => { console.error('harness error:', e.stack); process.exit(1) })

// ---------------------------------------------------------------- orchestrator

async function main () {
  const E = await createEngines({ prefix: 'signer-e2e' })
  const { peers, launch, stop, backdate, check, until, finish } = E
  const info = async (name, gid) => (await peers[name].call('listGroups')).find(g => g.id === gid)?.indexers


  await Promise.all(['owner', 'ana', 'ben', 'cal'].map(launch))
  console.log('four engines up\n')

  const group = await peers.owner.call('createGroup', 'SignerTest', {})
  const gid = group.id
  // Join the way the app's invite flow does (App.jsx): save the group record,
  // key included, THEN join. joinGroup alone opens the base with the key but
  // never stores it, so a member restarted later comes back keyless, on the
  // unencrypted topic, unable to find anyone. That is what made "ana" lag
  // after her restart in early runs of this script.
  const join = async name => { await peers[name].call('putGroup', group); await peers[name].call('joinGroup', group) }
  // One at a time: joining both at once left the second one's every
  // connection timing out on this host.
  await join('ana')
  await until(async () => ((await peers.owner.call('listGroups')).find(x => x.id === gid)?.members?.length ?? 0) >= 2, 120000)
  await until(async () => ((await peers.owner.call('listGroups')).find(x => x.id === gid)?.members?.length ?? 0) >= 2, 120000)
  await join('ben')
  await until(async () => ((await peers.owner.call('listGroups')).find(x => x.id === gid)?.members?.length ?? 0) >= 3, 120000)
  await join('cal')

  let seen = {}
  const joined = await until(async () => {
    for (const name of Object.keys(peers)) {
      const g = (await peers[name].call('listGroups')).find(x => x.id === gid)
      seen[name] = g ? (g.members?.length ?? 0) + (g.writable === false ? ' read-only' : '') : 'none'
    }
    const g = (await peers.owner.call('listGroups')).find(x => x.id === gid)
    return (g?.members?.length ?? 0) >= 4 ? g : null
  }, 180000)
  check('all three members joined', !!joined, 'members seen ' + JSON.stringify(seen))
  if (!joined) return finish(1)
  // Give the grants time to apply everywhere.
  await new Promise(r => setTimeout(r, 15000))

  const before = await info('owner', gid)
  check('1. new members join as plain writers', before?.count === 1, 'signers=' + before?.count + ' policy=' + before?.policy)

  // 1b. Owner and cal refuse each other, so everything between them goes
  // through ana or ben. The owner must still see cal as online, which is what
  // lets it promote or keep cal (liveness.js).
  const calKey = await peers.cal.ctl('swarmKey')
  const separate = async () => {
    const ownerKey = await peers.owner.ctl('swarmKey')
    await peers.cal.ctl('block', { key: ownerKey })
    await peers.owner.ctl('block', { key: calKey })
  }
  await separate()
  const calWriter = (await peers.cal.call('debugGroup', gid)).me
  const seesCal = async () => ((await peers.owner.call('debugGroup', gid)).liveness || []).find(w => w.k === calWriter)
  const relayed = await until(async () => { const w = await seesCal(); return w && w.live && !w.direct ? w : null }, 240000, 5000)
  const lastSeen = relayed || await seesCal()
  check('1b. owner sees cal, reached only through others, as online', !!relayed,
    relayed ? JSON.stringify(relayed) : 'cal=' + calWriter + ' owner sees ' + JSON.stringify((await peers.owner.call('debugGroup', gid)).liveness))
  if (process.env.STOP_AFTER_1B) return finish(E.failures() ? 1 : 0)

  await stop('owner')
  const n = await backdate('owner', gid, (k, v) => ({ ...v, firstSeen: Date.now() - 2 * DAY }))
  await launch('owner', { BLOCK: calKey })
  await separate()
  console.log('      backdated firstSeen on', n, 'device records, owner restarted, still cut off from cal')

  const grown = await until(async () => {
    const i = await info('owner', gid)
    return i?.count === 3 ? i : null
  }, 300000, 5000)
  const last = grown || await info('owner', gid)
  check('2. owner promotes two: three signers', !!grown, 'signers=' + last?.count + ' policy=' + last?.policy)

  const agree = await until(async () => {
    const all = await Promise.all(['ana', 'ben', 'cal'].map(n => info(n, gid)))
    return all.every(i => i?.count === 3)
  }, 120000)
  check('   every peer agrees on three', !!agree)

  // Restart a member: its reconnect re-announces to everyone.
  await stop('ana')
  await launch('ana')
  await new Promise(r => setTimeout(r, 30000))
  const after = await info('owner', gid)
  check('3. a reconnect does not change the signers', after?.count === 3, 'signers=' + after?.count)

  const today = new Date().toISOString().slice(0, 10)
  // A shared event goes through putEvent:sync, as the UI does; putEvent alone
  // only writes this device's local copy.
  async function shareEvents (name, tag) {
    for (let i = 0; i < 3; i++) {
      const ev = { id: tag + '-' + i, title: tag + ' ' + i, date: today, groups: [gid] }
      await peers[name].call('putEvent', ev)
      await peers[name].call('putEvent:sync', gid, ev)
    }
  }
  // Signers keep appending acknowledgements of their own, so "nothing
  // unsigned" never holds with three of them. The test is that the history up
  // to and including the new events gets signed.
  async function signedPast (name, written) {
    let mark = 0
    await until(async () => { mark = (await info(name, gid))?.total ?? 0; return mark >= written }, 60000)
    return until(async () => {
      const i = await info(name, gid)
      return i && i.signed >= mark ? i : null
    }, 180000)
  }
  const atTotal = (await info('owner', gid))?.total ?? 0
  await shareEvents('ben', 'e2e')
  const signed = await signedPast('owner', atTotal + 3)
  const s = signed || await info('owner', gid)
  const everyone = async names => (await Promise.all(names.map(async n => { const i = await info(n, gid); return n + ' ' + i?.signed + '/' + i?.total + ' (' + i?.count + ')' }))).join(', ')
  check('4. new entries get signed', !!signed, signed ? 'signed=' + s.signed + '/' + s.total : await everyone(['owner', 'ana', 'ben', 'cal']))
  if (!signed) {
    for (const n of ['owner', 'ana', 'ben', 'cal']) console.log('      ' + n + ' ' + JSON.stringify(await peers[n].call('debugGroup', gid).then(d => ({ me: d.me, signed: d.signed, total: d.total, self: d.self, writers: d.writers }))))
  }

  // 4b. One promoted signer goes away. Three signers exist so that losing one
  // does not stop the calendar; the owner and the other promoted one must
  // carry on alone.
  const dbg = {}
  for (const n of ['ana', 'ben', 'cal']) dbg[n] = await peers[n].call('debugGroup', gid)
  const promoted = ['ana', 'ben', 'cal'].filter(n => (dbg[n].writers || []).some(w => w.k === dbg[n].me && w.signer))
  const plain = ['ana', 'ben', 'cal'].find(n => !promoted.includes(n))
  const gone = promoted[0]
  const left = ['owner', ...promoted.slice(1), plain]
  await stop(gone)
  console.log('      stopped promoted signer', gone, '- left:', left.join(', '))
  const at4b = (await info('owner', gid))?.total ?? 0
  await shareEvents(plain, 'one-signer-gone')
  const signed4b = await signedPast('owner', at4b + 3)
  check('4b. one signer gone: the other two still sign', !!signed4b,
    signed4b ? 'signed=' + signed4b.signed + '/' + signed4b.total : await everyone(left))
  if (!signed4b) {
    for (const n of left) console.log('      ' + n + ' ' + JSON.stringify(await peers[n].call('debugGroup', gid).then(d => ({ me: d.me, signed: d.signed, total: d.total, self: d.self, writers: d.writers }))))
    // Does a hand-triggered ack get it moving? Tells a stuck ack path apart
    // from one that correctly decides there is nothing to ack.
    for (const n of left) await peers[n].call('debugGroupAck', gid).catch(e => console.log('      ack error on', n, e.message))
    await new Promise(r => setTimeout(r, 20000))
    console.log('      after a forced ack: ' + await everyone(left))
  }
  await launch(gone)
  if (process.env.STOP_AFTER_4B) return finish(E.failures() ? 1 : 0)

  // 5. The owner goes away for good. Each member's database is told the
  // owner was last seen 15 days ago and everyone has been around for 2 days.
  const ownerGroup = (await peers.owner.call('listGroups')).find(x => x.id === gid)
  const ownerKeys = new Set((ownerGroup.members ?? []).filter(m => m.id === ownerGroup.ownerId).map(m => m.writerKey).filter(Boolean))
  await stop('owner')
  for (const name of ['ana', 'ben', 'cal']) {
    await stop(name)
    await backdate(name, gid, (k, v) => ({
      ...v,
      firstSeen: Date.now() - 2 * DAY,
      ...(ownerKeys.has(k) ? { ts: Date.now() - 15 * DAY } : {}),
    }))
  }
  await Promise.all(['ana', 'ben', 'cal'].map(launch))
  console.log('      owner gone, members told it was last seen 15 days ago')
  const replaced = await until(async () => {
    for (const name of ['ana', 'ben', 'cal']) {
      const i = await info(name, gid)
      if (i?.policy && i.policy.startsWith('replace')) return { name, i }
    }
    return null
  }, 400000, 5000)
  check('5. a member stands in and replaces the owner\'s signer', !!replaced,
    replaced ? replaced.name + ': ' + replaced.i.policy : JSON.stringify(await Promise.all(['ana', 'ben', 'cal'].map(n => info(n, gid).then(i => i?.policy)))))
  const settled = await until(async () => {
    const all = await Promise.all(['ana', 'ben', 'cal'].map(n => info(n, gid)))
    return all.every(i => i?.count === 3)
  }, 120000)
  check('   still three signers, every member agrees', !!settled)
  const before5 = (await info('ana', gid))?.total ?? 0
  await shareEvents('cal', 'after-owner')
  const signed5 = await signedPast('ana', before5 + 3)
  const s5 = signed5 || await info('ana', gid)
  check('   the calendar signs without the owner', !!signed5, 'signed=' + s5?.signed + '/' + s5?.total)

  finish(E.failures() ? 1 : 0)
}

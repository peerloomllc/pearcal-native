// PeerLoom Seeder records (proposals/2026-10-13-peerloom-seeder.md): shape,
// signature, LWW, and that only the owner or whoever added a seeder may change
// its row. Also checks the vendored client matches ../peerloom-seeder.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const sodium = require('sodium-native')
const b4a = require('b4a')
const { recordKey, parseRecordKey, buildRecord, acceptRecord, canChange } = require('../src/lib/peerloomSeeder.js')

function person () {
  const pk = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const sk = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(pk, sk)
  // A member id is not the signing key (it can derive from a recovery identity).
  return { id: b4a.toString(pk, 'hex'), mid: 'id-' + b4a.toString(pk, 'hex').slice(0, 8), sk: b4a.toString(sk, 'hex') }
}
const owner = person()
const adder = person()
const other = person()
const stranger = person()
const SEEDER = 'e'.repeat(64)
const KEY = recordKey(SEEDER)
const NOW = 1_800_000_000_000
const group = { ownerId: owner.mid, members: [owner, adder, other].map((p) => ({ id: p.mid, publicKey: p.id })) }
const row = (p, opts = {}) => buildRecord({ seederKey: SEEDER, writer: p.id, secretKey: p.sk, now: NOW, ...opts })
const accept = (incoming, existing = null, now = NOW) => acceptRecord({ key: KEY, incoming, existing, group, now })

test('keys', () => {
  assert.equal(parseRecordKey(KEY), SEEDER)
  assert.equal(parseRecordKey('pseeder:short'), null)
  assert.equal(parseRecordKey('seeder:' + SEEDER), null)
})

test('any member may add a seeder, as themselves', () => {
  assert.ok(accept(row(adder)))
  assert.ok(!accept(row(stranger)), 'not a member')
  const forged = { ...row(other), addedBy: adder.id }
  assert.ok(!accept(forged), 'addedBy someone else')
})

test('signatures and shape are checked', () => {
  const r = row(adder)
  assert.ok(!accept({ ...r, updatedAt: r.updatedAt + 1 }), 'changed after signing')
  assert.ok(!accept({ ...r, sig: row(other).sig }), 'someone else\'s signature')
  assert.ok(!acceptRecord({ key: recordKey('f'.repeat(64)), incoming: r, group, now: NOW }), 'key mismatch')
  assert.ok(!accept(row(adder, { now: NOW + 3600e3 })), 'from the future')
})

test('only the owner or the adder may revoke or re-admit', () => {
  const added = row(adder)
  const byOther = row(other, { existing: added, revoked: true, now: NOW + 1000 })
  assert.ok(!accept(byOther, added), 'another member may not revoke')
  const byAdder = row(adder, { existing: added, revoked: true, now: NOW + 1000 })
  assert.ok(accept(byAdder, added))
  assert.equal(byAdder.addedBy, adder.id)
  const byOwner = row(owner, { existing: added, revoked: true, now: NOW + 1000 })
  assert.ok(accept(byOwner, added))
  const readmit = row(owner, { existing: byOwner, now: NOW + 2000 })
  assert.ok(accept(readmit, byOwner))
  assert.ok(!readmit.revoked)
  assert.ok(!accept(row(other, { existing: byOwner, now: NOW + 2000 }), byOwner), 'another member may not re-admit')
})

test('addedBy and addedAt never change, and older rows lose', () => {
  const added = row(adder)
  const moved = buildRecord({ seederKey: SEEDER, writer: owner.id, secretKey: owner.sk, now: NOW + 1000 })
  assert.ok(!accept(moved, added), 'a fresh row over an existing one rewrites addedBy')
  const later = row(adder, { existing: added, revoked: true, now: NOW + 1000 })
  assert.ok(!accept(added, later), 'older row')
  assert.ok(!accept(later, later), 'same row again')
})

test('canChange', () => {
  const added = row(adder)
  assert.ok(canChange({ me: other.id, existing: null, group }))
  assert.ok(canChange({ me: adder.id, existing: added, group }))
  assert.ok(canChange({ me: owner.id, existing: added, group }))
  assert.ok(!canChange({ me: other.id, existing: added, group }))
})

test('the vendored client matches ../peerloom-seeder', { skip: !fs.existsSync(path.join(__dirname, '..', '..', 'peerloom-seeder')) && 'no sibling checkout' }, () => {
  for (const f of ['client.js', 'protocol.js']) {
    assert.equal(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'peerloom-seeder', f), 'utf8'),
      fs.readFileSync(path.join(__dirname, '..', '..', 'peerloom-seeder', 'src', f), 'utf8'),
      f + ' is stale: run node scripts/vendor-peerloom-seeder.js')
  }
})

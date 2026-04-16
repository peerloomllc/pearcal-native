// Standalone node test for src/lib/sign.js.
//   node tools/test-sign.js
// Exits non-zero on any failed assertion.

const sodium = require('sodium-native')
const b4a    = require('b4a')
const { canonicalize, signMessage, verifySignature } = require('../src/lib/sign.js')

let failed = 0
function check (name, ok, detail) {
  if (ok) {
    console.log('  ok  ', name)
  } else {
    failed++
    console.log('  FAIL', name, detail ? '— ' + detail : '')
  }
}

function keypair () {
  const pk = b4a.allocUnsafe(sodium.crypto_sign_PUBLICKEYBYTES)
  const sk = b4a.allocUnsafe(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(pk, sk)
  return { pk: b4a.toString(pk, 'hex'), sk: b4a.toString(sk, 'hex') }
}

console.log('canonicalize')
check('primitive string',  canonicalize('hi') === '"hi"')
check('primitive number',  canonicalize(42)   === '42')
check('primitive null',    canonicalize(null) === 'null')
check('empty object',      canonicalize({})   === '{}')
check('empty array',       canonicalize([])   === '[]')
check(
  'object key-order independent',
  canonicalize({ b: 1, a: 2 }) === canonicalize({ a: 2, b: 1 }),
  canonicalize({ b: 1, a: 2 }) + ' vs ' + canonicalize({ a: 2, b: 1 })
)
check(
  'nested key-order independent',
  canonicalize({ x: { b: 1, a: 2 }, y: [3, 4] })
    === canonicalize({ y: [3, 4], x: { a: 2, b: 1 } })
)
check(
  'array order preserved',
  canonicalize([3, 1, 2]) === '[3,1,2]'
)

console.log('sign/verify round-trip')
const alice = keypair()
const bob   = keypair()
const payload = {
  type: 'groupMigration',
  oldGroupId: 'abc123',
  newGroupId: 'def456',
  newGroupKey: '0'.repeat(64),
  migratedAt: 1712345678901,
}
const sig = signMessage(payload, alice.sk)
check('signature is hex string', typeof sig === 'string' && /^[0-9a-f]+$/.test(sig))
check('signature length = 2 * crypto_sign_BYTES',
  sig.length === sodium.crypto_sign_BYTES * 2, 'got ' + sig.length)

check('verify correct payload + key',
  verifySignature(payload, sig, alice.pk) === true)

check('verify with wrong pubkey fails',
  verifySignature(payload, sig, bob.pk) === false)

const tampered = { ...payload, migratedAt: payload.migratedAt + 1 }
check('verify tampered payload fails',
  verifySignature(tampered, sig, alice.pk) === false)

const reordered = {
  migratedAt: payload.migratedAt,
  newGroupKey: payload.newGroupKey,
  newGroupId: payload.newGroupId,
  oldGroupId: payload.oldGroupId,
  type: payload.type,
}
check('verify survives key-reorder (canonicalization works)',
  verifySignature(reordered, sig, alice.pk) === true)

check('verify with malformed hex sig returns false (no throw)',
  verifySignature(payload, 'not-hex', alice.pk) === false)
check('verify with empty sig returns false',
  verifySignature(payload, '', alice.pk) === false)
check('verify with malformed pubkey returns false',
  verifySignature(payload, sig, 'zz') === false)

console.log('')
if (failed > 0) {
  console.log(failed + ' assertion(s) FAILED')
  process.exit(1)
}
console.log('all assertions passed')

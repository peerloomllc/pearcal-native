// TODO #130 — the direct-first blind-relay policy. Pure decision extracted to
// src/lib/relay.js. (feature/blind-relay-backstop)
const test = require('node:test')
const assert = require('node:assert/strict')
const z32 = require('z32')
const {
  relayThroughFor, RELAY_PUBLIC_KEY, RELAY_PUBLIC_KEY_Z, RELAY_PUBLIC_KEY_HEX
} = require('../src/lib/relay.js')

const KEY = Buffer.alloc(32, 7)

test('DIRECT-FIRST: a normal first attempt never offers the relay', () => {
  assert.equal(relayThroughFor({ force: false, randomized: false, useRelay: true, relayKey: KEY }), null)
})

test('escalates to the relay only once a direct punch has failed', () => {
  assert.equal(relayThroughFor({ force: true, randomized: false, useRelay: true, relayKey: KEY }), KEY)
})

test('a double-randomized NAT relays immediately — a direct punch can never land', () => {
  assert.equal(relayThroughFor({ force: false, randomized: true, useRelay: true, relayKey: KEY }), KEY)
})

test('THE PRIVACY TOGGLE: off means never relay, however hard the punch is failing', () => {
  assert.equal(relayThroughFor({ force: true, randomized: true, useRelay: false, relayKey: KEY }), null)
  assert.equal(relayThroughFor({ force: true, randomized: false, useRelay: false, relayKey: KEY }), null)
})

test('no baked relay key is a pure no-op — behaves exactly as before the relay existed', () => {
  for (const force of [true, false]) {
    for (const randomized of [true, false]) {
      assert.equal(relayThroughFor({ force, randomized, useRelay: true, relayKey: null }), null)
    }
  }
})

test('undefined useRelay is treated as OFF — callers must pass the resolved setting', () => {
  // bare.js resolves the persisted value (default on) before calling; a missing
  // flag here means the caller forgot, and silently relaying would be worse.
  assert.equal(relayThroughFor({ force: true, randomized: false, relayKey: KEY }), null)
})

test('the baked relay key decodes to a 32-byte public key', () => {
  assert.ok(RELAY_PUBLIC_KEY, 'a relay key is baked in')
  assert.equal(RELAY_PUBLIC_KEY.length, 32)
  assert.equal(RELAY_PUBLIC_KEY_Z.length, 52)
})

test('THE DRIFT GUARD: the hex we decode is the z32 we show and deployed', () => {
  // relay.js decodes hex (so it needs no z32 dependency at runtime) but the z32
  // string is the human-facing form. If someone rotates the relay and updates one
  // constant without the other, dials would go to a box that is not the relay.
  assert.equal(Buffer.from(z32.decode(RELAY_PUBLIC_KEY_Z)).toString('hex'), RELAY_PUBLIC_KEY_HEX)
})

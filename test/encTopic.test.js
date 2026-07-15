// Encrypted groups use a domain-separated swarm topic so OLD-code peers (which
// join on the plain groupKey topic) never connect to an encrypted group and
// can't corrupt its membership (the EncTestv incident). seed.topicForGroupKey
// is bare.js groupSwarmTopic()'s encrypted branch; assert it differs from the
// legacy topic. (proposal 2026-07-15; bugfix/encrypted-group-topic-separation)
const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const { topicForGroupKey } = require('../src/seed.js')

const groupKey = 'a'.repeat(64)
const legacyTopic = b4a.toString(b4a.from(groupKey.slice(0, 64).padEnd(64, '0'), 'hex'), 'hex')

test('encrypted topic is a 32-byte value distinct from the legacy groupKey topic', () => {
  const enc = topicForGroupKey(groupKey)
  assert.equal(enc.length, 32)
  assert.notEqual(b4a.toString(enc, 'hex'), legacyTopic, 'old-code peers must not share the topic')
})

test('encrypted topic derivation is deterministic', () => {
  assert.equal(b4a.toString(topicForGroupKey(groupKey), 'hex'), b4a.toString(topicForGroupKey(groupKey), 'hex'))
})

test('different groupKeys yield different encrypted topics', () => {
  assert.notEqual(b4a.toString(topicForGroupKey('a'.repeat(64)), 'hex'), b4a.toString(topicForGroupKey('b'.repeat(64)), 'hex'))
})

// StartOS Properties page renderer (seeder-launcher/start9/write-stats.js).
// Requiring the module must NOT start the poller — it is guarded behind
// `require.main === module` precisely so this test can import it.
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { render } = require('../seeder-launcher/start9/write-stats.js')

// Parse with python's yaml so the assertion is about real YAML, not a JS
// re-implementation of the same escaping bug the renderer might have.
function parseYaml (text) {
  return JSON.parse(execFileSync('python3', [
    '-c', 'import sys,yaml,json;json.dump(yaml.safe_load(sys.stdin.read()),sys.stdout)',
  ], { input: text, encoding: 'utf8' }))
}

const sample = {
  status: { pubkey: 'a'.repeat(64), nickname: 'Mac Mini', peers: 2, bytes: 1048576, blocks: 10 },
  enrolled: [{ name: 'Hudgins 2' }, { name: 'Hudgins 3' }],
}

test('render output is valid YAML with the expected properties', () => {
  const d = parseYaml(render(sample))
  assert.equal(d.version, 2)
  assert.deepEqual(Object.keys(d.data), [
    'Seeder Public Key', 'Nickname', 'Groups Seeded', 'Connected Peers', 'Stored',
  ])
})

test('the seeder public key is surfaced and copyable', () => {
  // The whole point of the Properties page: on StartOS this is otherwise only
  // visible by opening the dashboard.
  const d = parseYaml(render(sample))
  assert.equal(d.data['Seeder Public Key'].value, 'a'.repeat(64))
  assert.equal(d.data['Seeder Public Key'].copyable, true)
})

test('a nickname containing a double quote and a backslash round-trips', () => {
  // The nickname is user-supplied and lands inside a YAML double-quoted scalar,
  // so unescaped `"` would truncate the value or break the document outright.
  const nickname = 'Mac "Mini" \\ back\\slash "quoted"'
  const d = parseYaml(render({ ...sample, status: { ...sample.status, nickname } }))
  assert.equal(d.data.Nickname.value, nickname)
})

test('group names are listed, and the empty case reads sensibly', () => {
  assert.match(parseYaml(render(sample)).data['Groups Seeded'].description, /Hudgins 2, Hudgins 3/)
  const empty = parseYaml(render({ status: { pubkey: 'x' }, enrolled: [] }))
  assert.equal(empty.data['Groups Seeded'].value, '0')
  assert.match(empty.data['Groups Seeded'].description, /No groups enrolled/)
})

test('a missing or empty payload still renders parseable YAML', () => {
  // The poller writes whatever /api/status returned; a partial response must not
  // produce a broken file that StartOS then fails to read.
  for (const payload of [{}, { status: {} }, { status: null, enrolled: null }]) {
    const d = parseYaml(render(payload))
    assert.equal(d.version, 2)
    assert.equal(d.data['Seeder Public Key'].value, 'unavailable')
  }
})

test('requiring the module does not start the poller', () => {
  // If this regressed, the test run itself would hang on an open interval.
  const mod = require('../seeder-launcher/start9/write-stats.js')
  assert.equal(typeof mod.render, 'function')
  assert.equal(typeof mod.tick, 'function')
})

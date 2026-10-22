const test = require('node:test')
const assert = require('node:assert')
const path = require('path')

// TODO #177: on 2026-08-07 the desktop moved autobase from 7.27.3 to 7.25.1 to
// carry the patch in patches/, but kept hypercore 11.28.1. Autobase 7.25.1 with
// hypercore 11.28.1 throws "Atomic state must flush to parent" on createGroup
// and joinGroup, so the desktop could not open a new calendar. Mobile ran
// 7.25.1 with hypercore 11.26.0 and was fine. The two installs must move these
// together.
const PINNED_TOGETHER = ['autobase', 'hypercore']

const lock = p => require(path.join(__dirname, '..', p))
const version = (l, name) => l.packages['node_modules/' + name]?.version

test('desktop and mobile install the same autobase and hypercore', () => {
  const mobile = lock('package-lock.json')
  const desktop = lock('electron/package-lock.json')
  for (const name of PINNED_TOGETHER) {
    assert.ok(version(mobile, name), name + ' missing from the mobile lock')
    assert.equal(version(desktop, name), version(mobile, name), name + ' differs between electron/ and the app')
  }
})

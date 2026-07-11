// Unit tests for the writer-core rewind decision (src/lib/rewindGuard.js).
const test = require('brittle')
const { writerRewindStatus } = require('../src/lib/rewindGuard')

test('not behind when the network has no more than we do', (t) => {
  t.alike(writerRewindStatus({ localLength: 10, networkLength: 10 }), { behind: false, downloadFrom: 0, downloadTo: 0 })
  t.alike(writerRewindStatus({ localLength: 10, networkLength: 5 }), { behind: false, downloadFrom: 0, downloadTo: 0 })
})

test('behind when a peer holds a longer copy of our own core (truncation)', (t) => {
  t.alike(writerRewindStatus({ localLength: 8, networkLength: 12 }), { behind: true, downloadFrom: 8, downloadTo: 12 })
})

test('no peer connected (networkLength 0) => authoritative, not behind', (t) => {
  t.alike(writerRewindStatus({ localLength: 5, networkLength: 0 }), { behind: false, downloadFrom: 0, downloadTo: 0 })
})

test('missing / non-finite inputs coerce to 0', (t) => {
  t.alike(writerRewindStatus({}), { behind: false, downloadFrom: 0, downloadTo: 0 })
  t.alike(writerRewindStatus(), { behind: false, downloadFrom: 0, downloadTo: 0 })
  t.alike(writerRewindStatus({ localLength: NaN, networkLength: 3 }), { behind: true, downloadFrom: 0, downloadTo: 3 })
})

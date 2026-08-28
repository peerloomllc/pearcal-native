// TODO #172: re-stamping a CORESTORE marker after the host copied the data
// folder. Exercises the real device-file guard, and hypercore-storage through a
// real Hypercore, under Node. The "was modified" condition is produced the way
// StartOS 0.4.0.1 produces it: the marker's recorded inode / created stamp stop
// matching the file, while the extended attribute survives.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const DeviceFile = require('device-file')
const Hypercore = require('hypercore')
const {
  MODIFIED_MESSAGE, isDeviceFileModifiedError, parseMarker,
  healDeviceFile, healCorestoreDeviceFiles,
} = require('../src/lib/deviceFileHeal.js')

function tmp () { return fs.mkdtempSync(path.join(os.tmpdir(), 'pearcal-dfh-')) }

// Edit one key of the marker in place, keeping inode and xattr.
function tamper (file, key, value) {
  const text = fs.readFileSync(file, 'utf8')
  const out = text.split('\n').map((ln) => ln.startsWith(key + '=') ? key + '=' + value : ln).join('\n')
  const fd = fs.openSync(file, 'r+')
  fs.ftruncateSync(fd, 0)
  fs.writeSync(fd, Buffer.from(out), 0, Buffer.byteLength(out), 0)
  fs.closeSync(fd)
}

async function writeMarker (file) {
  const d = new DeviceFile(file)
  await d.ready()
  await d.close()
}

async function verifyError (file) {
  const d = new DeviceFile(file, { create: false })
  try { await d.ready() } catch (e) { await d.close().catch(() => {}); return e }
  await d.close()
  return null
}

test('isDeviceFileModifiedError: only the exact inode/created mismatch', () => {
  const mk = (message, code = 'DEVICE_FILE') => Object.assign(new Error(message), { code, fatal: true })
  assert.equal(isDeviceFileModifiedError(mk(MODIFIED_MESSAGE)), true)
  assert.equal(isDeviceFileModifiedError(mk('Invalid device file, was moved unsafely')), false)
  assert.equal(isDeviceFileModifiedError(mk('Invalid device file, was made on different platform')), false)
  assert.equal(isDeviceFileModifiedError(mk('Invalid device file, was modified', 'EOTHER')), false)
  assert.equal(isDeviceFileModifiedError(new Error('boom')), false)
  assert.equal(isDeviceFileModifiedError(null), false)
})

test('a consistent marker is left alone', async () => {
  const file = path.join(tmp(), 'CORESTORE')
  await writeMarker(file)
  const before = fs.readFileSync(file, 'utf8')
  assert.equal(healDeviceFile(fs, file), null)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(await verifyError(file), null)
})

test('a missing marker is not created', () => {
  const file = path.join(tmp(), 'CORESTORE')
  assert.equal(healDeviceFile(fs, file), null)
  assert.equal(fs.existsSync(file), false)
})

test('inode mismatch: device-file says "was modified", heal fixes it in place', async () => {
  const file = path.join(tmp(), 'CORESTORE')
  await writeMarker(file)
  const ino = fs.statSync(file).ino
  tamper(file, 'device/inode', ino + 1)
  const err = await verifyError(file)
  assert.ok(err && isDeviceFileModifiedError(err), 'guard should trip: ' + (err && err.message))

  const r = healDeviceFile(fs, file)
  assert.equal(r.before.inode, ino + 1)
  assert.equal(r.after.inode, ino)
  assert.equal(fs.statSync(file).ino, ino, 'same file, same inode')
  assert.equal(parseMarker(fs.readFileSync(file, 'utf8')).inode, ino)
  assert.equal(await verifyError(file), null)
})

test('created drift beyond the slack trips the guard; heal re-stamps created', async () => {
  const file = path.join(tmp(), 'CORESTORE')
  await writeMarker(file)
  const { created } = parseMarker(fs.readFileSync(file, 'utf8'))
  tamper(file, 'device/created', created - 60 * 60 * 1000)
  // tamper() rewrote the file, so mtime moved to now and created is an hour old
  const err = await verifyError(file)
  assert.ok(err && isDeviceFileModifiedError(err), 'guard should trip: ' + (err && err.message))
  const r = healDeviceFile(fs, file)
  assert.ok(r && Math.abs(r.after.created - Date.now()) < 5000)
  assert.equal(await verifyError(file), null)
})

test('a marker missing its attribute ("moved unsafely") is not the healed case', async () => {
  const file = path.join(tmp(), 'CORESTORE')
  await writeMarker(file)
  // A copy that drops xattrs: what rsync without -X or a cross-filesystem copy does.
  const copy = path.join(tmp(), 'CORESTORE')
  fs.copyFileSync(file, copy)
  const err = await verifyError(copy)
  assert.ok(err, 'guard should trip on the copy')
  assert.equal(isDeviceFileModifiedError(err), false, err.message)
})

test('healCorestoreDeviceFiles: only rewrites the dirs that need it', async () => {
  const a = tmp(); const b = tmp(); const c = tmp()
  await writeMarker(path.join(a, 'CORESTORE'))
  await writeMarker(path.join(b, 'CORESTORE'))
  tamper(path.join(a, 'CORESTORE'), 'device/inode', 1)
  const healed = healCorestoreDeviceFiles(fs, [a, b, c])
  assert.deepEqual(healed.map((h) => h.file), [path.join(a, 'CORESTORE')])
  assert.equal(await verifyError(path.join(a, 'CORESTORE')), null)
})

test('end to end through hypercore-storage: a real Hypercore refuses, heal, reopens with data intact', async () => {
  const dir = path.join(tmp(), 'core')
  const c1 = new Hypercore(dir, { valueEncoding: 'json' })
  await c1.ready()
  await c1.append({ hello: 'world' })
  await c1.close()

  const marker = path.join(dir, 'CORESTORE')
  assert.ok(fs.existsSync(marker), 'hypercore-storage writes the marker where the seeder expects it')
  tamper(marker, 'device/inode', fs.statSync(marker).ino + 7)

  const c2 = new Hypercore(dir, { valueEncoding: 'json' })
  let err = null
  try { await c2.ready() } catch (e) { err = e }
  await c2.close().catch(() => {})
  assert.ok(err && isDeviceFileModifiedError(err), 'hypercore should refuse: ' + (err && err.message))

  const healed = healCorestoreDeviceFiles(fs, [dir])
  assert.equal(healed.length, 1)

  const c3 = new Hypercore(dir, { valueEncoding: 'json' })
  await c3.ready()
  assert.equal(c3.length, 1)
  assert.deepEqual(await c3.get(0), { hello: 'world' })
  await c3.close()
})

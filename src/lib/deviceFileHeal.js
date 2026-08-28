// Re-stamp a hypercore-storage CORESTORE marker after the host copied our data
// folder (TODO #172).
//
// hypercore-storage opens each store through `device-file`, which writes a small
// CORESTORE file recording that file's own inode number and a creation
// timestamp, and refuses to open ("Invalid device file, was modified") when
// either no longer matches. The guard exists so two live copies of a core can
// never both write. StartOS 0.4.0.1 trips it by accident: its first boot clones
// every package volume into a btrfs subvolume and deletes the original, so every
// file gets a new inode and birth time while exactly one copy remains. Both
// seeders on the Start9 crash-looped on 2026-08-28 until the markers were
// rewritten by hand (DONE.md, same date).
//
// This module does that rewrite in place: same file, same inode, and the
// `user.device-file=original` extended attribute untouched, because device-file
// separately reports a missing attribute as "was moved unsafely" and that case
// is NOT healed here. It only ever touches the two lines device-file compares.
//
// Runs under Bare (bare-fs) and Node (fs): only the sync API is used and the
// two agree on openSync/fstatSync/ftruncateSync/writeSync/closeSync.
const b4a = require('b4a')

const MODIFIED_MESSAGE = 'Invalid device file, was modified'
const MARKER = 'CORESTORE'
// device-file's own tolerance between the recorded created stamp and the
// file's max(mtime, birthtime).
const MODIFIED_SLACK = 5000

function isDeviceFileModifiedError (err) {
  return !!err && err.code === 'DEVICE_FILE' &&
    typeof err.message === 'string' && err.message.startsWith(MODIFIED_MESSAGE)
}

// Parse the marker into { inode, created, lines } without touching anything else.
function parseMarker (text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  let inode = 0
  let created = 0
  for (const ln of lines) {
    const i = ln.indexOf('=')
    if (i === -1) continue
    const k = ln.slice(0, i).trim()
    const v = ln.slice(i + 1).trim()
    if (k === 'device/inode') inode = Number(v)
    else if (k === 'device/created') created = Number(v)
  }
  return { inode, created, lines }
}

// Rewrite one marker so device-file accepts it again. Returns null when the
// marker is absent or already consistent, otherwise { file, before, after }.
function healDeviceFile (fs, file, now = Date.now()) {
  if (!fs.existsSync(file)) return null
  const text = b4a.toString(fs.readFileSync(file))
  const { inode, created, lines } = parseMarker(text)
  const fd = fs.openSync(file, 'r+')
  try {
    const st = fs.fstatSync(fd)
    const modified = Math.max(st.mtimeMs || 0, st.birthtimeMs || 0)
    const inodeOk = st.ino === inode
    const createdOk = !created || Math.abs(modified - created) < MODIFIED_SLACK
    if (inodeOk && createdOk) return null
    const nl = text.includes('\r\n') ? '\r\n' : '\n'
    let sawInode = false
    const out = lines.map((ln) => {
      if (ln.startsWith('device/inode=')) { sawInode = true; return 'device/inode=' + st.ino }
      if (ln.startsWith('device/created=')) return 'device/created=' + now
      return ln
    })
    if (!sawInode) out.push('device/inode=' + st.ino)
    const buf = b4a.from(out.join(nl) + nl)
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, buf, 0, buf.length, 0)
    return { file, before: { inode, created }, after: { inode: st.ino, created: now } }
  } finally {
    fs.closeSync(fd)
  }
}

// Heal the CORESTORE marker of each store directory. Returns the markers that
// were actually rewritten.
function healCorestoreDeviceFiles (fs, dirs, now = Date.now()) {
  const healed = []
  for (const dir of dirs) {
    const r = healDeviceFile(fs, dir + '/' + MARKER, now)
    if (r) healed.push(r)
  }
  return healed
}

module.exports = {
  MODIFIED_MESSAGE, MARKER, isDeviceFileModifiedError, parseMarker,
  healDeviceFile, healCorestoreDeviceFiles,
}

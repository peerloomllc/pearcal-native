// Member invite links (`/join`). Shared CJS module so the UI and the Bare
// worklet build and parse ONE definition and cannot drift - the same reason
// seedInvite.js exists, and now load-bearing for a second reason.
//
// #164: on an encrypted calendar the owner's invite carried `&enc=` and every
// other member's did not, so any link they handed out produced a member who
// could never sync. The builder was only ever reachable from the WebView, which
// holds a COPY of the group record that can be missing the local-only
// `encryptionKey`; the worklet's record is the authoritative one and always has
// it. Moving the builder here lets bare.js mint the link from that record, so a
// stale UI copy cannot produce a broken invite regardless of how it went stale.
//
// Format:
//   https://peerloomllc.com/join?group={base64(groupId)}&name={name}&key={groupKey}&inviter={publicKey}[&enc=][&reinvite=1]
//
// Legacy shapes still parsed: pear://pearcal/join?…  and  pearcal://join?…

const SCHEME   = 'https://peerloomllc.com'
const MAX_NAME = 64    // chars
const KEY_LEN  = 64    // hex chars (32-byte public key)

// base64 without assuming a browser. This runs in the WebView (where `btoa`
// exists) and in the Bare worklet (where it may not). Group ids are short
// ASCII, so latin1 round trips them exactly.
function _b64enc (s) {
  if (typeof btoa === 'function') return btoa(s)
  return Buffer.from(String(s), 'latin1').toString('base64')
}
function _b64dec (s) {
  if (typeof atob === 'function') return atob(s)
  return Buffer.from(String(s), 'base64').toString('latin1')
}

function _params (group, myIdentityId) {
  return new URLSearchParams({
    group:   _b64enc(group.id),
    name:    group.name,
    key:     (group.groupKey ?? group.id).slice(0, KEY_LEN),
    inviter: myIdentityId,
  })
}

/**
 * Generate an invite link for a group.
 *
 * @param {object} group          the group record. MUST be the authoritative
 *                                one (bare.js `getGroup`), not a UI copy - a
 *                                copy without `encryptionKey` silently mints a
 *                                link that produces a keyless join (#164/#124).
 * @param {string} myIdentityId   inviter's `profile.id` (identity-derived,
 *                                stable across devices). Pre-v1.0.23 links
 *                                carried `profile.publicKey` instead; the
 *                                joiner side accepts both shapes.
 */
function buildInviteLink (group, myIdentityId) {
  const params = _params(group, myIdentityId)
  // Block-encryption key for encrypted groups (proposal 2026-07-15). MEMBER
  // invites carry it so joiners can decrypt; the blind-seeder invite omits it.
  if (group.encryptionKey) params.set('enc', group.encryptionKey)
  return `${SCHEME}/join?${params.toString()}`
}

function buildReinviteLink (group, myIdentityId) {
  const params = _params(group, myIdentityId)
  params.set('reinvite', '1')
  if (group.encryptionKey) params.set('enc', group.encryptionKey)
  return `${SCHEME}/join?${params.toString()}`
}

/**
 * Parse and validate an invite URL. Returns { ok: true, ...fields } or
 * { ok: false, error }.
 */
function parseInviteLink (url) {
  if (typeof url !== 'string') return { ok: false, error: 'invalid_url' }

  const normalised = url
    .replace(/^pear:\/\/pearcal\//, 'https://peerloomllc.com/')
    .replace(/^pearcal:\/\//, 'https://peerloomllc.com/')
  let u
  try { u = new URL(normalised) } catch {
    return { ok: false, error: 'malformed_url' }
  }

  if (u.host !== 'peerloomllc.com' || !u.pathname.startsWith('/join')) {
    return { ok: false, error: 'wrong_path' }
  }

  const raw = {
    group:   u.searchParams.get('group'),
    name:    u.searchParams.get('name'),
    key:     u.searchParams.get('key'),
    inviter: u.searchParams.get('inviter'),
    enc:     u.searchParams.get('enc'),
  }

  if (!raw.group || !raw.name || !raw.key || !raw.inviter) {
    return { ok: false, error: 'missing_params' }
  }

  let groupId
  try { groupId = _b64dec(raw.group) } catch {
    return { ok: false, error: 'invalid_group_id' }
  }

  const groupName = decodeURIComponent(raw.name).trim().slice(0, MAX_NAME)
  if (!groupName) return { ok: false, error: 'empty_name' }

  if (!/^[0-9a-f]+$/i.test(raw.key) || raw.key.length < 16) {
    return { ok: false, error: 'invalid_key' }
  }
  if (!/^[0-9a-f]+$/i.test(raw.inviter) || raw.inviter.length < 16) {
    return { ok: false, error: 'invalid_inviter' }
  }

  // Optional block-encryption key. Absent → legacy unencrypted group →
  // encryptionKey null (Autobase opens without block encryption). When present
  // it must be a full 32-byte hex key.
  let encryptionKey = null
  if (raw.enc != null && raw.enc !== '') {
    if (!/^[0-9a-f]{64}$/i.test(raw.enc)) return { ok: false, error: 'invalid_enc' }
    encryptionKey = raw.enc.toLowerCase()
  }

  const reinvite = u.searchParams.get('reinvite') === '1'
  return {
    ok: true,
    groupId,
    groupName,
    reinvite,
    groupKey:   raw.key,
    inviterKey: raw.inviter,
    encryptionKey,
  }
}

module.exports = { buildInviteLink, buildReinviteLink, parseInviteLink, SCHEME, KEY_LEN, MAX_NAME }

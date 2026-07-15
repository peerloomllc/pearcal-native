// Seed-invite links for the blind-seeder admission path (proposal
// 2026-07-15-pearcal-seeder-port, Phase 4). Shared CJS module so the member/UI
// side (build) and the seed worklet (parse) use ONE definition and can't drift.
//
// Format (deliberately DISTINCT path from member /join invites):
//   https://peerloomllc.com/seed?group={base64(groupId)}&name={name}&key={groupKey}&inviter={publicKey}
//   pearcal://seed?...            (custom scheme)
//
// The seed invite carries the groupKey (swarm topic + Autobase bootstrap) but
// NEVER the block-encryption key (`enc`). That is the whole point: a seeder
// admitted via this link replicates ciphertext it can never read. parseSeedInvite
// refuses member /join invites and ignores any stray &enc=, so a seeder can never
// end up holding a block key.

const SCHEME = 'https://peerloomllc.com'
const MAX_NAME = 64
const KEY_LEN = 64

function _b64 (s) { return Buffer.from(String(s)).toString('base64') }
function _unb64 (s) { return Buffer.from(String(s), 'base64').toString() }

/**
 * Build a /seed invite for one group. `group` needs { id, name, groupKey }.
 * @returns {string}
 */
function buildSeedInvite (group, inviterId) {
  if (!group || !group.id) throw new Error('buildSeedInvite: group.id required')
  const params = new URLSearchParams({
    group:   _b64(group.id),
    name:    group.name || 'Group',
    key:     String(group.groupKey ?? group.id).slice(0, KEY_LEN),
    inviter: inviterId,
  })
  // No `enc` — a blind seeder must never receive the block-encryption key.
  return `${SCHEME}/seed?${params.toString()}`
}

/**
 * Parse a single /seed invite. Rejects member /join invites and any bundle
 * (multiple invites in one string). Never returns an encryptionKey.
 * @returns {{ok:boolean, groupId?, groupName?, groupKey?, inviterKey?, error?}}
 */
function parseSeedInvite (url) {
  if (typeof url !== 'string') return { ok: false, error: 'invalid_url' }
  const trimmed = url.trim()
  // Bundle guard: a single real invite has exactly one '/seed?' marker; more
  // than one means a newline-joined bundle was passed as one string (which
  // last-key-wins would silently merge across invites). Reject loudly.
  if ((trimmed.match(/\/seed\?/g) || []).length > 1 || /[\r\n]/.test(trimmed)) {
    return { ok: false, error: 'looks_like_bundle' }
  }
  const normalised = trimmed
    .replace(/^pear:\/\/pearcal\//, 'https://peerloomllc.com/')
    .replace(/^pearcal:\/\//, 'https://peerloomllc.com/')
  let u
  try { u = new URL(normalised) } catch { return { ok: false, error: 'malformed_url' } }
  if (u.host !== 'peerloomllc.com') return { ok: false, error: 'wrong_host' }
  // A member invite must NEVER be usable as a seed invite (it carries enc).
  if (u.pathname.startsWith('/join')) return { ok: false, error: 'member_invite_not_seed' }
  if (!u.pathname.startsWith('/seed')) return { ok: false, error: 'wrong_path' }

  const group = u.searchParams.get('group')
  const name = u.searchParams.get('name')
  const key = u.searchParams.get('key')
  const inviter = u.searchParams.get('inviter')
  if (!group || !name || !key || !inviter) return { ok: false, error: 'missing_params' }

  let groupId
  try { groupId = _unb64(group) } catch { return { ok: false, error: 'invalid_group_id' } }
  if (!groupId) return { ok: false, error: 'invalid_group_id' }
  const groupName = decodeURIComponent(name).trim().slice(0, MAX_NAME)
  if (!groupName) return { ok: false, error: 'empty_name' }
  if (!/^[0-9a-f]+$/i.test(key) || key.length < 16) return { ok: false, error: 'invalid_key' }
  if (!/^[0-9a-f]+$/i.test(inviter) || inviter.length < 16) return { ok: false, error: 'invalid_inviter' }

  // Deliberately ignore any &enc= — a blind seeder never takes a block key.
  return { ok: true, groupId, groupName, groupKey: key.toLowerCase(), inviterKey: inviter }
}

/**
 * Build an all-groups seed bundle: newline-joined /seed invites so one admit
 * enrolls the seeder in every group the user is in.
 */
function buildSeedBundle (groups, inviterId) {
  return (Array.isArray(groups) ? groups : [])
    .filter(g => g && g.id && g.groupKey)
    .map(g => buildSeedInvite(g, inviterId))
    .join('\n')
}

/**
 * Parse a seed bundle into an array of parseSeedInvite results (one per line).
 */
function parseSeedBundle (text) {
  if (typeof text !== 'string') return []
  return text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean).map(parseSeedInvite)
}

module.exports = { buildSeedInvite, parseSeedInvite, buildSeedBundle, parseSeedBundle, SCHEME, KEY_LEN, MAX_NAME }

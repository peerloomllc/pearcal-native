// Group settings modal — name, emoji, color, member list (read-only),
// leave, delete. Mobile's GroupSettingsModal also covers ownership
// transfer, member kick/admin promotion, rejoin approvals, history
// sweeps, and member-nickname editing — those live behind D7.2.
//
// Save semantics: edits stay local until "Save"; Leave/Delete are
// confirmed via window.confirm. Owners cannot leave (must delete);
// non-owners cannot delete (must leave).

import { useEffect, useRef, useState } from 'react'
import { compressImage } from '../lib/imagePicker.js'
import { MemberAvatar } from './MemberAvatar.jsx'
import { QRCodeCanvas } from './QRCode.jsx'
import { GroupNotices } from '../../ui-shared/index.js'

const GROUP_COLORS = ['#6C9BF5','#5DBF8A','#E5864A','#D45F7A','#A97FD4','#4BBDCC','#F5C842','#E07B54']
const GROUP_EMOJIS = ['👨‍👩‍👧‍👦','⚽','📚','🎮','🏋️','🎵','🌿','🐾','✈️','🍕','💼','🎨']

export function GroupSettingsModal ({ tokens, group, profile, db, pendingApproval, onUpdate, onLeave, onDelete, onClose }) {
  const [name,    setName]    = useState(group?.name  ?? '')
  const [emoji,   setEmoji]   = useState(group?.emoji ?? '')
  const [color,   setColor]   = useState(group?.color ?? GROUP_COLORS[0])
  const [icon,    setIcon]    = useState(group?.icon  ?? null)
  const [iconBusy, setIconBusy] = useState(false)
  const [iconErr,  setIconErr]  = useState('')
  const [saving,  setSaving]  = useState(false)
  const [saved,   setSaved]   = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const myMember = (group?.members ?? []).find(m => m.id === profile?.id)
  const [nickname, setNickname] = useState(myMember?.nickname ?? '')
  const [nickSaving, setNickSaving] = useState(false)
  const [nickSaved, setNickSaved] = useState(false)
  const nameRef = useRef(null)
  const fileRef = useRef(null)

  const isOwner   = group?.ownerId === profile?.id
  const dirty = (name.trim() !== (group?.name ?? '').trim())
             || (emoji !== (group?.emoji ?? ''))
             || (color !== (group?.color ?? GROUP_COLORS[0]))
             || ((icon ?? null) !== (group?.icon ?? null))

  async function handleFile (e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setIconErr('That file is not an image.')
      return
    }
    setIconBusy(true); setIconErr('')
    try {
      const compressed = await compressImage(file)
      setIcon(compressed)
    } catch (err) {
      setIconErr('Could not load image: ' + (err?.message ?? 'unknown error'))
    }
    setIconBusy(false)
  }
  function clearIcon () { setIcon(null); setIconErr('') }

  useEffect(() => { nameRef.current?.focus() }, [])
  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSave () {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      await onUpdate({ ...group, name: trimmed, emoji, color, icon, updatedAt: Date.now() })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      alert('Could not save: ' + (e?.message ?? 'unknown error'))
    }
    setSaving(false)
  }

  async function handleLeave () {
    if (!confirm('Leave "' + (group?.name ?? 'this group') + '"? Your local copy of its events will be removed from this device.')) return
    await onLeave(group.id)
    onClose()
  }

  async function handleDelete () {
    if (!confirm('Delete "' + (group?.name ?? 'this group') + '" for everyone? This removes the group from all members\' devices.')) return
    await onDelete(group.id)
    onClose()
  }

  // Keep the nickname draft in sync if another device updates the
  // group's member record while this modal is open. Skip while a save
  // is in flight so we don't blow away the user's in-progress edit.
  useEffect(() => {
    if (nickSaving) return
    setNickname(myMember?.nickname ?? '')
  }, [myMember?.nickname, nickSaving])

  async function saveNickname () {
    if (!db) return
    setNickSaving(true)
    try {
      await db.setMemberNickname(group.id, nickname.trim())
      setNickSaved(true)
      setTimeout(() => setNickSaved(false), 1500)
    } catch (e) {
      alert('Could not save nickname: ' + (e?.message ?? 'unknown error'))
    }
    setNickSaving(false)
  }

  async function copyInviteLink () {
    if (!inviteLink) return
    try { await navigator.clipboard?.writeText?.(inviteLink) } catch {}
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
  }

  // #164 - minted by the WORKLET from the authoritative group record, never
  // rebuilt from this component's copy. That copy can be missing the local-only
  // encryptionKey, and a link without `enc=` produces a member who can never
  // sync. Stays empty if the worklet refuses, so a broken link is never shown.
  const [inviteLink, setInviteLink] = useState('')
  useEffect(() => {
    if (!group?.id || !db?.buildInvite) return
    let alive = true
    db.buildInvite(group.id)
      .then(l => { if (alive && typeof l === 'string') setInviteLink(l) })
      .catch(() => { if (alive) setInviteLink('') })
    return () => { alive = false }
  }, [group?.id, db])

  const inputBase = {
    width: '100%', padding: '7px 10px', borderRadius: 5,
    fontSize: 13, fontWeight: 400,
    border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
    fontFamily: tokens.font, boxSizing: 'border-box', outline: 'none',
  }
  const label = {
    fontSize: 11, fontWeight: 600, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7,
  }
  const btnBase = {
    padding: '7px 14px', fontSize: 13, fontWeight: 500,
    borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`,
    background: tokens.bg, color: tokens.text,
  }

  const members = group?.members ?? []

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20, width: 460, maxWidth: '90vw',
        maxHeight: '85vh', overflowY: 'auto',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        fontFamily: tokens.font,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Group Settings</div>
          {saved && <div style={{ fontSize: 12, color: '#5DBF8A', marginRight: 10 }}>✓ Saved</div>}
          <button onClick={onClose} style={{
            ...btnBase, padding: '4px 10px', fontSize: 14,
            background: 'transparent', border: 'none',
          }}>✕</button>
        </div>

        {/* #163 - the three trouble notices, shared with mobile
            (src/ui-shared/components/GroupNotices.jsx). They existed on mobile
            only, so the shipped desktop build said nothing at all when a
            calendar broke. Each renders null when it has nothing to say. No
            icons passed: desktop has no icon library and the wording stands on
            its own. */}
        <GroupNotices
          group={group}
          pendingApproval={pendingApproval}
          theme={{ text: tokens.text, muted: tokens.muted }} />

        {!isOwner && (
          <div style={{
            fontSize: 12, color: tokens.muted, marginBottom: 12,
            padding: '7px 10px', borderRadius: 5,
            background: tokens.bg, border: `1px solid ${tokens.border}`,
          }}>
            You're a member of this group. Only the owner can change name, emoji, or color.
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <div style={label}>Name</div>
          <input ref={nameRef} value={name} onChange={e => setName(e.target.value)}
                 disabled={!isOwner} placeholder="Group name" style={{
                   ...inputBase, opacity: isOwner ? 1 : 0.6,
                 }} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={label}>Group icon</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 8,
              background: icon ? 'transparent' : color + '22',
              border: `2px solid ${color}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, overflow: 'hidden', flexShrink: 0,
            }}>
              {icon
                ? <img src={icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : (emoji || '👥')}
            </div>
            {isOwner && (
              <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                <button onClick={() => fileRef.current?.click()} disabled={iconBusy}
                        style={{ ...btnBase, flex: 1, opacity: iconBusy ? 0.5 : 1 }}>
                  {iconBusy ? 'Loading…' : (icon ? 'Change Photo' : 'Choose Photo')}
                </button>
                <button onClick={clearIcon} disabled={!icon}
                        style={{ ...btnBase, flex: 1, opacity: icon ? 1 : 0.4, cursor: icon ? 'pointer' : 'default' }}>
                  Remove Photo
                </button>
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                 onChange={handleFile} />
          {iconErr && (
            <div style={{ fontSize: 11, color: '#C0504A', marginBottom: 6 }}>{iconErr}</div>
          )}
          {isOwner && (
            <>
              <div style={{ fontSize: 11, color: tokens.muted, marginBottom: 6 }}>
                Or pick an emoji:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {GROUP_EMOJIS.map(em => (
                  <button key={em} onClick={() => { setEmoji(em); setIcon(null) }}
                    style={{
                      width: 30, height: 30, borderRadius: 6, fontSize: 16,
                      background: !icon && emoji === em ? color + '22' : tokens.bg,
                      border: `2px solid ${!icon && emoji === em ? color : tokens.border}`,
                      cursor: 'pointer', fontFamily: tokens.font,
                    }}>
                    {em}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={label}>Color</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {GROUP_COLORS.map(c => (
              <button key={c} disabled={!isOwner}
                onClick={() => setColor(c)}
                style={{
                  width: 26, height: 26, borderRadius: '50%',
                  background: c, border: 'none',
                  outline: color === c ? `2px solid ${tokens.text}` : 'none',
                  outlineOffset: 2,
                  cursor: isOwner ? 'pointer' : 'default',
                  opacity: isOwner ? 1 : 0.6,
                }}
                aria-label={'Color ' + c} />
            ))}
          </div>
        </div>

        {db && myMember && (
          <div style={{ marginBottom: 14 }}>
            <div style={label}>Your nickname in this group</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={nickname}
                     onChange={e => { setNickname(e.target.value); setNickSaved(false) }}
                     placeholder={profile?.name ?? 'Your name'}
                     style={{ ...inputBase, flex: 1 }} />
              <button onClick={saveNickname} disabled={nickSaving || nickname.trim() === (myMember.nickname ?? '').trim()}
                      style={{
                        ...btnBase, minWidth: 80,
                        opacity: (nickSaving || nickname.trim() === (myMember.nickname ?? '').trim()) ? 0.5 : 1,
                      }}>
                {nickSaved ? '✓ Saved' : (nickSaving ? 'Saving…' : 'Save')}
              </button>
            </div>
            <div style={{ fontSize: 11, color: tokens.muted, marginTop: 5 }}>
              Only changes how others in this group see you. Your profile name stays unchanged.
            </div>
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <div style={label}>Members ({members.length})</div>
          <div style={{
            border: `1px solid ${tokens.border}`, borderRadius: 6,
            background: tokens.bg, maxHeight: 180, overflowY: 'auto',
          }}>
            {members.length === 0 && (
              <div style={{ padding: '8px 10px', fontSize: 12, color: tokens.muted }}>No members yet.</div>
            )}
            {members.map(m => {
              const isMe          = m.id === profile?.id
              const isOwnerMember = m.id === group?.ownerId
              const display       = m.nickname?.trim() || m.name || 'Unnamed'
              return (
                <div key={m.id} style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  padding: '7px 10px',
                  borderBottom: `1px solid ${tokens.border}`,
                  fontSize: 13,
                }}>
                  <MemberAvatar avatar={m.avatar} avatarHash={m.avatarHash}
                                name={display} color={m.color ?? tokens.muted}
                                size={26} fontSize={12} />
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {display}{isMe ? ' (you)' : ''}
                  </div>
                  {isOwnerMember && (
                    <div style={{ fontSize: 11, color: tokens.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Owner
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={label}>Invite</div>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
            <QRCodeCanvas value={inviteLink} size={220} tokens={tokens} />
          </div>
          <textarea readOnly value={inviteLink} rows={3}
                    onClick={e => e.target.select()}
                    style={{ ...inputBase, fontFamily: 'ui-monospace, monospace', fontSize: 11, resize: 'none' }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button onClick={copyInviteLink} style={{ ...btnBase, flex: 1 }}>
              {linkCopied ? '✓ Copied' : 'Copy invite link'}
            </button>
          </div>
          <div style={{ fontSize: 11, color: tokens.muted, marginTop: 6, lineHeight: 1.5 }}>
            Anyone with this link can scan the QR or paste the link into PearCal to join.
          </div>
        </div>

        {/* Destructive actions get their own section above the modal's
            primary action row so users can't fat-finger Delete while
            reaching for Save. Pattern: GitHub / Linear / Notion. */}
        <div style={{
          marginTop: 14, paddingTop: 14,
          borderTop: `1px solid ${tokens.border}`,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
        }}>
          <div style={{ ...label, color: '#C0504A', textAlign: 'center', marginBottom: 8 }}>Danger zone</div>
          {isOwner ? (
            <button onClick={handleDelete} style={{
              ...btnBase, minWidth: 140, color: '#C0504A', borderColor: '#C0504A',
            }}>Delete group</button>
          ) : (
            <button onClick={handleLeave} style={{
              ...btnBase, minWidth: 140, color: '#C0504A', borderColor: '#C0504A',
            }}>Leave group</button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18 }}>
          <button onClick={onClose} style={{ ...btnBase, minWidth: 140 }}>Close</button>
          {isOwner && (
            <button onClick={handleSave} disabled={!dirty || !name.trim() || saving} style={{
              ...btnBase, minWidth: 140,
              background: tokens.accent, color: tokens.bg, borderColor: tokens.accent,
              opacity: (!dirty || !name.trim() || saving) ? 0.5 : 1,
              cursor:  (!dirty || !name.trim() || saving) ? 'default' : 'pointer',
            }}>{saving ? 'Saving…' : 'Save'}</button>
          )}
        </div>
      </div>
    </div>
  )
}

// Group settings modal — name, emoji, color, member list (read-only),
// leave, delete. Mobile's GroupSettingsModal also covers ownership
// transfer, member kick/admin promotion, rejoin approvals, history
// sweeps, and member-nickname editing — those live behind D7.2.
//
// Save semantics: edits stay local until "Save"; Leave/Delete are
// confirmed via window.confirm. Owners cannot leave (must delete);
// non-owners cannot delete (must leave).

import { useEffect, useRef, useState } from 'react'

const GROUP_COLORS = ['#6C9BF5','#5DBF8A','#E5864A','#D45F7A','#A97FD4','#4BBDCC','#F5C842','#E07B54']
const GROUP_EMOJIS = ['👨‍👩‍👧‍👦','⚽','📚','🎮','🏋️','🎵','🌿','🐾','✈️','🍕','💼','🎨']

export function GroupSettingsModal ({ tokens, group, profile, onUpdate, onLeave, onDelete, onClose }) {
  const [name,    setName]    = useState(group?.name  ?? '')
  const [emoji,   setEmoji]   = useState(group?.emoji ?? '')
  const [color,   setColor]   = useState(group?.color ?? GROUP_COLORS[0])
  const [saving,  setSaving]  = useState(false)
  const [saved,   setSaved]   = useState(false)
  const nameRef = useRef(null)

  const isOwner   = group?.ownerId === profile?.id
  const dirty = (name.trim() !== (group?.name ?? '').trim())
             || (emoji !== (group?.emoji ?? ''))
             || (color !== (group?.color ?? GROUP_COLORS[0]))

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
      await onUpdate({ ...group, name: trimmed, emoji, color, updatedAt: Date.now() })
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
          <div style={label}>Emoji</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {GROUP_EMOJIS.map(em => (
              <button key={em} disabled={!isOwner}
                onClick={() => setEmoji(em)}
                style={{
                  width: 30, height: 30, borderRadius: 6, fontSize: 16,
                  background: emoji === em ? color + '22' : tokens.bg,
                  border: `2px solid ${emoji === em ? color : tokens.border}`,
                  cursor: isOwner ? 'pointer' : 'default',
                  opacity: isOwner ? 1 : 0.6,
                  fontFamily: tokens.font,
                }}>
                {em}
              </button>
            ))}
          </div>
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

        <div style={{ marginBottom: 14 }}>
          <div style={label}>Members ({members.length})</div>
          <div style={{
            border: `1px solid ${tokens.border}`, borderRadius: 6,
            background: tokens.bg, maxHeight: 140, overflowY: 'auto',
          }}>
            {members.length === 0 && (
              <div style={{ padding: '8px 10px', fontSize: 12, color: tokens.muted }}>No members yet.</div>
            )}
            {members.map(m => {
              const isMe    = m.id === profile?.id
              const isOwnerMember = m.id === group?.ownerId
              const display = m.nickname?.trim() || m.name || 'Unnamed'
              return (
                <div key={m.id} style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  padding: '7px 10px',
                  borderBottom: `1px solid ${tokens.border}`,
                  fontSize: 13,
                }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: '50%',
                    background: m.color ?? tokens.muted, color: tokens.bg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 600, flexShrink: 0,
                  }}>
                    {(m.avatar?.startsWith?.('data:') ? null : (m.avatar || display[0] || '?'))}
                  </div>
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

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          {isOwner ? (
            <button onClick={handleDelete} style={{
              ...btnBase, color: '#C0504A', borderColor: '#C0504A', marginRight: 'auto',
            }}>Delete group</button>
          ) : (
            <button onClick={handleLeave} style={{
              ...btnBase, color: '#C0504A', borderColor: '#C0504A', marginRight: 'auto',
            }}>Leave group</button>
          )}
          <button onClick={onClose} style={btnBase}>Close</button>
          {isOwner && (
            <button onClick={handleSave} disabled={!dirty || !name.trim() || saving} style={{
              ...btnBase,
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

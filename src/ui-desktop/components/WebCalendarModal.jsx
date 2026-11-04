// Add or edit a web calendar subscription (TODO #189 phase 2).

import { useEffect, useState } from 'react'

const COLORS = ['#4BBDCC','#A97FD4','#F5C842','#E07B54','#6C9BF5','#5DBF8A','#E5864A','#D45F7A']

export function WebCalendarModal ({ tokens, web, subscription, onClose }) {
  const isNew = !subscription?.id
  const [url, setUrl] = useState(subscription?.url ?? '')
  const [name, setName] = useState(subscription?.name ?? '')
  const [color, setColor] = useState(subscription?.color ?? COLORS[(web.subscriptions.length) % COLORS.length])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const feed = isNew ? null : web.feeds[subscription.id]
  const downloading = !isNew && !!web.busy[subscription.id]
  const status = isNew ? null
    : downloading ? 'Downloading…'
    : feed?.error ? 'Last try failed: ' + feed.error + (feed.fetchedAt ? ' Showing the copy from ' + new Date(feed.fetchedAt).toLocaleString() + '.' : '')
    : feed?.fetchedAt ? 'Updated ' + new Date(feed.fetchedAt).toLocaleString() + '.'
    : 'Not downloaded yet.'

  async function save () {
    setErr(''); setBusy(true)
    try {
      if (isNew) {
        const { error } = await web.addSubscription({ url, name, color })
        if (error) { setErr('Added, but the first download failed: ' + error + ' PearCal will keep trying.'); return }
      } else {
        await web.updateSubscription(subscription.id, { url, name: name.trim(), color })
      }
      onClose()
    } catch (e) { setErr(e?.message ?? String(e)) } finally { setBusy(false) }
  }

  async function remove () {
    setBusy(true)
    try { await web.removeSubscription(subscription.id); onClose() } finally { setBusy(false) }
  }

  const inputBase = {
    width: '100%', padding: '7px 10px', borderRadius: 5, fontSize: 13, fontWeight: 400,
    border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
    fontFamily: tokens.font, boxSizing: 'border-box', outline: 'none',
  }
  const label = {
    fontSize: 11, fontWeight: 600, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7,
  }
  const btnBase = {
    padding: '7px 14px', fontSize: 13, fontWeight: 500, borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20, width: 460, maxWidth: '90vw',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)', fontFamily: tokens.font, color: tokens.text,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          {isNew ? 'Add a web calendar' : 'Web calendar'}
        </div>
        <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, marginBottom: 14 }}>
          Paste a calendar link (https:// or webcal://). Each of your devices downloads it from that
          website itself, about twice a day, so the website can see your IP address. Its events are
          read-only and are never shared with your groups.
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={label}>Link</div>
          <input autoFocus={isNew} value={url} spellCheck={false}
            onChange={e => { setUrl(e.target.value); setErr('') }}
            onKeyDown={e => { if (e.key === 'Enter') save() }}
            placeholder="https://example.com/calendar.ics" style={inputBase} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={label}>Name</div>
          <input value={name} maxLength={60} onChange={e => setName(e.target.value)}
            placeholder={isNew ? 'Optional, taken from the calendar' : ''} style={inputBase} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={label}>Color</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {COLORS.map(c => (
              <button key={c} onClick={() => setColor(c)} aria-label={c} style={{
                width: 24, height: 24, borderRadius: 12, background: c, cursor: 'pointer',
                border: color === c ? `2px solid ${tokens.text}` : '2px solid transparent',
              }} />
            ))}
          </div>
        </div>
        {status && <div style={{ fontSize: 12, color: feed?.error ? '#E5484D' : tokens.muted, marginBottom: 10, lineHeight: 1.5 }}>{status}</div>}
        {err && <div style={{ fontSize: 12, color: '#E5484D', marginBottom: 10, lineHeight: 1.5 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {!isNew && (
            <button disabled={busy} onClick={remove} style={{ ...btnBase, marginRight: 'auto', color: '#E5484D' }}>Remove</button>
          )}
          {!isNew && (
            <button disabled={downloading} onClick={() => web.refresh(web.subscriptions.find(s => s.id === subscription.id))} style={btnBase}>Download now</button>
          )}
          <button onClick={onClose} style={btnBase}>{isNew ? 'Cancel' : 'Close'}</button>
          <button disabled={busy || !url.trim()} onClick={save}
            style={{ ...btnBase, background: tokens.accent, borderColor: tokens.accent, color: '#fff', opacity: url.trim() ? 1 : 0.5 }}>
            {isNew ? 'Add' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

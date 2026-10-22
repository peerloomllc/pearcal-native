// The 12 words, desktop (proposals/2026-10-22-phrase-recovers-calendars.md,
// section 2). Same flow as mobile's RecoveryPhraseSheet: a warning first, then
// "Show my words", which asks the main process (shell-handlers.js
// revealRecoveryPhrase). That prompts for Touch ID on a Mac that has it; on
// Windows, Linux and other Macs this warning and its button are the gate
// (decided 2026-10-22). `intro` is the one-time screen, with Skip. No copy
// button, nothing uploaded.

import { useEffect, useState } from 'react'

export function RecoveryPhraseModal ({ tokens, intro = false, onClose }) {
  const [words, setWords] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // Capture phase, and stop it there: Esc closes this window only, not the
  // Settings window it may sit on.
  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const show = async () => {
    setBusy(true); setMsg('')
    try {
      const w = await window.__pearDB.call('revealRecoveryPhrase')
      setWords(String(w).trim().split(/\s+/))
    } catch (e) {
      setMsg(/cancel/.test(e?.message || '') ? 'Touch ID was cancelled.' : "Couldn't show your words: " + (e?.message || e))
    } finally { setBusy(false) }
  }

  const btn = {
    padding: '8px 14px', fontSize: 13, fontWeight: 500, borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
  }
  const accentBtn = { ...btn, background: tokens.accent, color: tokens.bg, borderColor: tokens.accent }
  const body = { fontSize: 13, color: tokens.muted, lineHeight: 1.6, marginBottom: 12, textAlign: 'center' }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 110,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`, borderRadius: 10,
        padding: 20, width: 460, maxWidth: '92vw', boxShadow: '0 12px 40px rgba(0,0,0,0.5)', fontFamily: tokens.font,
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, textAlign: 'center', marginBottom: 12, color: tokens.text }}>Your recovery phrase</div>
        {!words && (<>
          <div style={body}>
            These 12 words are the key to your PearCal. If you lose this computer, they bring back
            who you are and, with a seeder, your calendars. Write them down and keep them somewhere
            safe.{intro ? ' You can see them again any time in Settings.' : ''}
          </div>
          <div style={{ fontSize: 13, color: tokens.text, lineHeight: 1.5, padding: '10px 12px', borderRadius: 8, border: `1px solid ${tokens.border}`, marginBottom: 12, textAlign: 'center' }}>
            Anyone with these words can read every calendar your seeders keep. PearCal never uploads them.
          </div>
          {msg && <div style={{ ...body, marginBottom: 8 }}>{msg}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{ ...btn, flex: 1 }}>{intro ? 'Skip' : 'Cancel'}</button>
            <button onClick={show} disabled={busy} style={{ ...accentBtn, flex: 1, opacity: busy ? 0.6 : 1 }}>{busy ? 'Unlocking…' : 'Show my words'}</button>
          </div>
        </>)}
        {words && (<>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
            {words.map((w, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '8px 10px', borderRadius: 6,
                border: `1px solid ${tokens.border}`, fontSize: 14, color: tokens.text, userSelect: 'none' }}>
                <span style={{ fontSize: 11, color: tokens.muted, minWidth: 16 }}>{i + 1}</span>{w}
              </div>
            ))}
          </div>
          <div style={body}>Write them down in this order. Don't share them or keep them in a screenshot or a note that syncs.</div>
          <button onClick={onClose} style={{ ...accentBtn, width: '100%' }}>Done</button>
        </>)}
      </div>
    </div>
  )
}

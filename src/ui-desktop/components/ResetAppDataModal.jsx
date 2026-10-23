// Reset app data on the desktop (#163, ported from the phone's Settings in
// src/ui/App.jsx; engine side is TODO #118, proposals/2026-07-18-in-app-reset-data).
//
// Two levels, same as the phone:
//   keep  clear the calendar and groups, stay the same person
//   full  also delete the identity and leave every group (type RESET first)
//
// There is no success state: when the engine finishes it emits appDataReset,
// and electron/src/main/shell-handlers.js clears session storage and relaunches.

import { useState } from 'react'

const RED = '#C0504A'

export function ResetAppDataModal ({ tokens, sync, onClose }) {
  const [mode, setMode] = useState(null) // null | 'keep' | 'full'
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const blocked = busy || (mode === 'full' && typed.trim().toUpperCase() !== 'RESET')
  const text = { fontSize: 13, color: tokens.muted, lineHeight: 1.55, marginBottom: 14 }
  const btn = {
    flex: 1, padding: '8px 14px', fontSize: 13, fontWeight: 500, borderRadius: 5,
    fontFamily: tokens.font, cursor: busy ? 'wait' : 'pointer',
  }
  const choice = (border) => ({
    display: 'block', width: '100%', textAlign: 'left', marginBottom: 10,
    padding: '12px 14px', borderRadius: 8, cursor: 'pointer',
    border: `1px solid ${border}`, background: 'transparent', fontFamily: tokens.font,
  })

  async function reset () {
    setBusy(true); setError(null)
    try {
      await sync.resetAppData({ keepIdentity: mode === 'keep' })
    } catch (e) {
      setError(e?.message || String(e))
      setBusy(false)
    }
  }

  function close () { if (!busy) onClose() }

  return (
    // stopPropagation because this renders inside the settings overlay, whose
    // own backdrop click closes settings.
    <div onClick={e => { e.stopPropagation(); close() }} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 110,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20, width: 460, maxWidth: '90vw',
        maxHeight: '85vh', overflowY: 'auto',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        fontFamily: tokens.font, color: tokens.text,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, textAlign: 'center', marginBottom: 14 }}>
          {mode === null ? 'Reset app data'
            : mode === 'keep' ? 'Clear calendar and groups?'
            : 'Start over as a new user?'}
        </div>

        {mode === null && (
          <>
            <div style={text}>Both options clear this computer. Only the second one tells anybody else.</div>
            <button onClick={() => setMode('keep')} style={choice(tokens.border)}>
              <div style={{ fontSize: 13, color: tokens.text, marginBottom: 3 }}>Clear calendar and groups</div>
              <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5 }}>
                You stay the same person. Your events and groups are removed from this
                computer, and you can rejoin a group with its invite link to get everything back.
              </div>
            </button>
            <button onClick={() => setMode('full')} style={choice(RED)}>
              <div style={{ fontSize: 13, color: RED, marginBottom: 3 }}>Start over as a new user</div>
              <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5 }}>
                Everything above, and this computer stops being you. It gets a brand new
                identity, with no way back to the account you are using now. You also leave
                every group, so you stop showing in their member lists. Groups you run are
                handed to another member, or deleted if you are the only one in them.
              </div>
            </button>
            <div style={{ display: 'flex' }}>
              <button onClick={close} style={{ ...btn, border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text }}>
                Cancel
              </button>
            </div>
          </>
        )}

        {mode === 'keep' && (
          <div style={text}>
            Your events and groups will be removed from this computer. You stay signed in
            as yourself and keep your name, so you can rejoin any group with its invite
            link and your calendar comes back from the other members. Nobody else is told,
            and you stay in their member lists. PearCal restarts when it is done.
          </div>
        )}

        {mode === 'full' && (
          <>
            <div style={text}>
              This computer stops being you. It gets a brand new identity, so there is no way
              back to the account you are using now, and anything only this computer was
              holding is gone for good. You will also leave every group you are in, and any
              group you run is handed to another member or deleted if nobody else is in it.
              PearCal restarts when it is done.
            </div>
            {/* The departure only reaches peers connected at that moment; the
                pending-leave record lives in the database being deleted. */}
            <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.55, marginBottom: 14,
              padding: '10px 12px', borderRadius: 8, border: `1px solid ${tokens.border}` }}>
              <span style={{ color: tokens.text }}>One thing to know:</span> leaving
              only reaches people who have the app open at that moment. Anyone offline may
              still see you in their group's member list, and once your data is gone there is
              no way to tell them. If that matters, leave your groups by hand first, while
              the other members are around.
            </div>
            <div style={{ fontSize: 12, color: tokens.muted, marginBottom: 6 }}>Type RESET to confirm</div>
            <input autoFocus value={typed} onChange={e => setTyped(e.target.value)} spellCheck={false}
              onKeyDown={e => { if (e.key === 'Enter' && !blocked) reset() }}
              style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 5,
                marginBottom: 14, border: `1px solid ${tokens.border}`, background: tokens.bg,
                color: tokens.text, fontFamily: tokens.font, fontSize: 13, outline: 'none' }} />
          </>
        )}

        {error && <div style={{ fontSize: 12, color: RED, lineHeight: 1.5, marginBottom: 12 }}>{error}</div>}

        {mode !== null && (
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => { setMode(null); setTyped(''); setError(null) }} disabled={busy}
              style={{ ...btn, border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text, opacity: busy ? 0.5 : 1 }}>
              Back
            </button>
            <button onClick={reset} disabled={blocked}
              style={{ ...btn, border: 'none', background: RED, color: '#fff', opacity: blocked ? 0.5 : 1 }}>
              {busy ? 'Resetting…' : mode === 'keep' ? 'Clear it' : 'Delete everything'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

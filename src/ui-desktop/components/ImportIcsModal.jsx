// Desktop .ics import (TODO #170). The mobile sheet's twin: same question,
// same routing rules, laid out as a centred modal instead of a bottom sheet.
//
// The routing itself lives in src/ui-shared/lib/ics.js so both platforms agree
// on where an imported event lands; this file is purely the desktop shape of
// asking.

import { useEffect, useMemo, useState } from 'react'
import { icsFileGroups, routeIcsImport } from '../../ui-shared/index.js'

export function ImportIcsModal ({ tokens, events, filename, groups = [], existingEventIds, onImport, onClose }) {
  const memberIds = useMemo(() => new Set(groups.map(g => g.id)), [groups])
  // Only a PearCal-exported .ics names groups; a file from Google/Apple/Outlook
  // has nothing to keep, so the "keep" option never appears for one.
  const hasFileGroups = useMemo(
    () => icsFileGroups(events, memberIds).size > 0, [events, memberIds])
  const [dest, setDest] = useState(hasFileGroups ? 'file' : 'personal')
  const destGroup = groups.find(g => g.id === dest) ?? null

  // Esc closes, the same way every other desktop modal binds it locally.
  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const routed = routeIcsImport(events, { dest, groupIds: memberIds, existingEventIds })
  const toImport = routed.filter(r => !r.skipped)
  const skippedCount = routed.length - toImport.length

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
  const pill = (selected, color) => ({
    ...btnBase, padding: '5px 12px',
    display: 'flex', alignItems: 'center', gap: 6,
    background:  selected ? (color ?? tokens.accent) : tokens.bg,
    color:       selected ? tokens.bg : (color ?? tokens.text),
    borderColor: color ?? (selected ? tokens.accent : tokens.border),
  })

  const caption = dest === 'personal'
    ? 'Only you will see these events.'
    : destGroup
      ? `Everyone in ${destGroup.name} will see these events.`
      : 'Each event keeps the groups it was exported with.'

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 120,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20, width: 460, maxWidth: '90vw',
        maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        fontFamily: tokens.font, color: tokens.text,
      }}>
        <div style={{ position: 'relative', marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, textAlign: 'center' }}>
            Import {toImport.length} Event{toImport.length !== 1 ? 's' : ''}
          </div>
          <div style={{ fontSize: 12, color: tokens.muted, textAlign: 'center', marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {filename}
          </div>
          <button onClick={onClose} style={{
            ...btnBase, padding: '4px 10px', fontSize: 14,
            background: 'transparent', border: 'none',
            position: 'absolute', top: 0, right: 0,
          }}>✕</button>
        </div>

        {groups.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={label}>Import into</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {hasFileGroups && (
                <button onClick={() => setDest('file')} style={pill(dest === 'file', null)}>
                  Keep from file
                </button>
              )}
              <button onClick={() => setDest('personal')} style={pill(dest === 'personal', null)}>
                Personal
              </button>
              {groups.map(g => (
                <button key={g.id} onClick={() => setDest(g.id)} style={pill(dest === g.id, g.color)}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, overflow: 'hidden',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, flexShrink: 0 }}>
                    {g.icon
                      ? <img src={g.icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : g.emoji}
                  </span>
                  {g.name}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, paddingTop: 8 }}>
              {caption}
            </div>
          </div>
        )}

        {skippedCount > 0 && (
          <div style={{ fontSize: 12, color: tokens.muted, marginBottom: 10 }}>
            {skippedCount} event{skippedCount !== 1 ? 's' : ''} already
            {skippedCount === 1 ? ' exists' : ' exist'} - will be skipped
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
          {routed.map((r, i) => (
            <div key={i} style={{
              padding: '8px 10px', borderRadius: 6,
              border: `1px solid ${tokens.border}`,
              opacity: r.skipped ? 0.5 : 1,
            }}>
              <div style={{ fontSize: 13 }}>
                {r.ev.title}{r.skipped ? ' · (skipped)' : ''}
              </div>
              <div style={{ fontSize: 11, color: tokens.muted }}>
                {r.ev.date}
                {r.ev.allDay
                  ? (r.ev.endDate ? ` - ${r.ev.endDate} · All day` : ' · All day')
                  : (r.ev.start ? ` · ${r.ev.start}${r.ev.end ? '-' + r.ev.end : ''}` : '')}
              </div>
            </div>
          ))}
        </div>

        <button onClick={() => onImport(toImport)} disabled={toImport.length === 0}
          style={{ ...btnBase, width: '100%', padding: '9px 14px',
            background: tokens.accent, color: tokens.bg, borderColor: tokens.accent,
            cursor: toImport.length === 0 ? 'default' : 'pointer',
            opacity: toImport.length === 0 ? 0.4 : 1 }}>
          Import {toImport.length} Event{toImport.length !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
  )
}

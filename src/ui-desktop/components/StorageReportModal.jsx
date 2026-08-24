// Storage reports for the desktop (#163, proposals/2026-08-08-desktop-ui-parity.md).
//
// Two read-only views over the same modal, matching what mobile's settings tab
// actually SHIPS: a breakdown of what is on disk, and an estimate of how much of
// it is reclaimable. Mobile's two write actions, Reclaim Storage and Sweep
// Orphaned Data, are hidden there behind `{false && ...}` (#154, PR #143) and so
// have no desktop counterpart either - see the note in main.jsx.
//
// Shapes come from bare.js: storageBreakdown() returns { total, cats, perDir },
// analyzeStorage({ keepTail }) returns { totalBytes, reclaimableBytes, pct,
// groups: [{ id, name, bytes, reclaim }] } with the local database as
// `__local__` and unreachable cores as `__orphans__`.

import { formatBytes } from '../../ui-shared/index.js'

const TYPE_LABEL = {
  blob: 'Large values',
  log_old: 'Old log files',
  sst: 'Index data',
  log: 'Current logs',
  wal: 'Write-ahead log',
  manifest: 'Manifests',
  other: 'Other',
}

const ANALYZE_SECTIONS = [
  { heading: 'Local database', match: g => g.id === '__local__' },
  { heading: 'Groups', match: g => g.id !== '__local__' && g.id !== '__orphans__' },
  { heading: 'Orphaned cores', match: g => g.id === '__orphans__' },
]

export function StorageReportModal ({ tokens, kind, report, error, onClose }) {
  const label = {
    fontSize: 11, fontWeight: 600, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em', margin: '16px 0 8px',
  }
  const rowText = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: tokens.text }

  // Two stacked bars: the group's whole footprint in grey, the reclaimable part
  // of it in accent on top, both scaled against the same total so rows compare.
  const Bar = ({ size, total, under }) => (
    <div style={{
      height: 6, borderRadius: 3, background: tokens.border,
      overflow: 'hidden', marginTop: 4, position: 'relative',
    }}>
      {under !== undefined && (
        <div style={{
          height: '100%', width: pct(under, total) + '%',
          background: tokens.muted, opacity: 0.35,
        }} />
      )}
      <div style={{
        position: under !== undefined ? 'absolute' : 'static',
        top: 0, left: 0, height: '100%',
        width: pct(size, total) + '%', background: tokens.accent,
      }} />
    </div>
  )

  return (
    // stopPropagation because this renders inside the settings overlay, whose
    // own backdrop click closes settings - without it, dismissing the report
    // would close settings out from under it too.
    <div onClick={e => { e.stopPropagation(); onClose() }} style={{
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
          {kind === 'breakdown' ? 'Storage breakdown' : 'Reclaimable storage'}
        </div>

        {error && (
          <div style={{ fontSize: 13, color: '#E06C75', textAlign: 'center', padding: '10px 0' }}>
            {error}
          </div>
        )}

        {!error && kind === 'breakdown' && report && (() => {
          const cats = Object.entries(report.cats ?? {})
            .filter(([, v]) => v?.count > 0)
            .sort((a, b) => b[1].size - a[1].size)
          const dirs = Object.entries(report.perDir ?? {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
          return (
            <>
              <Total value={report.total ?? 0} caption="total on disk" tokens={tokens} />
              {cats.length > 0 && <div style={label}>By type</div>}
              {cats.map(([k, v]) => (
                <div key={k} style={{ marginBottom: 10 }}>
                  <div style={rowText}>
                    <span>{TYPE_LABEL[k] || k}</span>
                    <span style={{ color: tokens.muted }}>{formatBytes(v.size)}</span>
                  </div>
                  <Bar size={v.size} total={report.total} />
                </div>
              ))}
              {dirs.length > 0 && <div style={label}>By location</div>}
              {dirs.map(([k, v]) => (
                <div key={k} style={{ marginBottom: 10 }}>
                  <div style={rowText}>
                    <span style={{ fontFamily: 'monospace' }}>{k || '.'}</span>
                    <span style={{ color: tokens.muted }}>{formatBytes(v)}</span>
                  </div>
                  <Bar size={v} total={report.total} />
                </div>
              ))}
            </>
          )
        })()}

        {!error && kind === 'analyze' && report && (
          <>
            <Total
              value={report.reclaimableBytes ?? 0}
              caption={`reclaimable (${report.pct ?? 0}% of ${formatBytes(report.totalBytes ?? 0)})`}
              tokens={tokens}
            />
            <div style={{
              height: 8, borderRadius: 4, background: tokens.border,
              overflow: 'hidden', marginBottom: 6,
            }}>
              <div style={{ height: '100%', width: (report.pct ?? 0) + '%', background: tokens.accent }} />
            </div>
            {ANALYZE_SECTIONS.map(s => {
              const items = (report.groups ?? []).filter(s.match).sort((a, b) => b.bytes - a.bytes)
              if (!items.length) return null
              return (
                <div key={s.heading}>
                  <div style={label}>{s.heading}</div>
                  {items.map(g => (
                    <div key={g.id} style={{ marginBottom: 10 }}>
                      <div style={rowText}>
                        <span>{g.name}</span>
                        <span style={{ color: tokens.muted }}>
                          {formatBytes(g.bytes)}{g.reclaim > 0 ? ' · ' + formatBytes(g.reclaim) + ' reclaimable' : ''}
                        </span>
                      </div>
                      <Bar size={g.reclaim} under={g.bytes} total={report.totalBytes} />
                    </div>
                  ))}
                </div>
              )
            })}
            <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, marginTop: 14 }}>
              Reclaimable space is old history PearCal keeps but no longer needs. Nothing is
              deleted by looking at this, and there is no way to free it from the app yet.
            </div>
          </>
        )}

        <button onClick={e => { e.stopPropagation(); onClose() }} style={{
          marginTop: 18, width: '100%', padding: '8px 14px',
          fontSize: 13, fontWeight: 500, borderRadius: 5, cursor: 'pointer',
          fontFamily: tokens.font, border: `1px solid ${tokens.border}`,
          background: tokens.bg, color: tokens.text,
        }}>Close</button>
      </div>
    </div>
  )
}

function Total ({ value, caption, tokens }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: 16 }}>
      <div style={{ fontSize: 26, color: tokens.text, fontVariantNumeric: 'tabular-nums' }}>
        {formatBytes(value)}
      </div>
      <div style={{ fontSize: 12, color: tokens.muted }}>{caption}</div>
    </div>
  )
}

const pct = (part, total) => 100 * (part ?? 0) / Math.max(total ?? 0, 1)

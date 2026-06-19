// Centered modal for create + edit. The form is intentionally simple
// for D4 — title, date, all-day toggle, time range, group multi-select,
// notes, location. Recurring + reminders + RSVP-enable land in later
// phases; the underlying record format already accepts those fields,
// so existing events with them will round-trip safely (we just don't
// expose UI to change them yet).

import { useEffect, useRef, useState } from 'react'

function makeEventId () {
  return 'e' + Date.now() + Math.floor(Math.random() * 1000)
}

// Smart-default times — match mobile App.jsx's openCreate (line 1205):
// when a slot was clicked we use that snapped time as start and round
// up to the next hour-mark for end; when nothing was clicked (the
// "+ New" button or a month-cell create) start defaults to the next
// hour from now and end is one hour after that.
function nextHourMark (hh) {
  return String((hh + 1) % 24).padStart(2, '0') + ':00'
}
function toMin (hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}
function fromMin (mins) {
  const m = ((mins % 1440) + 1440) % 1440
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
}
function defaultsFor (initialStart) {
  if (initialStart) {
    const h = parseInt(initialStart.split(':')[0], 10)
    return { start: initialStart, end: nextHourMark(h) }
  }
  const now = new Date()
  const next = new Date(now.getTime() + (60 - now.getMinutes()) * 60000)
  next.setSeconds(0, 0)
  return {
    start: String(next.getHours()).padStart(2, '0') + ':00',
    end:   nextHourMark(next.getHours()),
  }
}

// Modal layout — width and viewport guard rails. Used both for the
// centered fallback and the anchor-positioned variant so the popover
// can never be clipped off-screen.
const MODAL_WIDTH    = 460
const MODAL_GAP_PX   = 16
const MODAL_MARGIN   = 16

// Compute the popover position adjacent to the anchor, preferring the
// right side. Falls back to the left if right would overflow; clamps
// vertically so the panel never lands outside the viewport. Returns
// null when the anchor itself doesn't fit either side — caller falls
// back to a centered modal in that case.
function computeAnchorPosition (anchor) {
  if (!anchor) return null
  const vw = window.innerWidth
  const vh = window.innerHeight
  // Estimate panel height — actual height varies by content (50% of the
  // form is conditionally rendered by allDay), so cap at 90vh and let
  // the inner scroll handle anything that would clip.
  const estH = Math.min(560, vh - MODAL_MARGIN * 2)

  let left
  if (anchor.x + MODAL_GAP_PX + MODAL_WIDTH + MODAL_MARGIN <= vw) {
    left = anchor.x + MODAL_GAP_PX
  } else if (anchor.x - MODAL_GAP_PX - MODAL_WIDTH >= MODAL_MARGIN) {
    left = anchor.x - MODAL_GAP_PX - MODAL_WIDTH
  } else {
    return null  // neither side fits; fall back to centered
  }

  // Center vertically on the anchor, then clamp.
  let top = anchor.y - estH / 2
  if (top < MODAL_MARGIN) top = MODAL_MARGIN
  if (top + estH > vh - MODAL_MARGIN) top = vh - MODAL_MARGIN - estH
  return { left, top }
}

export function EventModal ({ tokens, mode, initial, anchor, groups, profile, use24h, onSave, onDelete, onClose }) {
  const [title,    setTitle]    = useState(initial?.title ?? '')
  const [date,     setDate]     = useState(initial?.date ?? '')
  const [allDay,   setAllDay]   = useState(initial?.allDay ?? false)
  // `||` instead of `??` here: parent passes empty strings (not undefined)
  // when no slot time was clicked, and we want those to fall through to
  // the smart defaults rather than land in the input as ''.
  const seedTimes = defaultsFor(initial?.start)
  const [start,    setStart]    = useState(initial?.start || seedTimes.start)
  const [end,      setEnd]      = useState(initial?.end   || seedTimes.end)

  // Keep End synced to Start by preserving the current duration. User
  // edits Start → End shifts by the same delta. User edits End → only
  // End changes (and the implicit duration is whatever they set).
  // Standard Apple Calendar / Outlook behavior.
  function handleStartChange (newStart) {
    const oldDuration = (toMin(end) - toMin(start) + 1440) % 1440
    setStart(newStart)
    setEnd(fromMin(toMin(newStart) + oldDuration))
  }
  // All-day events may span multiple days. We store the inclusive end day in
  // `endDate`; '' means single-day. Only surfaced for all-day, non-recurring
  // events (matches the mobile UI).
  const [endDate,  setEndDate]  = useState(initial?.endDate ?? '')
  const [groupIds, setGroupIds] = useState(initial?.groups ?? [])
  const [notes,    setNotes]    = useState(initial?.desc ?? '')
  const [location, setLocation] = useState(initial?.location ?? '')

  // Recurrence (parity with mobile — TODO #102). "Custom…" is a UI mode stored
  // as a unit cadence + recurrenceInterval. Editing an existing occurrence
  // prompts for scope (this / future / all) before saving.
  const [recurrence,   setRecurrence]   = useState(initial?.recurrence ?? 'none')
  const [recInterval,  setRecInterval]  = useState(initial?.recurrenceInterval ?? 1)
  const [recEnd,       setRecEnd]       = useState(initial?.recurrenceEnd ?? '')
  const [repeatForever, setRepeatForever] = useState(!!initial?.repeatForever)
  const [recNth,       setRecNth]       = useState(initial?.recurrenceNth ?? 0)
  const [recWeekday,   setRecWeekday]   = useState(initial?.recurrenceWeekday ?? 0)
  const [customMode,   setCustomMode]   = useState((initial?.recurrenceInterval ?? 1) > 1)
  const [intervalDraft, setIntervalDraft] = useState(null)
  const [scopePrompt,  setScopePrompt]  = useState(null)  // pending {ev, opts} for a series edit

  const isRecurring = recurrence !== 'none'
  const showEndDate = allDay && !isRecurring

  function defaultRecEnd () {
    if (!date) return ''
    const [y, m, d] = date.split('-').map(Number)
    const end = new Date(y + 1, m - 1, d)
    return String(end.getFullYear()) + '-' + String(end.getMonth() + 1).padStart(2, '0') + '-' + String(end.getDate()).padStart(2, '0')
  }
  function handleFreqChange (val) {
    if (val === 'custom') {
      setCustomMode(true)
      if (!['daily', 'weekly', 'monthly', 'yearly'].includes(recurrence)) setRecurrence('daily')
      if (!(recInterval > 1)) setRecInterval(2)
      setIntervalDraft(null)
      if (!recEnd && !repeatForever) setRecEnd(defaultRecEnd())
      return
    }
    setCustomMode(false)
    setIntervalDraft(null)
    if (val === 'none') { setRecurrence('none'); return }
    setRecInterval(1)
    setRecurrence(val)
    if (!recEnd && !repeatForever) setRecEnd(defaultRecEnd())
    if (val === 'monthly-nth' && date) {
      const dt = new Date(date + 'T12:00:00')
      const weekday = dt.getDay()
      let nth = 0; const tmp = new Date(dt.getFullYear(), dt.getMonth(), 1)
      while (tmp <= dt) { if (tmp.getDay() === weekday) nth++; tmp.setDate(tmp.getDate() + 1) }
      setRecNth(nth); setRecWeekday(weekday)
    }
  }

  const titleRef = useRef(null)
  useEffect(() => { titleRef.current?.focus() }, [])

  // Esc-to-close at the modal level — App.jsx wires its own global
  // Esc handler in D5; for now keep the listener local.
  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function toggleGroup (id) {
    setGroupIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  function handleSave () {
    const t = title.trim()
    if (!t || !date) return
    const ev = {
      id: initial?.id ?? makeEventId(),
      title: t,
      date,
      allDay,
      start: allDay ? '' : start,
      end:   allDay ? '' : end,
      groups: groupIds,
      invitees: initial?.invitees ?? [],
      desc: notes,
      location,
      meetingLink: initial?.meetingLink ?? '',
      color:       initial?.color ?? '',
      colors:      initial?.colors ?? [],
      creatorId:   initial?.creatorId ?? profile?.id ?? 'unknown',
      recurrence,
      recurrenceId:      initial?.recurrenceId ?? '',
      recurrenceEnd:     recurrence === 'none' ? '' : (repeatForever ? '' : recEnd),
      recurrenceNth:     recNth,
      recurrenceWeekday: recWeekday,
      recurrenceInterval: recurrence === 'none' ? 1 : recInterval,
      repeatForever:     recurrence === 'none' ? false : repeatForever,
      editPermission:    initial?.editPermission ?? 'creator',
      // Persist the chosen end day only for multi-day all-day events; a timed
      // event or a single-day all-day event clears it back to ''.
      endDate:           (showEndDate && endDate && endDate !== date) ? endDate : '',
      rsvpEnabled:       initial?.rsvpEnabled ?? false,
    }
    const opts = {}
    if (mode === 'edit' && initial?.date && initial.date !== date) opts._prevDate = initial.date
    // New events inherit the profile's default reminder (matches mobile). The
    // negative fixed-time options aren't auto-applied — only real offsets.
    if (mode === 'create') {
      const dr = typeof profile?.defaultReminder === 'number' ? profile.defaultReminder : 15
      if (dr > 0) opts.reminders = [dr]
    }
    // Editing one occurrence of a series → ask whether to apply to this / future
    // / all before committing (the chosen scope drives regeneration upstream).
    if (mode === 'edit' && initial?.recurrenceId) { setScopePrompt({ ev, opts }); return }
    onSave(ev, opts)
  }

  function handleDelete () {
    if (mode !== 'edit' || !initial?.id) return
    if (!confirm('Delete "' + (initial.title ?? 'this event') + '"?')) return
    onDelete(initial.id)
  }

  const inputBase = {
    width: '100%', padding: '7px 10px', borderRadius: 5,
    fontSize: 13, fontWeight: 400,
    border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
    fontFamily: tokens.font, boxSizing: 'border-box', outline: 'none',
  }

  const label = {
    fontSize: 11, fontWeight: 600, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5,
  }

  const btnBase = {
    padding: '7px 14px', fontSize: 13, fontWeight: 500,
    borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`,
    background: tokens.bg, color: tokens.text,
  }

  // Compute placement once on render. window dimensions can change if
  // the user resizes mid-modal, but for a single-shot popover the
  // initial calculation is good enough; recomputing on resize would
  // also fight the user's instinctive close-on-click-outside.
  const anchorPos = computeAnchorPosition(anchor)
  const overlayStyle = anchorPos
    ? { position: 'fixed', inset: 0, background: 'transparent', zIndex: 100 }
    : { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }
  const panelStyle = anchorPos
    ? {
        position: 'fixed', top: anchorPos.top, left: anchorPos.left,
        width: MODAL_WIDTH, maxHeight: '90vh', overflowY: 'auto',
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20,
        boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
      }
    : {
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20, width: MODAL_WIDTH, maxWidth: '90vw',
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      }

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div onClick={e => e.stopPropagation()} className="pearcal-modal-enter" style={panelStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
          {mode === 'edit' ? 'Edit event' : 'New event'}
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={label}>Title</div>
          <input ref={titleRef} value={title} onChange={e => setTitle(e.target.value)}
                 placeholder="Event title" style={inputBase} />
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={label}>Date</div>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputBase} />
          </div>
          <label style={{
            display: 'flex', alignItems: 'flex-end', gap: 6, paddingBottom: 8,
            fontSize: 13, color: tokens.text, cursor: 'pointer',
          }}>
            <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} />
            All day
          </label>
        </div>

        {!allDay && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={label}>Start</div>
              <TimeSelect tokens={tokens} value={start} use24h={use24h} onChange={handleStartChange} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={label}>End</div>
              <TimeSelect tokens={tokens} value={end} use24h={use24h} onChange={setEnd} />
            </div>
          </div>
        )}

        {showEndDate && (
          <div style={{ marginBottom: 12 }}>
            <div style={label}>End date</div>
            <input type="date" value={endDate || date} min={date}
                   onChange={e => setEndDate(e.target.value === date ? '' : e.target.value)}
                   style={inputBase} />
          </div>
        )}

        {/* Recurrence (parity with mobile — TODO #102) */}
        <div style={{ marginBottom: 12 }}>
          <div style={label}>Repeat</div>
          <select value={customMode ? 'custom' : recurrence}
                  onChange={e => handleFreqChange(e.target.value)} style={inputBase}>
            <option value="none">Does not repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every 2 weeks</option>
            <option value="monthly">Monthly (same date)</option>
            <option value="monthly-nth">Monthly (same weekday)</option>
            <option value="yearly">Yearly</option>
            <option value="custom">Custom…</option>
          </select>
        </div>

        {customMode && (
          <div style={{ marginBottom: 12 }}>
            <div style={label}>Every</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="number" min="1" max="999" inputMode="numeric"
                     style={{ ...inputBase, width: 90 }}
                     value={intervalDraft != null ? intervalDraft : String(recInterval)}
                     onChange={e => {
                       const raw = e.target.value
                       setIntervalDraft(raw)
                       const parsed = parseInt(raw, 10)
                       if (Number.isFinite(parsed) && parsed >= 1) setRecInterval(Math.min(999, parsed))
                     }}
                     onBlur={() => {
                       const parsed = parseInt(intervalDraft ?? '', 10)
                       setRecInterval(Number.isFinite(parsed) ? Math.max(1, Math.min(999, parsed)) : 1)
                       setIntervalDraft(null)
                     }} />
              <select value={recurrence} onChange={e => setRecurrence(e.target.value)}
                      style={{ ...inputBase, flex: 1 }}>
                <option value="daily">{recInterval === 1 ? 'day' : 'days'}</option>
                <option value="weekly">{recInterval === 1 ? 'week' : 'weeks'}</option>
                <option value="monthly">{recInterval === 1 ? 'month' : 'months'}</option>
                <option value="yearly">{recInterval === 1 ? 'year' : 'years'}</option>
              </select>
            </div>
          </div>
        )}

        {isRecurring && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
                            color: tokens.text, cursor: 'pointer', marginBottom: repeatForever ? 0 : 8 }}>
              <input type="checkbox" checked={repeatForever}
                     onChange={e => setRepeatForever(e.target.checked)} />
              Repeat forever
            </label>
            {!repeatForever && (
              <>
                <div style={label}>Repeat until</div>
                <input type="date" value={recEnd} min={date}
                       onChange={e => setRecEnd(e.target.value)} style={inputBase} />
              </>
            )}
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <div style={label}>Groups</div>
          {groups.length === 0 && (
            <div style={{ fontSize: 13, color: tokens.muted }}>
              No groups. Event will be personal-only.
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {groups.map(g => {
              const selected = groupIds.includes(g.id)
              return (
                <button key={g.id} onClick={() => toggleGroup(g.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', borderRadius: 14,
                  background: selected ? (g.color ?? tokens.muted) : 'transparent',
                  color: selected ? tokens.bg : tokens.text,
                  border: `1px solid ${g.color ?? tokens.border}`,
                  fontSize: 12, fontWeight: 500, cursor: 'pointer',
                  fontFamily: tokens.font,
                }}>
                  {g.emoji ? g.emoji + ' ' : ''}{g.name}
                </button>
              )
            })}
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={label}>Location</div>
          <input value={location} onChange={e => setLocation(e.target.value)}
                 placeholder="Optional" style={inputBase} />
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={label}>Notes</div>
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
                    rows={3} placeholder="Optional"
                    style={{ ...inputBase, resize: 'vertical', minHeight: 60 }} />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {mode === 'edit' && (
            <button onClick={handleDelete} style={{
              ...btnBase,
              color: '#C0504A', borderColor: '#C0504A', marginRight: 'auto',
            }}>Delete</button>
          )}
          <button onClick={onClose} style={btnBase}>Cancel</button>
          <button onClick={handleSave} disabled={!title.trim() || !date} style={{
            ...btnBase,
            background: tokens.accent, color: tokens.bg, borderColor: tokens.accent,
            opacity: (!title.trim() || !date) ? 0.5 : 1,
            cursor:  (!title.trim() || !date) ? 'default' : 'pointer',
          }}>{mode === 'edit' ? 'Save' : 'Create'}</button>
        </div>

        {/* Series-edit scope chooser (parity with mobile's bottom sheet) */}
        {scopePrompt && (
          <div onClick={() => setScopePrompt(null)}
               style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 110,
                        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div onClick={e => e.stopPropagation()}
                 style={{ background: tokens.surface, border: `1px solid ${tokens.border}`,
                          borderRadius: 10, padding: 20, width: 320, maxWidth: '90vw',
                          boxShadow: '0 12px 40px rgba(0,0,0,0.5)' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Apply changes to…</div>
              <div style={{ fontSize: 12, color: tokens.muted, marginBottom: 14 }}>
                This is a repeating event.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[['one', 'This event only'], ['future', 'This and following events'], ['all', 'All events in the series']].map(([s, lbl]) => (
                  <button key={s}
                          onClick={() => { const p = scopePrompt; setScopePrompt(null); onSave(p.ev, { ...p.opts, scope: s }) }}
                          style={{ ...btnBase, textAlign: 'left', padding: '9px 12px' }}>
                    {lbl}
                  </button>
                ))}
                <button onClick={() => setScopePrompt(null)}
                        style={{ ...btnBase, textAlign: 'center', marginTop: 4, opacity: 0.7 }}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// 24h-aware time picker. Native <input type="time"> displays in the OS
// locale's preferred format (12h with AM/PM in en-US Chromium), which
// ignores the user's profile.use24h setting. Custom 2- or 3-select
// picker honors use24h regardless of locale. Underlying value contract
// is unchanged: always "HH:MM" 24h.
function TimeSelect ({ tokens, value, use24h, onChange }) {
  const [h, m] = (value || '00:00').split(':').map(Number)
  function fire (newH, newM) {
    onChange(String(newH).padStart(2, '0') + ':' + String(newM).padStart(2, '0'))
  }
  const sel = {
    padding: '7px 8px', fontSize: 13, fontWeight: 400,
    border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
    fontFamily: tokens.font, outline: 'none', borderRadius: 5,
    appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
    cursor: 'pointer',
  }
  if (use24h) {
    return (
      <div style={{ display: 'flex', gap: 4 }}>
        <select value={h} onChange={e => fire(parseInt(e.target.value, 10), m)} style={{ ...sel, flex: 1 }}>
          {Array.from({ length: 24 }, (_, i) => (
            <option key={i} value={i}>{String(i).padStart(2, '0')}</option>
          ))}
        </select>
        <select value={m} onChange={e => fire(h, parseInt(e.target.value, 10))} style={{ ...sel, flex: 1 }}>
          {Array.from({ length: 60 }, (_, i) => (
            <option key={i} value={i}>{String(i).padStart(2, '0')}</option>
          ))}
        </select>
      </div>
    )
  }
  // 12h: hour (1..12), minute, AM/PM
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12  = h % 12 === 0 ? 12 : h % 12
  function setH12 (newH12) {
    let newH = newH12 % 12
    if (ampm === 'pm') newH += 12
    fire(newH, m)
  }
  function setAmPm (newAmPm) {
    let newH = h12 % 12
    if (newAmPm === 'pm') newH += 12
    fire(newH, m)
  }
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <select value={h12} onChange={e => setH12(parseInt(e.target.value, 10))} style={{ ...sel, flex: 1 }}>
        {Array.from({ length: 12 }, (_, i) => (
          <option key={i} value={i + 1}>{i + 1}</option>
        ))}
      </select>
      <select value={m} onChange={e => fire(h, parseInt(e.target.value, 10))} style={{ ...sel, flex: 1 }}>
        {Array.from({ length: 60 }, (_, i) => (
          <option key={i} value={i}>{String(i).padStart(2, '0')}</option>
        ))}
      </select>
      <select value={ampm} onChange={e => setAmPm(e.target.value)} style={{ ...sel, width: 60 }}>
        <option value="am">AM</option>
        <option value="pm">PM</option>
      </select>
    </div>
  )
}

// #162 — the desktop had no edit lock, so an event locked to its creator could
// be rewritten (and synced to the whole group) by anyone. These cover the pure
// rule the four desktop mutation paths now share.
// (bugfix/desktop-event-edit-lock)
const test = require('node:test')
const assert = require('node:assert/strict')
const { canEditEvent, isHolidayEvent } = require('../src/ui-desktop/lib/eventPermissions.js')

const ME    = 'me-0000000000000000'
const OTHER = 'other-000000000000'

// ── the case that caused the bug ──────────────────────────────────────────
test('a creator-locked event belonging to someone else is not editable', () => {
  assert.equal(canEditEvent({ creatorId: OTHER, editPermission: 'creator' }, ME), false)
})
test('a creator-locked event belonging to me is editable', () => {
  assert.equal(canEditEvent({ creatorId: ME, editPermission: 'creator' }, ME), true)
})

// ── the permission the creator can grant ──────────────────────────────────
test("'everyone' lets any member edit someone else's event", () => {
  assert.equal(canEditEvent({ creatorId: OTHER, editPermission: 'everyone' }, ME), true)
})

// ── must not retroactively lock existing calendars ────────────────────────
test('an event with no editPermission stays editable, matching mobile', () => {
  // Mobile compares `ev.editPermission === 'creator'`, so undefined is unlocked.
  // Locking these would freeze every event written before the field existed.
  assert.equal(canEditEvent({ creatorId: OTHER }, ME), true)
})
test('an event with no creatorId is editable — nobody claims it', () => {
  assert.equal(canEditEvent({ editPermission: 'creator' }, ME), true)
})

// ── generated holidays belong to nobody ───────────────────────────────────
test('a holiday is never editable, whatever its permission says', () => {
  assert.equal(canEditEvent({ creatorId: 'system', editPermission: 'everyone' }, ME), false)
  assert.equal(canEditEvent({ creatorId: 'system', editPermission: 'creator' }, 'system'), false)
})
test('isHolidayEvent keys off the system creator id', () => {
  assert.equal(isHolidayEvent({ creatorId: 'system' }), true)
  assert.equal(isHolidayEvent({ creatorId: ME }), false)
  assert.equal(isHolidayEvent(null), false)
})

// ── defensive: a missing profile must not grant access ────────────────────
test('no profile id cannot satisfy a creator lock', () => {
  // Before the profile loads, `profile?.id` is undefined. Comparing
  // undefined === undefined would otherwise hand out edit rights on an event
  // whose creatorId was also missing — that path is covered above, but an
  // event WITH a creator must stay locked.
  assert.equal(canEditEvent({ creatorId: OTHER, editPermission: 'creator' }, undefined), false)
})
test('a null event is not editable', () => {
  assert.equal(canEditEvent(null, ME), false)
})

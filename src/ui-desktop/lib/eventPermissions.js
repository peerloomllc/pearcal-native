// Who is allowed to change a shared event — one rule, one place.
//
// An event whose creator chose "Only me" (`editPermission: 'creator'`) belongs
// to that creator, and a generated public holiday (`creatorId: 'system'`)
// belongs to nobody. Mobile enforces this once, inside its single event form
// (`isReadOnly` / `formLocked`, src/ui/App.jsx:4220 and :4264).
//
// Desktop has FOUR ways to mutate an event — the modal, the inspector popover,
// the right-click menu and drag-to-move/resize — and had the check on none of
// them (#162). Every one of them routes through `saveEvent`/`deleteEvent`,
// which write locally AND fan out to each group the event is in, so editing
// someone else's event left this machine holding a version of it that no other
// device agreed with. Found in the field on 2026-08-08: dragging a family
// member's locked event to a new time looked like it worked and then looked
// like it "didn't sync".
//
// Events written before `editPermission` existed carry no value for it and stay
// editable, which is what mobile does too — this must not retroactively lock
// old calendars.
export function canEditEvent (ev, profileId) {
  if (!ev) return false
  if (ev.creatorId === 'system') return false      // generated holiday
  if (ev.editPermission !== 'creator') return true // 'everyone', or absent
  if (!ev.creatorId) return true                   // nobody claims it
  return !!profileId && ev.creatorId === profileId
}

export function isHolidayEvent (ev) {
  return !!ev && ev.creatorId === 'system'
}

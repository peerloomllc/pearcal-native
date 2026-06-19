// Reminder offset presets shared by the desktop Settings and Event modals.
// Values are "minutes before the event"; the two negatives are fixed-time
// tokens (9 AM morning-of / day-before) that the scheduler special-cases.
export const MORNING_OF = -1
export const DAY_BEFORE = -2

export const REMINDER_OPTIONS = [
  { label: '5 min before',      value: 5 },
  { label: '10 min before',     value: 10 },
  { label: '15 min before',     value: 15 },
  { label: '30 min before',     value: 30 },
  { label: '1 hour before',     value: 60 },
  { label: '2 hours before',    value: 120 },
  { label: 'Morning of (9 AM)', value: MORNING_OF },
  { label: 'Day before (9 AM)', value: DAY_BEFORE },
  { label: '1 day before',      value: 1440 },
  { label: '1 week before',     value: 10080 },
  { label: '2 weeks before',    value: 20160 },
]

// Screenshot-mode fixtures. Activated when window.__PEARCAL_SCREENSHOT_SCENE is set
// before this bundle runs. Replaces the RN/Bare bridge with canned data and freezes
// "today" to FROZEN_TODAY so the calendar always renders the same.
//
// Scenes:
//   1 — Month view (hero)
//   2 — Event detail modal (Bitcoin Meetup on Jan 6)
//   3 — Groups list
//   4 — Invite / QR for Bitcoin group
//   5 — Day view on Jan 6

export const FROZEN_TODAY = '2027-01-03'  // Sunday — Bitcoin genesis block anniversary
const FROZEN_MS = new Date(FROZEN_TODAY + 'T10:15:00').getTime()

const ME = { id: 'u-satoshi', name: 'Satoshi Nakamoto', avatar: 'SN' }

// ─── People ──────────────────────────────────────────────────────────────────
const HAL       = { id: 'u-hal',       name: 'Hal Finney',       avatar: 'HF' }
const ADAM      = { id: 'u-adam',      name: 'Adam Back',        avatar: 'AB' }
const NICK      = { id: 'u-nick',      name: 'Nick Szabo',       avatar: 'NS' }
const LAURA     = { id: 'u-laura',     name: 'Laura',            avatar: 'L'  }
const AIKO      = { id: 'u-aiko',      name: 'Aiko',             avatar: 'A'  }
const KENJI     = { id: 'u-kenji',     name: 'Kenji',            avatar: 'K'  }
const REN       = { id: 'u-ren',       name: 'Ren',              avatar: 'R'  }
const MAYA      = { id: 'u-maya',      name: 'Maya Chen',        avatar: 'MC' }
const DIEGO     = { id: 'u-diego',     name: 'Diego Ruiz',       avatar: 'DR' }
const PRIYA     = { id: 'u-priya',     name: 'Priya Patel',      avatar: 'PP' }
const JAMIE     = { id: 'u-jamie',     name: 'Jamie Torres',     avatar: 'JT' }
const ELI       = { id: 'u-eli',       name: 'Eli Weiss',        avatar: 'EW' }
const ANDREAS   = { id: 'u-andreas',   name: 'Andreas',          avatar: 'A'  }
const JAMESON   = { id: 'u-jameson',   name: 'Jameson',          avatar: 'J'  }

// ─── Groups ──────────────────────────────────────────────────────────────────
const G_FAMILY = {
  id: 'g-family', name: 'Family', emoji: '🏡', color: '#6C9BF5',
  ownerId: ME.id,
  members: [ME, AIKO, KENJI, REN],
  groupKey: 'f1a2b3c4d5e6f7081928374655647382910abcdef1234567890fedcba9876543',
  removedMembers: [],
}
const G_WORK = {
  id: 'g-work', name: 'Work', emoji: '💼', color: '#5DBF8A',
  ownerId: ME.id,
  members: [ME, HAL, MAYA, DIEGO, PRIYA, JAMIE],
  groupKey: 'a9b8c7d6e5f4032110fedcba9876543210abcdef0123456789fedcba98765432',
  removedMembers: [],
}
const G_BITCOIN = {
  id: 'g-bitcoin', name: 'Bitcoin', emoji: '₿', color: '#F7931A',
  ownerId: ME.id,
  members: [ME, HAL, ADAM, NICK, ANDREAS, ELI],
  groupKey: 'b17c017b17c017b17c017b17c017b17c017b17c017b17c017b17c017b17c017b',
  removedMembers: [],
}

const GROUPS = [G_FAMILY, G_WORK, G_BITCOIN]

// ─── Events ──────────────────────────────────────────────────────────────────
// Helper to build an event with sensible defaults
function ev (id, date, title, { allDay = false, start = '', end = '', groups = [], desc = '', location = '', meetingLink = '', endDate = '', rsvpEnabled = false, recurrence = 'none', creatorId = ME.id, invitees = [] } = {}) {
  const gObj = groups[0] ? GROUPS.find(g => g.id === groups[0]) : null
  const color = gObj?.color ?? '#6C9BF5'
  const colors = groups.map(gid => GROUPS.find(g => g.id === gid)?.color).filter(Boolean)
  return {
    id, title, date, allDay, start, end,
    groups, invitees, color, colors,
    reminder: 15, desc, location, meetingLink,
    creatorId,
    recurrence, recurrenceId: '', recurrenceEnd: '', recurrenceNth: 0, recurrenceWeekday: 0,
    editPermission: 'everyone', endDate, rsvpEnabled,
    updatedAt: FROZEN_MS - 86400000,
  }
}

const BITCOIN_MEETUP_ID = 'e-btc-meetup-0103'

const EVENTS = [
  ev('e-church-0103',   '2027-01-03', 'Church',               { start: '10:30', end: '12:00', location: 'Grace Cathedral' }),

  // Week of Jan 4 – Jan 10
  ev('e-run-0104',      '2027-01-04', 'Morning Run',          { start: '07:00', end: '07:45' }),
  ev('e-1on1-0105',     '2027-01-05', '1:1 with Hal',         { start: '10:30', end: '11:00', groups: ['g-work'], location: 'Zoom', meetingLink: 'https://zoom.us/j/1234567890' }),
  ev('e-standup-0106',  '2027-01-06', 'Team Standup',         { start: '09:00', end: '09:30', groups: ['g-work'], meetingLink: 'https://meet.google.com/abc-defg-hij' }),
  ev('e-dentist-0106',  '2027-01-06', 'Dentist',              { start: '14:00', end: '15:00', location: '400 Market St, SF' }),
  ev(BITCOIN_MEETUP_ID, '2027-01-03', 'Bitcoin Meetup',       {
    start: '17:30', end: '19:00',
    groups: ['g-bitcoin'],
    location: 'The Blockchain Pub, 2121 Mission St',
    meetingLink: 'https://meet.jit.si/bitcoin-meetup-sf',
    desc: 'Monthly SF Bitcoin meetup. Topic this month: Covenants and OP_CTV. Pizza + beer sponsored by BitGo.',
    rsvpEnabled: true,
  }),
  ev('e-moms-bday',     '2027-01-07', "Mom's Birthday",       { allDay: true, groups: ['g-family'] }),
  ev('e-kickoff-0108',  '2027-01-08', 'Project Genesis Kickoff', { start: '13:00', end: '15:00', groups: ['g-work'], location: 'Conference Room A', meetingLink: 'https://meet.google.com/xyz-abcd-efg' }),
  ev('e-ski-0109',      '2027-01-09', 'Ski Trip',             { allDay: true, groups: ['g-family'], endDate: '2027-01-11', location: 'Lake Tahoe' }),

  // Week of Jan 11 – Jan 17
  ev('e-run-0111',      '2027-01-11', 'Morning Run',          { start: '07:00', end: '07:45' }),
  ev('e-standup-0111',  '2027-01-11', 'Team Standup',         { start: '09:00', end: '09:30', groups: ['g-work'] }),
  ev('e-ln-workshop',   '2027-01-12', 'Lightning Workshop',   { start: '19:00', end: '21:00', groups: ['g-bitcoin'], meetingLink: 'https://meet.jit.si/ln-workshop' }),
  ev('e-lunch-0114',    '2027-01-14', 'Lunch with Hal',       { start: '12:30', end: '13:30', location: 'Blue Bottle, Mint Plaza' }),
  ev('e-planning-0115', '2027-01-15', 'Q1 Planning',          { start: '15:00', end: '16:30', groups: ['g-work'] }),
  ev('e-brunch-0117',   '2027-01-17', 'Family Brunch',        { start: '10:00', end: '12:00', groups: ['g-family'], location: 'Zazie' }),

  // Week of Jan 18 – Jan 24
  ev('e-mlk',           '2027-01-18', 'Martin Luther King Jr. Day', { allDay: true, creatorId: 'system', desc: 'Public Holiday' }),
  ev('e-standup-0120',  '2027-01-20', 'Team Standup',         { start: '09:00', end: '09:30', groups: ['g-work'] }),
  ev('e-book-0120',     '2027-01-20', 'Book Club: Bitcoin Standard', { start: '19:00', end: '20:30', groups: ['g-bitcoin'] }),
  ev('e-review-0121',   '2027-01-21', 'Design Review',        { start: '09:00', end: '10:00', groups: ['g-work'] }),
  ev('e-parents-0123',  '2027-01-23', 'Parents Visiting',     { allDay: true, groups: ['g-family'], endDate: '2027-01-24' }),

  // Week of Jan 25 – Jan 31
  ev('e-standup-0127',  '2027-01-27', 'Team Standup',         { start: '09:00', end: '09:30', groups: ['g-work'] }),
  ev('e-movie-0129',    '2027-01-29', 'Movie Night',          { start: '20:00', end: '22:00', groups: ['g-family'] }),
]

// Color map for fast lookup
const COLOR_BY_GID = Object.fromEntries(GROUPS.map(g => [g.id, g.color]))

// ─── Profile ─────────────────────────────────────────────────────────────────
const PROFILE = {
  id: ME.id,
  name: ME.name,
  avatar: ME.avatar,
  use24h: false,
  weekStart: 0,
  holidayCountries: ['us'],
  defaultReminder: 15,
  onboardingComplete: true,
}

// ─── Reminders / RSVPs ───────────────────────────────────────────────────────
const REMINDERS_BY_EVENT = {
  [BITCOIN_MEETUP_ID]: [60, 15],
}

const RSVPS_BY_EVENT = {
  [BITCOIN_MEETUP_ID]: [
    { eventId: BITCOIN_MEETUP_ID, memberId: HAL.id,     status: 'going',    updatedAt: FROZEN_MS },
    { eventId: BITCOIN_MEETUP_ID, memberId: ADAM.id,    status: 'going',    updatedAt: FROZEN_MS },
    { eventId: BITCOIN_MEETUP_ID, memberId: NICK.id,    status: 'going',    updatedAt: FROZEN_MS },
    { eventId: BITCOIN_MEETUP_ID, memberId: ANDREAS.id, status: 'going',    updatedAt: FROZEN_MS },
    { eventId: BITCOIN_MEETUP_ID, memberId: ELI.id,     status: 'declined', updatedAt: FROZEN_MS },
  ],
}

// ─── Scene definitions ───────────────────────────────────────────────────────
export const SCENES = {
  1: { tab: 'calendar', calendarView: 'month', date: FROZEN_TODAY },
  2: { tab: 'calendar', calendarView: 'month', date: FROZEN_TODAY, openEventId: BITCOIN_MEETUP_ID },
  3: { tab: 'groups' },
  4: { tab: 'groups', openInviteGroupId: 'g-bitcoin' },
  5: { tab: 'calendar', calendarView: 'day',   date: FROZEN_TODAY },
}

// ─── Date freeze ─────────────────────────────────────────────────────────────
function freezeDate () {
  const OrigDate = window.Date
  const FrozenDate = function (...args) {
    if (args.length === 0) return new OrigDate(FROZEN_MS)
    return new OrigDate(...args)
  }
  FrozenDate.now = () => FROZEN_MS
  FrozenDate.parse = OrigDate.parse
  FrozenDate.UTC = OrigDate.UTC
  FrozenDate.prototype = OrigDate.prototype
  window.Date = FrozenDate
}

// ─── Fake DB / sync / notifs ─────────────────────────────────────────────────
function resolve (v) { return Promise.resolve(v) }

function makeDb () {
  return {
    getProfile:            () => resolve(PROFILE),
    updateProfile:         () => resolve(true),
    listEvents:            () => resolve(EVENTS),
    putEvent:              () => resolve(true),
    deleteEvent:           () => resolve(true),
    deleteEventSeries:     () => resolve(true),
    localDeleteEvent:      () => resolve(true),
    getGroup:              (id) => resolve(GROUPS.find(g => g.id === id) ?? null),
    listGroups:            () => resolve(GROUPS),
    putGroup:              () => resolve(true),
    deleteGroup:           () => resolve(true),
    isBlockedFromGroup:    () => resolve(false),
    clearBlockedFromGroup: () => resolve(true),
    reinviteMember:        () => resolve(null),
    listMembers:           (gid) => resolve(GROUPS.find(g => g.id === gid)?.members ?? []),
    putMember:             () => resolve(true),
    removeMember:          () => resolve(true),
    resyncGroup:           () => resolve(true),
    setMemberNickname:     () => resolve(true),
    getReminders:          (id) => resolve(REMINDERS_BY_EVENT[id] ?? []),
    putReminders:          () => resolve(true),
    getRsvp:               (eid, mid) => resolve((RSVPS_BY_EVENT[eid] ?? []).find(r => r.memberId === mid) ?? null),
    listRsvps:             (eid) => resolve(RSVPS_BY_EVENT[eid] ?? []),
    listMyRsvps:           () => resolve({}),
    putRsvp:               () => resolve(true),
    getBlindPeerKey:       () => resolve(null),
    setBlindPeerKey:       () => resolve(true),
    removeBlindPeerKey:    () => resolve(true),
  }
}

function makeNotifs () {
  return {
    scheduleForEvent: () => resolve(true),
    cancelForEvent:   () => resolve(true),
    restoreAll:       () => resolve(true),
  }
}

function makeSync () {
  return {
    joinGroup:   () => resolve(true),
    leaveGroup:  () => resolve(true),
    deleteGroup: () => resolve(true),
    putEvent:    () => resolve(true),
    deleteEvent: () => resolve(true),
    putGroup:    () => resolve(true),
    memberLeft:  () => resolve(true),
    purgeMember: () => resolve(true),
    debugGroup:  () => resolve(true),
    nativeShare: () => resolve(true),
    exportIcs:   () => resolve(true),
    qrScan:      () => resolve(null),
    takePhoto:   () => resolve(null),
    haptic:      () => resolve(true),
    openURL:     () => resolve(true),
    canOpenLightning: () => resolve(false),
    openLightning: () => resolve(true),
  }
}

export function installFixtures (sceneNum) {
  const scene = SCENES[sceneNum]
  if (!scene) {
    console.warn('[screenshot] unknown scene', sceneNum)
    return null
  }
  freezeDate()
  window.__pearScreenshotScene = scene
  return { db: makeDb(), sync: makeSync(), notifs: makeNotifs(), scene }
}

// GitHub #400 - show who added a shared event. Pure lookup in
// src/ui-shared/lib/addedBy.js. (feature/event-added-by)
const test = require('node:test')
const assert = require('node:assert/strict')

const ME = 'me'
const groups = [
  { id: 'g1', members: [{ id: ME, name: 'Tim' }, { id: 'sam', name: 'Sam' }, { id: 'al', name: 'Alex', nickname: 'Al' }] },
  { id: 'g2', members: [{ id: ME, name: 'Tim' }, { id: 'inv', name: 'Inviter', avatar: '?' }] },
]
const ev = (over) => ({ id: 'e1', title: 'Dinner', groups: ['g1'], creatorId: 'sam', ...over })

test('#400: names the member who added a group event', async () => {
  const { eventAddedByName } = await import('../src/ui-shared/lib/addedBy.js')
  assert.equal(eventAddedByName(ev(), groups, ME), 'Sam')
  assert.equal(eventAddedByName(ev({ creatorId: 'al' }), groups, ME), 'Al', 'uses the group nickname')
})

test('shows nothing for my own, personal, holiday and shadow events', async () => {
  const { eventAddedByName } = await import('../src/ui-shared/lib/addedBy.js')
  assert.equal(eventAddedByName(ev({ creatorId: ME }), groups, ME), null)
  assert.equal(eventAddedByName(ev({ groups: [] }), groups, ME), null)
  assert.equal(eventAddedByName(ev({ creatorId: 'system' }), groups, ME), null)
  assert.equal(eventAddedByName(ev({ isShadow: true }), groups, ME), null)
  assert.equal(eventAddedByName(ev({ creatorId: undefined }), groups, ME), null)
})

test('skips the invite placeholder and falls back to the saved editor name', async () => {
  const { eventAddedByName } = await import('../src/ui-shared/lib/addedBy.js')
  assert.equal(eventAddedByName(ev({ groups: ['g2'], creatorId: 'inv' }), groups, ME), null)
  assert.equal(eventAddedByName(ev({ creatorId: 'gone', updatedById: 'gone', updatedByName: 'Pat' }), groups, ME), 'Pat')
  assert.equal(eventAddedByName(ev({ creatorId: 'gone', updatedById: 'sam', updatedByName: 'Sam' }), groups, ME), null)
})

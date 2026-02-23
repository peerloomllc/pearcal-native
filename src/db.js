import Hypercore from 'hypercore'
import Hyperbee from 'hyperbee'
import { generateKeypair, keyToHex } from './lib/crypto.js'

// ─── Key namespaces ──────────────────────────────────────────────────────────
const NS = {
  profile:       'profile',               // profile (singleton)
  events:        'events:',              // events:{YYYY-MM-DD}:{id}
  groups:        'groups:',              // groups:{id}
  members:       'members:',             // members:{groupId}:{userId}
  notifications: 'notifications:',       // notifications:{eventId}
}

export class PearCalDB {
  constructor (storagePath = './data') {
    this._path  = storagePath
    this.core   = null
    this.db     = null
  }

  async ready () {
    this.core = new Hypercore(this._path + '/core', { valueEncoding: 'json' })
    await this.core.ready()
    this.db = new Hyperbee(this.core, {
      keyEncoding:   'utf-8',
      valueEncoding: 'json',
    })
    await this.db.ready()

    // Bootstrap profile on first launch
    const existing = await this.db.get(NS.profile)
    if (!existing) {
      const { publicKey, secretKey } = generateKeypair()
      await this.db.put(NS.profile, {
        id:        keyToHex(publicKey),
        name:      'My Name',
        avatar:    '',          // base64 image or initials fallback
        publicKey: keyToHex(publicKey),
        secretKey: keyToHex(secretKey),  // never leaves the device
        createdAt: Date.now(),
      })
    }
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  async getProfile () {
    const node = await this.db.get(NS.profile)
    return node?.value ?? null
  }

  async updateProfile (updates) {
    const current = await this.getProfile()
    await this.db.put(NS.profile, { ...current, ...updates, updatedAt: Date.now() })
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  /**
   * List all events. Optionally filter by date range or group.
   * @param {{ from?: string, to?: string, groupId?: string }} opts
   * @returns {Promise<object[]>}
   */
  async listEvents ({ from, to, groupId } = {}) {
    const gt = NS.events + (from ?? '')
    const lt = NS.events + (to ? to + '\xff' : '\xff')
    const events = []
    for await (const { value } of this.db.createReadStream({ gt, lt })) {
      if (groupId && !value.groups?.includes(groupId)) continue
      events.push(value)
    }
    return events
  }

  async getEvent (date, id) {
    const node = await this.db.get(`${NS.events}${date}:${id}`)
    return node?.value ?? null
  }

  async putEvent (event) {
    const key = `${NS.events}${event.date}:${event.id}`
    await this.db.put(key, { ...event, updatedAt: Date.now() })
    return event
  }

  async deleteEvent (date, id) {
    await this.db.del(`${NS.events}${date}:${id}`)
  }

  // ─── Groups ───────────────────────────────────────────────────────────────

  async listGroups () {
    const groups = []
    for await (const { value } of this.db.createReadStream({
      gt: NS.groups, lt: NS.groups + '\xff',
    })) {
      groups.push(value)
    }
    return groups
  }

  async getGroup (id) {
    const node = await this.db.get(NS.groups + id)
    return node?.value ?? null
  }

  async putGroup (group) {
    await this.db.put(NS.groups + group.id, { ...group, updatedAt: Date.now() })
    return group
  }

  async deleteGroup (id) {
    await this.db.del(NS.groups + id)
    // Also remove all member entries for this group
    for await (const { key } of this.db.createReadStream({
      gt: NS.members + id, lt: NS.members + id + '\xff',
    })) {
      await this.db.del(key)
    }
  }

  // ─── Members ──────────────────────────────────────────────────────────────

  async listMembers (groupId) {
    const members = []
    for await (const { value } of this.db.createReadStream({
      gt: NS.members + groupId + ':', lt: NS.members + groupId + ':\xff',
    })) {
      members.push(value)
    }
    return members
  }

  async putMember (groupId, member) {
    const key = `${NS.members}${groupId}:${member.id}`
    await this.db.put(key, { ...member, groupId, updatedAt: Date.now() })
  }

  async removeMember (groupId, memberId) {
    await this.db.del(`${NS.members}${groupId}:${memberId}`)
  }

  // ─── Notifications (used by NotificationScheduler) ────────────────────────

  async putNotification (eventId, notif) {
    await this.db.put(NS.notifications + eventId, notif)
  }

  async getNotification (eventId) {
    const node = await this.db.get(NS.notifications + eventId)
    return node?.value ?? null
  }

  async deleteNotification (eventId) {
    await this.db.del(NS.notifications + eventId)
  }

  async listNotifications () {
    const notifs = []
    for await (const { value } of this.db.createReadStream({
      gt: NS.notifications, lt: NS.notifications + '\xff',
    })) {
      notifs.push(value)
    }
    return notifs
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────

  async close () {
    await this.db.close()
    await this.core.close()
  }
}
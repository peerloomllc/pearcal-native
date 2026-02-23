/**
 * PearCal — SyncManager
 *
 * Each Peer Group is backed by an Autobase — a multi-writer log that
 * merges all members' Hypercore feeds into one linearised view.
 *
 * Topology:
 *   - Each user has one local Hypercore (their "writer feed")
 *   - Each Peer Group has one Autobase keyed by the group's public key
 *   - Hyperswarm connects members in the same group via DHT topic = groupKey
 *   - On connect, peers exchange their writer feed keys and replicate
 */

import Hyperswarm  from 'hyperswarm'
import Autobase    from 'autobase'
import Hyperbee    from 'hyperbee'
import Hypercore   from 'hypercore'
import b4a         from 'b4a'

export class SyncManager {
  /**
   * @param {import('./db.js').PearCalDB} db
   * @param {{ publicKey: string, secretKey: string }} profile
   */
  constructor (db, profile) {
    this.db       = db
    this.profile  = profile
    this.swarm    = new Hyperswarm()
    this.bases    = new Map()   // groupId → Autobase
    this.cores    = new Map()   // groupId → local writer Hypercore

    this._onPeer = this._onPeer.bind(this)
    this.swarm.on('connection', this._onPeer)
  }

  // ─── Join ──────────────────────────────────────────────────────────────────

  /**
   * Join the swarm topic for every group the user is a member of.
   * @param {object[]} groups
   */
  async joinAll (groups) {
    await Promise.all(groups.map(g => this.joinGroup(g)))
  }

  /**
   * Join (or re-join) a single group's swarm topic.
   * @param {object} group
   */
  async joinGroup (group) {
    if (this.bases.has(group.id)) return   // already joined

    // Each group gets its own local writer core
    const writerCore = new Hypercore(
      `./data/groups/${group.id}/writer`,
      { valueEncoding: 'json' }
    )
    await writerCore.ready()
    this.cores.set(group.id, writerCore)

    // Autobase — open with this device's writer core
    const base = new Autobase([writerCore], {
      open:  store => new Hyperbee(store, { keyEncoding: 'utf-8', valueEncoding: 'json' }),
      apply: applyOp,
    })
    await base.ready()
    this.bases.set(group.id, base)

    // Announce + discover peers on the DHT using the group key as the topic
    const topic = b4a.from(group.id.padEnd(32, '0').slice(0, 32))
    const discovery = this.swarm.join(topic, { server: true, client: true })
    await discovery.flushed()
  }

  /**
   * Leave a group's swarm topic and close its Autobase.
   * @param {string} groupId
   */
  async leaveGroup (groupId) {
    const base = this.bases.get(groupId)
    if (base) { await base.close(); this.bases.delete(groupId) }
    const core = this.cores.get(groupId)
    if (core) { await core.close(); this.cores.delete(groupId) }
  }

  // ─── Write operations (append to Autobase) ────────────────────────────────

  /**
   * Append a put-event operation to the group's Autobase.
   * @param {string} groupId
   * @param {object} event
   */
  async putEvent (groupId, event) {
    const base = this.bases.get(groupId)
    if (!base) throw new Error(`Not in group: ${groupId}`)
    await base.append({ op: 'put', type: 'event', key: `events:${event.date}:${event.id}`, value: event })
  }

  async deleteEvent (groupId, eventId, date) {
    const base = this.bases.get(groupId)
    if (!base) throw new Error(`Not in group: ${groupId}`)
    await base.append({ op: 'del', type: 'event', key: `events:${date}:${eventId}` })
  }

  async putGroup (group) {
    const base = this.bases.get(group.id)
    if (!base) throw new Error(`Not in group: ${group.id}`)
    await base.append({ op: 'put', type: 'group', key: `groups:${group.id}`, value: group })
  }

  // ─── Peer connection handler ───────────────────────────────────────────────

  async _onPeer (conn, info) {
    // Identify which group this connection belongs to via the topic
    const topicHex = b4a.toString(info.topics[0] ?? b4a.alloc(32), 'hex')
    const groupId  = [...this.bases.keys()].find(id =>
      id.padEnd(32, '0').slice(0, 32) === topicHex.slice(0, 32)
    )
    if (!groupId) return conn.destroy()

    const base = this.bases.get(groupId)
    if (!base) return conn.destroy()

    // Exchange writer feed keys and start replication
    // Autobase handles multi-writer merge automatically
    base.replicate(conn)
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────

  async destroy () {
    await this.swarm.destroy()
    for (const base of this.bases.values()) await base.close()
    for (const core of this.cores.values()) await core.close()
    this.bases.clear()
    this.cores.clear()
  }
}

// ─── Autobase apply function ─────────────────────────────────────────────────
// Called by Autobase when linearising concurrent writes from multiple peers.
// Applies each op to the shared Hyperbee view.

async function applyOp (nodes, view, host) {
  for (const node of nodes) {
    const { op, key, value } = node.value
    if (op === 'put')      await view.put(key, value)
    else if (op === 'del') await view.del(key)
  }
}

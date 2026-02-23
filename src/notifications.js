/**
 * PearCal — Notification Scheduler
 *
 * Architecture:
 *   - Notifications are stored in Hyperbee under `notifications:{eventId}`
 *   - On app launch, all pending notifications are re-registered with Android
 *   - Scheduling uses Pear's native Android bridge → AlarmManager
 *   - Web Notifications API is used as a fallback (foreground only)
 *
 * Pear native bridge surface used:
 *   Pear.notifications.schedule(opts)   → schedules an AlarmManager alarm
 *   Pear.notifications.cancel(id)       → cancels a pending alarm
 *   Pear.notifications.cancelAll()      → cancels all pending alarms
 *   Pear.notifications.getPermission()  → returns 'granted' | 'denied' | 'prompt'
 *   Pear.notifications.requestPermission() → triggers Android permission dialog
 */

import Hyperbee from 'hyperbee'

const NS = 'notifications:'   // Hyperbee key namespace

export class NotificationScheduler {
  /**
   * @param {Hyperbee} db  — the app's Hyperbee instance
   */
  constructor (db) {
    this.db = db
    this.native = globalThis.Pear?.notifications ?? null   // null in dev/browser
    this.webNotif = ('Notification' in globalThis)         // Web Notifications API
  }

  // ─── Permission ────────────────────────────────────────────────────────────

  async requestPermission () {
    // Native Android (POST_NOTIFICATIONS, required Android 13+)
    if (this.native) {
      const status = await this.native.getPermission()
      if (status !== 'granted') {
        return await this.native.requestPermission()
      }
      return status
    }

    // Web Notifications fallback (dev / desktop)
    if (this.webNotif) {
      return await Notification.requestPermission()
    }

    return 'denied'
  }

  async hasPermission () {
    if (this.native) {
      return (await this.native.getPermission()) === 'granted'
    }
    if (this.webNotif) {
      return Notification.permission === 'granted'
    }
    return false
  }

  // ─── Schedule ──────────────────────────────────────────────────────────────

  /**
   * Schedule (or reschedule) a notification for a single event.
   *
   * @param {object} event
   * @param {string} event.id
   * @param {string} event.title
   * @param {string} event.date       — 'YYYY-MM-DD'
   * @param {string} event.start      — 'HH:MM' (ignored when allDay)
   * @param {boolean} event.allDay
   * @param {number}  event.reminder  — minutes before event start (0 = no reminder)
   * @param {string}  event.desc
   */
  async scheduleForEvent (event) {
    if (!event.reminder || event.reminder === 0) {
      await this.cancelForEvent(event.id)
      return
    }

    const fireAt = this._calcFireTime(event)
    if (!fireAt || fireAt <= Date.now()) return   // already past

    const notif = {
      id:       this._notifId(event.id),
      eventId:  event.id,
      title:    '📅 ' + event.title,
      body:     this._buildBody(event),
      fireAt,   // Unix ms timestamp
      scheduled: Date.now(),
    }

    // Persist to Hyperbee so we can restore after app restart
    await this.db.put(NS + event.id, JSON.stringify(notif))

    // Register with Android AlarmManager via Pear native bridge
    if (this.native) {
      await this.native.schedule({
        id:      notif.id,
        title:   notif.title,
        body:    notif.body,
        fireAt:  notif.fireAt,
        // Android notification channel (created in MainActivity setup)
        channelId: 'pearcal_reminders',
        // Deep link back into the app when notification is tapped
        data: { action: 'open_event', eventId: event.id },
      })
      return
    }

    // Web Notifications fallback — setTimeout (foreground only, dev use)
    this._scheduleWebNotif(notif)
  }

  /**
   * Schedule notifications for multiple events at once (e.g. on app launch).
   * @param {object[]} events
   */
  async scheduleAll (events) {
    await Promise.all(events.map(e => this.scheduleForEvent(e)))
  }

  // ─── Cancel ────────────────────────────────────────────────────────────────

  async cancelForEvent (eventId) {
    const id = this._notifId(eventId)

    // Remove from Hyperbee
    await this.db.del(NS + eventId).catch(() => {})

    // Cancel in Android
    if (this.native) {
      await this.native.cancel(id)
    }
  }

  async cancelAll () {
    // Walk all persisted notifications and cancel each
    const stream = this.db.createReadStream({ gt: NS, lt: NS + '\xff' })
    const keys = []
    for await (const { key } of stream) keys.push(key)

    await Promise.all(keys.map(async key => {
      const eventId = key.slice(NS.length)
      await this.cancelForEvent(eventId)
    }))

    if (this.native) {
      await this.native.cancelAll()
    }
  }

  // ─── Restore (call on every app launch) ────────────────────────────────────

  /**
   * Re-register all stored notifications with Android after an app restart.
   * AlarmManager alarms do NOT survive device reboots or app reinstalls,
   * so this must be called on every launch (and optionally on BOOT_COMPLETED).
   */
  async restoreAll () {
    if (!this.native) return

    const stream = this.db.createReadStream({ gt: NS, lt: NS + '\xff' })
    const now = Date.now()
    const toDelete = []

    for await (const { key, value } of stream) {
      let notif
      try { notif = JSON.parse(value) } catch { continue }

      if (notif.fireAt <= now) {
        // Missed while app was closed — show immediately as a catch-up
        await this.native.schedule({
          ...notif,
          fireAt: now + 1000,   // 1 second from now
          body: '(Missed) ' + notif.body,
          channelId: 'pearcal_reminders',
        })
        toDelete.push(key)
      } else {
        // Re-register the pending alarm
        await this.native.schedule({
          ...notif,
          channelId: 'pearcal_reminders',
        })
      }
    }

    // Clean up expired entries
    await Promise.all(toDelete.map(k => this.db.del(k).catch(() => {})))
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _notifId (eventId) {
    // Android notification IDs must be integers; hash the eventId string
    let h = 0
    for (const c of eventId) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0
    return Math.abs(h)
  }

  _calcFireTime (event) {
    // Build the event's start datetime in local time
    const [y, mo, d] = event.date.split('-').map(Number)

    let h = 9, m = 0   // default: 9 AM for all-day events
    if (!event.allDay && event.start) {
      [h, m] = event.start.split(':').map(Number)
    }

    const eventMs = new Date(y, mo - 1, d, h, m, 0, 0).getTime()
    return eventMs - event.reminder * 60 * 1000
  }

  _buildBody (event) {
    if (event.allDay) {
      return `All day · ${event.reminder >= 1440
        ? `${event.reminder / 1440}d before`
        : `${event.reminder}m before`}`
    }
    const reminderLabel = event.reminder >= 60
      ? `${event.reminder / 60}h before`
      : `${event.reminder}m before`
    return `${event.start} – ${event.end} · ${reminderLabel}`
  }

  _scheduleWebNotif (notif) {
    const delay = notif.fireAt - Date.now()
    if (delay < 0) return
    setTimeout(() => {
      if (Notification.permission === 'granted') {
        new Notification(notif.title, {
          body: notif.body,
          icon: '/icons/pear-192.png',
          tag: String(notif.id),
        })
      }
    }, delay)
  }
}

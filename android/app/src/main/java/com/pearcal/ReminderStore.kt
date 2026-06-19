package com.pearcal

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

/**
 * Native-side mirror of the currently-armed reminder alarms.
 *
 * AlarmManager drops every pending alarm on device reboot and on app update
 * (ACTION_MY_PACKAGE_REPLACED). The JS/worklet layer owns *what* should be
 * scheduled, but it only runs while the app is open — so after a reboot or an
 * over-the-top update the alarms stay dead until the user next launches the
 * app. To close that gap we persist every alarm here as it is armed (and drop
 * it as it is cancelled), then replay the still-future ones from BootReceiver
 * entirely in native code: no Activity, no worklet, no WebView.
 *
 * The persisted set is kept exactly in sync with AlarmManager because every
 * arm/cancel in NotificationsModule goes through here.
 */
object ReminderStore {
    private const val PREFS = "pearcal_reminders"
    private const val KEY = "alarms"

    data class Reminder(
        val id: Int,
        val fireAt: Long,
        val title: String,
        val body: String,
        val eventId: String,
        val tab: String
    )

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun load(ctx: Context): JSONObject =
        try { JSONObject(prefs(ctx).getString(KEY, "{}") ?: "{}") }
        catch (_: Exception) { JSONObject() }

    @Synchronized
    fun put(ctx: Context, r: Reminder) {
        val root = load(ctx)
        root.put(r.id.toString(), JSONObject().apply {
            put("fireAt", r.fireAt)
            put("title", r.title)
            put("body", r.body)
            put("eventId", r.eventId)
            put("tab", r.tab)
        })
        prefs(ctx).edit().putString(KEY, root.toString()).apply()
    }

    @Synchronized
    fun remove(ctx: Context, id: Int) {
        val root = load(ctx)
        if (root.has(id.toString())) {
            root.remove(id.toString())
            prefs(ctx).edit().putString(KEY, root.toString()).apply()
        }
    }

    /**
     * Arm a single alarm via AlarmManager. Shared by NotificationsModule.schedule()
     * and the boot-time restore so both paths stay byte-for-byte identical.
     */
    fun arm(ctx: Context, r: Reminder) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(ctx, NotificationReceiver::class.java).apply {
            putExtra("notifId", r.id)
            putExtra("title", r.title)
            putExtra("body", r.body)
            putExtra("eventId", r.eventId)
            putExtra("tab", r.tab)
        }
        val pending = PendingIntent.getBroadcast(
            ctx, r.id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
            // Fallback to inexact alarm (within ~1 minute window)
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, r.fireAt, pending)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, r.fireAt, pending)
        } else {
            am.setExact(AlarmManager.RTC_WAKEUP, r.fireAt, pending)
        }
    }

    /**
     * Re-arm every still-future persisted alarm and prune the ones whose fireAt
     * has already passed. Called from BootReceiver after reboot / app update.
     */
    @Synchronized
    fun restoreAll(ctx: Context) {
        val root = load(ctx)
        val now = System.currentTimeMillis()
        val keep = JSONObject()
        var restored = 0
        val keys = root.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val o = root.optJSONObject(key) ?: continue
            val id = key.toIntOrNull() ?: continue
            val fireAt = o.optLong("fireAt", 0L)
            if (fireAt <= now) continue  // already past — drop it
            val r = Reminder(
                id = id,
                fireAt = fireAt,
                title = o.optString("title", ""),
                body = o.optString("body", ""),
                eventId = o.optString("eventId", ""),
                tab = o.optString("tab", "calendar")
            )
            try { arm(ctx, r); keep.put(key, o); restored++ }
            catch (_: Exception) { /* skip a single bad record, keep going */ }
        }
        prefs(ctx).edit().putString(KEY, keep.toString()).apply()
        android.util.Log.d("ReminderStore", "restoreAll re-armed $restored alarm(s)")
    }
}

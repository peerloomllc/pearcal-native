package com.pearcal

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule

@ReactModule(name = NotificationsModule.NAME)
class NotificationsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "PearCalNotifications"
        const val TZ_EVENT = "pearcalTimezoneChanged"
    }

    override fun getName() = NAME

    private val alarmMgr get() =
        reactApplicationContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    // Wall-clock event semantics: a "9 AM" event should stay at 9 AM wherever
    // the user flies. AlarmManager.RTC_WAKEUP fires at an absolute UTC instant,
    // so a stale fireAt set in a previous TZ will fire at the wrong wall-clock
    // after the device crosses zones. Wake the JS reconcile pass on TZ change
    // so it recomputes fireAt against the new local zone. ACTION_TIME_CHANGED
    // covers manual clock edits / DST corrections that bypass TZ broadcasts.
    private val tzReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            val rnCtx = reactApplicationContext
            if (!rnCtx.hasActiveCatalystInstance()) return
            try {
                rnCtx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit(TZ_EVENT, null)
            } catch (_: Exception) { /* RN not ready; visibilitychange will catch it */ }
        }
    }

    init {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_TIMEZONE_CHANGED)
            addAction(Intent.ACTION_TIME_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            reactContext.registerReceiver(tzReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            reactContext.registerReceiver(tzReceiver, filter)
        }
        reactContext.addLifecycleEventListener(object : LifecycleEventListener {
            override fun onHostResume() {}
            override fun onHostPause() {}
            override fun onHostDestroy() {
                try { reactContext.unregisterReceiver(tzReceiver) } catch (_: Exception) {}
            }
        })
    }

    @ReactMethod
    fun schedule(opts: ReadableMap, promise: Promise) {
        try {
            val r = ReminderStore.Reminder(
                id      = opts.getInt("id"),
                fireAt  = opts.getDouble("fireAt").toLong(),
                title   = opts.getString("title") ?: "",
                body    = opts.getString("body") ?: "",
                eventId = if (opts.hasKey("eventId")) opts.getString("eventId") ?: "" else "",
                tab     = if (opts.hasKey("tab")) opts.getString("tab") ?: "" else ""
            )
            // Arm the alarm and persist it so BootReceiver can replay it after a
            // reboot / app update (AlarmManager clears all alarms on both).
            ReminderStore.arm(reactApplicationContext, r)
            ReminderStore.put(reactApplicationContext, r)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SCHEDULE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun cancel(notifId: Int, promise: Promise) {
        try {
            val intent = Intent(reactApplicationContext, NotificationReceiver::class.java)
            val pending = PendingIntent.getBroadcast(
                reactApplicationContext, notifId, intent,
                PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
            )
            pending?.let { alarmMgr.cancel(it) }
            // Drop the persisted mirror so it isn't replayed on next reboot.
            ReminderStore.remove(reactApplicationContext, notifId)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("CANCEL_ERROR", e.message)
        }
    }

    @ReactMethod
    fun getPermission(promise: Promise) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = reactApplicationContext.checkSelfPermission(
                android.Manifest.permission.POST_NOTIFICATIONS
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            promise.resolve(if (granted) "granted" else "denied")
        } else {
            promise.resolve("granted")
        }
    }

    @ReactMethod
    fun postNow(opts: ReadableMap, promise: Promise) {
        try {
            val notifId = opts.getInt("id")
            val title   = opts.getString("title") ?: "PearCal"
            val body    = opts.getString("body") ?: ""

            val nm = reactApplicationContext
                .getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = android.app.NotificationChannel(
                    "pearcal_sync", "Sync Updates",
                    android.app.NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "Updates from shared calendar members"
                    enableVibration(false)
                }
                nm.createNotificationChannel(channel)
            }

            val tab = opts.getString("tab") ?: ""
            val groupSettingsId = if (opts.hasKey("groupSettingsId")) opts.getString("groupSettingsId") ?: "" else ""
            val tapIntent = android.content.Intent(
                reactApplicationContext, MainActivity::class.java
            ).apply {
                flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK or
                        android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP
                if (tab.isNotEmpty()) putExtra("pearTab", tab)
                if (groupSettingsId.isNotEmpty()) putExtra("pearGroupSettingsId", groupSettingsId)
            }
            val tapPending = android.app.PendingIntent.getActivity(
                reactApplicationContext, notifId, tapIntent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
            )

            val notification = androidx.core.app.NotificationCompat
                .Builder(reactApplicationContext, "pearcal_sync")
                .setSmallIcon(R.drawable.ic_stat_name)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(tapPending)
                .setAutoCancel(true)
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_DEFAULT)
                .build()

            nm.notify(notifId, notification)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("POST_NOW_ERROR", e.message)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}

// Add to NotificationsModule companion object

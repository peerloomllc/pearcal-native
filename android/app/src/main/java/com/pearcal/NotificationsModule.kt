package com.pearcal

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = NotificationsModule.NAME)
class NotificationsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "PearCalNotifications"
    }

    override fun getName() = NAME

    private val alarmMgr get() =
        reactApplicationContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    @ReactMethod
    fun schedule(opts: ReadableMap, promise: Promise) {
        try {
            val notifId = opts.getInt("id")
            val fireAt  = opts.getDouble("fireAt").toLong()
            val title   = opts.getString("title") ?: ""
            val body    = opts.getString("body") ?: ""
            val eventId = if (opts.hasKey("eventId")) opts.getString("eventId") ?: "" else ""

            val intent = Intent(reactApplicationContext, NotificationReceiver::class.java).apply {
                putExtra("notifId", notifId)
                putExtra("title",   title)
                putExtra("body",    body)
                putExtra("eventId", eventId)
            }
            val pending = PendingIntent.getBroadcast(
                reactApplicationContext, notifId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmMgr.canScheduleExactAlarms()) {
                // Fallback to inexact alarm (within ~1 minute window)
                alarmMgr.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pending)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmMgr.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pending)
            } else {
                alarmMgr.setExact(AlarmManager.RTC_WAKEUP, fireAt, pending)
            }
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
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}

// Add to NotificationsModule companion object

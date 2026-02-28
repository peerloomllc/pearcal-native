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

            val tapIntent = android.content.Intent(
                reactApplicationContext, MainActivity::class.java
            ).apply {
                flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK or
                        android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val tapPending = android.app.PendingIntent.getActivity(
                reactApplicationContext, notifId, tapIntent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
            )

            val notification = androidx.core.app.NotificationCompat
                .Builder(reactApplicationContext, "pearcal_sync")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
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

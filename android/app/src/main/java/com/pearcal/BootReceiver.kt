package com.pearcal

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms reminder alarms that the OS cleared on device reboot or on an
 * over-the-top app update (ACTION_MY_PACKAGE_REPLACED). Runs entirely in
 * native code via ReminderStore — no Activity is launched, so the app never
 * pops open. (The previous approach started MainActivity, which is blocked by
 * the background-activity-start restriction on Android 10+ and so never
 * reliably fired.)
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON" -> {
                try {
                    ReminderStore.restoreAll(context.applicationContext)
                } catch (e: Exception) {
                    android.util.Log.e("BootReceiver", "reminder restore failed", e)
                }
                // The widget's periodic redraw is scheduled when a widget is first
                // placed, so an app update that ADDS the schedule finds nothing to
                // re-arm it. Do it here too, and redraw once: the cached week may
                // well have rolled onto a new day while the device was off. (#174)
                try {
                    com.pearcal.widget.DailyWidgetWorker.schedule(context.applicationContext)
                    com.pearcal.widget.DailyWidgetReceiver.updateAll(context.applicationContext)
                } catch (e: Exception) {
                    android.util.Log.e("BootReceiver", "widget refresh failed", e)
                }
            }
        }
    }
}

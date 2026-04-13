package com.pearcal.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import com.pearcal.R
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class DailyWidgetReceiver : AppWidgetProvider() {

    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) render(context, mgr, id)
    }

    override fun onEnabled(context: Context) {
        DailyWidgetWorker.schedule(context)
    }

    override fun onDisabled(context: Context) {
        DailyWidgetWorker.cancel(context)
    }

    companion object {
        private const val ROW_COUNT = 5

        fun updateAll(context: Context) {
            val mgr = AppWidgetManager.getInstance(context)
            val ids = mgr.getAppWidgetIds(ComponentName(context, DailyWidgetReceiver::class.java))
            for (id in ids) render(context, mgr, id)
        }

        private fun render(context: Context, mgr: AppWidgetManager, id: Int) {
            val views = RemoteViews(context.packageName, R.layout.widget_daily)
            val (dateLabel, events) = readCache(context)
            views.setTextViewText(R.id.widget_date, dateLabel)

            // Launch app on tap (whole widget)
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            if (launch != null) {
                launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                val pi = PendingIntent.getActivity(
                    context, 0, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                views.setOnClickPendingIntent(R.id.widget_root, pi)
            }

            val rowIds = arrayOf(
                R.id.widget_event_0, R.id.widget_event_1, R.id.widget_event_2,
                R.id.widget_event_3, R.id.widget_event_4
            )
            val colorIds = arrayOf(
                R.id.widget_color_0, R.id.widget_color_1, R.id.widget_color_2,
                R.id.widget_color_3, R.id.widget_color_4
            )
            val timeIds = arrayOf(
                R.id.widget_time_0, R.id.widget_time_1, R.id.widget_time_2,
                R.id.widget_time_3, R.id.widget_time_4
            )
            val titleIds = arrayOf(
                R.id.widget_title_0, R.id.widget_title_1, R.id.widget_title_2,
                R.id.widget_title_3, R.id.widget_title_4
            )

            if (events.isEmpty()) {
                views.setViewVisibility(R.id.widget_empty, View.VISIBLE)
                for (i in 0 until ROW_COUNT) views.setViewVisibility(rowIds[i], View.GONE)
                views.setViewVisibility(R.id.widget_overflow, View.GONE)
            } else {
                views.setViewVisibility(R.id.widget_empty, View.GONE)
                val shown = minOf(events.size, ROW_COUNT)
                for (i in 0 until ROW_COUNT) {
                    if (i < shown) {
                        val e = events[i]
                        views.setViewVisibility(rowIds[i], View.VISIBLE)
                        views.setTextViewText(timeIds[i], e.timeLabel)
                        views.setTextViewText(titleIds[i], e.title)
                        views.setInt(colorIds[i], "setBackgroundColor", e.color)
                    } else {
                        views.setViewVisibility(rowIds[i], View.GONE)
                    }
                }
                val overflow = events.size - shown
                if (overflow > 0) {
                    views.setViewVisibility(R.id.widget_overflow, View.VISIBLE)
                    views.setTextViewText(R.id.widget_overflow, "+ $overflow more")
                } else {
                    views.setViewVisibility(R.id.widget_overflow, View.GONE)
                }
            }

            mgr.updateAppWidget(id, views)
        }

        private data class EventRow(val timeLabel: String, val title: String, val color: Int)

        private fun readCache(context: Context): Pair<String, List<EventRow>> {
            val todayLabel = SimpleDateFormat("EEE, MMM d", Locale.getDefault()).format(Date())
            val file = File(File(context.filesDir, "widget"), "today.json")
            if (!file.exists()) return todayLabel to emptyList()
            return try {
                val json = JSONObject(file.readText())
                val arr = json.optJSONArray("events") ?: return todayLabel to emptyList()
                val list = ArrayList<EventRow>(arr.length())
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val title = o.optString("title", "").ifEmpty { "(Untitled)" }
                    val allDay = o.optBoolean("allDay", false)
                    val start = o.optString("start", "")
                    val timeLabel = if (allDay || start.isEmpty()) "all-day" else start
                    val colorStr = o.optString("color", "")
                    val color = parseColor(colorStr)
                    list.add(EventRow(timeLabel, title, color))
                }
                todayLabel to list
            } catch (e: Exception) {
                todayLabel to emptyList()
            }
        }

        private fun parseColor(s: String): Int {
            if (s.isEmpty()) return Color.parseColor("#C8922A")
            return try { Color.parseColor(s) } catch (e: Exception) { Color.parseColor("#C8922A") }
        }
    }
}

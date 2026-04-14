package com.pearcal.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.view.View
import android.widget.RemoteViews
import com.pearcal.R
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
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
        private const val COLOR_TEXT = "#F2EFE8"
        private const val COLOR_MUTED = "#8A8478"
        private const val COLOR_ACCENT = "#C8922A"
        private const val COLOR_DEFAULT_EVENT = "#C8922A"

        fun updateAll(context: Context) {
            val mgr = AppWidgetManager.getInstance(context)
            val ids = mgr.getAppWidgetIds(ComponentName(context, DailyWidgetReceiver::class.java))
            for (id in ids) render(context, mgr, id)
        }

        private fun render(context: Context, mgr: AppWidgetManager, id: Int) {
            val views = RemoteViews(context.packageName, R.layout.widget_daily)
            val cache = readCache(context)
            val dateLabel = SimpleDateFormat("EEE · MMM d", Locale.getDefault()).format(Date())
            views.setTextViewText(R.id.widget_date, dateLabel)

            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            if (launch != null) {
                launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                val pi = PendingIntent.getActivity(
                    context, 0, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                views.setOnClickPendingIntent(R.id.widget_root, pi)
            }

            val rowIds = arrayOf(R.id.widget_event_0, R.id.widget_event_1, R.id.widget_event_2, R.id.widget_event_3, R.id.widget_event_4)
            val colorIds = arrayOf(R.id.widget_color_0, R.id.widget_color_1, R.id.widget_color_2, R.id.widget_color_3, R.id.widget_color_4)
            val timeIds = arrayOf(R.id.widget_time_0, R.id.widget_time_1, R.id.widget_time_2, R.id.widget_time_3, R.id.widget_time_4)
            val titleIds = arrayOf(R.id.widget_title_0, R.id.widget_title_1, R.id.widget_title_2, R.id.widget_title_3, R.id.widget_title_4)
            val locationIds = arrayOf(R.id.widget_location_0, R.id.widget_location_1, R.id.widget_location_2, R.id.widget_location_3, R.id.widget_location_4)

            if (cache.events.isEmpty()) {
                views.setViewVisibility(R.id.widget_empty_container, View.VISIBLE)
                if (cache.tomorrowPreview != null) {
                    views.setViewVisibility(R.id.widget_tomorrow, View.VISIBLE)
                    views.setTextViewText(R.id.widget_tomorrow, cache.tomorrowPreview)
                } else {
                    views.setViewVisibility(R.id.widget_tomorrow, View.GONE)
                }
                for (i in 0 until ROW_COUNT) views.setViewVisibility(rowIds[i], View.GONE)
                views.setViewVisibility(R.id.widget_overflow, View.GONE)
            } else {
                views.setViewVisibility(R.id.widget_empty_container, View.GONE)
                val events = cache.events
                val nowMin = currentMinutes()
                val nextUpIdx = findNextUp(events, nowMin)
                val shown = minOf(events.size, ROW_COUNT)
                for (i in 0 until ROW_COUNT) {
                    if (i < shown) {
                        val e = events[i]
                        views.setViewVisibility(rowIds[i], View.VISIBLE)
                        views.setTextViewText(timeIds[i], e.timeLabel)
                        views.setTextViewText(titleIds[i], e.title)
                        views.setInt(colorIds[i], "setBackgroundColor", e.color)

                        val isPast = !e.allDay && e.endMin != null && e.endMin < nowMin
                        val isNextUp = i == nextUpIdx
                        val titleColor = when {
                            isPast -> Color.parseColor(COLOR_MUTED)
                            isNextUp -> Color.parseColor(COLOR_ACCENT)
                            else -> Color.parseColor(COLOR_TEXT)
                        }
                        val timeColor = if (isNextUp) Color.parseColor(COLOR_ACCENT) else Color.parseColor(COLOR_MUTED)
                        views.setTextColor(titleIds[i], titleColor)
                        views.setTextColor(timeIds[i], timeColor)

                        if (e.location.isNullOrEmpty()) {
                            views.setViewVisibility(locationIds[i], View.GONE)
                        } else {
                            views.setViewVisibility(locationIds[i], View.VISIBLE)
                            views.setTextViewText(locationIds[i], e.location)
                            val locColor = if (isPast) Color.parseColor("#5A554E") else Color.parseColor(COLOR_MUTED)
                            views.setTextColor(locationIds[i], locColor)
                        }
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

        private data class EventRow(
            val timeLabel: String,
            val title: String,
            val location: String?,
            val color: Int,
            val allDay: Boolean,
            val startMin: Int?,
            val endMin: Int?,
        )

        private data class WidgetCache(val events: List<EventRow>, val tomorrowPreview: String?)

        private fun readCache(context: Context): WidgetCache {
            val file = File(File(context.filesDir, "widget"), "today.json")
            if (!file.exists()) return WidgetCache(emptyList(), null)
            return try {
                val json = JSONObject(file.readText())
                val arr = json.optJSONArray("events")
                val list = ArrayList<EventRow>(arr?.length() ?: 0)
                if (arr != null) {
                    for (i in 0 until arr.length()) {
                        val o = arr.getJSONObject(i)
                        val title = o.optString("title", "").ifEmpty { "(Untitled)" }
                        val allDay = o.optBoolean("allDay", false)
                        val start = o.optString("start", "")
                        val end = o.optString("end", "")
                        val location = if (o.isNull("location")) null else o.optString("location", "").ifEmpty { null }
                        val timeLabel = when {
                            allDay || start.isEmpty() -> "All day"
                            end.isNotEmpty() -> "$start–$end"
                            else -> start
                        }
                        val color = parseColor(o.optString("color", ""))
                        list.add(EventRow(
                            timeLabel, title, location, color, allDay,
                            parseMinutes(start), parseMinutes(end)
                        ))
                    }
                }
                val tomorrow = json.optJSONObject("tomorrowFirst")
                val preview = if (tomorrow != null) formatTomorrowPreview(tomorrow) else null
                WidgetCache(list, preview)
            } catch (e: Exception) {
                WidgetCache(emptyList(), null)
            }
        }

        private fun formatTomorrowPreview(o: JSONObject): String {
            val title = o.optString("title", "").ifEmpty { "(Untitled)" }
            val allDay = o.optBoolean("allDay", false)
            val start = o.optString("start", "")
            val timeStr = if (allDay || start.isEmpty()) "All day" else start
            return "Tomorrow · $timeStr  $title"
        }

        private fun parseColor(s: String): Int {
            if (s.isEmpty()) return Color.parseColor(COLOR_DEFAULT_EVENT)
            return try { Color.parseColor(s) } catch (e: Exception) { Color.parseColor(COLOR_DEFAULT_EVENT) }
        }

        private fun parseMinutes(s: String): Int? {
            if (s.isEmpty() || !s.contains(":")) return null
            val parts = s.split(":")
            val h = parts.getOrNull(0)?.toIntOrNull() ?: return null
            val m = parts.getOrNull(1)?.toIntOrNull() ?: return null
            return h * 60 + m
        }

        private fun currentMinutes(): Int {
            val cal = Calendar.getInstance()
            return cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
        }

        private fun findNextUp(events: List<EventRow>, nowMin: Int): Int {
            // First event that is currently happening (start <= now < end) wins; otherwise
            // the first event whose start is in the future. All-day events are skipped.
            var happeningIdx = -1
            for (i in events.indices) {
                val e = events[i]
                if (e.allDay || e.startMin == null) continue
                val endMin = e.endMin ?: (e.startMin + 30)
                if (e.startMin <= nowMin && nowMin < endMin) { happeningIdx = i; break }
            }
            if (happeningIdx >= 0) return happeningIdx
            for (i in events.indices) {
                val e = events[i]
                if (e.allDay || e.startMin == null) continue
                if (e.startMin >= nowMin) return i
            }
            return -1
        }
    }
}

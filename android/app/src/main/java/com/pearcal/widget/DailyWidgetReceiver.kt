package com.pearcal.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.text.format.DateFormat
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
            val rightColorIds = arrayOf(R.id.widget_color_right_0, R.id.widget_color_right_1, R.id.widget_color_right_2, R.id.widget_color_right_3, R.id.widget_color_right_4)
            val rightTitleIds = arrayOf(R.id.widget_title_right_0, R.id.widget_title_right_1, R.id.widget_title_right_2, R.id.widget_title_right_3, R.id.widget_title_right_4)

            if (cache.events.isEmpty() && cache.upcoming.isEmpty()) {
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
                val slots = cache.slots
                val nowMin = currentMinutes()
                val nextUpSet = findNextUp(events, nowMin)
                // Today's events claim rows first; "show upcoming" rows (#107)
                // then fill whatever remains (with their date where time goes).
                val todaySlots = minOf(slots.size, ROW_COUNT)
                var eventsShown = 0
                var rowIdx = 0
                while (rowIdx < todaySlots) {
                    val slot = slots[rowIdx]
                    val leftIdx = slot[0]
                    val e = events[leftIdx]
                    views.setViewVisibility(rowIds[rowIdx], View.VISIBLE)
                    views.setTextViewText(timeIds[rowIdx], e.timeLabel)
                    views.setTextViewText(titleIds[rowIdx], e.title)
                    applyColorBar(views, colorIds[rowIdx], e)

                    val endEff = effectiveEndMin(e)
                    val isPast = !e.allDay && endEff != null && endEff < nowMin
                    val isNextUp = nextUpSet.contains(leftIdx)
                    val titleColor = when {
                        isPast -> Color.parseColor(COLOR_MUTED)
                        isNextUp -> Color.parseColor(COLOR_ACCENT)
                        else -> Color.parseColor(COLOR_TEXT)
                    }
                    val timeColor = if (isNextUp) Color.parseColor(COLOR_ACCENT) else Color.parseColor(COLOR_MUTED)
                    views.setTextColor(titleIds[rowIdx], titleColor)
                    views.setTextColor(timeIds[rowIdx], timeColor)

                    if (slot.size >= 2) {
                        val rightIdx = slot[1]
                        val e2 = events[rightIdx]
                        views.setViewVisibility(locationIds[rowIdx], View.GONE)
                        views.setViewVisibility(rightColorIds[rowIdx], View.VISIBLE)
                        views.setViewVisibility(rightTitleIds[rowIdx], View.VISIBLE)
                        applyColorBar(views, rightColorIds[rowIdx], e2)
                        views.setTextViewText(rightTitleIds[rowIdx], e2.title)
                        val endEffR = effectiveEndMin(e2)
                        val isPastR = !e2.allDay && endEffR != null && endEffR < nowMin
                        val isNextUpR = nextUpSet.contains(rightIdx)
                        val titleColorR = when {
                            isPastR -> Color.parseColor(COLOR_MUTED)
                            isNextUpR -> Color.parseColor(COLOR_ACCENT)
                            else -> Color.parseColor(COLOR_TEXT)
                        }
                        views.setTextColor(rightTitleIds[rowIdx], titleColorR)
                    } else {
                        views.setViewVisibility(rightColorIds[rowIdx], View.GONE)
                        views.setViewVisibility(rightTitleIds[rowIdx], View.GONE)
                        if (e.location.isNullOrEmpty()) {
                            views.setViewVisibility(locationIds[rowIdx], View.GONE)
                        } else {
                            views.setViewVisibility(locationIds[rowIdx], View.VISIBLE)
                            views.setTextViewText(locationIds[rowIdx], e.location)
                            val locColor = if (isPast) Color.parseColor("#5A554E") else Color.parseColor(COLOR_MUTED)
                            views.setTextColor(locationIds[rowIdx], locColor)
                        }
                    }
                    eventsShown += slot.size
                    rowIdx++
                }
                // Upcoming events fill the remaining rows.
                for (e in cache.upcoming) {
                    if (rowIdx >= ROW_COUNT) break
                    views.setViewVisibility(rowIds[rowIdx], View.VISIBLE)
                    views.setTextViewText(timeIds[rowIdx], e.timeLabel)
                    views.setTextViewText(titleIds[rowIdx], e.title)
                    applyColorBar(views, colorIds[rowIdx], e)
                    views.setTextColor(titleIds[rowIdx], Color.parseColor(COLOR_TEXT))
                    views.setTextColor(timeIds[rowIdx], Color.parseColor(COLOR_ACCENT))
                    views.setViewVisibility(rightColorIds[rowIdx], View.GONE)
                    views.setViewVisibility(rightTitleIds[rowIdx], View.GONE)
                    views.setViewVisibility(locationIds[rowIdx], View.GONE)
                    rowIdx++
                }
                while (rowIdx < ROW_COUNT) {
                    views.setViewVisibility(rowIds[rowIdx], View.GONE)
                    rowIdx++
                }
                val overflow = events.size - eventsShown
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
            val colors: List<Int>?,   // 2–3 entry strip (e.g. US holiday) — TODO #104
            val allDay: Boolean,
            val startMin: Int?,
            val endMin: Int?,
            val carried: Boolean = false,   // began yesterday, still running now (TODO #114)
        )

        private data class WidgetCache(
            val events: List<EventRow>,
            val slots: List<List<Int>>,
            val tomorrowPreview: String?,
            val upcoming: List<EventRow> = emptyList(),
        )

        private fun readCache(context: Context): WidgetCache {
            val file = File(File(context.filesDir, "widget"), "today.json")
            if (!file.exists()) return WidgetCache(emptyList(), emptyList(), null)
            return try {
                val json = JSONObject(file.readText())
                val use24h: Boolean = when {
                    json.isNull("use24h") -> DateFormat.is24HourFormat(context)
                    json.has("use24h") -> json.optBoolean("use24h", DateFormat.is24HourFormat(context))
                    else -> DateFormat.is24HourFormat(context)
                }
                val arr = json.optJSONArray("events")
                val list = ArrayList<EventRow>(arr?.length() ?: 0)
                if (arr != null) {
                    for (i in 0 until arr.length()) list.add(parseEventRow(arr.getJSONObject(i), use24h, upcoming = false))
                }
                // "Show upcoming events" rows (TODO #107) — only present when the
                // setting is on and today is empty; weekday label replaces time.
                val upArr = json.optJSONArray("upcoming")
                val upList = ArrayList<EventRow>(upArr?.length() ?: 0)
                if (upArr != null) {
                    for (i in 0 until upArr.length()) upList.add(parseEventRow(upArr.getJSONObject(i), use24h, upcoming = true))
                }
                val slotsArr = json.optJSONArray("slots")
                val slotList = ArrayList<List<Int>>()
                if (slotsArr != null) {
                    for (i in 0 until slotsArr.length()) {
                        val inner = slotsArr.optJSONArray(i) ?: continue
                        val s = ArrayList<Int>(inner.length())
                        for (j in 0 until inner.length()) s.add(inner.getInt(j))
                        if (s.isNotEmpty()) slotList.add(s)
                    }
                } else {
                    for (i in list.indices) slotList.add(listOf(i))
                }
                val tomorrow = json.optJSONObject("tomorrowFirst")
                val preview = if (tomorrow != null) formatTomorrowPreview(tomorrow, use24h) else null
                WidgetCache(list, slotList, preview, upList)
            } catch (e: Exception) {
                WidgetCache(emptyList(), emptyList(), null)
            }
        }

        private fun parseEventRow(o: JSONObject, use24h: Boolean, upcoming: Boolean): EventRow {
            val title = o.optString("title", "").ifEmpty { "(Untitled)" }
            val allDay = o.optBoolean("allDay", false)
            val start = o.optString("start", "")
            val end = o.optString("end", "")
            val location = if (o.isNull("location")) null else o.optString("location", "").ifEmpty { null }
            val color = parseColor(o.optString("color", ""))
            val colorsArr = o.optJSONArray("colors")
            val colors: List<Int>? = if (colorsArr != null && colorsArr.length() > 1) {
                (0 until minOf(colorsArr.length(), 3)).map { parseColor(colorsArr.optString(it, "")) }
            } else null
            // A carried row began yesterday, so its start time is not today's —
            // labelling it "11:00 PM" would read as starting tonight. Show when it
            // ends instead. (TODO #114)
            val carried = o.optBoolean("carried", false)
            val timeLabel = if (upcoming) {
                val dl = upcomingDateLabel(o.optString("date", ""))
                if (allDay || start.isEmpty()) dl else "$dl · ${prettyTime(start, use24h)}"
            } else if (carried && end.isNotEmpty()) {
                "Until ${prettyTime(end, use24h)}"
            } else {
                if (allDay || start.isEmpty()) "All day" else prettyTime(start, use24h)
            }
            return EventRow(timeLabel, title, location, color, colors, allDay, parseMinutes(start), parseMinutes(end), carried)
        }

        // Weekday + month/day for upcoming rows, e.g. "Sat · Jun 19" (TODO #107).
        private fun upcomingDateLabel(dateStr: String): String {
            if (dateStr.isEmpty()) return ""
            return try {
                val d = SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(dateStr) ?: return ""
                SimpleDateFormat("EEE · MMM d", Locale.getDefault()).format(d)
            } catch (e: Exception) { "" }
        }

        private fun formatTomorrowPreview(o: JSONObject, use24h: Boolean): String {
            val title = o.optString("title", "").ifEmpty { "(Untitled)" }
            val allDay = o.optBoolean("allDay", false)
            val start = o.optString("start", "")
            val timeStr = if (allDay || start.isEmpty()) "All day" else prettyTime(start, use24h)
            return "Tomorrow · $timeStr  $title"
        }

        private fun prettyTime(hhmm: String, use24h: Boolean): String {
            if (hhmm.isEmpty() || !hhmm.contains(":")) return hhmm
            return try {
                val parser = SimpleDateFormat("HH:mm", Locale.US)
                val d = parser.parse(hhmm) ?: return hhmm
                val pattern = if (use24h) "HH:mm" else "h:mm a"
                SimpleDateFormat(pattern, Locale.US).format(d)
            } catch (e: Exception) { hhmm }
        }

        private fun parseColor(s: String): Int {
            if (s.isEmpty()) return Color.parseColor(COLOR_DEFAULT_EVENT)
            return try { Color.parseColor(s) } catch (e: Exception) { Color.parseColor(COLOR_DEFAULT_EVENT) }
        }

        // Paint an event's color bar: a stacked-segment strip (e.g. US holiday
        // red/white/blue) when it has a 2–3 colour `colors` list, else a solid
        // fill. The strip is a 1×N bitmap stretched by the ImageView's fitXY
        // scaleType to fill the bar. (TODO #104)
        private fun applyColorBar(views: RemoteViews, viewId: Int, e: EventRow) {
            val cs = e.colors
            if (cs != null && cs.size >= 2) {
                views.setImageViewBitmap(viewId, stripBitmap(cs))
            } else {
                // Clear any strip bitmap a prior render left on this ImageView —
                // otherwise a reused row (e.g. a holiday was here last update)
                // keeps the red/white/blue strip under a solid colour. (TODO #107)
                views.setImageViewBitmap(viewId, null)
                views.setInt(viewId, "setBackgroundColor", e.color)
            }
        }

        private fun stripBitmap(colors: List<Int>): Bitmap {
            val bmp = Bitmap.createBitmap(1, colors.size, Bitmap.Config.ARGB_8888)
            for (i in colors.indices) bmp.setPixel(0, i, colors[i])
            return bmp
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

        // Wall-clock start/end are stored against a single date, so an event whose
        // end sorts before its start runs past midnight (10pm-12am, an overnight
        // shift). Unwrap both ends onto *today's* timeline: one that started today
        // ends tomorrow (+1 day), while a carried one started yesterday and is still
        // running (-1 day). Without this it reads as having ended at 00:00 and is
        // greyed out as past all day, and never highlights while actually running.
        private fun effectiveStartMin(e: EventRow): Int? {
            val start = e.startMin ?: return null
            return if (e.carried) start - 1440 else start
        }

        private fun effectiveEndMin(e: EventRow): Int? {
            val end = e.endMin ?: return null
            if (e.carried) return end
            val start = e.startMin ?: return end
            return if (end < start) end + 1440 else end
        }

        private fun findNextUp(events: List<EventRow>, nowMin: Int): Set<Int> {
            // All events currently happening (start <= now < end) win; otherwise
            // the first event whose start is in the future. All-day events are skipped.
            val happening = HashSet<Int>()
            for (i in events.indices) {
                val e = events[i]
                if (e.allDay) continue
                val startMin = effectiveStartMin(e) ?: continue
                val endMin = effectiveEndMin(e) ?: (startMin + 30)
                if (startMin <= nowMin && nowMin < endMin) happening.add(i)
            }
            if (happening.isNotEmpty()) return happening
            for (i in events.indices) {
                val e = events[i]
                if (e.allDay) continue
                val startMin = effectiveStartMin(e) ?: continue
                // A carried event started before today began, so it is never "next up".
                if (startMin >= nowMin) return setOf(i)
            }
            return emptySet()
        }
    }
}

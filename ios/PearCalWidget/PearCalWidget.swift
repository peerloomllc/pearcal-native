import WidgetKit
import SwiftUI

// MARK: - Model

struct CachedEvent: Codable, Identifiable {
  let id: String
  let title: String
  let allDay: Bool
  let start: String?
  let end: String?
  let location: String?
  let color: String?
  let colors: [String]?   // 2–3 hex strip (e.g. US holiday red/white/blue) — TODO #104
  let date: String?       // only set on `upcoming` rows (yyyy-MM-dd) — TODO #107
  let carried: Bool?      // began yesterday, still running now — TODO #114
}

// One day of the cached window. The app writes a week of these at a time.
struct CachedDay: Codable {
  let date: String
  let events: [CachedEvent]
  let slots: [[Int]]?
}

struct CachedPayload: Codable {
  let date: String
  let generatedAt: Double
  let events: [CachedEvent]
  let slots: [[Int]]?
  let tomorrowFirst: CachedEvent?
  let upcoming: [CachedEvent]?   // next few events on empty days, when enabled — TODO #107
  let days: [CachedDay]?         // today and the week after it — TODO #174
  let use24h: Bool?
}

private let dayKeyFormatter: DateFormatter = {
  let f = DateFormatter()
  f.dateFormat = "yyyy-MM-dd"
  f.locale = Locale(identifier: "en_US_POSIX")
  return f
}()

extension CachedPayload {
  // Which day to draw is decided at render, not at write time. Only the app can
  // build this payload and it may not run for days, so it hands over a week and
  // the widget picks the day it wakes up on. Before that the widget drew the one
  // day it was given whatever the date was, so after midnight it showed
  // yesterday's events under today's header until something opened the app.
  func resolved(for when: Date) -> CachedPayload {
    let key = dayKeyFormatter.string(from: when)
    let nextKey = dayKeyFormatter.string(
      from: Calendar.current.date(byAdding: .day, value: 1, to: when) ?? when)
    // Anything the clock has passed since the app last ran is no longer upcoming.
    let stillAhead = upcoming?.filter { ($0.date ?? "") > key }
    let today = days?.first { $0.date == key }
    // No `days` at all means a cache file written by a build older than the day
    // window. Its flat payload is still good, but only on the day it was written.
    let flat = days == nil && date == key
    if today == nil && !flat {
      return CachedPayload(date: key, generatedAt: generatedAt, events: [], slots: nil,
                           tomorrowFirst: nil, upcoming: stillAhead, days: days, use24h: use24h)
    }
    guard let today = today else {
      return CachedPayload(date: key, generatedAt: generatedAt, events: events, slots: slots,
                           tomorrowFirst: tomorrowFirst, upcoming: stillAhead, days: days, use24h: use24h)
    }
    // The tomorrow line moves with the date too, so it comes from the next
    // cached day rather than from what was tomorrow when the app last ran.
    let next = days?.first { $0.date == nextKey }?.events.first
    return CachedPayload(date: key, generatedAt: generatedAt, events: today.events, slots: today.slots,
                         tomorrowFirst: next, upcoming: stillAhead, days: days, use24h: use24h)
  }
}

// MARK: - Theme

enum Theme {
  static let bg = Color(red: 0x1A / 255.0, green: 0x19 / 255.0, blue: 0x16 / 255.0)
  static let accent = Color(red: 0xC8 / 255.0, green: 0x92 / 255.0, blue: 0x2A / 255.0)
  static let text = Color(red: 0xF2 / 255.0, green: 0xEF / 255.0, blue: 0xE8 / 255.0)
  static let subtle = Color(red: 0xF2 / 255.0, green: 0xEF / 255.0, blue: 0xE8 / 255.0).opacity(0.6)
  static let muted = Color(red: 0x8A / 255.0, green: 0x84 / 255.0, blue: 0x78 / 255.0)
}

// MARK: - Cache loader

enum CacheLoader {
  static let appGroup = "group.com.pearcal"
  static let filename = "today.json"

  static func load() -> CachedPayload? {
    guard let url = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: appGroup)?.appendingPathComponent(filename),
      let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(CachedPayload.self, from: data)
  }
}

// MARK: - Timeline

struct PearCalEntry: TimelineEntry {
  let date: Date
  let payload: CachedPayload?
}

struct PearCalProvider: TimelineProvider {
  func placeholder(in context: Context) -> PearCalEntry {
    PearCalEntry(date: Date(), payload: nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (PearCalEntry) -> Void) {
    let now = Date()
    completion(PearCalEntry(date: now, payload: CacheLoader.load()?.resolved(for: now)))
  }

  // One entry for now plus one per midnight in the cached window, each resolved
  // to its own day. WidgetKit renders the entry whose date has arrived, so the
  // widget turns the page at midnight on its own — no app launch, and no waiting
  // on a reload the system may not grant. The 15-minute reload still runs, to
  // pick up whatever the app has written since. (TODO #174)
  func getTimeline(in context: Context, completion: @escaping (Timeline<PearCalEntry>) -> Void) {
    let now = Date()
    let payload = CacheLoader.load()
    var entries = [PearCalEntry(date: now, payload: payload?.resolved(for: now))]
    let cal = Calendar.current
    var day = cal.startOfDay(for: now)
    for _ in 0..<7 {
      guard let next = cal.date(byAdding: .day, value: 1, to: day) else { break }
      day = next
      entries.append(PearCalEntry(date: day, payload: payload?.resolved(for: day)))
    }
    let refresh = cal.date(byAdding: .minute, value: 15, to: now) ?? now.addingTimeInterval(900)
    completion(Timeline(entries: entries, policy: .after(refresh)))
  }
}

// MARK: - Helpers

// Format an "HH:mm" 24-hour string as either 12- or 24-hour time. When
// `use24h` is nil, defers to the user's iOS 12/24-hour preference via the
// locale-aware "jmm" template. When set, uses a fixed en_US_POSIX format so
// the system-wide "24-Hour Time" toggle can't override the app's preference
// (Apple QA1480 — fixed `dateFormat` strings get rewritten by user settings
// unless the locale is pinned).
private func prettyTime(_ hhmm: String?, use24h: Bool?) -> String {
  guard let hhmm = hhmm, !hhmm.isEmpty else { return "" }
  let parser = DateFormatter()
  parser.dateFormat = "HH:mm"
  parser.locale = Locale(identifier: "en_US_POSIX")
  guard let d = parser.date(from: hhmm) else { return hhmm }
  let out = DateFormatter()
  if let use24h = use24h {
    out.dateFormat = use24h ? "HH:mm" : "h:mm a"
    out.locale = Locale(identifier: "en_US_POSIX")
  } else {
    out.setLocalizedDateFormatFromTemplate("jmm")
  }
  return out.string(from: d)
}

private func swatch(_ hex: String?) -> Color {
  guard let hex = hex else { return Theme.accent }
  var s = hex
  if s.hasPrefix("#") { s.removeFirst() }
  guard s.count == 6, let n = UInt32(s, radix: 16) else { return Theme.accent }
  return Color(red: Double((n >> 16) & 0xFF) / 255.0,
               green: Double((n >> 8) & 0xFF) / 255.0,
               blue: Double(n & 0xFF) / 255.0)
}

// The event's color bar. With a 2–3 entry `colors` strip (subscribed holidays
// like US federal days) it paints stacked segments; otherwise a solid swatch.
// Caller applies the .frame — TODO #104.
@ViewBuilder
private func colorBar(_ ev: CachedEvent) -> some View {
  if let cs = ev.colors, cs.count >= 2 {
    VStack(spacing: 0) {
      ForEach(Array(cs.prefix(3).enumerated()), id: \.offset) { _, hex in
        Rectangle().fill(swatch(hex))
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: 2))
  } else {
    RoundedRectangle(cornerRadius: 2).fill(swatch(ev.color))
  }
}

private func eventTimeLabel(_ ev: CachedEvent, use24h: Bool?) -> String {
  if ev.allDay { return "All day" }
  // A carried row began yesterday, so its start time is not today's — labelling it
  // "11:00 PM" would read as starting tonight. Show when it ends instead. (TODO #114)
  if ev.carried == true, let end = ev.end, !end.isEmpty {
    return "Until \(prettyTime(end, use24h: use24h))"
  }
  return prettyTime(ev.start, use24h: use24h)
}

// Weekday + month/day for an "upcoming" row's date, e.g. "Sat · Jun 19".
// Future days are distinguished by the date right in the row, so no separate
// divider header is needed on the compact widget (TODO #107).
private func upcomingDateLabel(_ dateStr: String?) -> String {
  guard let dateStr = dateStr else { return "" }
  let parser = DateFormatter()
  parser.dateFormat = "yyyy-MM-dd"
  parser.locale = Locale(identifier: "en_US_POSIX")
  guard let d = parser.date(from: dateStr) else { return "" }
  let out = DateFormatter()
  out.dateFormat = "EEE · MMM d"
  return out.string(from: d)
}

private func upcomingTimeLabel(_ ev: CachedEvent, use24h: Bool?) -> String {
  let dl = upcomingDateLabel(ev.date)
  if ev.allDay { return dl }
  let t = prettyTime(ev.start, use24h: use24h)
  return t.isEmpty ? dl : "\(dl) · \(t)"
}

@ViewBuilder
private func upcomingRow(_ ev: CachedEvent, use24h: Bool?) -> some View {
  HStack(alignment: .top, spacing: 6) {
    colorBar(ev).frame(width: 3, height: 20)
    Text(ev.title).font(.system(size: 13, weight: .medium)).foregroundColor(Theme.text).lineLimit(1)
    Spacer()
    Text(upcomingTimeLabel(ev, use24h: use24h)).font(.caption2).foregroundColor(Theme.accent)
  }
}

private func minutesFromHHMM(_ s: String?) -> Int? {
  guard let s = s, s.contains(":") else { return nil }
  let parts = s.split(separator: ":")
  guard parts.count >= 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
  return h * 60 + m
}

// The entry's own moment, not `Date()`. WidgetKit renders a timeline entry well
// before it is shown, so a view that reads the wall clock while drawing the
// midnight entry would highlight and grey rows against the time it was rendered.
private func currentMinutes(_ when: Date) -> Int {
  let comps = Calendar.current.dateComponents([.hour, .minute], from: when)
  return (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
}

// Wall-clock start/end are stored against a single date, so an event whose end
// sorts before its start runs past midnight (10pm-12am, an overnight shift).
// Unwrap both ends onto *today's* timeline: one that started today ends tomorrow
// (+1 day), while a carried one started yesterday and is still running (-1 day).
// Without this it reads as having ended at 00:00 and is dimmed as past all day,
// and never highlights while actually running.
private func effectiveStartMin(_ e: CachedEvent) -> Int? {
  guard let start = minutesFromHHMM(e.start) else { return nil }
  return e.carried == true ? start - 1440 : start
}

private func effectiveEndMin(_ e: CachedEvent) -> Int? {
  guard let end = minutesFromHHMM(e.end) else { return nil }
  if e.carried == true { return end }
  guard let start = minutesFromHHMM(e.start) else { return end }
  return end < start ? end + 1440 : end
}

private func findNextUp(_ events: [CachedEvent], nowMin: Int) -> Set<Int> {
  var happening = Set<Int>()
  for (i, e) in events.enumerated() {
    if e.allDay { continue }
    guard let startMin = effectiveStartMin(e) else { continue }
    let endMin = effectiveEndMin(e) ?? (startMin + 30)
    if startMin <= nowMin && nowMin < endMin { happening.insert(i) }
  }
  if !happening.isEmpty { return happening }
  for (i, e) in events.enumerated() {
    if e.allDay { continue }
    guard let startMin = effectiveStartMin(e) else { continue }
    // A carried event started before today began, so it is never "next up".
    if startMin >= nowMin { return [i] }
  }
  return []
}

private func isPastEvent(_ e: CachedEvent, nowMin: Int) -> Bool {
  if e.allDay { return false }
  guard let endMin = effectiveEndMin(e) else { return false }
  return endMin < nowMin
}

private func headerDateString(_ when: Date) -> String {
  let fmt = DateFormatter()
  fmt.dateFormat = "EEE, MMM d"
  return fmt.string(from: when).uppercased()
}

// MARK: - Small view

struct SmallView: View {
  let entry: PearCalEntry

  var body: some View {
    let events = entry.payload?.events ?? []
    let upcoming = entry.payload?.upcoming ?? []
    let tomorrow = entry.payload?.tomorrowFirst
    // Today first, then upcoming (TODO #107), within the small widget's budget.
    let budget = 3
    let shownToday = Array(events.prefix(budget))
    let shownUpcoming = Array(upcoming.prefix(max(0, budget - shownToday.count)))
    let remaining = events.count - shownToday.count

    VStack(alignment: .leading, spacing: 6) {
      Text(headerDateString(entry.date)).font(.caption2).foregroundColor(Theme.subtle)
      ForEach(Array(shownToday.enumerated()), id: \.offset) { _, ev in
        eventRow(ev, showTime: true)
      }
      if !shownUpcoming.isEmpty {
        ForEach(Array(shownUpcoming.enumerated()), id: \.offset) { _, ev in
          upcomingRow(ev, use24h: entry.payload?.use24h)
        }
      }
      if remaining > 0 && shownUpcoming.isEmpty {
        Text("+\(remaining) more").font(.caption2).foregroundColor(Theme.subtle)
      }
      if shownToday.isEmpty && shownUpcoming.isEmpty {
        if let t = tomorrow {
          Spacer()
          Text("TOMORROW").font(.caption2).foregroundColor(Theme.accent)
          eventRow(t, showTime: true)
        } else {
          Spacer()
          Text("No events today").font(.caption).foregroundColor(Theme.subtle)
        }
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  @ViewBuilder
  private func eventRow(_ ev: CachedEvent, showTime: Bool) -> some View {
    HStack(alignment: .top, spacing: 6) {
      colorBar(ev).frame(width: 3)
      VStack(alignment: .leading, spacing: 2) {
        Text(ev.title).font(.system(size: 14, weight: .semibold)).foregroundColor(Theme.text).lineLimit(2)
        if showTime {
          Text(eventTimeLabel(ev, use24h: entry.payload?.use24h)).font(.caption2).foregroundColor(Theme.accent)
        }
      }
    }
  }
}

// MARK: - Medium view

struct MediumView: View {
  let entry: PearCalEntry
  // Rows this family has room for. .systemMedium keeps its historical 4; a
  // .systemLarge is roughly two and a half times the height, so it takes 10.
  // iOS widgets cannot scroll, so this is the whole of what a large one shows.
  var rowBudget: Int = 4

  var body: some View {
    let allEvents = entry.payload?.events ?? []
    let allSlots: [[Int]] = entry.payload?.slots ?? allEvents.indices.map { [$0] }
    let upcoming = entry.payload?.upcoming ?? []
    let tomorrow = entry.payload?.tomorrowFirst
    let nowMin = currentMinutes(entry.date)
    let nextUp = findNextUp(allEvents, nowMin: nowMin)
    // Today's events take rows first; upcoming (TODO #107) fills the rest of the
    // budget so a holiday today no longer hides what's coming up.
    let shownSlots = Array(allSlots.prefix(rowBudget))
    let shownEventCount = shownSlots.reduce(0) { $0 + $1.count }
    let remaining = allEvents.count - shownEventCount
    let shownUpcoming = Array(upcoming.prefix(max(0, rowBudget - shownSlots.count)))

    VStack(alignment: .leading, spacing: 6) {
      Text(headerDateString(entry.date))
        .font(.caption2)
        .foregroundColor(Theme.subtle)
        .frame(maxWidth: .infinity, alignment: .center)
      if !allEvents.isEmpty {
        ForEach(Array(shownSlots.enumerated()), id: \.offset) { _, slot in
          if slot.count >= 2, slot[0] < allEvents.count, slot[1] < allEvents.count {
            pairedRow(
              allEvents[slot[0]], allEvents[slot[1]],
              leftNextUp: nextUp.contains(slot[0]),
              leftPast: isPastEvent(allEvents[slot[0]], nowMin: nowMin),
              rightNextUp: nextUp.contains(slot[1]),
              rightPast: isPastEvent(allEvents[slot[1]], nowMin: nowMin)
            )
          } else if slot.count >= 1, slot[0] < allEvents.count {
            row(
              allEvents[slot[0]],
              isNextUp: nextUp.contains(slot[0]),
              isPast: isPastEvent(allEvents[slot[0]], nowMin: nowMin)
            )
          }
        }
      }
      if !shownUpcoming.isEmpty {
        ForEach(Array(shownUpcoming.enumerated()), id: \.offset) { _, ev in
          upcomingRow(ev, use24h: entry.payload?.use24h)
        }
      }
      if remaining > 0 && shownUpcoming.isEmpty {
        Text("+\(remaining) more").font(.caption2).foregroundColor(Theme.subtle)
      }
      if allEvents.isEmpty && shownUpcoming.isEmpty {
        if let t = tomorrow {
          Spacer()
          Text("NOTHING TODAY — TOMORROW").font(.caption2).foregroundColor(Theme.accent)
          row(t, isNextUp: false, isPast: false)
          Spacer()
        } else {
          Spacer()
          Text("No events today").font(.subheadline).foregroundColor(Theme.subtle)
          Spacer()
        }
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private func titleColor(isNextUp: Bool, isPast: Bool) -> Color {
    if isPast { return Theme.muted }
    if isNextUp { return Theme.accent }
    return Theme.text
  }

  @ViewBuilder
  private func row(_ ev: CachedEvent, isNextUp: Bool, isPast: Bool) -> some View {
    let tColor = titleColor(isNextUp: isNextUp, isPast: isPast)
    let timeColor: Color = isNextUp ? Theme.accent : Theme.muted
    let hasLoc = !(ev.location ?? "").isEmpty
    VStack(alignment: .leading, spacing: 1) {
      HStack(spacing: 8) {
        colorBar(ev).frame(width: 3, height: 20)
        Text(ev.title).font(.system(size: 13, weight: .medium)).foregroundColor(tColor).lineLimit(1)
        Spacer()
        Text(eventTimeLabel(ev, use24h: entry.payload?.use24h)).font(.caption2).foregroundColor(timeColor)
      }
      if hasLoc, let loc = ev.location {
        Text(loc)
          .font(.system(size: 10))
          .foregroundColor(isPast ? Theme.muted.opacity(0.5) : Theme.muted)
          .lineLimit(1)
          .padding(.leading, 11)
      }
    }
  }

  @ViewBuilder
  private func pairedRow(_ a: CachedEvent, _ b: CachedEvent,
                         leftNextUp: Bool, leftPast: Bool,
                         rightNextUp: Bool, rightPast: Bool) -> some View {
    let aColor = titleColor(isNextUp: leftNextUp, isPast: leftPast)
    let bColor = titleColor(isNextUp: rightNextUp, isPast: rightPast)
    let timeColor: Color = (leftNextUp || rightNextUp) ? Theme.accent : Theme.muted
    HStack(spacing: 6) {
      colorBar(a).frame(width: 3, height: 20)
      Text(a.title).font(.system(size: 13, weight: .medium)).foregroundColor(aColor).lineLimit(1)
      colorBar(b).frame(width: 3, height: 20).padding(.leading, 2)
      Text(b.title).font(.system(size: 13, weight: .medium)).foregroundColor(bColor).lineLimit(1)
      Spacer()
      Text(eventTimeLabel(a, use24h: entry.payload?.use24h)).font(.caption2).foregroundColor(timeColor)
    }
  }
}

// MARK: - Entry view

struct PearCalWidgetEntryView: View {
  @Environment(\.widgetFamily) var family
  let entry: PearCalEntry

  var body: some View {
    switch family {
    case .systemLarge: MediumView(entry: entry, rowBudget: 10)
    case .systemMedium: MediumView(entry: entry)
    default: SmallView(entry: entry)
    }
  }
}

// MARK: - Widget

@main
struct PearCalWidget: Widget {
  let kind: String = "PearCalWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: PearCalProvider()) { entry in
      if #available(iOS 17.0, *) {
        PearCalWidgetEntryView(entry: entry)
          .padding(12)
          .containerBackground(Theme.bg, for: .widget)
      } else {
        PearCalWidgetEntryView(entry: entry)
          .padding(12)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Theme.bg)
      }
    }
    .configurationDisplayName("Today")
    .description("Your PearCal events for today.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

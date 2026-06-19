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
}

struct CachedPayload: Codable {
  let date: String
  let generatedAt: Double
  let events: [CachedEvent]
  let slots: [[Int]]?
  let tomorrowFirst: CachedEvent?
  let upcoming: [CachedEvent]?   // next few events on empty days, when enabled — TODO #107
  let use24h: Bool?
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
    completion(PearCalEntry(date: Date(), payload: CacheLoader.load()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<PearCalEntry>) -> Void) {
    let now = Date()
    let entry = PearCalEntry(date: now, payload: CacheLoader.load())
    let refresh = Calendar.current.date(byAdding: .minute, value: 15, to: now) ?? now.addingTimeInterval(900)
    completion(Timeline(entries: [entry], policy: .after(refresh)))
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

private func currentMinutes() -> Int {
  let comps = Calendar.current.dateComponents([.hour, .minute], from: Date())
  return (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
}

private func findNextUp(_ events: [CachedEvent], nowMin: Int) -> Set<Int> {
  var happening = Set<Int>()
  for (i, e) in events.enumerated() {
    if e.allDay { continue }
    guard let startMin = minutesFromHHMM(e.start) else { continue }
    let endMin = minutesFromHHMM(e.end) ?? (startMin + 30)
    if startMin <= nowMin && nowMin < endMin { happening.insert(i) }
  }
  if !happening.isEmpty { return happening }
  for (i, e) in events.enumerated() {
    if e.allDay { continue }
    guard let startMin = minutesFromHHMM(e.start) else { continue }
    if startMin >= nowMin { return [i] }
  }
  return []
}

private func isPastEvent(_ e: CachedEvent, nowMin: Int) -> Bool {
  if e.allDay { return false }
  guard let endMin = minutesFromHHMM(e.end) else { return false }
  return endMin < nowMin
}

private func headerDateString() -> String {
  let fmt = DateFormatter()
  fmt.dateFormat = "EEE, MMM d"
  return fmt.string(from: Date()).uppercased()
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
      Text(headerDateString()).font(.caption2).foregroundColor(Theme.subtle)
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

  var body: some View {
    let allEvents = entry.payload?.events ?? []
    let allSlots: [[Int]] = entry.payload?.slots ?? allEvents.indices.map { [$0] }
    let upcoming = entry.payload?.upcoming ?? []
    let tomorrow = entry.payload?.tomorrowFirst
    let nowMin = currentMinutes()
    let nextUp = findNextUp(allEvents, nowMin: nowMin)
    // Today's events take rows first; upcoming (TODO #107) fills the rest of a
    // fixed budget so a holiday today no longer hides what's coming up.
    let rowBudget = 4
    let shownSlots = Array(allSlots.prefix(rowBudget))
    let shownEventCount = shownSlots.reduce(0) { $0 + $1.count }
    let remaining = allEvents.count - shownEventCount
    let shownUpcoming = Array(upcoming.prefix(max(0, rowBudget - shownSlots.count)))

    VStack(alignment: .leading, spacing: 6) {
      Text(headerDateString())
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
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

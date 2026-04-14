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
}

struct CachedPayload: Codable {
  let date: String
  let generatedAt: Double
  let events: [CachedEvent]
  let tomorrowFirst: CachedEvent?
}

// MARK: - Theme

enum Theme {
  static let bg = Color(red: 0x1A / 255.0, green: 0x19 / 255.0, blue: 0x16 / 255.0)
  static let accent = Color(red: 0xC8 / 255.0, green: 0x92 / 255.0, blue: 0x2A / 255.0)
  static let text = Color(red: 0xF2 / 255.0, green: 0xEF / 255.0, blue: 0xE8 / 255.0)
  static let subtle = Color(red: 0xF2 / 255.0, green: 0xEF / 255.0, blue: 0xE8 / 255.0).opacity(0.6)
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

// Format an "HH:mm" 24-hour string as "h:mm a" in the user's locale. Returns
// the input unchanged if parsing fails.
private func prettyTime(_ hhmm: String?) -> String {
  guard let hhmm = hhmm, !hhmm.isEmpty else { return "" }
  let parser = DateFormatter()
  parser.dateFormat = "HH:mm"
  parser.locale = Locale(identifier: "en_US_POSIX")
  guard let d = parser.date(from: hhmm) else { return hhmm }
  let out = DateFormatter()
  out.dateFormat = "h:mm a"
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

private func eventTimeLabel(_ ev: CachedEvent) -> String {
  if ev.allDay { return "All day" }
  return prettyTime(ev.start)
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
    let tomorrow = entry.payload?.tomorrowFirst

    VStack(alignment: .leading, spacing: 6) {
      Text(headerDateString()).font(.caption2).foregroundColor(Theme.subtle)
      if let ev = events.first {
        eventRow(ev, showTime: true)
        if events.count > 1 {
          Text("+\(events.count - 1) more").font(.caption2).foregroundColor(Theme.subtle)
        }
      } else if let t = tomorrow {
        Spacer()
        Text("TOMORROW").font(.caption2).foregroundColor(Theme.accent)
        eventRow(t, showTime: true)
      } else {
        Spacer()
        Text("No events today").font(.caption).foregroundColor(Theme.subtle)
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  @ViewBuilder
  private func eventRow(_ ev: CachedEvent, showTime: Bool) -> some View {
    HStack(alignment: .top, spacing: 6) {
      RoundedRectangle(cornerRadius: 2).fill(swatch(ev.color)).frame(width: 3)
      VStack(alignment: .leading, spacing: 2) {
        Text(ev.title).font(.system(size: 14, weight: .semibold)).foregroundColor(Theme.text).lineLimit(2)
        if showTime {
          Text(eventTimeLabel(ev)).font(.caption2).foregroundColor(Theme.accent)
        }
      }
    }
  }
}

// MARK: - Medium view

struct MediumView: View {
  let entry: PearCalEntry

  var body: some View {
    let events = Array((entry.payload?.events ?? []).prefix(4))
    let tomorrow = entry.payload?.tomorrowFirst

    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(headerDateString()).font(.caption2).foregroundColor(Theme.subtle)
        Spacer()
        Text("PearCal").font(.caption2).foregroundColor(Theme.accent)
      }
      if !events.isEmpty {
        ForEach(events) { ev in row(ev) }
        if (entry.payload?.events.count ?? 0) > events.count {
          Text("+\((entry.payload?.events.count ?? 0) - events.count) more")
            .font(.caption2).foregroundColor(Theme.subtle)
        }
      } else if let t = tomorrow {
        Spacer()
        Text("NOTHING TODAY — TOMORROW").font(.caption2).foregroundColor(Theme.accent)
        row(t)
        Spacer()
      } else {
        Spacer()
        Text("No events today").font(.subheadline).foregroundColor(Theme.subtle)
        Spacer()
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  @ViewBuilder
  private func row(_ ev: CachedEvent) -> some View {
    HStack(spacing: 8) {
      RoundedRectangle(cornerRadius: 2).fill(swatch(ev.color)).frame(width: 3, height: 20)
      Text(ev.title).font(.system(size: 13, weight: .medium)).foregroundColor(Theme.text).lineLimit(1)
      Spacer()
      Text(eventTimeLabel(ev)).font(.caption2).foregroundColor(Theme.accent)
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

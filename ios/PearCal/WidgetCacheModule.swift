import Foundation
import WidgetKit

@objc(WidgetCache)
class WidgetCacheModule: NSObject {
  static let appGroup = "group.com.pearcal"
  static let widgetKind = "PearCalWidget"
  static let cacheFilename = "today.json"

  @objc(writeCache:resolver:rejecter:)
  func writeCache(_ json: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let containerURL = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: WidgetCacheModule.appGroup) else {
      reject("no_container", "App Group container unavailable", nil)
      return
    }
    let fileURL = containerURL.appendingPathComponent(WidgetCacheModule.cacheFilename)
    do {
      try json.data(using: .utf8)?.write(to: fileURL, options: .atomic)
      if #available(iOS 14.0, *) {
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetCacheModule.widgetKind)
      }
      resolve(fileURL.path)
    } catch {
      reject("write_failed", error.localizedDescription, error)
    }
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}

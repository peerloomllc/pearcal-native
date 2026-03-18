import UserNotifications

@objc(PearCalNotifications)
class NotificationsModule: NSObject {

  private static var permissionRequested = false

  private static func ensurePermission() {
    guard !permissionRequested else { return }
    permissionRequested = true
    UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .sound, .badge]
    ) { _, _ in }
  }

  @objc func schedule(
    _ opts: NSDictionary,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    NotificationsModule.ensurePermission()
    guard
      let id = opts["id"] as? Int,
      let fireAtMs = opts["fireAt"] as? Double,
      let title = opts["title"] as? String
    else {
      reject("INVALID_ARGS", "Missing required fields", nil)
      return
    }
    let body = opts["body"] as? String ?? ""
    let tab = opts["tab"] as? String ?? ""
    let eventId = opts["eventId"] as? String ?? ""

    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    content.userInfo = ["tab": tab, "eventId": eventId]

    let fireDate = Date(timeIntervalSince1970: fireAtMs / 1000.0)
    let components = Calendar.current.dateComponents(
      [.year, .month, .day, .hour, .minute, .second],
      from: fireDate
    )
    let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
    let request = UNNotificationRequest(
      identifier: "\(id)",
      content: content,
      trigger: trigger
    )

    UNUserNotificationCenter.current().add(request) { error in
      if let error = error {
        reject("SCHEDULE_ERROR", error.localizedDescription, error)
      } else {
        resolve(nil)
      }
    }
  }

  @objc func cancel(
    _ notifId: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    let idStr = "\(notifId.intValue)"
    UNUserNotificationCenter.current().removePendingNotificationRequests(
      withIdentifiers: [idStr]
    )
    UNUserNotificationCenter.current().removeDeliveredNotifications(
      withIdentifiers: [idStr]
    )
    resolve(nil)
  }

  @objc func postNow(
    _ opts: NSDictionary,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    NotificationsModule.ensurePermission()
    let id = opts["id"] as? Int ?? Int.random(in: 1_000_000...9_999_999)
    let title = opts["title"] as? String ?? "PearCal"
    let body = opts["body"] as? String ?? ""
    let tab = opts["tab"] as? String ?? ""

    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    content.userInfo = ["tab": tab]

    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
    let request = UNNotificationRequest(
      identifier: "now-\(id)",
      content: content,
      trigger: trigger
    )
    UNUserNotificationCenter.current().add(request) { _ in resolve(nil) }
  }

  @objc func getPermission(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral:
        resolve("granted")
      default:
        resolve("denied")
      }
    }
  }

  // Required stubs for RN event emitter contract
  @objc func addListener(_ eventName: String) {}
  @objc func removeListeners(_ count: Double) {}

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}

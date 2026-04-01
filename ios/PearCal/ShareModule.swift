import UIKit

@objc(PearCalShare)
class ShareModule: NSObject {
  @objc func share(_ title: String, text: String) {
    DispatchQueue.main.async {
      let items: [Any] = [text]
      let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
      if let root = UIApplication.shared.connectedScenes
          .compactMap({ $0 as? UIWindowScene })
          .first?.windows.first?.rootViewController {
        vc.popoverPresentationController?.sourceView = root.view
        root.present(vc, animated: true)
      }
    }
  }

  @objc func shareCalendar(_ content: String) {
    DispatchQueue.main.async {
      // Write to a temp .ics file so the share sheet offers calendar-aware destinations
      let tmpURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pearcal-export.ics")
      try? content.write(to: tmpURL, atomically: true, encoding: .utf8)
      let items: [Any] = [tmpURL]
      let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
      if let root = UIApplication.shared.connectedScenes
          .compactMap({ $0 as? UIWindowScene })
          .first?.windows.first?.rootViewController {
        vc.popoverPresentationController?.sourceView = root.view
        root.present(vc, animated: true)
      }
    }
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}

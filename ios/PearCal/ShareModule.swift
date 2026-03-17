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
        root.present(vc, animated: true)
      }
    }
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}

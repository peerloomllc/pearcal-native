import UIKit

@objc(PearCalDeepLink)
class DeepLinkModule: NSObject {

  @objc func openURL(_ urlString: String) {
    guard let url = URL(string: urlString) else { return }
    DispatchQueue.main.async {
      UIApplication.shared.open(url)
    }
  }

  @objc func canOpenLightning(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let url = URL(string: "lightning:") else { resolve(false); return }
    DispatchQueue.main.async {
      resolve(UIApplication.shared.canOpenURL(url))
    }
  }

  @objc func openLightning(_ invoice: String) {
    let urlStr = invoice.hasPrefix("lightning:") ? invoice : "lightning:\(invoice)"
    guard let url = URL(string: urlStr) else { return }
    DispatchQueue.main.async {
      UIApplication.shared.open(url)
    }
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}

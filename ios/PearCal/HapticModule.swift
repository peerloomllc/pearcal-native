import UIKit

@objc(PearCalHaptic)
class HapticModule: NSObject {
  @objc func impact(_ style: String) {
    DispatchQueue.main.async {
      switch style {
      case "medium":
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      case "heavy":
        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
      default:
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
      }
    }
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}

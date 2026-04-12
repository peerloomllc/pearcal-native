import Foundation

@objc(PearCalScreenshot)
class ScreenshotModule: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { return true }

  @objc func constantsToExport() -> [AnyHashable: Any]! {
    let args = ProcessInfo.processInfo.arguments
    var scene = 0
    var dark = -1  // -1 = not set; 0 = light; 1 = dark
    if let idx = args.firstIndex(of: "-screenshotScene"),
       idx + 1 < args.count,
       let n = Int(args[idx + 1]) {
      scene = n
    } else if let envN = ProcessInfo.processInfo.environment["PEARCAL_SCREENSHOT_SCENE"],
              let n = Int(envN) {
      scene = n
    }
    if let idx = args.firstIndex(of: "-screenshotDark"),
       idx + 1 < args.count,
       let n = Int(args[idx + 1]) {
      dark = n
    }
    return ["scene": scene, "dark": dark]
  }
}

import Foundation

@objc(PearCalLink)
class LinkModule: NSObject {
  static var pendingLink: String? = nil
  static var pendingTab: String? = nil

  @objc func getPendingLink(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    let link = LinkModule.pendingLink
    LinkModule.pendingLink = nil
    resolve(link)
  }

  @objc func getPendingTab(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    let tab = LinkModule.pendingTab
    LinkModule.pendingTab = nil
    resolve(tab)
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}

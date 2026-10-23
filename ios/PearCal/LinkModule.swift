import Foundation

@objc(PearCalLink)
class LinkModule: NSObject {
  static var pendingLink: String? = nil
  static var pendingTab: String? = nil
  static var pendingGroupSettingsId: String? = nil
  // #24: a calendar file opened into the app, as JSON { text, filename },
  // waiting for the JS side to poll it.
  static var pendingIcs: String? = nil

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

  @objc func getPendingGroupSettingsId(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    let gsid = LinkModule.pendingGroupSettingsId
    LinkModule.pendingGroupSettingsId = nil
    resolve(gsid)
  }

  @objc func getPendingIcs(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    let ics = LinkModule.pendingIcs
    LinkModule.pendingIcs = nil
    resolve(ics)
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}

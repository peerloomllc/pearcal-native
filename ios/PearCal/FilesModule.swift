import Foundation
import UIKit
import UniformTypeIdentifiers

// Folder access for the automatic .ics export (TODO #187). Pick a folder once,
// keep a security-scoped bookmark, and rewrite the calendar files there later,
// which expo-file-system can't do on iOS. Android does the same through the
// Storage Access Framework (FilesModule.kt). Ported from PearCircle's
// PearCircleFiles, which does this for its automatic backup.
@objc(PearCalFiles)
class FilesModule: NSObject, UIDocumentPickerDelegate {
  private var pendingFolder: RCTPromiseResolveBlock?

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  // Resolves { bookmark: base64, name } or { canceled: true }.
  @objc func pickFolder(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let root = UIApplication.shared.connectedScenes
          .compactMap({ $0 as? UIWindowScene })
          .first?.windows.first?.rootViewController else {
        reject("no_view", "no view controller to present from", nil)
        return
      }
      var presenter = root
      while let presented = presenter.presentedViewController { presenter = presented }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
      picker.delegate = self
      self.pendingFolder = resolve
      presenter.present(picker, animated: true)
    }
  }

  // Runs `body` with access to the bookmarked folder. Returns a fresh bookmark
  // when the stored one went stale, or nil.
  private func withFolder(_ bookmark: String, reject: RCTPromiseRejectBlock, _ body: (URL) throws -> Void) -> (ok: Bool, fresh: String?) {
    guard let data = Data(base64Encoded: bookmark) else {
      reject("bad_bookmark", "the saved folder is unreadable, pick it again", nil)
      return (false, nil)
    }
    var stale = false
    let folder: URL
    do {
      folder = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    } catch {
      reject("folder_gone", "the export folder is no longer available, pick it again", error)
      return (false, nil)
    }
    guard folder.startAccessingSecurityScopedResource() else {
      reject("no_access", "PearCal lost access to the export folder, pick it again", nil)
      return (false, nil)
    }
    defer { folder.stopAccessingSecurityScopedResource() }
    do { try body(folder) } catch {
      reject("write_failed", error.localizedDescription, error)
      return (false, nil)
    }
    var fresh: String? = nil
    if stale, let d = try? folder.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
      fresh = d.base64EncodedString()
    }
    return (true, fresh)
  }

  // Overwrite `filename` inside the bookmarked folder. Resolves { ok: true }
  // plus a fresh `bookmark` when the stored one went stale.
  @objc func writeToFolder(
    _ bookmark: String,
    filename: String,
    contents: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    let r = withFolder(bookmark, reject: reject) { folder in
      let file = folder.appendingPathComponent(filename)
      var coordinatorError: NSError?
      var writeError: Error?
      NSFileCoordinator().coordinate(writingItemAt: file, options: .forReplacing, error: &coordinatorError) { target in
        do { try Data(contents.utf8).write(to: target, options: .atomic) } catch { writeError = error }
      }
      if let err = coordinatorError ?? writeError { throw err }
    }
    guard r.ok else { return }
    var result: [String: Any] = ["ok": true]
    if let fresh = r.fresh { result["bookmark"] = fresh }
    resolve(result)
  }

  // Delete `filename` from the bookmarked folder if it is there.
  @objc func deleteFromFolder(
    _ bookmark: String,
    filename: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    let r = withFolder(bookmark, reject: reject) { folder in
      let file = folder.appendingPathComponent(filename)
      guard FileManager.default.fileExists(atPath: file.path) else { return }
      var coordinatorError: NSError?
      var deleteError: Error?
      NSFileCoordinator().coordinate(writingItemAt: file, options: .forDeleting, error: &coordinatorError) { target in
        do { try FileManager.default.removeItem(at: target) } catch { deleteError = error }
      }
      if let err = coordinatorError ?? deleteError { throw err }
    }
    guard r.ok else { return }
    var result: [String: Any] = ["ok": true]
    if let fresh = r.fresh { result["bookmark"] = fresh }
    resolve(result)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let resolve = pendingFolder else { return }
    pendingFolder = nil
    guard let url = urls.first else { resolve(["canceled": true]); return }
    let access = url.startAccessingSecurityScopedResource()
    defer { if access { url.stopAccessingSecurityScopedResource() } }
    if let data = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
      // The root of "On My iPhone" is a folder called "File Provider Storage"
      // on disk, and localizedName returns that too, so name it the way Files does.
      var name = url.lastPathComponent
      if name == "File Provider Storage" { name = "On My " + UIDevice.current.model }
      resolve(["bookmark": data.base64EncodedString(), "name": name])
    } else {
      resolve(["canceled": true, "error": "could not keep access to that folder"])
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pendingFolder?(["canceled": true])
    pendingFolder = nil
  }
}

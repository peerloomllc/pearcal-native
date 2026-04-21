import Foundation
import Security

@objc(PearCalICloudKeychain)
class ICloudKeychain: NSObject {
  private static let service = "com.pearcal.identity"
  private static let account = "pearcal.identity.mnemonic"

  private static func baseQuery() -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: kCFBooleanTrue!,
    ]
  }

  @objc func isAvailable(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    resolve(true)
  }

  @objc func saveMnemonic(
    _ value: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let data = value.data(using: .utf8) else {
      reject("icloud_keychain_encode_failed", "mnemonic not UTF-8 encodable", nil)
      return
    }
    var query = ICloudKeychain.baseQuery()
    SecItemDelete(query as CFDictionary)
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    let status = SecItemAdd(query as CFDictionary, nil)
    if status == errSecSuccess {
      resolve(true)
    } else {
      reject("icloud_keychain_save_failed", "SecItemAdd status=\(status)", nil)
    }
  }

  @objc func readMnemonic(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    var query = ICloudKeychain.baseQuery()
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = kCFBooleanTrue!
    var out: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    if status == errSecItemNotFound {
      resolve(NSNull())
      return
    }
    if status != errSecSuccess {
      reject("icloud_keychain_read_failed", "SecItemCopyMatching status=\(status)", nil)
      return
    }
    guard let data = out as? Data, let s = String(data: data, encoding: .utf8) else {
      resolve(NSNull())
      return
    }
    resolve(s)
  }

  @objc func deleteMnemonic(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    let query = ICloudKeychain.baseQuery()
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecSuccess || status == errSecItemNotFound {
      resolve(true)
    } else {
      reject("icloud_keychain_delete_failed", "SecItemDelete status=\(status)", nil)
    }
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}

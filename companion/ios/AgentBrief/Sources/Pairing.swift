import Foundation
import Security

/// One Mac this iPad pairs with. Its certificate fingerprint identifies it.
/// The credential lives in the Keychain and the rest in UserDefaults.
struct Pairing: Equatable, Identifiable {
  var hosts: [String]
  var port: Int
  var fingerprint: String
  var macName: String
  var credential: String

  var id: String { fingerprint }
}

enum PairingStore {
  private static let service = "com.skyam25.agentbrief.credential"
  private static let defaultsKey = "pairedMacs"

  private struct Plain: Codable {
    var hosts: [String]
    var port: Int
    var fingerprint: String
    var macName: String
  }

  private static func plains() -> [Plain] {
    guard let data = UserDefaults.standard.data(forKey: defaultsKey) else { return [] }
    return (try? JSONDecoder().decode([Plain].self, from: data)) ?? []
  }

  private static func store(_ plains: [Plain]) throws {
    UserDefaults.standard.set(try JSONEncoder().encode(plains), forKey: defaultsKey)
  }

  static func load() -> [Pairing] {
    plains().compactMap { plain in
      guard let credential = readCredential(plain.fingerprint) else { return nil }
      return Pairing(hosts: plain.hosts, port: plain.port, fingerprint: plain.fingerprint, macName: plain.macName, credential: credential)
    }
  }

  /// Adds this Mac, or replaces it when this iPad has paired with it before.
  static func save(_ pairing: Pairing) throws {
    try writeCredential(pairing.credential, pairing.fingerprint)
    let plain = Plain(hosts: pairing.hosts, port: pairing.port, fingerprint: pairing.fingerprint, macName: pairing.macName)
    try store(plains().filter { $0.fingerprint != pairing.fingerprint } + [plain])
  }

  static func remove(_ fingerprint: String) {
    try? store(plains().filter { $0.fingerprint != fingerprint })
    SecItemDelete(query(fingerprint) as CFDictionary)
  }

  static func clear() {
    UserDefaults.standard.removeObject(forKey: defaultsKey)
    SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
  }

  private static func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  private static func readCredential(_ account: String) -> String? {
    var q = query(account)
    q[kSecReturnData as String] = true
    var found: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private static func writeCredential(_ credential: String, _ account: String) throws {
    SecItemDelete(query(account) as CFDictionary)
    var q = query(account)
    q[kSecValueData as String] = Data(credential.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(q as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "The Keychain refused the credential (\(status))."])
    }
  }
}

import CryptoKit
import Foundation

enum LanError: Error, LocalizedError {
  /// No host answered. The string says why, in words for the screen.
  case unreachable(String)
  case unauthorized
  case certificateChanged
  /// The Mac answered and said no.
  case rejected(status: Int, message: String)

  var errorDescription: String? {
    switch self {
    case .unreachable(let why): why
    case .unauthorized: "The Mac no longer knows this device. Pair again."
    case .certificateChanged: "The Mac's certificate changed, so this device will not talk to it. Pair again."
    case .rejected(_, let message): message
    }
  }
}

/// Accepts a server only when its leaf certificate matches the fingerprint from the pairing QR code.
final class PinDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
  private let fingerprint: String
  private let lock = NSLock()
  private var mismatched = false

  init(fingerprint: String) { self.fingerprint = fingerprint }

  /// True once a server has shown the wrong certificate. Reading clears it.
  func takeMismatch() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let seen = mismatched
    mismatched = false
    return seen
  }

  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust
    else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate]
    if let leaf = chain?.first, Self.fingerprint(of: SecCertificateCopyData(leaf) as Data) == fingerprint {
      completionHandler(.useCredential, URLCredential(trust: trust))
      return
    }
    lock.lock()
    mismatched = true
    lock.unlock()
    completionHandler(.cancelAuthenticationChallenge, nil)
  }

  /// Base64url SHA-256 with no padding, as the pairing link carries it.
  static func fingerprint(of der: Data) -> String {
    Data(SHA256.hash(data: der)).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

/// Speaks the Mac's LAN API over pinned TLS and remembers which address answered.
final class LanClient: @unchecked Sendable {
  private let hosts: [String]
  private let port: Int
  private let credential: String?
  private let macName: String
  private let delegate: PinDelegate
  private let session: URLSession
  private let lock = NSLock()
  private var working: String?

  init(hosts: [String], port: Int, fingerprint: String, credential: String?, macName: String) {
    self.hosts = hosts
    self.port = port
    self.credential = credential
    self.macName = macName
    delegate = PinDelegate(fingerprint: fingerprint)
    let config = URLSessionConfiguration.ephemeral
    config.waitsForConnectivity = false
    config.timeoutIntervalForResource = 300
    session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
  }

  deinit { session.finishTasksAndInvalidate() }

  convenience init(_ pairing: Pairing) {
    self.init(hosts: pairing.hosts, port: pairing.port, fingerprint: pairing.fingerprint, credential: pairing.credential, macName: pairing.macName)
  }

  private var workingHost: String? {
    get {
      lock.lock()
      defer { lock.unlock() }
      return working
    }
    set {
      lock.lock()
      working = newValue
      lock.unlock()
    }
  }

  /// Addresses to try: the one that worked last, then the others in the order the QR code gave.
  private var ordered: [String] {
    guard let working = workingHost else { return hosts }
    return [working] + hosts.filter { $0 != working }
  }

  func pair(code: String, deviceName: String, installId: String?) async throws -> PairResponse {
    let body = try JSONEncoder().encode(PairRequest(code: code, deviceName: deviceName, installId: installId))
    return try JSONDecoder().decode(PairResponse.self, from: await request("POST", "/v1/pair", body: body, timeout: 6))
  }

  func unpair() async throws {
    _ = try await request("POST", "/v1/unpair", timeout: 3)
  }

  func handoffs() async throws -> [Handoff] {
    try JSONDecoder().decode(LanHandoffsResponse.self, from: await request("GET", "/v1/handoffs", timeout: 5)).handoffs
  }

  func handoff(id: String) async throws -> LanHandoffDetail {
    try JSONDecoder().decode(LanHandoffDetail.self, from: await request("GET", "/v1/handoffs/\(escaped(id))", timeout: 30))
  }

  /// Removes a hand-off from the Mac, and so from every paired device.
  func remove(id: String) async throws {
    _ = try JSONDecoder().decode(LanRemoveResponse.self, from: await request("DELETE", "/v1/handoffs/\(escaped(id))", timeout: 5))
  }

  /// Finds a live address first, so a large body never waits out a dead one.
  func deliver(id: String, json: Data) async throws -> IpadDeliveryResult {
    _ = try await handoffs()
    let data = try await request("POST", "/v1/handoffs/\(escaped(id))/deliver", body: json, timeout: 120, onlyWorking: true)
    return try JSONDecoder().decode(IpadDeliveryResult.self, from: data)
  }

  /// A file of a page hand-off's project, and its content type. `path` is already percent-encoded.
  func pageFile(id: String, path: String) async throws -> (Data, String) {
    let (data, response) = try await exchange("GET", "/v1/handoffs/\(escaped(id))/page/\(path)", timeout: 30)
    return (data, response.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream")
  }

  private func escaped(_ id: String) -> String { id.pathSegmentEscaped }

  private func request(_ method: String, _ path: String, body: Data? = nil, timeout: TimeInterval, onlyWorking: Bool = false) async throws -> Data {
    try await exchange(method, path, body: body, timeout: timeout, onlyWorking: onlyWorking).0
  }

  private func exchange(_ method: String, _ path: String, body: Data? = nil, timeout: TimeInterval, onlyWorking: Bool = false) async throws -> (Data, HTTPURLResponse) {
    var lastFailure: Error?
    for host in onlyWorking ? Array(ordered.prefix(1)) : ordered {
      var parts = URLComponents()
      parts.scheme = "https"
      parts.host = host
      parts.port = port
      parts.percentEncodedPath = path
      guard let url = parts.url else { continue }
      var req = URLRequest(url: url, timeoutInterval: timeout)
      req.httpMethod = method
      req.httpBody = body
      if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
      if let credential { req.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization") }
      do {
        let (data, response) = try await session.data(for: req)
        workingHost = host
        guard let http = response as? HTTPURLResponse else { throw LanError.unreachable("The Mac sent a reply this app cannot read.") }
        if http.statusCode == 401 { throw LanError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
          let said = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
          throw LanError.rejected(status: http.statusCode, message: said ?? "The Mac answered with error \(http.statusCode).")
        }
        return (data, http)
      } catch let error as URLError {
        if delegate.takeMismatch() { throw LanError.certificateChanged }
        lastFailure = error
        if workingHost == host { workingHost = nil }
      }
    }
    throw LanError.unreachable(reason(for: lastFailure))
  }

  private func reason(for error: Error?) -> String {
    let mac = macName.isEmpty ? "the Mac" : macName
    if let error = error as? URLError, error.code == .notConnectedToInternet {
      return "This device has no network, or Local Network access is off in Settings. Agent Brief can't reach \(mac)."
    }
    let code = (error as? URLError).map { " (error \($0.errorCode))" } ?? ""
    let app = macName.hasPrefix("Herdr on ") ? "Herdr" : "Agent Brief"
    return "Can't reach \(mac). Check that the Mac is awake, \(app) is open, and both are on the same network with no VPN on either.\(code)"
  }
}

extension String {
  /// Percent-encoded as one URL path segment, so a slash inside it stays part of the segment.
  var pathSegmentEscaped: String {
    addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? self
  }
}

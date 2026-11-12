import CryptoKit
import Foundation
import Network

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

/// Speaks the Mac's LAN API over pinned TLS and remembers which route answered.
///
/// The routes are the saved hosts and then the peer bridge. A route that worked last goes first.
/// Without one, the client gives every host a short window to accept a connection and warms the bridge meanwhile.
/// A LAN that answers wins, and a dead one costs that window instead of a full timeout per host.
final class LanClient: @unchecked Sendable {
  private enum Route: Equatable {
    case host(String)
    case peer
  }

  private let hosts: [String]
  private let port: Int
  private let fingerprint: String
  private let credential: String?
  private let macName: String
  private let delegate: PinDelegate
  private let session: URLSession
  private let pathMonitor = NWPathMonitor()
  private let lock = NSLock()
  private var working: Route?
  private var pathSignature: String?

  /// How long a host has to accept a connection before the search moves on.
  private static let probeWindow: TimeInterval = 1.5
  /// How long after a search starts the Mac's peer service may take to show up.
  private static let peerPatience: TimeInterval = 6

  init(hosts: [String], port: Int, fingerprint: String, credential: String?, macName: String) {
    self.hosts = hosts
    self.port = port
    self.fingerprint = fingerprint
    self.credential = credential
    self.macName = macName
    delegate = PinDelegate(fingerprint: fingerprint)
    let config = URLSessionConfiguration.ephemeral
    config.waitsForConnectivity = false
    config.timeoutIntervalForResource = 300
    session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    pathMonitor.pathUpdateHandler = { [weak self] path in self?.pathChanged(path) }
    pathMonitor.start(queue: DispatchQueue(label: "LanClient.path"))
  }

  deinit {
    pathMonitor.cancel()
    session.finishTasksAndInvalidate()
  }

  convenience init(_ pairing: Pairing) {
    self.init(hosts: pairing.hosts, port: pairing.port, fingerprint: pairing.fingerprint, credential: pairing.credential, macName: pairing.macName)
  }

  private var workingRoute: Route? {
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

  private var bridge: PeerBridge { PeerBridges.bridge(for: fingerprint) }

  /// A new network can revive a host or kill the working route, so the next request searches again from the LAN.
  /// The signature leaves out peer-to-peer and tunnel interfaces, which come and go with the bridge itself.
  private func pathChanged(_ path: NWPath) {
    let skipped = ["awdl", "llw", "lo", "utun", "ipsec"]
    let interfaces = path.availableInterfaces.map(\.name).filter { name in !skipped.contains { name.hasPrefix($0) } }
    let signature = "\(path.status) \(interfaces) \(path.gateways.map { "\($0)" })"
    lock.lock()
    if let old = pathSignature, old != signature { working = nil }
    pathSignature = signature
    lock.unlock()
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

  /// Finds a live route first, so a large body never waits out a dead one.
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

    // Nil means this route did not answer. Errors the Mac sent, and a wrong certificate, throw.
    func attempt(_ route: Route, peerBy deadline: Date) async throws -> (Data, HTTPURLResponse)? {
      do {
        return try await send(method, path, body: body, timeout: timeout, on: route, peerBy: deadline)
      } catch let error as URLError {
        if delegate.takeMismatch() { throw LanError.certificateChanged }
        lastFailure = error
        if workingRoute == route { workingRoute = nil }
        return nil
      } catch is PeerBridgeError {
        if workingRoute == route { workingRoute = nil }
        return nil
      }
    }

    // A working peer route whose service is gone gets a second, then the search below takes over and keeps the bridge browsing.
    if let route = workingRoute {
      if let answer = try await attempt(route, peerBy: Date().addingTimeInterval(1)) { return answer }
      if onlyWorking { throw LanError.unreachable(reason(for: lastFailure)) }
    }

    // The bridge warms up during the hosts' window, so it is ready when no host answers.
    let peerBy = Date().addingTimeInterval(Self.peerPatience)
    bridge.start()
    let probe = await Self.firstOpen(hosts, port: port, within: Self.probeWindow)
    if let host = probe.host, let answer = try await attempt(.host(host), peerBy: peerBy) { return answer }
    if let answer = try await attempt(.peer, peerBy: peerBy) { return answer }
    if lastFailure == nil, probe.offline { lastFailure = URLError(.notConnectedToInternet) }
    throw LanError.unreachable(reason(for: lastFailure))
  }

  private func send(
    _ method: String, _ path: String, body: Data?, timeout: TimeInterval, on route: Route, peerBy deadline: Date
  ) async throws -> (Data, HTTPURLResponse) {
    var parts = URLComponents()
    parts.scheme = "https"
    parts.percentEncodedPath = path
    switch route {
    case .host(let host):
      parts.host = host
      parts.port = port
    case .peer:
      parts.host = "127.0.0.1"
      parts.port = try await bridge.localPort(by: deadline)
    }
    guard let url = parts.url else { throw URLError(.badURL) }
    var req = URLRequest(url: url, timeoutInterval: timeout)
    req.httpMethod = method
    req.httpBody = body
    if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    if let credential { req.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization") }
    let (data, response) = try await session.data(for: req)
    workingRoute = route

    // The LAN works, so peer-to-peer Wi-Fi can rest.
    if case .host = route { bridge.pause() }
    guard let http = response as? HTTPURLResponse else { throw LanError.unreachable("The Mac sent a reply this app cannot read.") }
    if http.statusCode == 401 { throw LanError.unauthorized }
    guard (200..<300).contains(http.statusCode) else {
      let said = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
      throw LanError.rejected(status: http.statusCode, message: said ?? "The Mac answered with error \(http.statusCode).")
    }
    return (data, http)
  }

  // MARK: Probing

  private struct ProbeResult {
    /// The first host that accepted a connection.
    var host: String?
    /// True when some host had no network to try, or Local Network access was off.
    var offline = false
  }

  private enum Probe {
    case open, closed, offline
  }

  /// Tries every host at once and answers as soon as one accepts a TCP connection, or when the window ends.
  private static func firstOpen(_ hosts: [String], port: Int, within window: TimeInterval) async -> ProbeResult {
    await withTaskGroup(of: (String, Probe).self) { group in
      for host in hosts {
        group.addTask { (host, await probe(host, port: port, within: window)) }
      }
      var result = ProbeResult()
      for await (host, outcome) in group {
        if outcome == .offline { result.offline = true }
        if outcome == .open {
          result.host = host
          group.cancelAll()
          break
        }
      }
      return result
    }
  }

  private static let probeQueue = DispatchQueue(label: "LanClient.probe")

  private static func probe(_ host: String, port: Int, within window: TimeInterval) async -> Probe {
    guard let port = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else { return .closed }
    let connection = NWConnection(host: NWEndpoint.Host(host), port: port, using: .tcp)
    let once = Once()
    let outcome = await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Probe, Never>) in
        probeQueue.async {
          guard once.attach(continuation) else { return }
          connection.stateUpdateHandler = { state in
            switch state {
            case .ready: once.finish(.open)
            case .waiting: once.finish(connection.currentPath?.status == .unsatisfied ? .offline : .closed)
            case .failed: once.finish(.closed)
            default: break
            }
          }
          connection.start(queue: probeQueue)
          probeQueue.asyncAfter(deadline: .now() + window) { once.finish(.closed) }
        }
      }
    } onCancel: {
      probeQueue.async { once.finish(.closed) }
    }
    connection.cancel()
    return outcome
  }

  /// Resumes a probe's continuation once. Lives on the probe queue.
  private final class Once: @unchecked Sendable {
    private var continuation: CheckedContinuation<Probe, Never>?
    private var outcome: Probe?

    /// False when the probe already ended, as when it was cancelled first. The continuation is resumed then.
    func attach(_ continuation: CheckedContinuation<Probe, Never>) -> Bool {
      if let outcome {
        continuation.resume(returning: outcome)
        return false
      }
      self.continuation = continuation
      return true
    }

    func finish(_ outcome: Probe) {
      guard self.outcome == nil else { return }
      self.outcome = outcome
      continuation?.resume(returning: outcome)
      continuation = nil
    }
  }

  private func reason(for error: Error?) -> String {
    let mac = macName.isEmpty ? "the Mac" : macName
    if let error = error as? URLError, error.code == .notConnectedToInternet {
      return "This device has no network, or Local Network access is off in Settings. Agent Brief can't reach \(mac)."
    }
    let code = (error as? URLError).map { " (error \($0.errorCode))" } ?? ""
    let app = macName.hasPrefix("Herdr on ") ? "Herdr" : "Agent Brief"
    return "Can't reach \(mac). Check that the Mac is awake with \(app) open, and that both devices are on the same network or both have Wi-Fi and Bluetooth on.\(code)"
  }
}

extension String {
  /// Percent-encoded as one URL path segment, so a slash inside it stays part of the segment.
  var pathSegmentEscaped: String {
    addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? self
  }
}

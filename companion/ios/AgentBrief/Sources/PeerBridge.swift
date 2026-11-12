import Foundation
import Network

enum PeerBridgeError: Error {
  /// The Mac's service did not show up in time.
  case notFound
  case stopped
}

/// Reaches one Mac over Apple peer-to-peer Wi-Fi, so the devices need no shared network.
///
/// The bridge browses for the Mac's Bonjour service and listens on loopback.
/// Each loopback connection becomes a raw TCP pipe to the Mac's TLS listener,
/// so URLSession, the pinned certificate and the credential work as on the LAN.
final class PeerBridge: @unchecked Sendable {
  static let serviceType = "_agentbrief._tcp"

  /// The Mac names its service after its certificate fingerprint, so the pairing link needs no extra field.
  static func instanceName(for fingerprint: String) -> String { "ab-" + fingerprint.prefix(16) }

  let instanceName: String

  /// Every field below belongs to this queue.
  private let queue: DispatchQueue
  private var browser: NWBrowser?
  private var listener: NWListener?
  private var service: NWEndpoint?
  private var port: UInt16?
  private var waiters: [UUID: CheckedContinuation<Int, Error>] = [:]
  private var pipes: [ObjectIdentifier: Pipe] = [:]

  init(fingerprint: String) {
    instanceName = Self.instanceName(for: fingerprint)
    queue = DispatchQueue(label: "PeerBridge.\(instanceName)")
  }

  deinit {
    browser?.cancel()
    listener?.cancel()
  }

  /// Starts browsing and listening. Calling it again while running does nothing.
  func start() {
    queue.async { self.run() }
  }

  /// The loopback port that reaches the Mac. Throws when the Mac's service has not shown up by the deadline.
  func localPort(by deadline: Date) async throws -> Int {
    let id = UUID()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        queue.async {
          self.run()
          if let ready = self.readyPort {
            continuation.resume(returning: ready)
            return
          }
          let wait = deadline.timeIntervalSinceNow
          guard wait > 0 else {
            continuation.resume(throwing: PeerBridgeError.notFound)
            return
          }
          self.waiters[id] = continuation
          self.queue.asyncAfter(deadline: .now() + wait) { self.fail(id, PeerBridgeError.notFound) }
        }
      }
    } onCancel: {
      queue.async { self.fail(id, CancellationError()) }
    }
  }

  /// Stops browsing and listening while nothing waits for a port. Open pipes finish on their own.
  func pause() {
    queue.async {
      guard self.waiters.isEmpty else { return }
      self.halt()
    }
  }

  /// Stops everything, open pipes included. The next `localPort` starts again.
  func stop() {
    queue.async {
      self.halt()
      for pipe in self.pipes.values { pipe.close() }
      self.pipes = [:]
      for id in Array(self.waiters.keys) { self.fail(id, PeerBridgeError.stopped) }
    }
  }

  // MARK: On the queue

  private var readyPort: Int? {
    guard service != nil, let port else { return nil }
    return Int(port)
  }

  private func run() {
    if browser == nil {
      let parameters = NWParameters()
      parameters.includePeerToPeer = true
      let browser = NWBrowser(for: .bonjour(type: Self.serviceType, domain: "local."), using: parameters)
      browser.browseResultsChangedHandler = { [weak self] results, _ in self?.found(results) }
      browser.stateUpdateHandler = { [weak self, weak browser] state in
        guard case .failed = state, let self, let browser, self.browser === browser else { return }
        browser.cancel()
        self.browser = nil
        self.service = nil
      }
      self.browser = browser
      browser.start(queue: queue)
    }
    if listener == nil {
      let parameters = NWParameters.tcp
      parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
      guard let listener = try? NWListener(using: parameters) else { return }
      listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
      listener.stateUpdateHandler = { [weak self, weak listener] state in
        guard let self, let listener, self.listener === listener else { return }
        switch state {
        case .ready:
          self.port = listener.port?.rawValue
          self.serveWaiters()
        case .failed:
          listener.cancel()
          self.listener = nil
          self.port = nil
        default:
          break
        }
      }
      self.listener = listener
      listener.start(queue: queue)
    }
  }

  private func halt() {
    browser?.cancel()
    listener?.cancel()
    browser = nil
    listener = nil
    service = nil
    port = nil
  }

  private func found(_ results: Set<NWBrowser.Result>) {
    service = results.first { result in
      if case .service(let name, _, _, _) = result.endpoint { return name == instanceName }
      return false
    }?.endpoint
    serveWaiters()
  }

  private func serveWaiters() {
    guard let ready = readyPort else { return }
    let waiting = waiters
    waiters = [:]
    for continuation in waiting.values { continuation.resume(returning: ready) }
  }

  private func fail(_ id: UUID, _ error: Error) {
    waiters.removeValue(forKey: id)?.resume(throwing: error)
  }

  private func accept(_ inbound: NWConnection) {
    guard let service else {
      inbound.cancel()
      return
    }
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.connectionTimeout = 5
    let parameters = NWParameters(tls: nil, tcp: tcp)
    parameters.includePeerToPeer = true
    let pipe = Pipe(inbound, NWConnection(to: service, using: parameters), queue: queue)
    let key = ObjectIdentifier(pipe)
    pipe.onClose = { [weak self] in self?.pipes[key] = nil }
    pipes[key] = pipe
    pipe.start()
  }
}

/// Copies bytes both ways between two connections and closes both when either ends.
/// It reads the next chunk only after the last one was sent, so a large body never piles up in memory.
private final class Pipe {
  private let near: NWConnection
  private let far: NWConnection
  private let queue: DispatchQueue
  private var closed = false
  var onClose: (() -> Void)?

  init(_ near: NWConnection, _ far: NWConnection, queue: DispatchQueue) {
    self.near = near
    self.far = far
    self.queue = queue
  }

  func start() {
    for connection in [near, far] {
      connection.stateUpdateHandler = { [weak self] state in
        switch state {
        // Waiting means no route to the Mac right now, so the request fails fast instead of hanging.
        case .waiting, .failed, .cancelled: self?.close()
        default: break
        }
      }
      connection.start(queue: queue)
    }
    pump(from: near, to: far)
    pump(from: far, to: near)
  }

  private func pump(from source: NWConnection, to sink: NWConnection) {
    source.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
      guard let self, !self.closed else { return }
      if error != nil {
        close()
      } else if let data, !data.isEmpty {
        sink.send(content: data, completion: .contentProcessed { [weak self] error in
          guard let self, !self.closed else { return }
          if error != nil {
            close()
          } else if isComplete {
            finish(sink)
          } else {
            pump(from: source, to: sink)
          }
        })
      } else if isComplete {
        finish(sink)
      } else {
        pump(from: source, to: sink)
      }
    }
  }

  /// Passes the end of the stream on, then closes both sides.
  private func finish(_ sink: NWConnection) {
    sink.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self] _ in self?.close() })
  }

  func close() {
    guard !closed else { return }
    closed = true
    near.cancel()
    far.cancel()
    onClose?()
    onClose = nil
  }
}

/// One bridge per paired Mac, shared by every client that talks to it.
enum PeerBridges {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var bridges: [String: PeerBridge] = [:]

  static func bridge(for fingerprint: String) -> PeerBridge {
    lock.lock()
    defer { lock.unlock() }
    if let bridge = bridges[fingerprint] { return bridge }
    let bridge = PeerBridge(fingerprint: fingerprint)
    bridges[fingerprint] = bridge
    return bridge
  }

  /// Stops and forgets one Mac's bridge, as when the Mac is unpaired.
  static func remove(_ fingerprint: String) {
    lock.lock()
    let bridge = bridges.removeValue(forKey: fingerprint)
    lock.unlock()
    bridge?.stop()
  }

  /// Stops every bridge, as when the app leaves the foreground. Each starts again on demand.
  static func stopAll() {
    lock.lock()
    let all = Array(bridges.values)
    lock.unlock()
    for bridge in all { bridge.stop() }
  }
}

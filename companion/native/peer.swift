// Carries the phone API over Apple peer-to-peer Wi-Fi.
//
// Node cannot advertise a peer-to-peer Bonjour service, so this helper does it and forwards raw TCP bytes
// to the app's TLS listener on loopback. TLS runs end to end between the phone and Node.
//
//   agent-brief-peer --name <instance name> --port <local TCP port>
//
// stdout, one line:
//   ready              the listener is up and advertising _agentbrief._tcp
//   failed: <reason>   the listener could not start, then exits 1, or 64 for bad arguments
//
// It exits 0 when stdin closes or on SIGTERM or SIGINT. It exits 2 when the listener fails later or the
// service registration goes away, so the parent can restart it. Diagnostics go to stderr.

import Foundation
import Network

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)

let serviceType = "_agentbrief._tcp"

/// Bonjour caps an instance name at 63 bytes of UTF-8.
let maxNameBytes = 63

/// Each read takes at most this much, and the next read waits for its send to finish.
let chunkBytes = 64 * 1024

func log(_ message: String) {
  FileHandle.standardError.write(Data("agent-brief-peer: \(message)\n".utf8))
}

func say(_ line: String) {
  print(line)
  fflush(stdout)
}

func usage() -> Never {
  say("failed: usage: agent-brief-peer --name <instance name> --port <local TCP port>")
  exit(64)
}

func option(_ flag: String) -> String? {
  let args = CommandLine.arguments
  guard let at = args.firstIndex(of: flag), at + 1 < args.count else { return nil }
  return args[at + 1]
}

func trimmed(_ name: String) -> String {
  var out = ""
  for character in name {
    if out.utf8.count + String(character).utf8.count > maxNameBytes { break }
    out.append(character)
  }
  return out
}

guard let rawName = option("--name"), !rawName.isEmpty else { usage() }
guard let portText = option("--port"), let portNumber = UInt16(portText), portNumber > 0,
      let targetPort = NWEndpoint.Port(rawValue: portNumber) else { usage() }

let serviceName = trimmed(rawName)
if serviceName != rawName { log("name trimmed to \(maxNameBytes) bytes: \(serviceName)") }

/// One inbound connection and its loopback partner. Both directions copy chunk by chunk on one queue.
/// Each side's end of stream passes on as a half-close. Both connections close when both directions
/// have ended, or at once when a send or receive fails.
final class Bridge: @unchecked Sendable {
  let inbound: NWConnection
  let outbound: NWConnection
  let queue: DispatchQueue
  let label: String
  private var readyCount = 0
  private var openDirections = 2
  private var closed = false
  private var writeEnded = Set<ObjectIdentifier>()
  private let onClose: (Bridge) -> Void

  init(_ inbound: NWConnection, to port: NWEndpoint.Port, id: Int, onClose: @escaping (Bridge) -> Void) {
    self.inbound = inbound
    self.label = "#\(id)"
    self.queue = DispatchQueue(label: "agent-brief-peer.bridge.\(id)")
    self.outbound = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
    self.onClose = onClose
  }

  func start() {
    inbound.stateUpdateHandler = { [self] state in watch(state, of: inbound, side: "inbound") }
    outbound.stateUpdateHandler = { [self] state in watch(state, of: outbound, side: "outbound") }
    inbound.start(queue: queue)
    outbound.start(queue: queue)
  }

  private func watch(_ state: NWConnection.State, of connection: NWConnection, side: String) {

    // A connection that has sent its FIN reports failed (ENETDOWN) when the peer's FIN arrives, while
    // unread bytes and the end of stream are still waiting. Its read loop finishes or fails on its own.

    if writeEnded.contains(ObjectIdentifier(connection)), case .failed = state { return }
    switch state {
    case .ready:
      readyCount += 1
      if readyCount == 2 {
        copy(from: inbound, to: outbound)
        copy(from: outbound, to: inbound)
      }
    case .waiting(let error):

      // A waiting connection retries forever. A refused loopback port should end the bridge instead.

      close("\(side) waiting: \(error)")
    case .failed(let error):
      close("\(side) failed: \(error)")
    case .cancelled:
      close(nil)
    default:
      break
    }
  }

  private func copy(from source: NWConnection, to sink: NWConnection) {
    source.receive(minimumIncompleteLength: 1, maximumLength: chunkBytes) { [self] data, _, isComplete, error in
      if closed { return }
      if let error {
        close("receive failed: \(error)")
        return
      }
      if let data, !data.isEmpty {
        sink.send(content: data, completion: .contentProcessed { [self] error in
          if let error {
            close("send failed: \(error)")
          } else if isComplete {
            finish(sink)
          } else {
            copy(from: source, to: sink)
          }
        })
      } else if isComplete {
        finish(sink)
      } else {
        copy(from: source, to: sink)
      }
    }
  }

  /// Passes the end of stream on, then closes both sides once neither has more to send.
  private func finish(_ sink: NWConnection) {
    writeEnded.insert(ObjectIdentifier(sink))
    sink.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [self] error in
      if let error {
        close("half-close failed: \(error)")
        return
      }
      openDirections -= 1
      if openDirections == 0 { close(nil) }
    })
  }

  private func close(_ reason: String?) {
    if closed { return }
    closed = true
    if let reason { log("\(label) \(reason)") }
    inbound.cancel()
    outbound.cancel()
    onClose(self)
  }
}

/// Live bridges, so each one outlives the handler that made it.
final class BridgeSet: @unchecked Sendable {
  private var items: [ObjectIdentifier: Bridge] = [:]
  private let lock = NSLock()

  func add(_ bridge: Bridge) {
    lock.lock()
    items[ObjectIdentifier(bridge)] = bridge
    lock.unlock()
  }

  func remove(_ bridge: Bridge) {
    lock.lock()
    items[ObjectIdentifier(bridge)] = nil
    lock.unlock()
  }
}

let bridges = BridgeSet()
let mainQueue = DispatchQueue(label: "agent-brief-peer.listener")
var nextBridge = 0
var isReady = false

let parameters = NWParameters.tcp
parameters.includePeerToPeer = true

let listener: NWListener
do {
  listener = try NWListener(using: parameters)
} catch {
  say("failed: \(error)")
  exit(1)
}
listener.service = NWListener.Service(name: serviceName, type: serviceType)

listener.stateUpdateHandler = { state in
  switch state {
  case .ready:
    if isReady { return }
    isReady = true
    log("listening on port \(listener.port?.rawValue ?? 0), forwarding to 127.0.0.1:\(portNumber)")
    say("ready")
  case .waiting(let error):
    log("listener waiting: \(error)")
  case .failed(let error):
    if isReady {
      log("listener failed: \(error)")
      exit(2)
    }
    say("failed: \(error)")
    exit(1)
  case .cancelled:
    exit(isReady ? 2 : 1)
  default:
    break
  }
}

listener.serviceRegistrationUpdateHandler = { change in
  switch change {
  case .add(let endpoint):
    log("advertising \(endpoint)")
  case .remove(let endpoint):
    log("service registration lost: \(endpoint)")
    exit(2)
  @unknown default:
    break
  }
}

listener.newConnectionHandler = { connection in
  nextBridge += 1
  let bridge = Bridge(connection, to: targetPort, id: nextBridge) { bridges.remove($0) }
  bridges.add(bridge)
  bridge.start()
}

listener.start(queue: mainQueue)

// The parent holds stdin open. Its end means the app is gone.

Thread.detachNewThread {
  _ = FileHandle.standardInput.readDataToEndOfFile()
  exit(0)
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let signalSources = [SIGTERM, SIGINT].map { number in
  let source = DispatchSource.makeSignalSource(signal: number, queue: mainQueue)
  source.setEventHandler { exit(0) }
  source.resume()
  return source
}

dispatchMain()

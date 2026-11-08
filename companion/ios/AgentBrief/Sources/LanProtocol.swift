import Foundation

// Mirrors companion/src/shared/ipad.ts and the Handoff shape in companion/src/protocol.ts.

/// IPAD_MAX_BODY_BYTES. The Mac closes the connection on anything larger.
let ipadMaxBodyBytes = 64 * 1024 * 1024

struct PairLink: Equatable {
  let hosts: [String]
  let port: Int
  let code: String
  let fingerprint: String
  let mac: String

  init?(url: URL) {
    guard url.scheme == "agentbrief", url.host == "pair",
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
    else { return nil }

    // The Mac's URLSearchParams writes a space as `+`, which URLComponents keeps.
    func value(_ name: String) -> String { items.first { $0.name == name }?.value?.replacingOccurrences(of: "+", with: " ") ?? "" }
    let hosts = value("h").split(separator: ",").map(String.init)
    guard !hosts.isEmpty, let port = Int(value("p")), (1...65535).contains(port), !value("c").isEmpty, !value("f").isEmpty
    else { return nil }
    self.hosts = hosts
    self.port = port
    code = value("c")
    fingerprint = value("f")
    mac = value("m")
  }
}

struct PairRequest: Encodable {
  let code: String
  let deviceName: String
  let installId: String?
}

struct PairResponse: Decodable {
  let credential: String
  let macName: String
}

struct Handoff: Codable, Identifiable, Hashable {
  let id: String
  let sessionId: String
  let sessionLabel: String
  let prompt: String?
  let boardName: String
  /// The Mac board the iPad starts from. Nil for a blank hand-off, and from a Mac older than 0.5.36.
  var fromBoard: String? = nil
  let createdAt: Double
  let state: String
  /// The fingerprint of the Mac that made it. The iPad sets this, because ids are only unique per Mac.
  var macId: String?

  var hasPrompt: Bool { prompt?.isEmpty == false }
  /// The prompt, else the board it starts from, so two hand-offs from one session tell apart.
  var title: String { hasPrompt ? prompt! : fromBoard ?? "Sketch for this session" }

  /// Identifies this hand-off across every paired Mac.
  var key: String { "\(macId ?? "")-\(id)" }
  var created: Date { Date(timeIntervalSince1970: createdAt / 1000) }
}

struct LanHandoffsResponse: Decodable {
  let handoffs: [Handoff]
}

struct LanHandoffDetail: Decodable {
  let handoff: Handoff
  let scene: String?
  let notes: String
}

struct IpadUtterance: Codable, Equatable {
  let t: Double
  let tEnd: Double
  let text: String
}

struct IpadDeliveryResult: Decodable {
  let ok: Bool
  let state: String
  let message: String
}

struct ErrorBody: Decodable {
  let error: String
  let code: String
}

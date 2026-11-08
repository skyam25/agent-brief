import Foundation

/// A phrase of speech, in epoch ms on this device's clock.
struct Phrase: Codable, Equatable {
  let text: String
  let atMs: Double
  let endMs: Double
  /// Each word and when it began, so words can follow taps made mid-phrase.
  var words: [SpokenWord]?
}

struct SpokenWord: Codable, Equatable {
  let text: String
  let atMs: Double
}

/// Everything saved on this iPad: the inbox, each hand-off's work, and the outbox.
/// Writes run in order on one queue, so an autosave never overtakes an earlier one.
final class LocalStore: @unchecked Sendable {
  private let root: URL
  private let queue = DispatchQueue(label: "com.skyam25.agentbrief.store")

  init(root: URL? = nil) {
    let base = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AgentBrief")
    self.root = base
    try? FileManager.default.createDirectory(at: base.appendingPathComponent("outbox"), withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(at: base.appendingPathComponent("handoffs"), withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var marked = base
    try? marked.setResourceValues(values)
  }

  private func dir(_ id: String) -> URL { root.appendingPathComponent("handoffs").appendingPathComponent(Self.safe(id)) }
  private func outboxFile(_ id: String) -> URL { root.appendingPathComponent("outbox").appendingPathComponent("\(Self.safe(id)).json") }
  private var listFile: URL { root.appendingPathComponent("handoffs.json") }

  /// Hand-off ids come from the Mac, so they never become path segments as they are.
  private static func safe(_ id: String) -> String {
    Data(id.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-")
  }

  private func write(_ data: Data, to file: URL) {
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  // MARK: Inbox

  func saveList(_ handoffs: [Handoff]) {
    queue.async { [self] in
      if let data = try? JSONEncoder().encode(handoffs) { write(data, to: listFile) }
    }
  }

  func loadList() -> [Handoff] {
    queue.sync {
      guard let data = try? Data(contentsOf: listFile) else { return [] }
      return (try? JSONDecoder().decode([Handoff].self, from: data)) ?? []
    }
  }

  // MARK: Work

  /// True once this hand-off's starting board has come from the Mac.
  func hasWork(_ id: String) -> Bool {
    queue.sync { FileManager.default.fileExists(atPath: dir(id).appendingPathComponent("started").path) }
  }

  func start(_ id: String, scene: String?, notes: String) {
    queue.sync {
      if let scene { write(Data(scene.utf8), to: dir(id).appendingPathComponent("scene.json")) }
      write(Data(notes.utf8), to: dir(id).appendingPathComponent("notes.txt"))
      write(Data(), to: dir(id).appendingPathComponent("started"))
    }
  }

  /// True once the person has drawn, typed or talked on this hand-off.
  func isEdited(_ id: String) -> Bool {
    queue.sync { FileManager.default.fileExists(atPath: dir(id).appendingPathComponent("edited").path) }
  }

  private func markEdited(_ id: String) {
    write(Data(), to: dir(id).appendingPathComponent("edited"))
  }

  func saveScene(_ id: String, json: String) {
    queue.async { [self] in
      write(Data(json.utf8), to: dir(id).appendingPathComponent("scene.json"))
      markEdited(id)
    }
  }

  func scene(_ id: String) -> String? {
    queue.sync { (try? Data(contentsOf: dir(id).appendingPathComponent("scene.json"))).flatMap { String(data: $0, encoding: .utf8) } }
  }

  func saveNotes(_ id: String, _ notes: String) {
    queue.async { [self] in
      write(Data(notes.utf8), to: dir(id).appendingPathComponent("notes.txt"))
      markEdited(id)
    }
  }

  func notes(_ id: String) -> String {
    queue.sync { (try? String(contentsOf: dir(id).appendingPathComponent("notes.txt"), encoding: .utf8)) ?? "" }
  }

  func saveComments(_ id: String, json: String) {
    queue.async { [self] in
      write(Data(json.utf8), to: dir(id).appendingPathComponent("comments.json"))
      markEdited(id)
    }
  }

  func comments(_ id: String) -> String? {
    queue.sync { try? String(contentsOf: dir(id).appendingPathComponent("comments.json"), encoding: .utf8) }
  }

  func savePhrases(_ id: String, _ phrases: [Phrase]) {
    queue.async { [self] in
      if let data = try? JSONEncoder().encode(phrases) { write(data, to: dir(id).appendingPathComponent("phrases.json")) }
      markEdited(id)
    }
  }

  func phrases(_ id: String) -> [Phrase] {
    queue.sync {
      guard let data = try? Data(contentsOf: dir(id).appendingPathComponent("phrases.json")) else { return [] }
      return (try? JSONDecoder().decode([Phrase].self, from: data)) ?? []
    }
  }

  func removeWork(_ id: String) {
    queue.async { [self] in try? FileManager.default.removeItem(at: dir(id)) }
  }

  // MARK: Outbox

  func putInOutbox(_ id: String, json: Data) throws {
    let file = outboxFile(id)
    try queue.sync {
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try json.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
  }

  func outboxBody(_ id: String) -> Data? {
    queue.sync { try? Data(contentsOf: outboxFile(id)) }
  }

  func hasOutbox(_ id: String) -> Bool {
    queue.sync { FileManager.default.fileExists(atPath: outboxFile(id).path) }
  }

  func removeFromOutbox(_ id: String) {
    queue.sync { try? FileManager.default.removeItem(at: outboxFile(id)) }
  }
}

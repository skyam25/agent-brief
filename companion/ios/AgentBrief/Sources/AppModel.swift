import AVFoundation
import Observation
import UIKit

enum Connection: Equatable {
  case connecting
  case connected
  case problem(String)
}

enum OutboxState: Equatable {
  case sending
  case waiting(String)
  case refused(String)
}

@MainActor
@Observable
final class AppModel {
  private(set) var macs: [Pairing] = []
  private(set) var connections: [String: Connection] = [:]
  private(set) var handoffs: [Handoff] = []
  /// Hand-offs kept for work in progress after the Mac stopped listing them.
  private(set) var closed = Set<String>()
  /// A `Handoff.key`, like every id below.
  var selectedId: String?

  /// The hand-off whose board and words are on screen.
  private(set) var openId: String?
  private(set) var isLoadingBoard = false
  private(set) var boardError: String?

  private(set) var outbox: [String: OutboxState] = [:]
  private(set) var banner: String?

  var addMacPresented = false
  var pendingPair: PairLink?
  private(set) var isPairing = false
  private(set) var pairError: String?
  var pairText = ""

  /// The side panel with comments and the note.
  var panelOpen = true {
    didSet {
      let open = panelOpen
      if open != oldValue { inOrder { await self.web.setPanel(open) } }
    }
  }
  private(set) var canUndo = false
  private(set) var canRedo = false
  private(set) var talk: DictationStatus = .idle
  private(set) var liveWords = ""
  /// A comment in the panel shows the words, so the talk strip need not.
  private(set) var liveInPanel = false
  private(set) var talkError: String?
  private var phrases: [Phrase] = []
  /// Calls into the board run one at a time, so words land in the order heard. Send waits for the last.
  private var phraseWork: Task<Void, Never>?
  /// Settling words waiting for their turn on the board.
  private var latestLive: Phrase?

  let web = BoardWeb()
  private let store = LocalStore()
  private let dictation = Dictation()
  private var clients: [String: LanClient] = [:]
  private var polling: Task<Void, Never>?
  private var delivering = Set<String>()
  private var openGeneration = 0
  private var bannerTask: Task<Void, Never>?

  var open: Handoff? { handoffs.first { $0.key == openId } }
  /// Rows whose Mac is no longer paired, kept because their work has not been sent.
  var orphans: [Handoff] { handoffs.filter { handoff in !macs.contains { $0.id == handoff.macId } } }
  func handoffs(of mac: Pairing) -> [Handoff] { handoffs.filter { $0.macId == mac.id } }
  var micDenied: Bool { AVAudioApplication.shared.recordPermission == .denied }

  init() {
    #if DEBUG
      if ProcessInfo.processInfo.environment["AB_RESET"] == "1" {
        PairingStore.clear()
        try? FileManager.default.removeItem(at: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AgentBrief"))
        LocalStore().saveList([])
      }
    #endif
    macs = PairingStore.load()
    for mac in macs { clients[mac.id] = LanClient(mac) }
    handoffs = store.loadList()
    for handoff in handoffs where store.hasOutbox(handoff.key) { outbox[handoff.key] = .waiting("Trying to reach the Mac.") }

    web.onSave = { [weak self] board, json in
      guard board != "__start" else { return }
      self?.store.saveScene(board, json: json)
    }
    web.onComments = { [weak self] board, json in
      guard board != "__start" else { return }
      self?.store.saveComments(board, json: json)
    }
    web.onNotes = { [weak self] board, text in
      guard board != "__start" else { return }
      self?.store.saveNotes(board, text)
    }
    web.onHistory = { [weak self] undo, redo in
      self?.canUndo = undo
      self?.canRedo = redo
    }
    web.onCrash = { [weak self] in
      guard let self, let id = openId else { return }
      openId = nil
      selectedId = id
      Task { await self.openSelected() }
    }
    dictation.onStatus = { [weak self] status in
      guard let self else { return }
      talk = status
      let on = status != .idle
      inOrder { await self.web.setListening(on) }
    }
    dictation.onLive = { [weak self] live in
      guard let self else { return }
      liveWords = live.text
      guard openId != nil else { return }

      // Only the newest settling words matter, so a queued update takes them over instead of queueing another.
      let queued = latestLive != nil
      latestLive = live
      if queued { return }
      inOrder {
        guard let newest = self.latestLive else { return }
        self.latestLive = nil
        self.liveInPanel = await self.web.live(newest)
      }
    }
    dictation.onFailure = { [weak self] in self?.talkError = $0 }
    dictation.onPhrase = { [weak self] phrase in
      guard let self, let id = openId else { return }
      liveWords = phrase.text
      latestLive = nil
      inOrder {
        let took = await self.web.heard(phrase)
        self.liveInPanel = took
        if took { return }
        guard self.openId == id else { return }
        self.phrases.append(phrase)
        self.store.savePhrases(id, self.phrases)
      }
    }
  }

  /// Queues a call into the board behind the ones before it.
  private func inOrder(_ work: @escaping @MainActor () async -> Void) {
    let earlier = phraseWork
    phraseWork = Task {
      await earlier?.value
      await work()
    }
  }

  // MARK: Pairing

  func pairFromField() {
    let text = pairText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: text), let link = PairLink(url: url) else {
      pairError = "That isn't a pairing link. On the Mac, choose Pair iPad… and copy the link again."
      return
    }
    Task { await pair(link) }
  }

  /// The person chose to scan, so a scanned code pairs without asking again.
  func pair(scanned link: PairLink) {
    Task { await pair(link) }
  }

  /// Any app or web page can open a pairing link, so a link waits for the person to say yes.
  func handle(url: URL) {
    guard let link = PairLink(url: url) else { return }
    pendingPair = link
  }

  func confirm(_ link: PairLink) {
    pendingPair = nil
    Task { await pair(link) }
  }

  private func pair(_ link: PairLink) async {
    isPairing = true
    pairError = nil
    defer { isPairing = false }
    let trial = LanClient(hosts: link.hosts, port: link.port, fingerprint: link.fingerprint, credential: nil, macName: link.mac)
    do {
      let answer = try await redeem(link, with: trial)
      let paired = Pairing(hosts: link.hosts, port: link.port, fingerprint: link.fingerprint, macName: answer.macName.isEmpty ? link.mac : answer.macName, credential: answer.credential)
      try PairingStore.save(paired)
      macs = macs.filter { $0.id != paired.id } + [paired]
      clients[paired.id] = LanClient(paired)
      connections[paired.id] = .connecting
      pairText = ""
      addMacPresented = false
      await refresh(paired.id)
      startPolling()
    } catch {
      pairError = error.localizedDescription
    }
  }

  /// Keeps trying while the Local Network prompt waits for a tap. The code stays good until a request reaches the Mac.
  private func redeem(_ link: PairLink, with client: LanClient) async throws -> PairResponse {
    let deadline = Date().addingTimeInterval(Self.pairPatience)
    while true {
      do {
        return try await client.pair(code: link.code, deviceName: UIDevice.current.name, installId: UIDevice.current.identifierForVendor?.uuidString)
      } catch LanError.unreachable where Date() < deadline {
        try await Task.sleep(for: .seconds(2))
      }
    }
  }

  private static let pairPatience: TimeInterval = 45

  /// Tells the Mac when it can be reached. This iPad forgets it either way.
  func forget(_ mac: Pairing) {
    if let client = clients[mac.id] { Task { try? await client.unpair() } }
    remove(mac.id)
  }

  private func lostPairing(_ macId: String) {
    let name = macs.first { $0.id == macId }?.macName ?? "A Mac"
    remove(macId)
    let message = "\(name) no longer knows this device. Pair again."
    if macs.isEmpty { pairError = message } else { show(message) }
  }

  /// Drops one Mac and its rows. Edited or unsent work stays until it is discarded or that Mac pairs again.
  private func remove(_ macId: String) {
    PairingStore.remove(macId)
    macs.removeAll { $0.id == macId }
    clients[macId] = nil
    connections[macId] = nil
    let next = handoffs.filter { $0.macId != macId || store.hasOutbox($0.key) || store.isEdited($0.key) }
    if next != handoffs {
      handoffs = next
      store.saveList(next)
    }
    if let selected = selectedId, !next.contains(where: { $0.key == selected }) { selectedId = nil }
    if macs.isEmpty { stopPolling() }
  }

  // MARK: Foreground work

  func setForeground(_ foreground: Bool) {
    if foreground {
      startPolling()
    } else {
      stopPolling()
      Task { await stopTalking() }
    }
  }

  private func startPolling() {
    guard polling == nil, !macs.isEmpty else { return }
    polling = Task { [weak self] in
      while !Task.isCancelled {
        await self?.pollAll()
        try? await Task.sleep(for: .seconds(5))
      }
    }
  }

  private func stopPolling() {
    polling?.cancel()
    polling = nil
  }

  /// Each Mac runs on its own, so one that is away never holds up the others.
  private func pollAll() async {
    await withTaskGroup(of: Void.self) { group in
      for mac in macs {
        group.addTask { [weak self] in
          await self?.refresh(mac.id)
          await self?.drainOutbox(mac.id)
        }
      }
    }
  }

  func refresh() async {
    await withTaskGroup(of: Void.self) { group in
      for mac in macs {
        group.addTask { [weak self] in await self?.refresh(mac.id) }
      }
    }
  }

  private func refresh(_ macId: String) async {
    guard let client = clients[macId] else { return }
    do {
      merge(try await client.handoffs(), from: macId)
      connections[macId] = .connected
    } catch LanError.unauthorized {
      lostPairing(macId)
    } catch {
      if clients[macId] != nil { connections[macId] = .problem(error.localizedDescription) }
    }
  }

  /// Keeps what this Mac lists, anything of its still waiting in the outbox, and work in progress.
  /// Another iPad's answer closes a hand-off on the Mac, and that must not take this device's work away.
  private func merge(_ fromMac: [Handoff], from macId: String) {
    let live = fromMac.filter { $0.state == "open" }.map { handoff -> Handoff in
      var tagged = handoff
      tagged.macId = macId
      return tagged
    }
    let liveKeys = Set(live.map(\.key))
    let mine = handoffs.filter { $0.macId == macId && !liveKeys.contains($0.key) }
    let kept = mine.filter { store.hasOutbox($0.key) || $0.key == openId || store.isEdited($0.key) }
    for handoff in mine { closed.insert(handoff.key) }
    for key in liveKeys { closed.remove(key) }
    let next = (live + kept + handoffs.filter { $0.macId != macId }).sorted { $0.createdAt > $1.createdAt }
    if next != handoffs {
      handoffs = next
      store.saveList(next)
    }
    if let selected = selectedId, !next.contains(where: { $0.key == selected }) {
      selectedId = nil
      show("That hand-off was removed on the Mac.")
    }
  }

  private func show(_ message: String) {
    banner = message
    bannerTask?.cancel()
    bannerTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(6))
      if !Task.isCancelled { self?.banner = nil }
    }
  }

  // MARK: Opening a board

  func openSelected() async {
    openGeneration += 1
    let mine = openGeneration
    await stopTalking()
    guard mine == openGeneration else { return }
    boardError = nil
    isLoadingBoard = false
    guard let id = selectedId else {
      openId = nil
      phrases = []
      liveWords = ""
      return
    }
    guard id != openId else { return }

    // The canvas holds no known board from here on, so Send stays off and a tap back reopens.
    openId = nil
    isLoadingBoard = true
    defer { if mine == openGeneration { isLoadingBoard = false } }
    if !store.hasWork(id) {
      guard let handoff = handoffs.first(where: { $0.key == id }), let client = clients[handoff.macId ?? ""] else { return }
      do {
        let detail = try await client.handoff(id: handoff.id)
        store.start(id, scene: detail.scene, notes: detail.notes)
      } catch {
        if mine == openGeneration { boardError = error.localizedDescription }
        return
      }
    }
    guard mine == openGeneration else { return }
    do {
      try await web.open(board: id, scene: store.scene(id), notes: store.notes(id), comments: store.comments(id))
    } catch {
      if mine == openGeneration { boardError = "The board didn't open: \(error.localizedDescription)" }
      return
    }
    guard mine == openGeneration else { return }
    await web.setPanel(panelOpen)
    phrases = store.phrases(id)
    liveWords = ""
    liveInPanel = false
    talkError = nil
    openId = id
  }

  // MARK: Talk

  func undo() {
    inOrder { await self.web.undo() }
  }

  func redo() {
    inOrder { await self.web.redo() }
  }

  func toggleTalk() {
    talkError = nil
    switch talk {
    case .idle:
      guard openId != nil else { return }
      liveWords = ""
      liveInPanel = false
      Task { await dictation.start() }
    case .stopping:
      break
    default:
      Task { await dictation.stop() }
    }
  }

  private func stopTalking() async {
    await dictation.stop()
    await phraseWork?.value
  }

  // MARK: Send

  func send() {
    guard let id = openId, outbox[id] == nil else { return }
    outbox[id] = .sending
    Task {
      do {
        await stopTalking()
        guard openId == id else {
          outbox[id] = nil
          return
        }
        let captured = try await web.collect(board: id, phrases: phrases)
        guard var delivery = try JSONSerialization.jsonObject(with: captured) as? [String: Any] else {
          throw LanError.unreachable("The board handed over something this app can't read.")
        }
        let body = try JSONSerialization.data(withJSONObject: delivery)
        guard body.count <= ipadMaxBodyBytes else {
          throw LanError.unreachable("This board is too large to send. Remove some pictures and send again.")
        }
        try store.putInOutbox(id, json: body)
        await deliver(id)
      } catch {
        outbox[id] = nil
        show("Send failed: \(error.localizedDescription)")
      }
    }
  }

  private func drainOutbox(_ macId: String) async {
    for handoff in handoffs where handoff.macId == macId && store.hasOutbox(handoff.key) {
      if case .refused = outbox[handoff.key] { continue }
      await deliver(handoff.key)
    }
  }

  private func deliver(_ key: String) async {
    guard !delivering.contains(key), let body = store.outboxBody(key), let handoff = handoffs.first(where: { $0.key == key }) else { return }
    let macId = handoff.macId ?? ""
    guard let client = clients[macId] else {
      outbox[key] = .waiting("Pair with this Mac again to send this.")
      return
    }
    delivering.insert(key)
    defer { delivering.remove(key) }
    do {
      let result = try await client.deliver(id: handoff.id, json: body)
      finish(key)
      show(result.message)
    } catch LanError.unauthorized {
      outbox[key] = .waiting("Pair with this Mac again to send this.")
      lostPairing(macId)
    } catch LanError.rejected(let status, let message) where (400..<500).contains(status) && status != 429 {
      outbox[key] = .refused(message)
    } catch {
      outbox[key] = .waiting(error.localizedDescription)
    }
  }

  private func finish(_ key: String) {
    store.removeFromOutbox(key)
    store.removeWork(key)
    outbox[key] = nil
    closed.remove(key)
    handoffs.removeAll { $0.key == key }
    store.saveList(handoffs)
    if selectedId == key { selectedId = nil }
  }

  /// A hand-off the Mac still has open comes back at the next poll, so it can't be discarded here.
  func canDiscard(_ handoff: Handoff) -> Bool {
    if case .refused = outbox[handoff.key] { return true }
    return closed.contains(handoff.key) || orphans.contains { $0.key == handoff.key }
  }

  /// Throws away a hand-off's work, once the person says so.
  func discard(_ key: String) {
    finish(key)
  }
}

import AVFoundation
import Foundation
import Speech

// Live dictation on Apple's on-device speech engine. Ported from companion/native/dictate.swift.
// Times are epoch ms when the audio was heard, the same clock as Date.now strokes in the web view.

/// Converts each buffer to the analyzer's format and hands it on, noting when the first one was heard.
private final class Feed: @unchecked Sendable {
  let format: AVAudioFormat
  let input: AsyncStream<AnalyzerInput>.Continuation
  private var converter: AVAudioConverter?
  private let lock = NSLock()
  private var heardFrom: Double?
  private let onFirst: @Sendable () -> Void

  init(format: AVAudioFormat, input: AsyncStream<AnalyzerInput>.Continuation, onFirst: @escaping @Sendable () -> Void) {
    self.format = format
    self.input = input
    self.onFirst = onFirst
  }

  var startMs: Double? {
    lock.lock()
    defer { lock.unlock() }
    return heardFrom
  }

  /// `heardMs` is when the buffer's first sample reached the microphone.
  func push(_ buffer: AVAudioPCMBuffer, heardMs: Double) {
    lock.lock()
    defer { lock.unlock() }
    if heardFrom == nil {
      heardFrom = heardMs
      onFirst()
    }
    if converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: format) }
    guard let converter else { return }
    let frames = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 16
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
    var fed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    if error == nil, out.frameLength > 0 { input.yield(AnalyzerInput(buffer: out)) }
  }
}

private func epochMs() -> Double { Date().timeIntervalSince1970 * 1000 }

private protocol AudioSource {
  func start(_ feed: Feed) throws
  func stop()
}

private final class Microphone: AudioSource {
  private let engine = AVAudioEngine()

  func start(_ feed: Feed) throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement)
    try session.setActive(true)
    let node = engine.inputNode
    node.installTap(onBus: 0, bufferSize: 2048, format: node.outputFormat(forBus: 0)) { buffer, when in
      let age =
        when.isHostTimeValid
        ? AVAudioTime.seconds(forHostTime: mach_absolute_time()) - AVAudioTime.seconds(forHostTime: when.hostTime)
        : Double(buffer.frameLength) / buffer.format.sampleRate
      feed.push(buffer, heardMs: epochMs() - age * 1000)
    }
    engine.prepare()
    try engine.start()
  }

  func stop() {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

#if DEBUG
  /// Plays a file in real time in place of the microphone, then silence, for tests.
  private final class FilePlayer: AudioSource, @unchecked Sendable {
    private let url: URL
    private var task: Task<Void, Never>?

    init(_ url: URL) { self.url = url }

    func start(_ feed: Feed) throws {
      let file = try AVAudioFile(forReading: url)
      task = Task.detached {
        let chunk: AVAudioFrameCount = 1600
        let rate = file.processingFormat.sampleRate
        let began = epochMs()
        var sent = 0.0
        while !Task.isCancelled {
          guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk) else { return }
          if file.framePosition < file.length { try? file.read(into: buffer, frameCount: chunk) }

          // Past the end, silence keeps the clock running as a quiet microphone would.
          if buffer.frameLength == 0 { buffer.frameLength = chunk }
          feed.push(buffer, heardMs: began + sent * 1000)
          sent += Double(buffer.frameLength) / rate
          let wait = sent - (epochMs() - began) / 1000
          if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
        }
      }
    }

    func stop() { task?.cancel() }
  }
#endif

/// Splits on whitespace, so each word keeps its punctuation, and times each from its runs, in seconds.
private func words(_ text: AttributedString) -> [(text: String, start: Double?)] {
  var found: [(text: String, start: Double?)] = []
  var wordStart: AttributedString.Index?
  var index = text.startIndex
  func close(at end: AttributedString.Index) {
    guard let begin = wordStart else { return }
    wordStart = nil
    let slice = text[begin..<end]
    found.append((String(slice.characters), slice.runs.compactMap(\.audioTimeRange).first?.start.seconds))
  }
  while index < text.endIndex {
    if text.characters[index].isWhitespace { close(at: index) } else if wordStart == nil { wordStart = index }
    index = text.characters.index(after: index)
  }
  close(at: text.endIndex)
  return found
}

enum DictationStatus: Equatable {
  case idle
  case preparing
  case downloading(Double)
  case listening
  case stopping
}

enum DictationError: Error, LocalizedError {
  case microphoneDenied
  case unavailable
  case noModel(String)
  case failed(String)

  var errorDescription: String? {
    switch self {
    case .microphoneDenied: "Agent Brief can't use the microphone. Turn it on in Settings."
    case .unavailable: "On-device speech recognition isn't available on this device."
    case .noModel(let locale): "There's no speech model for \(locale)."
    case .failed(let message): message
    }
  }
}

/// One Talk press to the next. Words arrive through the callbacks, on the main actor.
@MainActor
final class Dictation {
  var onStatus: (DictationStatus) -> Void = { _ in }
  /// Words still settling. Each call replaces the last.
  var onLive: (Phrase) -> Void = { _ in }
  var onPhrase: (Phrase) -> Void = { _ in }
  var onFailure: (String) -> Void = { _ in }

  private(set) var status: DictationStatus = .idle {
    didSet { if status != oldValue { onStatus(status) } }
  }
  private var source: AudioSource?
  private var analyzer: SpeechAnalyzer?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var results: Task<Void, Never>?
  private var canned: Task<Void, Never>?
  /// Bumps on each stop, so a start still loading its model knows it was called off.
  private var generation = 0

  func start() async {
    guard status == .idle else { return }
    status = .preparing
    generation += 1
    let mine = generation
    do {
      #if targetEnvironment(simulator)
        if let phrases = ProcessInfo.processInfo.environment["AB_TEST_PHRASES"] {
          startCanned(phrases)
          return
        }
      #endif
      try await begin(generation: mine)
    } catch {
      guard generation == mine else { return }
      await teardown()
      status = .idle
      onFailure(error.localizedDescription)
    }
  }

  /// Stops listening and waits for the words in progress to settle.
  func stop() async {
    generation += 1
    guard status != .idle else { return }
    status = .stopping
    canned?.cancel()
    canned = nil
    source?.stop()
    source = nil
    input?.finish()
    input = nil
    try? await analyzer?.finalizeAndFinishThroughEndOfInput()
    await results?.value
    await teardown()
    status = .idle
  }

  private func teardown() async {
    source?.stop()
    source = nil
    input?.finish()
    input = nil
    analyzer = nil
    results = nil
  }

  private func testAudioURL() -> URL? {
    #if DEBUG
      guard let path = ProcessInfo.processInfo.environment["AB_TEST_AUDIO"], !path.isEmpty else { return nil }
      if path.hasPrefix("/") { return URL(fileURLWithPath: path) }
      return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(path)
    #else
      return nil
    #endif
  }

  private func makeSource(testAudio: URL?) -> AudioSource {
    #if DEBUG
      if let testAudio { return FilePlayer(testAudio) }
    #endif
    return Microphone()
  }

  private func begin(generation mine: Int) async throws {
    let testAudio = testAudioURL()
    if testAudio == nil {
      guard await AVAudioApplication.requestRecordPermission() else { throw DictationError.microphoneDenied }
    }
    guard SpeechTranscriber.isAvailable else { throw DictationError.unavailable }
    var found = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
    if found == nil { found = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) }
    guard let locale = found else { throw DictationError.noModel(Locale.current.identifier) }

    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [.volatileResults, .fastResults],
      attributeOptions: [.audioTimeRange]
    )
    do {
      try await reserve(locale)
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await download(request, generation: mine)
      }
    } catch {
      throw DictationError.failed("Could not load the speech model: \(error.localizedDescription)")
    }
    guard generation == mine else { return }

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw DictationError.failed("No audio format suits the speech model.")
    }
    let (inputs, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
    let feed = Feed(format: format, input: input) {
      Task { @MainActor [weak self] in
        if self?.status == .preparing { self?.status = .listening }
      }
    }
    do {
      try await analyzer.prepareToAnalyze(in: format)
      try await analyzer.start(inputSequence: inputs)
    } catch {
      throw DictationError.failed("Could not start the speech model: \(error.localizedDescription)")
    }
    guard generation == mine else {
      input.finish()
      return
    }

    self.analyzer = analyzer
    self.input = input
    results = Task.detached { [weak self] in
      do {
        for try await result in transcriber.results {
          guard let startMs = feed.startMs else { continue }
          let found = words(result.text)
          guard !found.isEmpty else { continue }
          let text = found.map(\.text).joined(separator: " ")
          // A word without its own time starts where the one before it did.
          var last = result.range.start.seconds
          let timed = found.map { word in
            last = word.start ?? last
            return SpokenWord(text: word.text, atMs: startMs + last * 1000)
          }
          let phrase = Phrase(text: text, atMs: timed[0].atMs, endMs: startMs + result.range.end.seconds * 1000, words: timed)
          if result.isFinal {
            await MainActor.run { self?.onPhrase(phrase) }
          } else {
            await MainActor.run { self?.onLive(phrase) }
          }
        }
      } catch {
        await MainActor.run { self?.onFailure("Dictation stopped: \(error.localizedDescription)") }
      }
    }

    let source = makeSource(testAudio: testAudio)
    do {
      try source.start(feed)
    } catch {
      throw DictationError.failed("Could not open the microphone: \(error.localizedDescription)")
    }
    self.source = source
  }

  private func reserve(_ locale: Locale) async throws {
    do {
      try await AssetInventory.reserve(locale: locale)
    } catch {
      for held in await AssetInventory.reservedLocales { await AssetInventory.release(reservedLocale: held) }
      try await AssetInventory.reserve(locale: locale)
    }
  }

  private func download(_ request: AssetInstallationRequest, generation mine: Int) async throws {
    status = .downloading(0)
    let progress = request.progress
    let watcher = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        if let self, self.generation == mine, case .downloading = self.status { self.status = .downloading(progress.fractionCompleted) }
        try? await Task.sleep(for: .milliseconds(250))
      }
    }
    defer { watcher.cancel() }
    try await request.downloadAndInstall()
    if generation == mine { status = .preparing }
  }

  #if targetEnvironment(simulator)
    /// Feeds phrases separated by `|` where the simulator has no speech engine. Simulator builds only.
    private func startCanned(_ list: String) {
      status = .listening
      let phrases = list.split(separator: "|").map(String.init)
      canned = Task { [weak self] in
        for text in phrases {
          let began = epochMs()
          self?.onLive(Phrase(text: text, atMs: began, endMs: began))
          try? await Task.sleep(for: .milliseconds(800))
          if Task.isCancelled { return }
          self?.onPhrase(Phrase(text: text, atMs: began, endMs: epochMs()))
        }
      }
    }
  #endif
}

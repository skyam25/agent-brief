// Live dictation on Apple's on-device speech engine.
//
// The process loads the speech model at launch and keeps the microphone off until main writes `start`.
// Each launch serves one dictation, so main keeps a loaded spare and presses go straight to the mic.
//
// stdin commands, one per line:
//   start   turns the microphone on
//   stop    flushes the words in progress, then exits
// stdin closing before `stop` exits at once.
//
// stdout, one JSON object per line. Times are epoch ms when the audio was heard.
//   {"prepared":true}                          model loaded, microphone off
//   {"ready":true,"atMs":…}                    microphone on, its audio starts at atMs
//   {"live":{"text","atMs","words":[…]}}       words still settling; each replaces the last
//   {"phrase":{"text","atMs","words":[…]}}     settled words
//   {"error":"…"}                              then exits 1
//
// `--file <audio>` plays a file in real time in place of the microphone, then silence, for tests.

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

struct Word: Encodable { let text: String; let atMs: Int64 }
struct Phrase: Encodable { let text: String; let atMs: Int64; let words: [Word] }

/// The audio thread and the results task both write, so lines go out one at a time.
let outputLock = NSLock()

func write(_ data: Data) {
  outputLock.lock()
  FileHandle.standardOutput.write(data + Data("\n".utf8))
  outputLock.unlock()
}

func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) { write(data) }
}

func emit(_ key: String, _ phrase: Phrase) {
  if let data = try? JSONEncoder().encode([key: phrase]) { write(data) }
}

func fail(_ message: String) -> Never {
  emit(["error": message])
  exit(1)
}

func epochMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// Converts each buffer to the analyzer's format and hands it on, noting when the first one was heard.
final class Feed: @unchecked Sendable {
  let format: AVAudioFormat
  let input: AsyncStream<AnalyzerInput>.Continuation
  private var converter: AVAudioConverter?
  private let lock = NSLock()
  private(set) var startMs: Double?

  init(format: AVAudioFormat, input: AsyncStream<AnalyzerInput>.Continuation) {
    self.format = format
    self.input = input
  }

  /// `heardMs` is when the buffer's first sample reached the microphone.
  func push(_ buffer: AVAudioPCMBuffer, heardMs: Double) {
    lock.lock()
    defer { lock.unlock() }
    if startMs == nil {
      startMs = heardMs
      emit(["ready": true, "atMs": Int64(heardMs)])
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

protocol Source { func start(_ feed: Feed) throws; func stop() }

final class Microphone: Source {
  private let engine = AVAudioEngine()

  func start(_ feed: Feed) throws {
    let node = engine.inputNode
    node.installTap(onBus: 0, bufferSize: 2048, format: node.outputFormat(forBus: 0)) { buffer, when in
      let age = when.isHostTimeValid
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
  }
}

final class FilePlayer: Source, @unchecked Sendable {
  private let url: URL
  private var task: Task<Void, Never>?

  init(_ url: URL) { self.url = url }

  func start(_ feed: Feed) throws {
    let file = try AVAudioFile(forReading: url)
    task = Task {
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

/// Splits on whitespace, so each word keeps its punctuation, and times each from its runs, in seconds.
func words(_ text: AttributedString) -> [(text: String, start: Double?)] {
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

/// Times words still settling. Their runs all carry the start of the settling range, so each word is
/// stamped when it first appears, spread over the last second of audio, and keeps that time after.
struct LiveClock {
  private var stamps: [Double] = []
  private var heardTo = 0.0

  mutating func time(_ found: [(text: String, start: Double?)], range: CMTimeRange) -> [Double] {
    let end = range.end.seconds
    let added = found.count - stamps.count
    if added > 0 {
      let from = max(heardTo, range.start.seconds, end - 1)
      for i in 0..<added { stamps.append(from + (end - from) * (Double(i) + 0.5) / Double(added)) }
    }
    heardTo = max(heardTo, end)
    return Array(stamps.prefix(found.count))
  }

  /// A settled phrase replaces the words settling before it.
  mutating func settle(through range: CMTimeRange) {
    stamps = []
    heardTo = max(heardTo, range.end.seconds)
  }
}

func phrase(_ found: [(text: String, start: Double?)], times: [Double], startMs: Double) -> Phrase? {
  let words = zip(found, times).map { Word(text: $0.0.text, atMs: Int64(startMs + $0.1 * 1000)) }
  guard let first = words.first else { return nil }
  return Phrase(text: words.map(\.text).joined(separator: " "), atMs: first.atMs, words: words)
}

func reserve(_ locale: Locale) async throws {
  do {
    try await AssetInventory.reserve(locale: locale)
  } catch {
    for held in await AssetInventory.reservedLocales { await AssetInventory.release(reservedLocale: held) }
    try await AssetInventory.reserve(locale: locale)
  }
}

let args = CommandLine.arguments
let filePath = args.firstIndex(of: "--file").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }

guard SpeechTranscriber.isAvailable else { fail("Speech recognition is not available on this Mac.") }
var found = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
if found == nil { found = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) }
guard let locale = found else { fail("No speech model for \(Locale.current.identifier).") }

let transcriber = SpeechTranscriber(
  locale: locale,
  transcriptionOptions: [],
  reportingOptions: [.volatileResults, .fastResults],
  attributeOptions: [.audioTimeRange]
)
do {
  try await reserve(locale)
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await request.downloadAndInstall()
  }
} catch {
  fail("Could not load the speech model: \(error.localizedDescription)")
}

let analyzer = SpeechAnalyzer(modules: [transcriber])
guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
  fail("No audio format suits the speech model.")
}
let (inputs, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
let feed = Feed(format: format, input: input)
let source: Source = filePath.map { FilePlayer(URL(fileURLWithPath: $0)) } ?? Microphone()
do {
  try await analyzer.prepareToAnalyze(in: format)
  try await analyzer.start(inputSequence: inputs)
} catch {
  fail("Could not start the speech model: \(error.localizedDescription)")
}

let results = Task.detached {
  do {
    var clock = LiveClock()
    for try await result in transcriber.results {
      guard let startMs = feed.startMs else { continue }
      let found = words(result.text)
      if result.isFinal {
        clock.settle(through: result.range)

        // A word with no run of its own takes the time of the word before it.
        var last = result.range.start.seconds
        let times = found.map { word in
          last = word.start ?? last
          return last
        }
        if let heard = phrase(found, times: times, startMs: startMs) { emit("phrase", heard) }
      } else if let heard = phrase(found, times: clock.time(found, range: result.range), startMs: startMs) {
        emit("live", heard)
      }
    }
  } catch {
    fail("Dictation failed: \(error.localizedDescription)")
  }
}

emit(["prepared": true])

var stopping = false
for try await line in FileHandle.standardInput.bytes.lines {
  if line == "start" {
    do { try source.start(feed) } catch { fail("Could not open the microphone: \(error.localizedDescription)") }
  } else if line == "stop" {
    stopping = true
    break
  }
}
if !stopping { exit(0) }

source.stop()
input.finish()
try? await analyzer.finalizeAndFinishThroughEndOfInput()
await results.value
exit(0)

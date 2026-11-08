import SwiftUI
import WebKit

/// Serves the bundled board page, so modules and fonts load as they would from a site.
private final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
  private let root = Bundle.main.url(forResource: "Web", withExtension: nil)

  private static let types: [String: String] = [
    "html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css",
    "json": "application/json", "woff2": "font/woff2", "png": "image/png", "svg": "image/svg+xml", "wasm": "application/wasm",
  ]

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url, let root else {
      task.didFailWithError(URLError(.fileDoesNotExist))
      return
    }
    let path = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
    let file = root.appendingPathComponent(path).standardizedFileURL
    guard file.path.hasPrefix(root.standardizedFileURL.path + "/"), let data = try? Data(contentsOf: file) else {
      let missing = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
      task.didReceive(missing)
      task.didFinish()
      return
    }
    let type = Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
    let headers = ["Content-Type": type, "Content-Length": String(data.count), "Access-Control-Allow-Origin": "*"]
    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// Serves a page hand-off's files from its Mac over `abpage://<token>/<path>`, and the review overlay from the app.
/// The Mac adds the overlay's script tag to each HTML page, as the Mac's own Review pane does.
final class PageSchemeHandler: NSObject, WKURLSchemeHandler {
  /// Loads a file of the page hand-off a token names: its bytes and content type. `path` stays percent-encoded.
  var load: (_ token: String, _ path: String) async throws -> (Data, String) = { _, _ in throw URLError(.resourceUnavailable) }
  private var stopped = Set<ObjectIdentifier>()
  private let overlay = Bundle.main.url(forResource: "Web", withExtension: nil)?.appendingPathComponent("overlay.js")

  private func respond(_ task: WKURLSchemeTask, _ url: URL, _ data: Data, type: String) {
    let headers = ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-store"]
    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url, let token = url.host else {
      task.didFailWithError(URLError(.badURL))
      return
    }
    let path = String(url.path(percentEncoded: true).dropFirst())
    if path == "__agent-brief__/overlay.js", let overlay, let data = try? Data(contentsOf: overlay) {
      respond(task, url, data, type: "text/javascript; charset=utf-8")
      return
    }
    let id = ObjectIdentifier(task)
    Task { @MainActor in
      defer { stopped.remove(id) }
      do {
        let (data, type) = try await load(token, path)
        if !stopped.contains(id) { respond(task, url, data, type: type) }
      } catch {
        guard !stopped.contains(id) else { return }
        let missing = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
        task.didReceive(missing)
        task.didReceive(Data(error.localizedDescription.utf8))
        task.didFinish()
      }
    }
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
    stopped.insert(ObjectIdentifier(task))
  }
}

/// Keeps the web view from retaining its message handler forever.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ target: WKScriptMessageHandler) { self.target = target }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}

/// The board page and the calls into it. One page lives for the whole run and switches boards.
@MainActor
final class BoardWeb: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  let webView: WKWebView
  var onSave: (_ board: String, _ json: String) -> Void = { _, _ in }
  var onComments: (_ board: String, _ json: String) -> Void = { _, _ in }
  var onNotes: (_ board: String, _ text: String) -> Void = { _, _ in }
  var onReady: () -> Void = {}
  /// Serves the open page hand-off, if any.
  let pages = PageSchemeHandler()
  /// Whether the board can undo and redo now.
  var onHistory: (_ undo: Bool, _ redo: Bool) -> Void = { _, _ in }
  var onCrash: () -> Void = {}
  private var ready = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  override init() {
    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "abapp")
    config.setURLSchemeHandler(pages, forURLScheme: "abpage")
    webView = WKWebView(frame: .zero, configuration: config)
    super.init()
    config.userContentController.add(WeakHandler(self), name: "agentBrief")
    webView.navigationDelegate = self
    webView.scrollView.isScrollEnabled = false
    webView.scrollView.bounces = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.allowsLinkPreview = false
    webView.accessibilityIdentifier = "board"
    #if DEBUG
      webView.isInspectable = true
    #endif
    load()
  }

  private func load() {
    webView.load(URLRequest(url: URL(string: "abapp://app/index.html")!))
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "ready":
      ready = true
      for waiter in waiting { waiter.resume() }
      waiting = []
      onReady()
    case "saveBoard":
      if let board = body["board"] as? String, let json = body["json"] as? String { onSave(board, json) }
    case "saveComments":
      if let board = body["board"] as? String, let json = body["json"] as? String { onComments(board, json) }
    case "openLink":
      if let href = body["href"] as? String, let url = URL(string: href), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
        UIApplication.shared.open(url)
      }
    case "history":
      onHistory(body["undo"] as? Bool ?? false, body["redo"] as? Bool ?? false)
    case "saveNotes":
      if let board = body["board"] as? String, let text = body["text"] as? String { onNotes(board, text) }
    case "log":
      print("[board] \(body["text"] ?? "")")
    default:
      break
    }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    ready = false
    load()
    onCrash()
  }

  private func whenReady() async {
    if ready { return }
    await withCheckedContinuation { waiting.append($0) }
  }

  /// Opens a board, or with `page`, a page hand-off's page at that address.
  func open(board: String, scene: String?, notes: String, comments: String?, page: String? = nil) async throws {
    await whenReady()
    let arg: [String: Any] = ["boardName": board, "scene": scene ?? NSNull(), "notes": notes, "comments": comments ?? NSNull(), "page": page ?? NSNull()]
    _ = try await webView.callAsyncJavaScript("await window.__ipad.open(arg);", arguments: ["arg": arg], contentWorld: .page)
  }

  /// The delivery as JSON, with strokes and these phrases on one clock.
  func collect(board: String, phrases: [Phrase]) async throws -> Data {
    await whenReady()
    let spoken = phrases.map { ["t": $0.atMs, "tEnd": $0.endMs, "text": $0.text] as [String: Any] }
    let result = try await webView.callAsyncJavaScript("return await window.__ipad.collect(spoken, board);", arguments: ["spoken": spoken, "board": board], contentWorld: .page)
    guard let json = result as? String else { throw LanError.unreachable("The board did not hand over its drawing.") }
    return Data(json.utf8)
  }

  func setListening(_ on: Bool) async {
    await whenReady()
    _ = try? await webView.callAsyncJavaScript("window.__ipad.setListening(on);", arguments: ["on": on], contentWorld: .page)
  }

  func undo() async {
    await whenReady()
    _ = try? await webView.callAsyncJavaScript("window.__ipad.undo();", arguments: [:], contentWorld: .page)
  }

  func redo() async {
    await whenReady()
    _ = try? await webView.callAsyncJavaScript("window.__ipad.redo();", arguments: [:], contentWorld: .page)
  }

  func setPanel(_ open: Bool) async {
    await whenReady()
    _ = try? await webView.callAsyncJavaScript("window.__ipad.setPanel(open);", arguments: ["open": open], contentWorld: .page)
  }

  /// Tells the page where the fold runs, so the panel takes one side of it. Nil when the screen is flat.
  func setFold(_ fold: CGRect?) async {
    await whenReady()
    let arg: Any = fold.map { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] } ?? NSNull()
    _ = try? await webView.callAsyncJavaScript("window.__ipad.setFold(fold ?? undefined);", arguments: ["fold": arg], contentWorld: .page)
  }

  /// Offers a finished phrase to the comments. True means a comment took it.
  func heard(_ phrase: Phrase) async -> Bool {
    await offer("heard", phrase)
  }

  /// Offers words still settling. True means a comment shows them.
  func live(_ phrase: Phrase) async -> Bool {
    await offer("live", phrase)
  }

  private func offer(_ call: String, _ phrase: Phrase) async -> Bool {
    await whenReady()
    let words: Any = phrase.words.map { $0.map { ["text": $0.text, "atMs": $0.atMs] } } ?? NSNull()
    let result = try? await webView.callAsyncJavaScript(
      "return window.__ipad.\(call)(text, t, words ?? undefined);",
      arguments: ["text": phrase.text, "t": phrase.atMs, "words": words], contentWorld: .page)
    return (result as? Bool) ?? false
  }

  func setTheme(dark: Bool) async {
    await whenReady()
    _ = try? await webView.callAsyncJavaScript("window.__ipad.setTheme(theme);", arguments: ["theme": dark ? "dark" : "light"], contentWorld: .page)
  }
}

struct BoardWebView: UIViewRepresentable {
  let board: BoardWeb
  func makeUIView(context: Context) -> WKWebView { board.webView }
  func updateUIView(_ view: WKWebView, context: Context) {}
}

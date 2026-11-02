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
  var onReady: () -> Void = {}
  var onCrash: () -> Void = {}
  private var ready = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  override init() {
    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "abapp")
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

  func open(board: String, scene: String?, notes: String) async throws {
    await whenReady()
    let arg: [String: Any] = ["boardName": board, "scene": scene ?? NSNull(), "notes": notes]
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

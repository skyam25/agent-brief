import Foundation

/// A hand-off's prompt as the app shows it. Each link reads as a short name, so a long share link never fills the screen.
enum PromptText {
  private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

  /// The short name for a link: "claude.ai artifact" for a Claude artifact, else its host.
  static func label(for url: URL) -> String {
    let host = (url.host ?? url.absoluteString).replacingOccurrences(of: "www.", with: "")
    let path = url.pathComponents.filter { $0 != "/" }
    if host == "claude.ai", path.first == "artifact" || path.first == "public" { return "claude.ai artifact" }
    return host
  }

  /// The text in order, as plain runs and web links.
  static func parts(_ text: String) -> [(text: String, url: URL?)] {
    let whole = NSRange(text.startIndex..., in: text)
    var parts: [(String, URL?)] = []
    var at = text.startIndex
    for match in detector?.matches(in: text, range: whole) ?? [] {
      guard let url = match.url, ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let range = Range(match.range, in: text) else { continue }
      if at < range.lowerBound { parts.append((String(text[at..<range.lowerBound]), nil)) }
      parts.append((String(text[range]), url))
      at = range.upperBound
    }
    if at < text.endIndex { parts.append((String(text[at...]), nil)) }
    return parts
  }

  /// One line of text with each link as its short name, for the inbox.
  static func plain(_ text: String) -> String {
    parts(text).map { $0.url.map(label(for:)) ?? $0.text }.joined()
  }

  /// The text with each link as a tappable short name.
  static func attributed(_ text: String) -> AttributedString {
    var out = AttributedString()
    for part in parts(text) {
      guard let url = part.url else {
        out += AttributedString(part.text)
        continue
      }
      var link = AttributedString("\(label(for: url)) ↗")
      link.link = url
      out += link
    }
    return out
  }
}

import XCTest

/// A hand-off from a Stack board of screenshots. Runs against the stub that ios/test/run-sim.mjs starts with `stack: true`.
final class StackHandoffTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var stubDir: String { env["AB_STUB_DIR"]! }

  override func setUp() {
    continueAfterFailure = false
  }

  private func shot(_ app: XCUIApplication, _ name: String) {
    try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(stubDir)/\(name).png"))
  }

  /// How many of the board's pixels show the stub's blue pictures, and the height over the width of the box they fill.
  /// The two pictures sit side by side, so the whole pair shows as about 0.36, and a cut-off pair shows flatter.
  private func bluePictures(_ board: XCUIElement) -> (count: Int, shape: Double) {
    guard let image = board.screenshot().image.cgImage else { return (0, 0) }
    let width = image.width, height = image.height
    var data = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = data.withUnsafeMutableBytes { bytes -> Bool in
      guard let ctx = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard drawn else { return (0, 0) }
    var count = 0, top = height, bottom = 0, left = width, right = 0
    for y in 0..<height {
      for x in 0..<width {
        let i = (y * width + x) * 4
        let r = Int(data[i]), g = Int(data[i + 1]), b = Int(data[i + 2])

        // The stub's blue, give or take dark mode's tint. System blue, as on Send, has almost no red.
        guard (40...100).contains(r), (100...160).contains(g), b > 200 else { continue }
        count += 1
        top = min(top, y)
        bottom = max(bottom, y)
        left = min(left, x)
        right = max(right, x)
      }
    }
    return count == 0 ? (0, 0) : (count, Double(bottom - top) / Double(max(1, right - left)))
  }

  func testStackHandoffNamesItsBoardAndShowsItsPictures() throws {
    let app = XCUIApplication()
    app.launchEnvironment["AB_RESET"] = "1"
    app.launch()
    let field = app.textFields["pair-link"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    field.tap()
    field.typeText(env["AB_PAIR_URL_S"]! + "\n")

    // A hand-off with no prompt goes by the board it starts from.
    let row = app.staticTexts["checkout-shots"]
    if !row.waitForExistence(timeout: 20) { shot(app, "failed-stack-row") }
    XCTAssertTrue(row.exists, "the inbox does not name the Stack board")
    XCTAssertTrue(app.staticTexts["Mark up the sign-up flow"].exists)
    shot(app, "stack-1-inbox")

    row.tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 15), "the board never opened")
    let board = app.webViews.firstMatch
    let deadline = Date().addingTimeInterval(8)
    var seen = bluePictures(board)
    while Date() < deadline && seen.count <= 20_000 {
      usleep(500_000)
      seen = bluePictures(board)
    }
    XCTAssertGreaterThan(seen.count, 20_000, "the Stack board shows placeholders, not its pictures")

    // The opened board fits in view, clear of a docked panel.
    sleep(1)
    seen = bluePictures(board)
    shot(app, "stack-2-board")
    XCTAssertGreaterThan(seen.shape, 0.3, "the pictures are cut off, at \(seen.shape) high for their width")
  }
}

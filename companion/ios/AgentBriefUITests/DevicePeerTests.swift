import XCTest

/// Runs on a real device, or a simulator, against live/ipad-stub.mjs with the Mac's peer helper. ios/test/run-device-peer.mjs starts it.
/// The pairing link's hosts never answer, so every request crosses the peer bridge.
/// The app keeps the pairings it has. The test adds the stub Mac and forgets only that Mac at the end.
final class DevicePeerTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var forgetButton: String { "forget-\(env["AB_MAC_NAME"]!)" }

  override func setUp() {
    continueAfterFailure = false
  }

  private func keep(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  private func note(_ name: String, _ value: String) {
    let attachment = XCTAttachment(string: value)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// Waits without tapping the app, since a stray tap can open an inbox row. A system prompt is answered by name.
  private func waitAllowing(_ element: XCUIElement, timeout: TimeInterval, scrolling app: XCUIApplication? = nil) -> Bool {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if element.waitForExistence(timeout: 1) { return true }
      for label in ["Allow", "Allow While Using App", "OK", "Open"] where springboard.alerts.buttons[label].exists {
        springboard.alerts.buttons[label].tap()
        break
      }
      // A new Mac lists last, which can be below the fold.
      app?.swipeUp()
    }
    return element.exists
  }

  /// Forgets the stub Mac if the menu lists it. Answers whether it did.
  @discardableResult
  private func forgetStub(_ app: XCUIApplication) -> Bool {
    let menu = app.buttons["more-menu"]
    guard menu.waitForExistence(timeout: 5) else { return false }
    menu.tap()
    let forget = app.buttons[forgetButton]
    guard forget.waitForExistence(timeout: 3) else {
      // A tap on the status bar closes the menu and opens nothing.
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.01)).tap()
      return false
    }
    forget.tap()
    return true
  }

  func testPeerRouteLeavesOtherPairingsAlone() throws {
    let app = XCUIApplication()
    app.launch()

    let field = app.textFields["pair-link"]
    let menu = app.buttons["more-menu"]
    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline, !field.exists, !menu.exists { sleep(1) }
    let pairedBefore = menu.exists
    XCTAssertTrue(pairedBefore || field.exists, "the app showed neither the pairing field nor the inbox")
    note("paired-before", pairedBefore ? "yes" : "no")

    // An earlier run that failed can leave the stub Mac paired. Only this test uses its name, so it is safe to forget.
    if pairedBefore, forgetStub(app) {
      note("leftover", "forgot a stub Mac an earlier run left")
      sleep(2)
    }
    addTeardownBlock {
      // A failure can leave the app off the inbox, where the menu lives.
      app.terminate()
      app.launch()
      self.forgetStub(app)
    }

    XCUIDevice.shared.system.open(URL(string: env["AB_PAIR_URL"]!)!)
    let confirm = app.alerts.buttons["Pair"]
    XCTAssertTrue(waitAllowing(confirm, timeout: 20), "the pairing link did not ask first")
    let started = Date()
    confirm.tap()

    let row = app.staticTexts[env["AB_PROMPT"]!]
    let listed = waitAllowing(row, timeout: 60, scrolling: app)
    note("peer-seconds", String(format: "%.2f", Date().timeIntervalSince(started)))
    keep(app, "1-listed")
    let pairError = app.staticTexts["pair-error"]
    XCTAssertTrue(listed, "the inbox never listed the hand-off over the peer route. Pair error: \(pairError.exists ? pairError.label : "none")")

    row.tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 30), "the board never opened over the peer route")
    sleep(2)
    let board = app.webViews.firstMatch
    board.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.3)).press(forDuration: 0.15, thenDragTo: board.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5)))
    sleep(1)
    keep(app, "2-board")
    app.buttons["send-button"].tap()
    let sent = app.staticTexts["banner"].waitForExistence(timeout: 60)
    keep(app, "3-sent")
    XCTAssertTrue(sent, "no message from the Mac over the peer route")

    XCTAssertTrue(forgetStub(app), "the menu never offered to forget the stub Mac")
    sleep(2)
    keep(app, "4-forgotten")
    if pairedBefore {
      XCTAssertFalse(field.exists, "forgetting the stub Mac unpaired the others")
    }
  }
}

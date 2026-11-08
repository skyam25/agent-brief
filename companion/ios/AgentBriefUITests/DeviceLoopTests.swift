import XCTest

/// Runs on a real iPad against live/ipad-stub.mjs. ios/test/run-device.mjs starts it and passes these values.
final class DeviceLoopTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment

  override func setUp() {
    continueAfterFailure = false
  }

  private func keep(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  /// A system prompt blocks the app, so a harmless tap at the screen edge makes the interruption monitor answer it.
  private func watchPrompts() {
    addUIInterruptionMonitor(withDescription: "permission") { alert in
      for label in ["Allow", "Allow While Using App", "OK"] where alert.buttons[label].exists {
        alert.buttons[label].tap()
        return true
      }
      return false
    }
  }

  private func waitAllowing(_ element: XCUIElement, in app: XCUIApplication, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if element.exists { return true }
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.99)).tap()
      sleep(2)
    }
    return element.exists
  }

  func testPairDrawDictateSend() throws {
    watchPrompts()
    let app = XCUIApplication()
    app.launchEnvironment["AB_RESET"] = "1"
    app.launchEnvironment["AB_TEST_AUDIO"] = "speech.wav"
    app.launch()

    let field = app.textFields["pair-link"]
    XCTAssertTrue(waitAllowing(field, in: app, timeout: 20))
    keep(app, "1-unpaired")
    field.tap()
    field.typeText(env["AB_PAIR_URL"]! + "\n")

    let prompt = env["AB_PROMPT"]!
    let row = app.staticTexts[prompt]
    let listed = waitAllowing(row, in: app, timeout: 90)
    keep(app, "2-inbox")
    XCTAssertTrue(listed, "the inbox never listed the hand-off")
    row.tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 20))
    sleep(2)
    keep(app, "3-board")

    app.buttons["talk-button"].tap()
    XCTAssertTrue(waitAllowing(app.staticTexts["live-words"], in: app, timeout: 300), "Talk never started, so the speech model may not have loaded")

    let board = app.webViews.firstMatch
    board.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.4))
      .press(forDuration: 0.15, thenDragTo: board.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.6)))
    sleep(3)
    keep(app, "4-live-words")
    board.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.7))
      .press(forDuration: 0.15, thenDragTo: board.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)))
    sleep(UInt32(env["AB_TALK_SECONDS"] ?? "14") ?? 14)
    keep(app, "5-talked")
    app.buttons["talk-button"].tap()
    sleep(3)

    let tab = app.webViews.firstMatch.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Note'")).firstMatch
    XCTAssertTrue(tab.waitForExistence(timeout: 5), "the panel has no Note tab")
    tab.tap()
    let note = app.webViews.firstMatch.textViews["Anything the drawing doesn't say"]
    XCTAssertTrue(note.waitForExistence(timeout: 5))
    note.tap()
    note.typeText("Check the second step")
    keep(app, "6-note")
    // On a narrow screen the keyboard pushes Send into the toolbar's overflow, so put it away first.
    let keyboardDone = app.toolbars.buttons["Done"]
    if keyboardDone.exists { keyboardDone.tap() }

    app.buttons["send-button"].tap()
    let banner = app.staticTexts["banner"]
    let sent = banner.waitForExistence(timeout: 60)
    keep(app, "7-sent")
    XCTAssertTrue(sent, "no message from the Mac")
  }

  /// Runs after the test above, which leaves this iPad paired. Only checks that the real microphone opens.
  func testRealMicrophoneOpens() throws {
    watchPrompts()
    let app = XCUIApplication()
    app.launchEnvironment["AB_RESET"] = "0"
    app.launch()
    let prompt = env["AB_PROMPT_2"]!
    let row = app.staticTexts[prompt]
    XCTAssertTrue(waitAllowing(row, in: app, timeout: 90), "the second hand-off never listed")
    row.tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 20))
    app.buttons["talk-button"].tap()
    let live = app.staticTexts["live-words"]
    let listening = waitAllowing(live, in: app, timeout: 120)
    keep(app, "8-mic")
    XCTAssertTrue(listening, "the microphone path showed no status")
    app.buttons["talk-button"].tap()
  }
}

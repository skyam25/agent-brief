import XCTest

/// Pins a comment, relaunches, talks onto it and sends. ios/test/run-sim.mjs checks what arrived.
final class CommentFlowTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment

  override func setUp() {
    continueAfterFailure = false
  }

  private func launch(reset: Bool) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AB_RESET"] = reset ? "1" : "0"
    if let phrases = env["AB_TEST_PHRASES"] { app.launchEnvironment["AB_TEST_PHRASES"] = phrases }
    app.launch()
    return app
  }

  private func shot(_ app: XCUIApplication, _ name: String) {
    try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(env["AB_STUB_DIR"]!)/\(name).png"))
  }

  private func openRow(_ app: XCUIApplication) {
    let row = app.staticTexts["Mark up the sign-up flow"]
    XCTAssertTrue(row.waitForExistence(timeout: 20), "the inbox never listed the hand-off")
    row.tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 15), "the board never opened")
    XCTAssertTrue(app.buttons["comment-button"].waitForExistence(timeout: 5))
  }

  func testPinCommentRelaunchTalkSend() throws {
    var app = launch(reset: true)
    let field = app.textFields["pair-link"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    field.tap()
    field.typeText(env["AB_PAIR_URL_C"]! + "\n")
    openRow(app)
    sleep(1)
    shot(app, "comment-1-off")

    app.buttons["comment-button"].tap()
    let board = app.webViews.firstMatch
    XCTAssertTrue(board.staticTexts["OVERALL"].waitForExistence(timeout: 5) || board.staticTexts["Overall"].exists, "the comment column never showed")
    shot(app, "comment-2-on")

    board.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).tap()
    let card = board.textViews["What should change here?"]
    XCTAssertTrue(card.waitForExistence(timeout: 5), "a tap on the board dropped no pin")
    card.tap()
    card.typeText("Make this bigger")
    shot(app, "comment-3-pinned")
    app.buttons["comment-button"].tap()
    sleep(1)

    app.terminate()
    app = launch(reset: false)
    openRow(app)
    let back = app.webViews.firstMatch.textViews.matching(NSPredicate(format: "value CONTAINS 'Make this bigger'")).firstMatch
    XCTAssertTrue(back.waitForExistence(timeout: 8), "the comment did not survive a relaunch")
    shot(app, "comment-4-relaunched")

    // Words said while a comment is selected land on it.
    back.tap()
    app.buttons["talk-button"].tap()
    let said = app.webViews.firstMatch.textViews.matching(NSPredicate(format: "value CONTAINS 'Circle'")).firstMatch
    XCTAssertTrue(said.waitForExistence(timeout: 30), "the words never reached the comment")
    shot(app, "comment-5-talked")
    app.buttons["talk-button"].tap()
    sleep(1)

    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["banner"].waitForExistence(timeout: 30), "no message from the Mac")
    shot(app, "comment-6-sent")
  }
}

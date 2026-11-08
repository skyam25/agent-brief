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

  /// Waits for a toggle's accessibility value, such as On or Off.
  private func reads(_ element: XCUIElement, _ value: String) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)
    return XCTWaiter().wait(for: [expectation], timeout: 5) == .completed
  }

  private func openRow(_ app: XCUIApplication) {
    let row = app.staticTexts["Mark up the sign-up flow"]
    XCTAssertTrue(row.waitForExistence(timeout: 20), "the inbox never listed the hand-off")
    row.tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 15), "the board never opened")
    XCTAssertTrue(app.buttons["comment-button"].waitForExistence(timeout: 5), "the toolbar has no Comment button")
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

    let board = app.webViews.firstMatch
    let comment = app.buttons["comment-button"]
    comment.tap()
    XCTAssertTrue(reads(comment, "On"), "Comment never turned on")
    shot(app, "comment-2-on")

    board.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.35)).tap()
    let card = board.textViews["What should change here?"]
    XCTAssertTrue(card.waitForExistence(timeout: 5), "a tap on the board dropped no pin")
    card.tap()
    card.typeText("Make this bigger")
    let typed = board.textViews.matching(NSPredicate(format: "value == 'Make this bigger'")).firstMatch
    XCTAssertTrue(typed.waitForExistence(timeout: 10), "the typing never finished")
    shot(app, "comment-3-pinned")
    // A phone folds the toolbar while the keyboard is up, so the keyboard goes first.
    let done = app.toolbars.buttons["Done"]
    if done.exists { done.tap() }
    comment.tap()
    XCTAssertTrue(reads(comment, "Off"), "Comment never turned off")
    // Comments save 400 ms after the last edit.
    sleep(2)

    app.terminate()
    app = launch(reset: false)
    openRow(app)
    // Nothing is selected after a relaunch, so the comment shows as one line. A tap opens it.
    let folded = app.webViews.firstMatch.buttons.matching(NSPredicate(format: "label CONTAINS 'Make this bigger'")).firstMatch
    XCTAssertTrue(folded.waitForExistence(timeout: 8), "the comment did not survive a relaunch")
    shot(app, "comment-4-relaunched")
    folded.tap()
    let back = app.webViews.firstMatch.textViews.matching(NSPredicate(format: "value CONTAINS 'Make this bigger'")).firstMatch
    XCTAssertTrue(back.waitForExistence(timeout: 5), "a tap did not open the comment")

    // Words said while a comment is selected land on it. Selecting it is enough, with no keyboard.
    app.buttons["talk-button"].tap()
    let said = app.webViews.firstMatch.textViews.matching(NSPredicate(format: "value CONTAINS 'Circle'")).firstMatch
    XCTAssertTrue(said.waitForExistence(timeout: 30), "the words never reached the comment")
    shot(app, "comment-5-talked")
    app.buttons["talk-button"].tap()
    sleep(1)

    // What the toolbar looks like with the keyboard up, for a look by hand.
    back.tap()
    sleep(1)
    shot(app, "comment-5b-keyboard")
    try? app.debugDescription.write(toFile: "\(env["AB_STUB_DIR"]!)/comment-5b-keyboard.txt", atomically: true, encoding: .utf8)
    // On a narrow screen the keyboard pushes Send into the toolbar's overflow, so put it away first.
    let keyboardDone = app.toolbars.buttons["Done"]
    if keyboardDone.exists { keyboardDone.tap() }

    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["banner"].waitForExistence(timeout: 30), "no message from the Mac")
    shot(app, "comment-6-sent")
  }
}

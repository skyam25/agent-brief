import XCTest

/// A page hand-off: the page opens in place of a board, a pin lands on its heading, and Send returns a review.
/// Runs against the stub that ios/test/run-sim.mjs starts with `page: true`, which checks what arrived.
final class PageHandoffTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var stubDir: String { env["AB_STUB_DIR"]! }

  override func setUp() {
    continueAfterFailure = false
  }

  private func flag(_ name: String, on: Bool) {
    let path = "\(stubDir)/\(name)"
    if on {
      FileManager.default.createFile(atPath: path, contents: Data())
    } else {
      try? FileManager.default.removeItem(atPath: path)
    }
  }

  private func shot(_ app: XCUIApplication, _ name: String) {
    try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(stubDir)/\(name).png"))
  }

  func testPageOpensPinsAndSendsAReview() throws {
    let app = XCUIApplication()
    app.launchEnvironment["AB_RESET"] = "1"
    app.launch()
    let field = app.textFields["pair-link"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    field.tap()
    field.typeText(env["AB_PAIR_URL_S"]! + "\n")

    // A Mac from before the delete route keeps the hand-off, so it is hidden here and stays hidden through a refresh.
    flag("mac-s/old-mac", on: true)
    let kept = app.staticTexts["Mark up the sign-up flow"]
    if !kept.waitForExistence(timeout: 20) { shot(app, "failed-old-row") }
    kept.swipeLeft()
    XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5), "no Delete on a swiped row")
    app.buttons["Delete"].tap()
    XCTAssertTrue(kept.waitForNonExistence(timeout: 10), "a hand-off an older Mac keeps stayed in the inbox")
    let banner = app.staticTexts["banner"]
    XCTAssertTrue(banner.waitForExistence(timeout: 5), "no word that the Mac still has it")
    XCTAssertTrue(banner.label.contains("older version"), "the banner says: \(banner.label)")
    app.collectionViews.firstMatch.swipeDown()
    sleep(3)
    XCTAssertFalse(kept.exists, "a refresh brought back a hand-off deleted here")
    flag("mac-s/old-mac", on: false)
    shot(app, "page-0-hidden")

    // Swipe, then Delete, removes a hand-off from the inbox and the Mac.
    let doomed = app.staticTexts["Blank board, no base scene"]
    if !doomed.waitForExistence(timeout: 20) { shot(app, "failed-delete-row") }
    doomed.swipeLeft()
    let delete = app.buttons["Delete"]
    XCTAssertTrue(delete.waitForExistence(timeout: 5), "no Delete on a swiped row")
    delete.tap()
    XCTAssertTrue(doomed.waitForNonExistence(timeout: 10), "the deleted hand-off stayed in the inbox")
    shot(app, "page-0-deleted")

    // A page hand-off with no prompt goes by its page.
    let row = app.staticTexts["site/plan.html"]
    if !row.waitForExistence(timeout: 20) { shot(app, "failed-page-row") }
    XCTAssertTrue(row.exists, "the inbox does not list the page")
    row.tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 15), "the page never opened")

    let board = app.webViews.firstMatch
    let heading = board.staticTexts["Keep the cart when a card fails"]
    if !heading.waitForExistence(timeout: 15) { shot(app, "failed-page-load") }
    XCTAssertTrue(heading.exists, "the page did not load from the Mac")
    shot(app, "page-1-open")

    // Comment in the toolbar turns pinning on until it is pressed again.
    let comment = app.buttons["comment-button"]
    XCTAssertTrue(comment.waitForExistence(timeout: 5), "no Comment in the toolbar")
    comment.tap()
    let hint = board.staticTexts["Tap the page to pin comments"]
    XCTAssertTrue(hint.waitForExistence(timeout: 5), "Comment never turned on")
    shot(app, "page-1b-armed")
    heading.tap()
    let card = board.textViews["What should change here?"]
    if !card.waitForExistence(timeout: 5) { shot(app, "failed-page-pin") }
    XCTAssertTrue(card.exists, "a tap on the heading made no comment")
    XCTAssertTrue(hint.exists, "Comment turned off after one pin")
    card.tap()
    card.typeText("Shorter title")
    shot(app, "page-2-pinned")

    // With the keyboard up, a phone folds Send into the toolbar's overflow, so the keyboard goes first.
    let done = app.toolbars.buttons["Done"]
    if done.exists { done.tap() }
    let send = app.buttons["send-button"]
    XCTAssertTrue(send.waitForExistence(timeout: 5), "Send never came back after the keyboard closed")
    send.tap()
    XCTAssertTrue(app.staticTexts["banner"].waitForExistence(timeout: 30), "no message from the Mac")
    shot(app, "page-3-sent")
  }
}

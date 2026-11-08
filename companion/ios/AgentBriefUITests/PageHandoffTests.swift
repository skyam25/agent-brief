import XCTest

/// A page hand-off: the page opens in place of a board, a pin lands on its heading, and Send returns a review.
/// Runs against the stub that ios/test/run-sim.mjs starts with `page: true`, which checks what arrived.
final class PageHandoffTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var stubDir: String { env["AB_STUB_DIR"]! }

  override func setUp() {
    continueAfterFailure = false
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

    // Pin is a toggle on the page, so it is found by its label, whatever its element type.
    let pin = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Pin'")).firstMatch
    XCTAssertTrue(pin.waitForExistence(timeout: 5), "no Pin in the panel")
    pin.tap()
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Done'")).firstMatch.waitForExistence(timeout: 5), "Pin never turned on")
    heading.tap()
    let card = board.textViews["What should change here?"]
    if !card.waitForExistence(timeout: 5) { shot(app, "failed-page-pin") }
    XCTAssertTrue(card.exists, "a tap on the heading made no comment")
    card.tap()
    card.typeText("Shorter title")
    shot(app, "page-2-pinned")

    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["banner"].waitForExistence(timeout: 30), "no message from the Mac")
    shot(app, "page-3-sent")
  }
}

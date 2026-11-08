import XCTest

/// The prompt line and the toolbar's Undo and Redo. Runs against the stub that ios/test/run-sim.mjs starts with `link: true`.
final class BoardToolsTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var stubDir: String { env["AB_STUB_DIR"]! }

  override func setUp() {
    continueAfterFailure = false
  }

  private func shot(_ app: XCUIApplication, _ name: String) {
    try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(stubDir)/\(name).png"))
  }

  private func starting(_ app: XCUIApplication, _ text: String) -> XCUIElement {
    app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
  }

  func testLinkPromptAndUndo() throws {
    let app = XCUIApplication()
    app.launchEnvironment["AB_RESET"] = "1"
    app.launch()
    let field = app.textFields["pair-link"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    field.tap()
    field.typeText(env["AB_PAIR_URL_S"]! + "\n")

    // The inbox names the link, and never shows the share link itself.
    let row = starting(app, "claude.ai artifact review this")
    if !row.waitForExistence(timeout: 20) { shot(app, "failed-tools-row") }
    XCTAssertTrue(row.exists, "the inbox does not shorten the link")
    XCTAssertFalse(starting(app, "https://").exists, "the inbox shows a raw link")
    shot(app, "tools-1-inbox")

    row.tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 15), "the board never opened")
    let prompt = app.staticTexts["handoff-prompt"]
    XCTAssertTrue(prompt.waitForExistence(timeout: 5))
    XCTAssertFalse(prompt.label.contains("sk=not-for-show"), "the prompt shows the share key")
    let more = app.buttons["prompt-more"]
    XCTAssertTrue(more.exists, "a long prompt offers the rest")
    let short = prompt.frame.height
    XCTAssertLessThan(short, 26, "the folded prompt takes more than one line")
    more.tap()
    XCTAssertTrue(app.buttons["Show less"].waitForExistence(timeout: 3))
    XCTAssertGreaterThan(prompt.frame.height, short, "Show all did not show more")
    more.tap()
    shot(app, "tools-2-board")

    let undo = app.buttons["undo-button"]
    let redo = app.buttons["redo-button"]
    XCTAssertTrue(undo.waitForExistence(timeout: 5), "no Undo in the toolbar")
    XCTAssertFalse(undo.isEnabled, "Undo is on before any change")
    let board = app.webViews.firstMatch
    board.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.3)).press(forDuration: 0.15, thenDragTo: board.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.35)))
    XCTAssertTrue(undo.wait(for: \.isEnabled, toEqual: true, timeout: 5), "Undo stays off after a stroke")
    shot(app, "tools-3-drawn")
    undo.tap()
    XCTAssertTrue(undo.wait(for: \.isEnabled, toEqual: false, timeout: 5), "Undo stays on after undoing the only stroke")
    XCTAssertTrue(redo.isEnabled, "Redo is off after an undo")
    redo.tap()
    XCTAssertTrue(undo.wait(for: \.isEnabled, toEqual: true, timeout: 5), "Redo did not bring the stroke back")
    shot(app, "tools-4-redone")
  }
}

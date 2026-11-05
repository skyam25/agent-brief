import XCTest

/// Reaches each screen and writes a screenshot. ios/test/tour-sim.mjs starts the stubs and passes these values.
final class ScreenTourTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var stubDir: String { env["AB_STUB_DIR"]! }
  private var portrait: Bool { env["AB_TOUR_ORIENTATION"] == "portrait" }

  override func setUp() {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = portrait ? .portrait : .landscapeLeft
  }

  private func launch(reset: Bool, phrases: Bool = true) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AB_RESET"] = reset ? "1" : "0"
    if phrases, let value = env["AB_TEST_PHRASES"] { app.launchEnvironment["AB_TEST_PHRASES"] = value }
    app.launch()
    return app
  }

  /// Asks the runner to shoot the screen, because XCUITest clips and rotates screenshots in landscape.
  private func shot(_ app: XCUIApplication, _ name: String) {
    let request = "\(stubDir)/shot-request"
    FileManager.default.createFile(atPath: request, contents: Data(name.utf8))
    while FileManager.default.fileExists(atPath: request) { usleep(100_000) }
  }

  private func flag(_ name: String, on: Bool) {
    let path = "\(stubDir)/\(name)"
    if on {
      FileManager.default.createFile(atPath: path, contents: Data())
    } else {
      try? FileManager.default.removeItem(atPath: path)
    }
  }

  private func draw(_ app: XCUIApplication, from: CGVector, to: CGVector) {
    let board = app.webViews.firstMatch
    board.coordinate(withNormalizedOffset: from).press(forDuration: 0.15, thenDragTo: board.coordinate(withNormalizedOffset: to))
  }

  private func text(_ app: XCUIApplication, _ start: String) -> XCUIElement {
    app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", start)).firstMatch
  }

  /// In portrait the inbox sits behind the sidebar button.
  private func revealInbox(_ app: XCUIApplication, row: String) {
    guard portrait, !text(app, row).isHittable else { return }
    app.navigationBars.buttons.firstMatch.tap()
    _ = text(app, row).waitForExistence(timeout: 5)
    sleep(1)
  }

  private func openBoard(_ app: XCUIApplication, row: String) {
    revealInbox(app, row: row)
    XCTAssertTrue(text(app, row).waitForExistence(timeout: 20), "no row \(row)")
    text(app, row).tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 15), "the board never opened")
    sleep(1)
  }

  func testTour() throws {
    let pairURL = env["AB_PAIR_URL"]!

    var app = launch(reset: true)
    let field = app.textFields["pair-link"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    shot(app, "01-unpaired")

    field.tap()
    field.typeText("not a link\n")
    XCTAssertTrue(app.staticTexts["pair-error"].waitForExistence(timeout: 5))
    shot(app, "02-unpaired-error")
    field.tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12))

    XCUIDevice.shared.system.open(URL(string: pairURL)!)
    let cancel = app.alerts.buttons["Cancel"]
    XCTAssertTrue(cancel.waitForExistence(timeout: 15))
    sleep(1)
    shot(app, "03-pair-question")
    cancel.tap()
    XCTAssertTrue(cancel.waitForNonExistence(timeout: 5))

    flag("empty", on: true)
    field.tap()
    field.typeText(pairURL + "\n")
    sleep(3)
    revealInbox(app, row: "Inbox")
    let connected = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Connected to'")).firstMatch
    XCTAssertTrue(connected.waitForExistence(timeout: 20))
    sleep(1)
    shot(app, "04-inbox-empty")

    app.buttons["more-menu"].tap()
    XCTAssertTrue(app.buttons["add-mac"].waitForExistence(timeout: 5))
    sleep(1)
    shot(app, "05-inbox-menu")
    app.buttons["add-mac"].tap()
    let sheetField = app.textFields["pair-link"]
    XCTAssertTrue(sheetField.waitForExistence(timeout: 10))
    sleep(1)
    shot(app, "06-pair-sheet")
    app.swipeDown(velocity: .fast)
    XCTAssertTrue(sheetField.waitForNonExistence(timeout: 5))

    flag("empty", on: false)
    let first = "Mark up the sign-up flow"
    XCTAssertTrue(app.staticTexts[first].waitForExistence(timeout: 20))
    sleep(1)
    shot(app, "07-inbox-items")

    flag("offline", on: true)
    sleep(12)
    shot(app, "08-inbox-offline")
    app.staticTexts[first].tap()
    sleep(8)
    revealInbox(app, row: first)
    shot(app, "09-board-error")
    flag("offline", on: false)
    sleep(7)

    openBoard(app, row: "Blank board, no base scene")
    shot(app, "10-board-blank")
    openBoard(app, row: first)
    shot(app, "11-board-open")

    app.buttons["talk-button"].tap()
    XCTAssertTrue(app.staticTexts["live-words"].waitForExistence(timeout: 60))
    draw(app, from: CGVector(dx: 0.3, dy: 0.5), to: CGVector(dx: 0.7, dy: 0.7))
    sleep(3)
    shot(app, "12-board-talking")
    app.buttons["talk-button"].tap()
    sleep(2)

    app.buttons["note-button"].tap()
    let note = app.textViews["note-editor"]
    XCTAssertTrue(note.waitForExistence(timeout: 5))
    sleep(1)
    shot(app, "13-note-empty")
    note.tap()
    note.typeText("Check the second step")
    shot(app, "14-note")
    app.buttons["note-button"].tap()
    sleep(1)

    flag("slow", on: true)
    app.buttons["send-button"].tap()
    sleep(2)
    shot(app, "15-sending")
    XCTAssertTrue(app.staticTexts["banner"].waitForExistence(timeout: 30))
    sleep(1)
    shot(app, "16-sent-banner")
    flag("slow", on: false)

    flag("offline", on: true)
    openBoard(app, row: "Blank board, no base scene")
    draw(app, from: CGVector(dx: 0.3, dy: 0.3), to: CGVector(dx: 0.6, dy: 0.5))
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["Waiting for the Mac"].firstMatch.waitForExistence(timeout: 30))
    sleep(1)
    shot(app, "17-waiting")
    flag("offline", on: false)
    XCTAssertTrue(app.staticTexts["banner"].waitForExistence(timeout: 30))
    sleep(1)

    openBoard(app, row: "Sketch how the retry banner should sit above the order summary")
    shot(app, "18-board-long-prompt")
    draw(app, from: CGVector(dx: 0.3, dy: 0.3), to: CGVector(dx: 0.6, dy: 0.5))
    flag("refuse", on: true)
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["The Mac refused this"].firstMatch.waitForExistence(timeout: 30))
    sleep(1)
    shot(app, "19-refused")
    app.buttons["Discard"].firstMatch.tap()
    flag("refuse", on: false)
    sleep(3)

    openBoard(app, row: "Sketch for this session")
    draw(app, from: CGVector(dx: 0.3, dy: 0.3), to: CGVector(dx: 0.6, dy: 0.5))
    sleep(3)
    flag("closed-h4", on: true)
    sleep(8)
    shot(app, "20-answered-elsewhere")
    flag("closed-h4", on: false)
    sleep(7)

    app.terminate()
    app = launch(reset: false, phrases: false)
    openBoard(app, row: "Sketch for this session")
    app.buttons["talk-button"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["talk-error"].waitForExistence(timeout: 30))
    sleep(1)
    shot(app, "21-talk-error")

    revealInbox(app, row: "Sketch for this session")
    app.buttons["more-menu"].tap()
    app.buttons["add-mac"].tap()
    let another = app.textFields["pair-link"]
    XCTAssertTrue(another.waitForExistence(timeout: 10))
    another.tap()
    another.typeText(env["AB_PAIR_URL_B"]! + "\n")
    let studio = "Studio: mark up the sign-up flow"
    XCTAssertTrue(app.staticTexts[studio].waitForExistence(timeout: 20))
    sleep(1)
    shot(app, "22-two-macs")
    openBoard(app, row: studio)
    draw(app, from: CGVector(dx: 0.3, dy: 0.3), to: CGVector(dx: 0.6, dy: 0.5))
    sleep(3)
    revealInbox(app, row: studio)
    app.buttons["more-menu"].tap()
    app.buttons["forget-Studio Mac"].tap()
    sleep(2)
    shot(app, "23-not-paired-section")

    flag("revoked", on: true)
    XCTAssertTrue(app.textFields["pair-link"].waitForExistence(timeout: 20))
    XCTAssertTrue(app.staticTexts["pair-error"].waitForExistence(timeout: 10))
    shot(app, "24-revoked")
    flag("revoked", on: false)
  }
}

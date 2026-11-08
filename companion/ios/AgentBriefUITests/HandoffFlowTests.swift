import XCTest

/// Runs against ios/test/stub-server.mjs. ios/test/run-sim.mjs starts it and passes these values.
final class HandoffFlowTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var stubDir: String { env["AB_STUB_DIR"]! }
  private var offlineFile: String { stubDir + "/offline" }

  override func setUp() {
    continueAfterFailure = false
    try? FileManager.default.removeItem(atPath: offlineFile)
  }

  private func launch(reset: Bool) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AB_RESET"] = reset ? "1" : "0"
    for key in ["AB_TEST_AUDIO", "AB_TEST_PHRASES"] {
      if let value = env[key] { app.launchEnvironment[key] = value }
    }
    app.launch()
    return app
  }

  private func shot(_ app: XCUIApplication, _ name: String) {
    let data = app.screenshot().pngRepresentation
    try? data.write(to: URL(fileURLWithPath: "\(stubDir)/\(name).png"))
  }

  private func draw(_ app: XCUIApplication, from: CGVector, to: CGVector) {
    let board = app.webViews.firstMatch
    board.coordinate(withNormalizedOffset: from).press(forDuration: 0.15, thenDragTo: board.coordinate(withNormalizedOffset: to))
  }

  private func openFirstRow(_ app: XCUIApplication, text: String) {
    let row = app.staticTexts[text]
    let listed = row.waitForExistence(timeout: 20)
    if !listed { shot(app, "failed-\(name)") }
    let pairError = app.staticTexts["pair-error"]
    XCTAssertTrue(listed, "the inbox never listed \(text). Pair error: \(pairError.exists ? pairError.label : "none")")
    row.tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 15), "the board never opened")
  }

  func testPairDrawTalkNoteSend() throws {
    let app = launch(reset: true)
    let field = app.textFields["pair-link"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    shot(app, "1-unpaired")
    field.tap()
    field.typeText(env["AB_PAIR_URL"]! + "\n")

    openFirstRow(app, text: "Mark up the sign-up flow")
    sleep(1)
    shot(app, "2-board-open")

    app.buttons["talk-button"].tap()
    let live = app.staticTexts["live-words"]
    let listening = live.waitForExistence(timeout: 60)
    if !listening { shot(app, "failed-talk") }
    let talkError = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'speech' OR label CONTAINS[c] 'microphone' OR label CONTAINS[c] 'dictation'")).firstMatch
    XCTAssertTrue(listening, "Talk showed no status. \(talkError.exists ? talkError.label : "no error shown")")

    draw(app, from: CGVector(dx: 0.3, dy: 0.25), to: CGVector(dx: 0.7, dy: 0.4))
    draw(app, from: CGVector(dx: 0.3, dy: 0.4), to: CGVector(dx: 0.7, dy: 0.25))
    sleep(UInt32(env["AB_TALK_SECONDS"] ?? "4") ?? 4)
    shot(app, "3-talking")
    app.buttons["talk-button"].tap()
    XCTAssertTrue(app.buttons["talk-button"].waitForExistence(timeout: 5))

    let tab = app.webViews.firstMatch.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Note'")).firstMatch
    XCTAssertTrue(tab.waitForExistence(timeout: 5), "the panel has no Note tab")
    tab.tap()
    let note = app.webViews.firstMatch.textViews["Anything the drawing doesn't say"]
    XCTAssertTrue(note.waitForExistence(timeout: 5))
    note.tap()
    note.typeText("Check the second step")
    shot(app, "4-note")
    // On a narrow screen the keyboard pushes Send into the toolbar's overflow, so put it away first.
    let keyboardDone = app.toolbars.buttons["Done"]
    if keyboardDone.exists { keyboardDone.tap() }

    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["banner"].waitForExistence(timeout: 30), "no message from the Mac")
    shot(app, "5-sent")
    XCTAssertFalse(app.staticTexts["Mark up the sign-up flow"].exists, "a delivered hand-off stayed in the inbox")
  }

  /// Runs after the test above, which pairs this simulator.
  func testSendWaitsSurvivesKillThenLands() throws {
    let app = launch(reset: false)
    openFirstRow(app, text: "Blank board, no base scene")
    sleep(1)
    draw(app, from: CGVector(dx: 0.3, dy: 0.3), to: CGVector(dx: 0.6, dy: 0.5))

    FileManager.default.createFile(atPath: offlineFile, contents: Data())
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["Waiting for the Mac"].firstMatch.waitForExistence(timeout: 30), "the outbox never said it was waiting")
    shot(app, "6-waiting")

    app.terminate()
    try FileManager.default.removeItem(atPath: offlineFile)
    let again = launch(reset: false)
    XCTAssertTrue(again.staticTexts["banner"].waitForExistence(timeout: 30), "the outbox never delivered after the relaunch")
    shot(again, "7-landed")
  }

  /// Two Macs whose hand-offs share ids. Each Send goes to its own Mac, and forgetting one leaves the other.
  func testTwoMacsKeepTheirOwnHandoffs() throws {
    let app = launch(reset: true)
    let field = app.textFields["pair-link"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    field.tap()
    field.typeText(env["AB_PAIR_URL_A"]! + "\n")
    let promptA = "First Mac: mark up the sign-up flow"
    let promptB = "Second Mac: mark up the sign-up flow"
    XCTAssertTrue(app.staticTexts[promptA].waitForExistence(timeout: 20))

    app.buttons["more-menu"].tap()
    app.buttons["add-mac"].tap()
    let second = app.textFields["pair-link"]
    XCTAssertTrue(second.waitForExistence(timeout: 10))
    second.tap()
    second.typeText(env["AB_PAIR_URL_B"]! + "\n")
    XCTAssertTrue(app.staticTexts[promptB].waitForExistence(timeout: 20), "the second Mac's hand-off never listed")
    XCTAssertTrue(app.staticTexts[promptA].exists, "pairing a second Mac dropped the first Mac's hand-off")
    shot(app, "11-two-macs")

    app.staticTexts[promptB].tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 15))
    sleep(1)
    draw(app, from: CGVector(dx: 0.3, dy: 0.3), to: CGVector(dx: 0.6, dy: 0.5))
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["banner"].waitForExistence(timeout: 30), "no message from the second Mac")
    XCTAssertTrue(app.staticTexts[promptA].exists, "sending to the second Mac removed the first Mac's hand-off")

    app.buttons["more-menu"].tap()
    app.buttons["forget-Second Stub Mac"].tap()
    sleep(1)
    XCTAssertFalse(app.textFields["pair-link"].exists, "forgetting one Mac unpaired them all")
    XCTAssertTrue(app.staticTexts[promptA].exists, "forgetting one Mac dropped the other Mac's hand-off")
    XCTAssertFalse(app.staticTexts["Second Mac: Blank board, no base scene"].exists, "the forgotten Mac's rows stayed")
    shot(app, "12-one-mac-left")
  }

  /// Sorts last, because it unpairs the simulator.
  func testWrongFingerprintRefusedThenDeepLinkPairsThenRevokeUnpairs() throws {
    var app = launch(reset: true)
    let field = app.textFields["pair-link"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    let good = env["AB_PAIR_URL"]!
    let parts = URLComponents(string: good)!
    let wrong = good.replacingOccurrences(of: parts.queryItems!.first { $0.name == "f" }!.value!, with: "AAAAwrongfingerprint")
    field.tap()
    field.typeText(wrong + "\n")
    let refused = app.staticTexts["pair-error"]
    XCTAssertTrue(refused.waitForExistence(timeout: 15))
    XCTAssertTrue(refused.label.contains("certificate"), "a wrong fingerprint gave: \(refused.label)")
    XCTAssertTrue(field.exists, "the app paired with a server whose certificate did not match")
    shot(app, "8-wrong-fingerprint")

    app.terminate()
    app = launch(reset: true)
    XCTAssertTrue(app.textFields["pair-link"].waitForExistence(timeout: 15))
    app.open(URL(string: good)!)
    let confirm = app.alerts.buttons["Pair"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 15), "a pairing link did not ask first")
    shot(app, "9-deep-link-asks")
    confirm.tap()
    let connected = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Connected to'")).firstMatch
    XCTAssertTrue(connected.waitForExistence(timeout: 20), "the deep link did not pair")
    shot(app, "9-deep-link-paired")

    // app.open would relaunch with AB_RESET and wipe the pairing.
    XCUIDevice.shared.system.open(URL(string: good)!)
    let cancel = app.alerts.buttons["Cancel"]
    XCTAssertTrue(cancel.waitForExistence(timeout: 15), "a pairing link on a paired iPad did not ask first")
    cancel.tap()
    XCTAssertTrue(cancel.waitForNonExistence(timeout: 5), "Cancel left the question up")
    XCTAssertTrue(connected.exists, "Cancel changed the pairing")

    app.buttons["more-menu"].tap()
    app.buttons["add-mac"].tap()
    let sheetField = app.textFields["pair-link"]
    XCTAssertTrue(sheetField.waitForExistence(timeout: 10))
    XCUIDevice.shared.system.open(URL(string: good)!)
    XCTAssertTrue(cancel.waitForExistence(timeout: 15), "a pairing link under the sheet did not ask first")
    cancel.tap()
    XCTAssertTrue(cancel.waitForNonExistence(timeout: 5), "Cancel left the question up over the sheet")
    app.swipeDown(velocity: .fast)
    XCTAssertTrue(sheetField.waitForNonExistence(timeout: 5), "the pairing sheet did not close")

    FileManager.default.createFile(atPath: stubDir + "/revoked", contents: Data())
    XCTAssertTrue(app.textFields["pair-link"].waitForExistence(timeout: 20), "a 401 did not return to the pairing screen")
    shot(app, "10-revoked")
    XCTAssertTrue(app.staticTexts["pair-error"].waitForExistence(timeout: 10), "the pairing screen did not say why")
    XCTAssertTrue(app.staticTexts["pair-error"].label.contains("Pair again"))
    try FileManager.default.removeItem(atPath: stubDir + "/revoked")
  }
}

import XCTest

/// Runs against a stub that only answers on the peer route. ios/test/run-sim.mjs starts it.
/// The pairing link's hosts never answer, so pairing, the list, the board and Send all cross the peer bridge.
/// The simulator has no peer-to-peer Wi-Fi, so the stub's Bonjour service on the Mac's own network stands in.
final class PeerRouteTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var stubDir: String { env["AB_STUB_DIR"]! }

  override func setUp() {
    continueAfterFailure = false
  }

  private func shot(_ app: XCUIApplication, _ name: String) {
    try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(stubDir)/\(name).png"))
  }

  func testPairListOpenSendOverPeerRoute() throws {
    let app = XCUIApplication()
    app.launchEnvironment["AB_RESET"] = "1"
    app.launch()
    let field = app.textFields["pair-link"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    field.tap()
    field.typeText(env["AB_PAIR_URL_P"]!)

    // Times from the tap on Return to the listed hand-off. That covers the dead hosts, the bridge, pairing and the first list.
    let started = Date()
    field.typeText("\n")
    let row = app.staticTexts["Peer Mac: mark up the sign-up flow"]
    let listed = row.waitForExistence(timeout: 30)
    let elapsed = Date().timeIntervalSince(started)
    try? String(format: "%.2f", elapsed).write(toFile: "\(stubDir)/peer-seconds.txt", atomically: true, encoding: .utf8)
    if !listed { shot(app, "failed-peer-pair") }
    let pairError = app.staticTexts["pair-error"]
    XCTAssertTrue(listed, "the inbox never listed the peer Mac's hand-off. Pair error: \(pairError.exists ? pairError.label : "none")")
    XCTAssertLessThan(elapsed, 8, "the peer route took \(elapsed) s to answer")
    shot(app, "20-peer-listed")

    row.tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 15), "the board never opened over the peer route")
    sleep(1)
    let board = app.webViews.firstMatch
    board.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.3)).press(forDuration: 0.15, thenDragTo: board.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5)))
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["banner"].waitForExistence(timeout: 30), "no message from the Mac over the peer route")
    shot(app, "21-peer-sent")

    // The Mac withdraws its service and stops answering. The app says so within a poll and a search, then reconnects once it is back.
    let peerDir = stubDir + "/mac-p"
    let switches = [peerDir + "/unadvertised", peerDir + "/offline"]
    for path in switches { FileManager.default.createFile(atPath: path, contents: Data()) }
    defer { for path in switches { try? FileManager.default.removeItem(atPath: path) } }
    let gone = Date()
    let problem = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Wi-Fi and Bluetooth'")).firstMatch
    XCTAssertTrue(problem.waitForExistence(timeout: 30), "a missing peer service never showed as a problem")
    try? String(format: "%.2f", Date().timeIntervalSince(gone)).write(toFile: "\(stubDir)/peer-gone-seconds.txt", atomically: true, encoding: .utf8)
    shot(app, "22-peer-gone")

    for path in switches { try FileManager.default.removeItem(atPath: path) }
    let back = Date()
    let connected = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Connected to'")).firstMatch
    XCTAssertTrue(connected.waitForExistence(timeout: 30), "the peer route never came back")
    try? String(format: "%.2f", Date().timeIntervalSince(back)).write(toFile: "\(stubDir)/peer-back-seconds.txt", atomically: true, encoding: .utf8)
    shot(app, "23-peer-back")
  }
}

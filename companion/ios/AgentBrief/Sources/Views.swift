import SwiftUI

struct RootView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    Group {
      if model.macs.isEmpty { UnpairedView() } else { MainView() }
    }
    .task(id: scheme) { await model.web.setTheme(dark: scheme == .dark) }
  }
}

struct UnpairedView: View {
  var title = "Pair with your Mac"
  @Environment(AppModel.self) private var model

  var body: some View {
    @Bindable var model = model
    VStack(alignment: .leading, spacing: 32) {
      VStack(spacing: 12) {
        Image(systemName: "qrcode.viewfinder")
          .font(.system(size: 56))
          .foregroundStyle(.tint)
          .accessibilityHidden(true)
        Text(title).font(.largeTitle.bold())
      }
      .frame(maxWidth: .infinity)

      VStack(alignment: .leading, spacing: 14) {
        PairStep(number: 1, text: "On the Mac, open Agent Brief and choose Pair iPad…")
        if ScanButton.supported {
          PairStep(number: 2, text: "Tap Scan QR Code and point the camera at the code on the Mac.")
          ScanButton().padding(.leading, 38)
        } else {
          PairStep(number: 2, text: "Point the Camera app at the QR code and tap the link it shows.")
        }
      }

      VStack(alignment: .leading, spacing: 10) {
        Text("Or paste the pairing link from the Mac")
          .font(.subheadline)
          .foregroundStyle(.secondary)
        HStack(spacing: 10) {
          TextField("agentbrief://pair?…", text: $model.pairText)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("pair-link")
            .submitLabel(.go)
            .onSubmit { model.pairFromField() }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(Color(uiColor: .tertiarySystemFill), in: .rect(cornerRadius: 12))
          Button("Pair") { model.pairFromField() }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.isPairing || model.pairText.isEmpty)
            .accessibilityIdentifier("pair-button")
        }
        if model.isPairing { ProgressView("Pairing…").padding(.top, 4) }
        if let error = model.pairError {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.circle").accessibilityHidden(true)
            Text(error).accessibilityIdentifier("pair-error")
          }
          .font(.callout)
          .foregroundStyle(.red)
          .padding(.top, 4)
        }
      }
    }
    .frame(maxWidth: 520)
    .padding(40)
    .modifier(PairQuestion())
  }
}

private struct PairStep: View {
  let number: Int
  let text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text("\(number)")
        .font(.footnote.weight(.semibold))
        .frame(width: 26, height: 26)
        .background(Color(uiColor: .tertiarySystemFill), in: .circle)
      Text(text)
    }
  }
}

/// Asks before a pairing link takes effect. An alert only shows from the topmost screen, so `active` turns off the one under a sheet.
struct PairQuestion: ViewModifier {
  @Environment(AppModel.self) private var model
  var active = true

  func body(content: Content) -> some View {
    content.alert(
      "Pair with \(model.pendingPair?.mac ?? "this Mac")?",
      isPresented: Binding(get: { active && model.pendingPair != nil }, set: { if !$0 { model.pendingPair = nil } }),
      presenting: model.pendingPair
    ) { link in
      Button("Pair") { model.confirm(link) }
      Button("Cancel", role: .cancel) { model.pendingPair = nil }
    } message: { link in
      Text("Your drawings will go to \(link.hosts.first ?? "that Mac"). Pair only if you scanned this code on your own Mac.")
    }
  }
}

struct MainView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    NavigationSplitView {
      InboxView()
    } detail: {
      WorkView()
    }
    // At the root, so the message stays when a narrow screen goes back to the inbox after Send.
    .overlay(alignment: .top) { BannerPill() }
    .animation(.snappy, value: model.banner)
  }
}

struct InboxView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    @Bindable var model = model
    List(selection: $model.selectedId) {
      ForEach(model.macs) { mac in
        Section {
          let rows = model.handoffs(of: mac)
          if rows.isEmpty {
            Text("No hand-offs").foregroundStyle(.secondary)
          }
          ForEach(rows, id: \.key) { row($0) }
        } header: {
          Text(mac.macName)
        } footer: {
          ConnectionLine(mac: mac)
        }
      }
      if !model.orphans.isEmpty {
        Section("Not paired") {
          ForEach(model.orphans, id: \.key) { row($0) }
        }
      }
    }
    .navigationTitle("Inbox")
    .refreshable { await model.refresh() }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button("Pair Another Mac…", systemImage: "plus") { model.addMacPresented = true }
            .accessibilityIdentifier("add-mac")
          Divider()
          ForEach(model.macs) { mac in
            Button("Forget \(mac.macName)", role: .destructive) { model.forget(mac) }
              .accessibilityIdentifier("forget-\(mac.macName)")
          }
        } label: {
          Image(systemName: "ellipsis").accessibilityLabel("More")
        }
        .accessibilityIdentifier("more-menu")
      }
    }
    .sheet(isPresented: $model.addMacPresented) {
      NavigationStack {
        UnpairedView(title: "Pair another Mac")
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Cancel") { model.addMacPresented = false }
            }
          }
      }
    }
    .modifier(PairQuestion(active: !model.addMacPresented))
    .onChange(of: model.selectedId) { Task { await model.openSelected() } }
  }

  private func row(_ handoff: Handoff) -> some View {
    HandoffRow(handoff: handoff, state: model.outbox[handoff.key], closed: model.closed.contains(handoff.key))
      .tag(handoff.key)
      .contextMenu {
        if model.canDiscard(handoff) {
          Button("Discard", role: .destructive) { model.discard(handoff.key) }
        }
      }
  }
}

struct ConnectionLine: View {
  @Environment(AppModel.self) private var model
  let mac: Pairing

  var body: some View {
    Group {
      switch model.connections[mac.id] ?? .connecting {
      case .connecting:
        Text("Connecting to \(mac.macName)…")
      case .connected:
        Label {
          Text("Connected to \(mac.macName)")
        } icon: {
          Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).accessibilityHidden(true)
        }
      case .problem(let why):
        Label {
          Text(why)
        } icon: {
          Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityHidden(true)
        }
      }
    }
    .font(.footnote)
    .accessibilityIdentifier("connection")
  }
}

struct HandoffRow: View {
  let handoff: Handoff
  let state: OutboxState?
  var closed = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(handoff.title).lineLimit(2)
      HStack(spacing: 4) {
        Text(handoff.sessionLabel).lineLimit(1)
        if handoff.hasPrompt, let board = handoff.fromBoard {
          Text("·")
          Text(board).lineLimit(1).accessibilityIdentifier("handoff-board")
        }
        Text("·")
        TimelineView(.periodic(from: .now, by: 30)) { _ in
          Text(handoff.created.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))).fixedSize()
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
      switch state {
      case .sending: status("Sending…", icon: "arrow.up.circle", color: .secondary)
      case .waiting: status("Waiting for the Mac", icon: "clock", color: .orange)
      case .refused: status("The Mac refused this", icon: "exclamationmark.circle", color: .red)
      case nil:
        if closed { Text("Answered elsewhere. Send still goes to this session.").font(.caption).foregroundStyle(.secondary) }
      }
    }
    .padding(.vertical, 2)
  }

  private func status(_ text: String, icon: String, color: Color) -> some View {
    HStack(spacing: 4) {
      Image(systemName: icon).accessibilityHidden(true)
      Text(text)
    }
    .font(.caption)
    .foregroundStyle(color)
  }
}

struct WorkView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var sizeClass
  @State private var boardSpace = BoardSpace()

  /// The board page docks its panel under the board at this width or less. ipad.css holds the same number.
  private static let dockWidth: CGFloat = 700

  /// Compact width keeps toolbar icons alone.
  private var narrow: Bool { sizeClass == .compact }
  /// The panel sits under the board, so the talk strip moves to the top.
  private var docked: Bool { boardSpace.fold.map { $0.width > $0.height } ?? (boardSpace.width <= Self.dockWidth) }

  var body: some View {
    ZStack {
      BoardWebView(board: model.web)
        .ignoresSafeArea(.container, edges: .bottom)
        .onGeometryChange(for: BoardSpace.self) { BoardSpace($0) } action: { space in
          boardSpace = space
          Task { await model.web.setFold(space.fold) }
        }
      if model.openId == nil { placeholder }
      if let id = model.openId, let state = model.outbox[id] { SentCover(id: id, state: state) }
    }
    .overlay(alignment: docked ? .top : .bottom) {
      TalkStrip()
        .padding(docked ? .top : .bottom, docked ? 12 : 76)
        .padding(.horizontal, 20)
    }
    .safeAreaInset(edge: .top, spacing: 0) { promptLine }
    .navigationTitle(model.open?.sessionLabel ?? "")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { if model.openId != nil { tools } }
  }

  private var sending: Bool { model.openId.flatMap { model.outbox[$0] } != nil }

  @ToolbarContentBuilder
  private var tools: some ToolbarContent {
    ToolbarItemGroup(placement: .primaryAction) {
      Button {
        model.toggleTalk()
      } label: {
        toolLabel(model.talk == .idle ? "Talk" : "Stop", icon: model.talk == .idle ? "mic" : "stop.fill")
      }
      .tint(model.talk == .idle ? nil : .red)
      .disabled(sending || model.talk == .stopping)
      .accessibilityIdentifier("talk-button")

      Button {
        model.panelOpen.toggle()
      } label: {
        // From the size class, not the measured width, so the toolbar never feeds back into the board's size.
        Image(systemName: narrow ? "rectangle.bottomhalf.inset.filled" : "sidebar.trailing")
          .accessibilityLabel(model.panelOpen ? "Hide Comments and Note" : "Show Comments and Note")
      }
      .accessibilityIdentifier("panel-button")
    }

    ToolbarSpacer(.fixed, placement: .primaryAction)

    ToolbarItem(placement: .primaryAction) {
      Button {
        model.send()
      } label: {
        toolLabel("Send", icon: "paperplane.fill")
      }
      .buttonStyle(.borderedProminent)
      .disabled(sending)
      .accessibilityIdentifier("send-button")
    }
  }

  /// The toolbar drops a Label's title, so these spell out both parts. Narrow screens keep the icon alone.
  @ViewBuilder
  private func toolLabel(_ title: String, icon: String) -> some View {
    if narrow {
      Image(systemName: icon).accessibilityLabel(title)
    } else {
      HStack(spacing: 6) {
        Image(systemName: icon)
        Text(title)
      }
      .padding(.horizontal, 4)
    }
  }

  @ViewBuilder
  private var promptLine: some View {
    if let prompt = model.open?.prompt, !prompt.isEmpty {
      Text(prompt)
        .font(.callout)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .background(.bar)
        .accessibilityIdentifier("handoff-prompt")
    }
  }

  private var placeholder: some View {
    ZStack {
      Color(uiColor: .systemBackground).ignoresSafeArea()
      if model.isLoadingBoard {
        ProgressView("Opening the board…")
      } else if let error = model.boardError {
        ContentUnavailableView("The board didn't open", systemImage: "exclamationmark.triangle", description: Text(error))
      } else if model.handoffs.isEmpty {
        ContentUnavailableView("No hand-offs yet", systemImage: "tray", description: Text("Use the iPad button in a Claude Code session, or run `/sketch --ipad` there."))
      } else {
        ContentUnavailableView("Pick a hand-off", systemImage: "tray", description: Text("What you send goes back to the Claude Code session that asked."))
      }
    }
  }
}

/// A short message from the Mac or about a Send.
struct BannerPill: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    if let banner = model.banner {
      Text(banner)
        .font(.callout.weight(.medium))
        .multilineTextAlignment(.center)
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .glassEffect(.regular, in: .capsule)
        .accessibilityIdentifier("banner")
        .padding(.top, 12)
        .padding(.horizontal, 20)
        .allowsHitTesting(false)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
  }
}

/// The board's width, and the fold across it when the device is partly folded.
struct BoardSpace: Equatable {
  var width: CGFloat = 0
  /// The active fold, in the board's own coordinates.
  var fold: CGRect?

  init() {}

  init(_ proxy: GeometryProxy) {
    width = proxy.size.width
    if #available(iOS 27.1, *) {
      fold = proxy.reservedRegions(kind: .division).first(where: \.isActive)?.frame
    }
  }
}

/// Stops further drawing once a board has been sent, and says where it stands.
struct SentCover: View {
  @Environment(AppModel.self) private var model
  let id: String
  let state: OutboxState

  var body: some View {
    ZStack {
      Color(uiColor: .systemBackground).opacity(0.7).ignoresSafeArea()
      card
        .padding(28)
        .background(.regularMaterial, in: .rect(cornerRadius: 20))
        .shadow(color: .black.opacity(0.12), radius: 20, y: 6)
        .accessibilityIdentifier("sent-cover")
    }
  }

  @ViewBuilder
  private var card: some View {
    switch state {
    case .sending:
      ProgressView("Sending…")
    case .waiting(let why):
      message(icon: "clock", color: .orange, title: "Waiting for the Mac", why: why) {
        Text("It sends by itself when the Mac is back.").font(.footnote).foregroundStyle(.secondary)
      }
    case .refused(let why):
      message(icon: "exclamationmark.triangle", color: .red, title: "The Mac refused this", why: why) {
        Button("Discard", role: .destructive) { model.discard(id) }
          .buttonStyle(.bordered)
          .controlSize(.large)
          .padding(.top, 4)
      }
    }
  }

  private func message(icon: String, color: Color, title: String, why: String, @ViewBuilder footer: () -> some View) -> some View {
    VStack(spacing: 10) {
      Image(systemName: icon).font(.title).foregroundStyle(color).accessibilityHidden(true)
      Text(title).font(.headline)
      Text(why).font(.callout).multilineTextAlignment(.center).foregroundStyle(.secondary)
      footer()
    }
    .frame(width: 360)
  }
}

/// Live words while talking, and what went wrong when talking can't start. Floats over the board, so the canvas keeps its size.
struct TalkStrip: View {
  @Environment(AppModel.self) private var model
  @State private var lingering = false

  private static let linger = Duration.seconds(4)

  var body: some View {
    Group {
      if let error = model.talkError {
        HStack(spacing: 10) {
          Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red).accessibilityHidden(true)
          Text(error)
          if model.micDenied {
            Button("Open Settings") {
              if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
          }
        }
        .pill()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("talk-error")
      } else if model.talk != .idle && (!model.liveInPanel || model.liveWords.isEmpty) || (lingering && !model.liveWords.isEmpty && !model.liveInPanel) {
        HStack(spacing: 10) {
          Image(systemName: model.talk == .idle ? "checkmark" : "waveform")
            .foregroundStyle(model.talk == .idle ? Color.secondary : Color.red)
            .symbolEffect(.pulse, isActive: model.talk == .listening)
            .accessibilityHidden(true)
          Text(line).lineLimit(2).accessibilityIdentifier("live-words")
        }
        .pill()
        .allowsHitTesting(false)
      }
    }
    .animation(.snappy, value: model.talk)
    .animation(.snappy, value: lingering)
    .task(id: model.talk) {
      guard model.talk == .idle else { return }
      lingering = true
      try? await Task.sleep(for: Self.linger)
      if !Task.isCancelled { lingering = false }
    }
  }

  private var line: String {
    switch model.talk {
    case .preparing: return "Getting ready…"
    case .downloading(let done): return "Downloading the speech model, \(Int(done * 100))%"
    case .listening where model.liveWords.isEmpty: return "Listening…"
    case .stopping where model.liveWords.isEmpty: return "Finishing…"
    default: return model.liveWords
    }
  }
}

private extension View {
  func pill() -> some View {
    font(.callout)
      .padding(.horizontal, 18)
      .padding(.vertical, 11)
      .glassEffect(.regular, in: .rect(cornerRadius: 22))
  }
}

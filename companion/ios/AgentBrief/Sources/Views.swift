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
    VStack(alignment: .leading, spacing: 20) {
      Text(title).font(.largeTitle.bold())
      VStack(alignment: .leading, spacing: 8) {
        Text("1. On the Mac, open Agent Brief and choose Pair iPad…")
        Text("2. Point this iPad's Camera app at the QR code and tap the link it shows.")
      }
      Divider()
      Text("Or paste the pairing link from the Mac").font(.headline)
      HStack {
        TextField("agentbrief://pair?…", text: $model.pairText)
          .textFieldStyle(.roundedBorder)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .accessibilityIdentifier("pair-link")
          .submitLabel(.go)
          .onSubmit { model.pairFromField() }
        Button("Pair") { model.pairFromField() }
          .buttonStyle(.borderedProminent)
          .disabled(model.isPairing || model.pairText.isEmpty)
          .accessibilityIdentifier("pair-button")
      }
      if model.isPairing { ProgressView("Pairing…") }
      if let error = model.pairError {
        Text(error).foregroundStyle(.red).accessibilityIdentifier("pair-error")
      }
    }
    .frame(maxWidth: 560)
    .padding(40)
    .modifier(PairQuestion())
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
            Text("Nothing to do. Use the iPad button in a Claude Code session, or run /sketch --ipad there.")
              .foregroundStyle(.secondary)
              .font(.callout)
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
          Image(systemName: "ellipsis.circle").accessibilityLabel("More")
        }
        .accessibilityIdentifier("more-menu")
      }
    }
    .sheet(isPresented: $model.addMacPresented) { UnpairedView(title: "Pair another Mac") }
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
      case .connecting: Text("Connecting to \(mac.macName)…")
      case .connected: Label("Connected to \(mac.macName)", systemImage: "checkmark.circle")
      case .problem(let why): Label(why, systemImage: "exclamationmark.triangle")
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
      Text(handoff.prompt?.isEmpty == false ? handoff.prompt! : "Sketch for this session").lineLimit(2)
      HStack(spacing: 4) {
        Text(handoff.sessionLabel)
        Text("·")
        Text(handoff.created, style: .relative)
      }
      .font(.caption)
      .foregroundStyle(.secondary)
      switch state {
      case .sending: Text("Sending…").font(.caption).foregroundStyle(.secondary)
      case .waiting: Text("Waiting for the Mac").font(.caption).foregroundStyle(.orange)
      case .refused: Text("The Mac refused this").font(.caption).foregroundStyle(.red)
      case nil:
        if closed { Text("Answered elsewhere. Send still goes to this session.").font(.caption).foregroundStyle(.secondary) }
      }
    }
    .padding(.vertical, 2)
  }
}

struct WorkView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    @Bindable var model = model
    ZStack {
      BoardWebView(board: model.web)
      if model.openId == nil { placeholder }
      if let id = model.openId, let state = model.outbox[id] { SentCover(id: id, state: state) }
    }
    .safeAreaInset(edge: .top, spacing: 0) { topLines }
    .safeAreaInset(edge: .bottom, spacing: 0) { TalkStrip() }
    .navigationTitle(model.open?.sessionLabel ?? "")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { if model.openId != nil { tools } }
    .inspector(isPresented: $model.notePresented) {
      VStack(alignment: .leading) {
        Text("Note").font(.headline)
        TextEditor(text: $model.noteText)
          .disabled(sending || model.openId == nil)
          .accessibilityIdentifier("note-editor")
      }
      .padding()
    }
  }

  private var sending: Bool { model.openId.flatMap { model.outbox[$0] } != nil }

  @ToolbarContentBuilder
  private var tools: some ToolbarContent {
    ToolbarItemGroup(placement: .primaryAction) {
      Button {
        model.toggleTalk()
      } label: {
        Label(model.talk == .idle ? "Talk" : "Stop", systemImage: model.talk == .idle ? "mic" : "stop.circle.fill")
          .labelStyle(.titleAndIcon)
      }
      .disabled(sending || model.talk == .stopping)
      .accessibilityIdentifier("talk-button")

      Button {
        model.notePresented.toggle()
      } label: {
        Label("Note", systemImage: "note.text").labelStyle(.titleAndIcon)
      }
      .accessibilityIdentifier("note-button")

      Button {
        model.send()
      } label: {
        Label("Send", systemImage: "paperplane.fill").labelStyle(.titleAndIcon)
      }
      .buttonStyle(.borderedProminent)
      .disabled(sending)
      .accessibilityIdentifier("send-button")
    }
  }

  @ViewBuilder
  private var topLines: some View {
    VStack(spacing: 0) {
      if let banner = model.banner {
        Text(banner)
          .frame(maxWidth: .infinity)
          .padding(10)
          .background(.green.opacity(0.2))
          .accessibilityIdentifier("banner")
      }
      if let prompt = model.open?.prompt, !prompt.isEmpty {
        Text(prompt)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(10)
          .background(.bar)
          .accessibilityIdentifier("handoff-prompt")
      }
    }
  }

  private var placeholder: some View {
    ZStack {
      Color(uiColor: .systemBackground).ignoresSafeArea()
      if model.isLoadingBoard {
        ProgressView("Opening the board…")
      } else if let error = model.boardError {
        ContentUnavailableView("The board didn't open", systemImage: "exclamationmark.triangle", description: Text(error))
      } else {
        ContentUnavailableView("Pick a hand-off", systemImage: "tray", description: Text("What you send goes back to the Claude Code session that asked."))
      }
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
      VStack(spacing: 12) {
        switch state {
        case .sending:
          ProgressView("Sending…")
        case .waiting(let why):
          Text("Waiting for the Mac").font(.title2.bold())
          Text(why).multilineTextAlignment(.center).foregroundStyle(.secondary)
          Text("It sends by itself when the Mac is back.").font(.footnote).foregroundStyle(.secondary)
        case .refused(let why):
          Text("The Mac refused this").font(.title2.bold())
          Text(why).multilineTextAlignment(.center).foregroundStyle(.secondary)
          Button("Discard", role: .destructive) { model.discard(id) }
        }
      }
      .padding(32)
      .frame(maxWidth: 480)
      .background(.regularMaterial, in: .rect(cornerRadius: 16))
      .accessibilityIdentifier("sent-cover")
    }
  }
}

/// Live words while talking, and what went wrong when talking can't start.
struct TalkStrip: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    if let error = model.talkError {
      HStack {
        Text(error)
        if model.micDenied {
          Button("Open Settings") {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
          }
        }
        Spacer()
      }
      .padding(10)
      .background(.red.opacity(0.15))
      .accessibilityIdentifier("talk-error")
    } else if model.talk != .idle || !model.liveWords.isEmpty {
      HStack {
        Image(systemName: model.talk == .listening ? "waveform" : "mic").symbolEffect(.pulse, isActive: model.talk == .listening)
        Text(line).lineLimit(2).accessibilityIdentifier("live-words")
        Spacer()
      }
      .padding(10)
      .background(.bar)
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

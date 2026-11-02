import SwiftUI

@main
struct AgentBriefApp: App {
  @State private var model = AppModel()
  @Environment(\.scenePhase) private var phase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .onOpenURL { model.handle(url: $0) }
        .onChange(of: phase, initial: true) { _, now in
          model.setForeground(now == .active)
        }
    }
  }
}

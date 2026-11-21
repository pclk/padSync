import SwiftUI

@main
struct PadSyncApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}

/// App-wide navigation state.
@MainActor @Observable
final class AppModel {
    /// The notebook open in the native editor; nil while the web screens show.
    var openNotebook: NotebookRoute?
}

struct NotebookRoute: Identifiable, Hashable {
    let id: String
}

/// The web app (library, AI import, chat, settings) with the native notebook editor over it.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        WebScreen { id in model.openNotebook = NotebookRoute(id: id) }
            .background(Color(red: 0xf1 / 255, green: 0xf5 / 255, blue: 0xf9 / 255))
            .fullScreenCover(item: $model.openNotebook) { route in
                NotebookScreen(notebookId: route.id) { model.openNotebook = nil }
            }
    }
}

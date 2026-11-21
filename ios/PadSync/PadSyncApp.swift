import SwiftUI
import UIKit
import WebKit

@main
struct PadSyncApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
        .onChange(of: scenePhase) { _, phase in model.scenePhaseChanged(phase) }
    }
}

/// App-wide state: navigation, the native store and its sync.
@MainActor @Observable
final class AppModel {
    /// The notebook open in the native editor; nil while the web screens show.
    var openNotebook: NotebookRoute? {
        didSet {
            sync.active = openNotebook != nil
            if openNotebook != nil { sync.wake(reason: "notebook opened") }
        }
    }

    let database: AppDatabase
    let sync: SyncEngine
    @ObservationIgnored private let cookieWatcher = CookieWatcher()

    init() {
        do {
            database = try AppDatabase.openShared()
        } catch {
            // A store that can't open (disk full, corrupt file) shouldn't keep the web screens from working.
            database = try! AppDatabase.inMemory()
        }
        sync = SyncEngine(db: database)
        cookieWatcher.onSessionChange = { [sync] in sync.wake(reason: "signed in") }
        sync.start()
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .active:
            sync.wake(reason: "foreground")
        case .background:
            // Push what's left before iOS suspends the app.
            // The request times out after 15 s, inside the ~30 s iOS allows.
            let app = UIApplication.shared
            let task = app.beginBackgroundTask(expirationHandler: nil)
            Task {
                _ = try? await sync.syncOnce()
                app.endBackgroundTask(task)
            }
        default:
            break
        }
    }
}

/// Wakes sync when the web view's sign-in cookie changes.
@MainActor
final class CookieWatcher: NSObject, WKHTTPCookieStoreObserver {
    var onSessionChange: () -> Void = {}
    private var lastSession: String?

    override init() {
        super.init()
        WKWebsiteDataStore.default().httpCookieStore.add(self)
    }

    nonisolated func cookiesDidChange(in store: WKHTTPCookieStore) {
        Task { @MainActor in
            let session = await Server.sessionCookie()?.value
            guard session != lastSession else { return }
            lastSession = session
            if session != nil { onSessionChange() }
        }
    }
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
                NotebookScreen(notebookId: route.id, database: model.database, sync: model.sync) { model.openNotebook = nil }
            }
    }
}

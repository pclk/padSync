import SwiftUI
import UIKit
import WebKit
import WidgetKit

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
            if openNotebook == nil {
                handwriting?.update()
                publishRecent()
            }
            sync.active = openNotebook != nil
            if openNotebook != nil { sync.wake(reason: "notebook opened") }
            updateRealtime()
        }
    }

    let database: AppDatabase
    let sync: SyncEngine
    @ObservationIgnored private let realtime = Realtime()
    @ObservationIgnored private var foreground = true
    @ObservationIgnored private var backgroundedAt: Date?
    @ObservationIgnored private let cookieWatcher = CookieWatcher()
    @ObservationIgnored private var handwriting: HandwritingIndex?

    init() {
        do {
            database = try AppDatabase.openShared()
        } catch {
            // A store that can't open (disk full, corrupt file) shouldn't keep the web screens from working.
            database = try! AppDatabase.inMemory()
        }
        sync = SyncEngine(db: database)
        realtime.onNotify = { [sync] seq in sync.notified(seq: seq) }
        realtime.onStatus = { [sync] status in sync.realtimeLive = status == .live }
        sync.onWake = { [realtime] reason in if reason == "online" { realtime.wake() } }
        cookieWatcher.onSessionChange = { [sync, realtime] in
            sync.wake(reason: "signed in")
            realtime.wake()
        }
        sync.start()
        #if DEBUG
        // `-openNotebook <id>` opens a notebook at launch, for checking the editor in the simulator.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-openNotebook"), i + 1 < args.count { openNotebook = NotebookRoute(id: args[i + 1]) }
        #endif
        updateRealtime()
        // Unit tests run inside the app: keep them on the web screens.
        if openNotebook == nil, ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil {
            openLatestNotebook(since: .now)
            Task { await SigningExpiry.schedule() }
            // Reads new ink for search once the first pull has had time to land.
            let index = HandwritingIndex(database: database)
            handwriting = index
            Task {
                try? await Task.sleep(for: .seconds(5))
                index.update()
            }
        }
    }

    /// How long the app must have been away before coming back reopens the latest notebook.
    static let reopenAfter: TimeInterval = 10 * 60

    /// Opens the notebook edited last on any device. It waits briefly for the first pull, so
    /// writing on the Mac a minute ago counts, then decides from whatever the store has.
    private func openLatestNotebook(since requested: Date) {
        Task { @MainActor [weak self] in
            let deadline = Date.now.addingTimeInterval(1.5)
            while let self, Date.now < deadline, !self.pulled(since: requested) {
                try? await Task.sleep(for: .milliseconds(100))
            }
            self?.publishRecent()
            guard let self, self.openNotebook == nil, !self.checkInbox(),
                  let id = try? await self.database.writer.read({ try AppDatabase.latestNotebookId($0) }) else { return }
            var instant = Transaction()
            instant.disablesAnimations = true
            withTransaction(instant) { self.openNotebook = NotebookRoute(id: id) }
        }
    }

    /// The widget's list: the notebooks edited last, newest first.
    func publishRecent() {
        Task {
            guard let rows = try? await database.writer.read({ try AppDatabase.recentNotebooks($0, limit: 6) }) else { return }
            let list = rows.map { RecentNotebook(id: $0.id, title: $0.title, edited: $0.edited) }
            guard list != RecentNotebook.load() else { return }
            RecentNotebook.save(list)
            WidgetCenter.shared.reloadTimelines(ofKind: "RecentNotebooks")
        }
    }

    /// PDFs shared to padSync are waiting: show the library, which imports them. True if any are.
    @discardableResult
    func checkInbox() -> Bool {
        guard !Inbox.files().isEmpty else { return false }
        openNotebook = nil
        // The web view may still be loading; the library also checks when it mounts.
        NotificationCenter.default.post(name: Inbox.waiting, object: nil)
        return true
    }

    /// A pull finished after `date`, or the server can't be reached and waiting won't help.
    private func pulled(since date: Date) -> Bool {
        if let at = sync.lastSyncedAt, at >= date { return true }
        return [.offline, .needsLogin, .localOnly, .error].contains(sync.status)
    }

    /// Realtime runs only while a notebook shows: the web screens run their own.
    private func updateRealtime() {
        realtime.active = foreground && openNotebook != nil
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .active:
            foreground = true
            updateRealtime()
            sync.wake(reason: "foreground")
            if checkInbox() {
                // Shared PDFs: the library imports them.
            } else if let away = backgroundedAt, Date.now.timeIntervalSince(away) >= Self.reopenAfter, openNotebook == nil {
                openLatestNotebook(since: .now)
            }
            backgroundedAt = nil
            handwriting?.update()
        case .background:
            foreground = false
            backgroundedAt = .now
            publishRecent()
            updateRealtime()
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

/// The web app (library, chat, settings) with the native notebook editor over it.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        WebScreen(database: model.database, covered: model.openNotebook != nil, onStoreWrite: { [sync = model.sync] in sync.requestSync(reason: "web store write") }) { id in
            model.openNotebook = NotebookRoute(id: id)
        }
            .ignoresSafeArea()
            .fullScreenCover(item: $model.openNotebook) { route in
                NotebookScreen(notebookId: route.id, database: model.database, sync: model.sync) { model.openNotebook = nil }
            }
            // The widget's padsync://notebook/<id> links.
            .onOpenURL { url in
                if let id = RecentNotebook.id(from: url) { model.openNotebook = NotebookRoute(id: id) }
            }
    }
}

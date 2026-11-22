import Foundation
import GRDB
import WebKit

/// Phase 4 groundwork: the web screens read and write the native store directly, through the
/// `padsyncStore` message handler, instead of keeping their own Dexie copy that only meets the
/// native one through the server. The web side is `src/lib/native-store.ts`.
///
/// Requests are `{ op, ... }` and each gets one reply (`postMessage` returns a promise):
/// - `get { id }` → the entity or null
/// - `list { notebookId, kind?, parentId?, includeDeleted? }` → entities, in id order
/// - `notebooks {}` → every notebook entity (including deleted, as Dexie's `kind` index gives them)
/// - `searchInk { query }` → `[{ notebookId, sectionId, line }]`, notebooks whose handwriting
///   (read on the iPad, HandwritingIndex) contains the query, one hit each
/// - `inbox {}` → `[{ id, name, base64 }]`, PDFs shared to padSync (PadSyncShare) not yet imported
/// - `clearInbox { ids }` → removes those once the library has started importing them
/// - `put { entities }` → stores them with a fresh hlc, dirty, and asks for a sync; replies with
///   what was written
///
/// Entities travel in the Dexie shape (`deleted` and `dirty` as 0/1). When anything in the store
/// changes, the page gets a `padsync-native-change` event, so live queries can re-run.
enum StoreBridge {
    static let handlerName = "padsyncStore"

    struct BridgeError: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Runs one request against the store. Pure enough to test without a web view.
    static func handle(_ body: Any, db: AppDatabase) throws -> (result: Any, wrote: Bool) {
        guard let body = body as? [String: Any], let op = body["op"] as? String else {
            throw BridgeError(message: "expected { op }")
        }
        switch op {
        case "get":
            guard let id = body["id"] as? String else { throw BridgeError(message: "get needs id") }
            let e = try db.writer.read { db in try Entity.fetchOne(db, key: id) }
            return (e.map(dexie) ?? NSNull(), false)
        case "list":
            guard let notebookId = body["notebookId"] as? String else { throw BridgeError(message: "list needs notebookId") }
            var request = Entity.filter(Column("notebookId") == notebookId)
            if let kind = body["kind"] as? String { request = request.filter(Column("kind") == kind) }
            if let parentId = body["parentId"] as? String { request = request.filter(Column("parentId") == parentId) }
            if body["includeDeleted"] as? Bool != true { request = request.filter(Column("deleted") == false) }
            let rows = try db.writer.read { db in try request.order(Column("id")).fetchAll(db) }
            return (rows.map(dexie), false)
        case "notebooks":
            let rows = try db.writer.read { db in
                try Entity.filter(Column("kind") == Entity.Kind.notebook.rawValue).order(Column("id")).fetchAll(db)
            }
            return (rows.map(dexie), false)
        case "put":
            guard let list = body["entities"] as? [Any] else { throw BridgeError(message: "put needs entities") }
            let entities = try list.map { item -> Entity in
                guard let wire = item as? [String: Any], let e = Entity(wire: wire.merging(["hlc": ""]) { old, _ in old }) else {
                    throw BridgeError(message: "bad entity")
                }
                return e
            }
            return (try db.save(entities).map(dexie), !entities.isEmpty)
        case "inbox":
            return (Inbox.list().map { ["id": $0.id, "name": $0.name, "base64": $0.base64] }, false)
        case "clearInbox":
            guard let ids = body["ids"] as? [String] else { throw BridgeError(message: "clearInbox needs ids") }
            Inbox.remove(ids)
            return (NSNull(), false)
        case "searchInk":
            guard let query = body["query"] as? String else { throw BridgeError(message: "searchInk needs query") }
            let hits = try db.writer.read { db in try HandwritingIndex.search(db, query: query) }
            return (hits.map { ["notebookId": $0.notebookId, "sectionId": $0.sectionId, "line": $0.line] }, false)
        default:
            throw BridgeError(message: "unknown op \(op)")
        }
    }

    /// The Dexie row shape (src/lib/types.ts `Entity`).
    static func dexie(_ e: Entity) -> [String: Any] {
        var row = e.wire
        row["dirty"] = e.dirty ? 1 : 0
        return row
    }

    /// Fired on the page after a commit that touched entities. Debounced by the observer.
    static let changeScript = "window.dispatchEvent(new CustomEvent('padsync-native-change'))"
    /// Fired when shared PDFs are waiting (`inbox`).
    static let inboxScript = "window.dispatchEvent(new CustomEvent('padsync-inbox'))"
}

/// PDFs the Share extension saved to the App Group, named `<ms>-<original name>`.
enum Inbox {
    static let waiting = Notification.Name("padsync.inbox")

    static func files(in folder: URL? = AppGroup.inbox) -> [URL] {
        guard let folder else { return [] }
        return ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension.lowercased() == "pdf" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    static func list(in folder: URL? = AppGroup.inbox) -> [(id: String, name: String, base64: String)] {
        files(in: folder).compactMap { url in
            guard let data = try? Data(contentsOf: url) else { return nil }
            let id = url.lastPathComponent
            let name = id.firstIndex(of: "-").map { String(id[id.index(after: $0)...]) } ?? id
            return (id, name, data.base64EncodedString())
        }
    }

    static func remove(_ ids: [String], in folder: URL? = AppGroup.inbox) {
        guard let folder else { return }
        // Only plain names from list(), never a path.
        for id in ids where !id.contains("/") && !id.hasPrefix(".") {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(id))
        }
    }
}

/// Answers `padsyncStore` messages from one web view and tells it when the store changes.
@MainActor
final class StoreBridgeHandler: NSObject, WKScriptMessageHandlerWithReply {
    private let db: AppDatabase
    private let onWrite: () -> Void
    weak var web: WKWebView?
    private var observer: AnyDatabaseCancellable?
    private var pendingNotify = false

    init(db: AppDatabase, onWrite: @escaping () -> Void) {
        self.db = db
        self.onWrite = onWrite
        super.init()
        NotificationCenter.default.addObserver(forName: Inbox.waiting, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { _ = self?.web?.evaluateJavaScript(StoreBridge.inboxScript) }
        }
        observer = DatabaseRegionObservation(tracking: Table(Entity.databaseTableName))
            .start(in: db.writer, onError: { _ in }, onChange: { [weak self] _ in
                Task { @MainActor in self?.storeChanged() }
            })
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        do {
            // On the main thread: SQLite answers a notebook's rows in milliseconds, and the
            // message body and reply aren't Sendable.
            let (result, wrote) = try StoreBridge.handle(message.body, db: db)
            if wrote { onWrite() }
            return (result, nil)
        } catch {
            return (nil, error.localizedDescription)
        }
    }

    /// Sync applies rows in bursts; one event per 250 ms is plenty for live queries.
    private func storeChanged() {
        guard !pendingNotify else { return }
        pendingNotify = true
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            pendingNotify = false
            _ = try? await web?.evaluateJavaScript(StoreBridge.changeScript)
        }
    }
}

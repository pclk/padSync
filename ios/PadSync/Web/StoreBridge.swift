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

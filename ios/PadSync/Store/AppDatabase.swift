import Foundation
import GRDB

/// The native offline store: entities, the event log and a little metadata, in SQLite under
/// Application Support (iOS never evicts it, unlike a PWA's IndexedDB). Same tables as the
/// Dexie database in src/lib/db.ts.
final class AppDatabase: Sendable {
    let writer: any DatabaseWriter
    let hlc: HLC

    init(_ writer: any DatabaseWriter) throws {
        self.writer = writer
        try Self.migrator.migrate(writer)
        let device = try writer.write { db in
            if let id = try Self.meta(db, "device")?.string { return id }
            let id = Self.newDeviceId()
            try Self.setMeta(db, "device", .string(id))
            return id
        }
        hlc = HLC(device: device)
        // The clock must not run behind anything already stored, or a new write could lose to it.
        if let newest = try writer.read({ db in try String.fetchOne(db, sql: "SELECT max(hlc) FROM entity") }) {
            hlc.observe(newest)
        }
    }

    var device: String { hlc.device }

    static func openShared() throws -> AppDatabase {
        let folder = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var config = Configuration()
        config.label = "padsync"
        let pool = try DatabasePool(path: folder.appendingPathComponent("padsync.sqlite").path, configuration: config)
        return try AppDatabase(pool)
    }

    static func inMemory() throws -> AppDatabase {
        try AppDatabase(DatabaseQueue())
    }

    /// 8 base-36 characters, like deviceId() in src/lib/db.ts.
    static func newDeviceId() -> String {
        let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return String((0..<8).map { _ in alphabet.randomElement()! })
    }

    private static var migrator: DatabaseMigrator {
        var m = DatabaseMigrator()
        m.registerMigration("v1") { db in
            try db.create(table: "entity") { t in
                t.primaryKey("id", .text)
                t.column("kind", .text).notNull()
                t.column("notebookId", .text).notNull()
                t.column("parentId", .text).notNull()
                t.column("data", .blob).notNull()
                t.column("hlc", .text).notNull()
                t.column("deleted", .boolean).notNull()
                t.column("dirty", .boolean).notNull()
            }
            try db.create(index: "entity_dirty", on: "entity", columns: ["dirty"])
            try db.create(index: "entity_notebook", on: "entity", columns: ["notebookId", "kind"])
            try db.create(index: "entity_parent", on: "entity", columns: ["parentId", "kind", "deleted"])
            try db.create(table: "event") { t in
                t.primaryKey("id", .text)
                t.column("notebookId", .text).notNull()
                t.column("sectionId", .text)
                t.column("type", .text).notNull()
                t.column("t", .integer).notNull()
                t.column("device", .text).notNull()
                t.column("data", .blob).notNull()
                t.column("synced", .boolean).notNull()
            }
            try db.create(index: "event_synced", on: "event", columns: ["synced"])
            try db.create(table: "meta") { t in
                t.primaryKey("key", .text)
                t.column("value", .blob).notNull()
            }
        }
        // Answers "which notebook was edited last" from each notebook's newest row
        // ([notebookId+hlc] in src/lib/db.ts).
        m.registerMigration("v2") { db in
            try db.create(index: "entity_notebook_hlc", on: "entity", columns: ["notebookId", "hlc"])
        }
        return m
    }

    // MARK: Metadata

    static func meta(_ db: Database, _ key: String) throws -> JSONValue? {
        try Data.fetchOne(db, sql: "SELECT value FROM meta WHERE key = ?", arguments: [key]).map(JSONValue.parse)
    }

    static func setMeta(_ db: Database, _ key: String, _ value: JSONValue) throws {
        try db.execute(sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", arguments: [key, value.serialized()])
    }

    func cursor() throws -> Int64 {
        try writer.read { db in try Self.meta(db, "cursor")?.int ?? 0 }
    }

    // MARK: Local writes

    /// Stamps each entity with a fresh clock, marks it dirty and stores it. Returns what was written.
    @discardableResult
    func save(_ entities: [Entity]) throws -> [Entity] {
        try writer.write { db in
            try entities.map { e in
                var e = e
                e.hlc = hlc.now()
                e.dirty = true
                try e.save(db)
                return e
            }
        }
    }

    func log(_ event: PadEvent) throws {
        try writer.write { db in try event.insert(db, onConflict: .ignore) }
    }

    // MARK: Sync

    struct Batch: Sendable {
        var since: Int64
        var entities: [Entity]
        var events: [PadEvent]
        var isEmpty: Bool { entities.isEmpty && events.isEmpty }
    }

    /// Up to `entityLimit` unacknowledged entities and `eventLimit` unsent events, with the pull cursor.
    func pendingBatch(entityLimit: Int, eventLimit: Int) throws -> Batch {
        try writer.read { db in
            Batch(since: try Self.meta(db, "cursor")?.int ?? 0,
                  entities: try Entity.filter(sql: "dirty = 1").limit(entityLimit).fetchAll(db),
                  events: try PadEvent.filter(sql: "synced = 0").limit(eventLimit).fetchAll(db))
        }
    }

    /// Applies one /api/sync response in a single transaction: acknowledges what was sent
    /// (unless it was rewritten while the request was in flight), stores remote rows newer than
    /// ours and moves the cursor. Returns the remote rows that were applied.
    func applySync(sent: Batch, changes: [Entity], cursor: Int64) throws -> [Entity] {
        try writer.write { db in
            for e in sent.entities {
                try db.execute(sql: "UPDATE entity SET dirty = 0 WHERE id = ? AND hlc = ?", arguments: [e.id, e.hlc])
            }
            for e in sent.events {
                try db.execute(sql: "UPDATE event SET synced = 1 WHERE id = ?", arguments: [e.id])
            }
            var applied: [Entity] = []
            for var remote in changes {
                hlc.observe(remote.hlc)
                let local = try String.fetchOne(db, sql: "SELECT hlc FROM entity WHERE id = ?", arguments: [remote.id])
                guard local.map({ HLC.isNewer(remote.hlc, than: $0) }) ?? true else { continue }
                remote.dirty = false
                try remote.save(db)
                applied.append(remote)
            }
            try Self.setMeta(db, "cursor", .int(cursor))
            return applied
        }
    }

    /// Pulls everything again on the next sync (Settings → re-download).
    func resetCursor() throws {
        try writer.write { db in try Self.setMeta(db, "cursor", .int(0)) }
    }
}

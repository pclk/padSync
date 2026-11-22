import Foundation
import GRDB

/// Read-side queries over the store. Each returns live rows only (deleted = 0).
extension AppDatabase {
    struct NotebookSummary: Sendable, Equatable {
        var notebook: Entity?
        var sections: [Entity]
        /// Live strokes per section id.
        var strokeCounts: [String: Int]
        var title: String { notebook?.data["title"]?.string ?? "Untitled notebook" }
    }

    static func notebookSummary(_ db: Database, id: String) throws -> NotebookSummary {
        let notebook = try Entity.filter(key: id).fetchOne(db)
        let sections = try Entity
            .filter(sql: "notebookId = ? AND kind = 'section' AND deleted = 0", arguments: [id])
            .fetchAll(db)
            .sorted { ($0.data["order"]?.double ?? 0) < ($1.data["order"]?.double ?? 0) }
        let rows = try Row.fetchAll(db, sql: """
            SELECT parentId, count(*) AS n FROM entity
            WHERE notebookId = ? AND kind = 'stroke' AND deleted = 0 GROUP BY parentId
            """, arguments: [id])
        let counts = Dictionary(uniqueKeysWithValues: rows.map { ($0["parentId"] as String, $0["n"] as Int) })
        return NotebookSummary(notebook: notebook?.deleted == false ? notebook : nil, sections: sections, strokeCounts: counts)
    }

    /// Emits a fresh summary whenever the notebook's rows change (local edits or a sync).
    func observeNotebook(id: String) -> AsyncValueObservation<NotebookSummary> {
        ValueObservation
            .tracking { db in try Self.notebookSummary(db, id: id) }
            .removeDuplicates()
            .values(in: writer)
    }

    /// The live notebook edited most recently on any device: the newest clock stamp among its rows,
    /// presence aside (lastEditedTimes in src/lib/store.ts, the library's "Recently edited").
    static func latestNotebookId(_ db: Database) throws -> String? {
        try String.fetchOne(db, sql: """
            SELECT n.id FROM entity n
            WHERE n.kind = 'notebook' AND n.deleted = 0
            ORDER BY (SELECT max(e.hlc) FROM entity e WHERE e.notebookId = n.id AND e.kind != 'presence') DESC
            LIMIT 1
            """)
    }
}

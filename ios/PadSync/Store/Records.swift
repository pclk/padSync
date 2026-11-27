import Foundation
import GRDB

/// Everything that syncs: a small JSON document stamped with a hybrid logical clock. Mirrors
/// `Entity` in src/lib/types.ts; conflicts resolve per entity, highest hlc wins.
struct Entity: Sendable, Hashable, Identifiable {
    enum Kind: String, Sendable {
        case notebook, section, stroke, textbox, image, presence, folder
    }

    var id: String
    var kind: Kind
    var notebookId: String
    /// Section id for strokes and text boxes; empty otherwise.
    var parentId: String
    var data: JSONValue
    var hlc: String
    /// Soft delete: nothing is removed, for analytics and undo.
    var deleted: Bool
    /// The server hasn't acknowledged this version yet.
    var dirty: Bool
}

extension Entity: FetchableRecord, PersistableRecord {
    static let databaseTableName = "entity"

    init(row: Row) throws {
        guard let kind = Kind(rawValue: row["kind"]) else {
            throw DatabaseError(message: "unknown entity kind \(String(describing: row["kind"] as String?))")
        }
        self.init(id: row["id"], kind: kind, notebookId: row["notebookId"], parentId: row["parentId"],
                  data: try JSONValue.parse(row["data"]), hlc: row["hlc"], deleted: row["deleted"], dirty: row["dirty"])
    }

    func encode(to container: inout PersistenceContainer) throws {
        container["id"] = id
        container["kind"] = kind.rawValue
        container["notebookId"] = notebookId
        container["parentId"] = parentId
        container["data"] = data.serialized()
        container["hlc"] = hlc
        container["deleted"] = deleted
        container["dirty"] = dirty
    }
}

extension Entity {
    /// The shape /api/sync accepts and returns (deleted as 0/1, no dirty flag).
    var wire: [String: Any] {
        ["id": id, "kind": kind.rawValue, "notebookId": notebookId, "parentId": parentId,
         "data": data.any, "hlc": hlc, "deleted": deleted ? 1 : 0]
    }

    init?(wire: [String: Any]) {
        guard let id = wire["id"] as? String, let kindRaw = wire["kind"] as? String, let kind = Kind(rawValue: kindRaw),
              let hlc = wire["hlc"] as? String else { return nil }
        self.init(id: id, kind: kind, notebookId: wire["notebookId"] as? String ?? "", parentId: wire["parentId"] as? String ?? "",
                  data: JSONValue(any: wire["data"] ?? NSNull()), hlc: hlc,
                  deleted: (wire["deleted"] as? NSNumber)?.intValue == 1, dirty: false)
    }
}

/// Append-only analytics log (`PadEvent` in src/lib/types.ts). Never updated except `synced`.
struct PadEvent: Sendable, Hashable, Identifiable {
    var id: String
    var notebookId: String
    var sectionId: String?
    var type: String
    /// ms since 1970.
    var t: Int64
    var device: String
    var data: JSONValue
    var synced: Bool
}

extension PadEvent: FetchableRecord, PersistableRecord {
    static let databaseTableName = "event"

    init(row: Row) throws {
        self.init(id: row["id"], notebookId: row["notebookId"], sectionId: row["sectionId"], type: row["type"], t: row["t"],
                  device: row["device"], data: try JSONValue.parse(row["data"]), synced: row["synced"])
    }

    func encode(to container: inout PersistenceContainer) throws {
        container["id"] = id
        container["notebookId"] = notebookId
        container["sectionId"] = sectionId
        container["type"] = type
        container["t"] = t
        container["device"] = device
        container["data"] = data.serialized()
        container["synced"] = synced
    }

    var wire: [String: Any] {
        ["id": id, "notebookId": notebookId, "sectionId": sectionId ?? NSNull(), "type": type, "t": t,
         "device": device, "data": data.any]
    }
}

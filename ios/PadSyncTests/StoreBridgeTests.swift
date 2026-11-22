import Foundation
import Testing
@testable import padSync

struct StoreBridgeTests {
    private func seeded() throws -> AppDatabase {
        let db = try AppDatabase.inMemory()
        _ = try db.applySync(sent: .init(since: 0, entities: [], events: []), changes: [
            Entity(id: "nb", kind: .notebook, notebookId: "nb", parentId: "", data: .object(["title": .string("Maths")]),
                   hlc: "1000000000000-0000-web", deleted: false, dirty: false),
            Entity(id: "s1", kind: .section, notebookId: "nb", parentId: "", data: .object([:]),
                   hlc: "1000000000000-0001-web", deleted: false, dirty: false),
            Entity(id: "k1", kind: .stroke, notebookId: "nb", parentId: "s1", data: .object(["pts": .array([])]),
                   hlc: "1000000000000-0002-web", deleted: false, dirty: false),
            Entity(id: "k2", kind: .stroke, notebookId: "nb", parentId: "s1", data: .object([:]),
                   hlc: "1000000000000-0003-web", deleted: true, dirty: false),
        ], cursor: 1)
        return db
    }

    @Test func getsOneEntityInTheDexieShape() throws {
        let db = try seeded()
        let row = try #require(StoreBridge.handle(["op": "get", "id": "k1"], db: db).result as? [String: Any])
        #expect(row["kind"] as? String == "stroke")
        #expect(row["parentId"] as? String == "s1")
        #expect(row["deleted"] as? Int == 0)
        #expect(row["dirty"] as? Int == 0)
        #expect(try StoreBridge.handle(["op": "get", "id": "missing"], db: db).result is NSNull)
    }

    @Test func listsLiveRowsByNotebookKindAndParent() throws {
        let db = try seeded()
        func ids(_ body: [String: Any]) throws -> [String] {
            try #require(StoreBridge.handle(body, db: db).result as? [[String: Any]]).compactMap { $0["id"] as? String }
        }
        #expect(try ids(["op": "list", "notebookId": "nb"]) == ["k1", "nb", "s1"])
        #expect(try ids(["op": "list", "notebookId": "nb", "kind": "stroke", "parentId": "s1"]) == ["k1"])
        #expect(try ids(["op": "list", "notebookId": "nb", "kind": "stroke", "includeDeleted": true]) == ["k1", "k2"])
        #expect(try ids(["op": "notebooks"]) == ["nb"])
    }

    @Test func putStampsAFreshClockAndMarksDirty() throws {
        let db = try seeded()
        let (result, wrote) = try StoreBridge.handle(["op": "put", "entities": [
            ["id": "k3", "kind": "stroke", "notebookId": "nb", "parentId": "s1", "data": ["pts": [1, 2]],
             "hlc": "0000000000000-0000-old", "deleted": 0, "dirty": 1],
        ]], db: db)
        #expect(wrote)
        let row = try #require((result as? [[String: Any]])?.first)
        let hlc = try #require(row["hlc"] as? String)
        #expect(HLC.isNewer(hlc, than: "1000000000000-0003-web"))
        #expect(HLC.device(hlc) == db.device)
        #expect(row["dirty"] as? Int == 1)
        let stored = try #require(try db.writer.read { try Entity.fetchOne($0, key: "k3") })
        #expect(stored.dirty)
        #expect(stored.data == .object(["pts": .array([.int(1), .int(2)])]))
    }

    @Test func refusesBadRequests() throws {
        let db = try seeded()
        #expect(throws: StoreBridge.BridgeError.self) { try StoreBridge.handle(["id": "x"], db: db) }
        #expect(throws: StoreBridge.BridgeError.self) { try StoreBridge.handle(["op": "drop"], db: db) }
        #expect(throws: StoreBridge.BridgeError.self) { try StoreBridge.handle(["op": "put", "entities": [["kind": "nope"]]], db: db) }
        #expect(try StoreBridge.handle(["op": "put", "entities": []], db: db).wrote == false)
    }
}

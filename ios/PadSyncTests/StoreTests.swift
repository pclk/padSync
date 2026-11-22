import Foundation
import Testing
@testable import padSync

struct HLCTests {
    @Test func encodesLikeTheWebClock() {
        #expect(HLC.encode(wall: 1_732_000_000_000, counter: 7, device: "abc12345") == "1732000000000-0007-abc12345")
        #expect(HLC.decode("1732000000000-0007-abc12345")! == (1_732_000_000_000, 7))
        #expect(HLC.decode("garbage") == nil)
        #expect(HLC.device("1732000000000-0007-ab-cd") == "ab-cd")
    }

    @Test func staysMonotonicWithinAMillisecond() {
        let clock = HLC(device: "d", clock: { 1_000_000_000_000 })
        let a = clock.now(), b = clock.now()
        #expect(a == "1000000000000-0000-d")
        #expect(b == "1000000000000-0001-d")
        #expect(HLC.isNewer(b, than: a))
    }

    @Test func observingARemoteStampMovesPastIt() {
        let clock = HLC(device: "d", clock: { 1_000_000_000_000 })
        clock.observe("1000000005000-0003-other")
        #expect(clock.now() == "1000000005000-0004-d")
    }
}

struct JSONValueTests {
    @Test func keepsIntsDoublesAndBoolsApart() throws {
        let v = try JSONValue.parse(Data(#"{"a":1,"b":1.5,"c":true,"d":null,"e":[0,"x"],"t":1732000000000}"#.utf8))
        #expect(v["a"] == .int(1))
        #expect(v["b"] == .double(1.5))
        #expect(v["c"] == .bool(true))
        #expect(v["d"] == .null)
        #expect(v["e"] == .array([.int(0), .string("x")]))
        #expect(v["t"]?.int == 1_732_000_000_000)
        #expect(try JSONValue.parse(v.serialized()) == v)
    }
}

struct StoreTests {
    func stroke(_ id: String, hlc: String = "") -> Entity {
        Entity(id: id, kind: .stroke, notebookId: "nb", parentId: "s1", data: .object(["tool": .string("pen")]),
               hlc: hlc, deleted: false, dirty: false)
    }

    @Test func savingStampsAndMarksDirty() throws {
        let db = try AppDatabase.inMemory()
        let saved = try db.save([stroke("a")])
        #expect(saved[0].dirty)
        #expect(HLC.device(saved[0].hlc) == db.device)
        let batch = try db.pendingBatch(entityLimit: 100, eventLimit: 500)
        #expect(batch.entities.map(\.id) == ["a"])
        #expect(batch.since == 0)
    }

    @Test func acknowledgesOnlyWhatWasNotRewrittenInFlight() throws {
        let db = try AppDatabase.inMemory()
        try db.save([stroke("a"), stroke("b")])
        let batch = try db.pendingBatch(entityLimit: 100, eventLimit: 500)
        try db.save([stroke("b")]) // edited again while the request was out
        _ = try db.applySync(sent: batch, changes: [], cursor: 42)
        let left = try db.pendingBatch(entityLimit: 100, eventLimit: 500)
        #expect(left.entities.map(\.id) == ["b"])
        #expect(left.since == 42)
    }

    @Test func remoteRowsApplyOnlyWhenNewer() throws {
        let db = try AppDatabase.inMemory()
        let mine = try db.save([stroke("a")])[0]
        let older = stroke("a", hlc: "0000000000001-0000-zz")
        let newer = stroke("b", hlc: "9999999999999-0000-zz")
        let applied = try db.applySync(sent: .init(since: 0, entities: [], events: []), changes: [older, newer], cursor: 5)
        #expect(applied.map(\.id) == ["b"])
        let summary = try db.writer.read { try AppDatabase.notebookSummary($0, id: "nb") }
        #expect(summary.strokeCounts["s1"] == 2)
        // The clock moved past the remote stamp, so the next local write still wins.
        let next = try db.save([stroke("a")])[0]
        #expect(HLC.isNewer(next.hlc, than: newer.hlc))
        #expect(HLC.isNewer(next.hlc, than: mine.hlc))
    }
}

/// Answers /api/sync from a script and records what was sent.
final class StubTransport: SyncTransport, @unchecked Sendable {
    var responses: [(Int, [String: Any])]
    var sent: [[String: Any]] = []

    init(_ responses: [(Int, [String: Any])]) { self.responses = responses }

    func send(_ method: String, _ path: String, body: Data?) async throws -> (Data, Int) {
        guard path == "/api/sync" else { return (Data(), 404) }
        sent.append(try JSONSerialization.jsonObject(with: body!) as! [String: Any])
        let (code, json) = responses.isEmpty ? (200, ["changes": [], "cursor": 0, "more": false]) : responses.removeFirst()
        return (try JSONSerialization.data(withJSONObject: json), code)
    }
}

@MainActor
struct SyncEngineTests {
    @Test func pushesDirtyRowsAndAppliesThePull() async throws {
        let db = try AppDatabase.inMemory()
        try db.save([Entity(id: "a", kind: .stroke, notebookId: "nb", parentId: "s1", data: .object([:]), hlc: "", deleted: false, dirty: false)])
        let remote: [String: Any] = ["id": "s1", "kind": "section", "notebookId": "nb", "parentId": "",
                                     "data": ["order": 1, "blocks": []], "hlc": "9999999999999-0000-web", "deleted": 0]
        let transport = StubTransport([(200, ["changes": [remote], "cursor": 7, "more": false])])
        let engine = SyncEngine(db: db, transport: transport)

        #expect(try await engine.syncOnce() == false)
        #expect(engine.status == .synced)
        let sent = transport.sent[0]
        #expect(sent["since"] as? Int == 0)
        let change = (sent["changes"] as! [[String: Any]])[0]
        #expect(change["id"] as? String == "a")
        #expect(change["deleted"] as? Int == 0)
        #expect(change["dirty"] == nil)
        let after = try db.pendingBatch(entityLimit: 100, eventLimit: 500)
        #expect(after.entities.isEmpty)
        #expect(after.since == 7)
        let summary = try await db.writer.read { try AppDatabase.notebookSummary($0, id: "nb") }
        #expect(summary.sections.map(\.id) == ["s1"])
    }

    @Test func reportsSignedOutAndKeepsWrites() async throws {
        let db = try AppDatabase.inMemory()
        try db.save([Entity(id: "a", kind: .stroke, notebookId: "nb", parentId: "s1", data: .object([:]), hlc: "", deleted: false, dirty: false)])
        let engine = SyncEngine(db: db, transport: StubTransport([(401, ["error": "unauthorized"])]))
        #expect(try await engine.syncOnce() == false)
        #expect(engine.status == .needsLogin)
        #expect(try db.pendingBatch(entityLimit: 100, eventLimit: 500).entities.count == 1)
    }

    @Test func asksForAnotherRoundWhenTheServerHasMore() async throws {
        let db = try AppDatabase.inMemory()
        let engine = SyncEngine(db: db, transport: StubTransport([(200, ["changes": [], "cursor": 200, "more": true])]))
        #expect(try await engine.syncOnce() == true)
    }
}

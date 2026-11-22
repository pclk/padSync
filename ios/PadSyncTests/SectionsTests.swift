import Foundation
import Testing
@testable import padSync

struct SectionsTests {
    private func section(_ id: String, order: Double) -> Entity {
        Entity(id: id, kind: .section, notebookId: "n", parentId: "", data: .object(["order": .double(order), "template": .string("lines")]),
               hlc: "", deleted: false, dirty: false)
    }

    private var sorted: [Entity] { [section("a", order: 1), section("b", order: 2), section("c", order: 4)] }

    @Test func newSectionsGoHalfwayToTheNext() {
        #expect(Sections.order(Sections.newSection(notebookId: "n", after: sorted[0], sorted: sorted)) == 1.5)
        #expect(Sections.order(Sections.newSection(notebookId: "n", after: sorted[1], sorted: sorted)) == 3)
    }

    @Test func newSectionsAfterTheLastAddOne() {
        #expect(Sections.order(Sections.newSection(notebookId: "n", after: sorted[2], sorted: sorted)) == 5)
        // insertSectionAfter(nb, null, sorted) appends too.
        #expect(Sections.order(Sections.newSection(notebookId: "n", after: nil, sorted: sorted)) == 5)
        // The first section of an empty notebook: (0 + 2) / 2.
        #expect(Sections.order(Sections.newSection(notebookId: "n", after: nil, sorted: [])) == 1)
    }

    @Test func newSectionsMatchTheWebTemplate() {
        let s = Sections.newSection(notebookId: "n", after: nil, sorted: sorted, now: Date(timeIntervalSince1970: 1_700_000_000))
        #expect(s.kind == .section)
        #expect(s.notebookId == "n")
        #expect(s.parentId == "")
        #expect(!s.deleted)
        #expect(s.data["template"]?.string == "dots")
        #expect(s.data["minHeight"]?.double == 1032)
        #expect(s.data["blocks"] == .array([]))
        #expect(s.data["createdAt"]?.double == 1_700_000_000_000)
        // Exactly blankSection() plus order and createdAt.
        if case .object(let o) = s.data { #expect(Set(o.keys) == ["blocks", "template", "minHeight", "order", "createdAt"]) }
    }

    @Test func swappingExchangesOrdersAndKeepsTheRest() {
        let swapped = Sections.swapped(sorted[0], sorted[2])
        #expect(swapped.map(\.id) == ["a", "c"])
        #expect(Sections.order(swapped[0]) == 4)
        #expect(Sections.order(swapped[1]) == 1)
        #expect(swapped[0].data["template"]?.string == "lines")
    }

    @Test func theLastSectionCantBeDeleted() {
        #expect(!Sections.canDelete(count: 1))
        #expect(Sections.canDelete(count: 2))
    }

    @Test func deletingKeepsTheInk() throws {
        let db = try AppDatabase.inMemory()
        let stroke = Entity(id: "k1", kind: .stroke, notebookId: "n", parentId: "b", data: .object(["pts": .array([])]),
                            hlc: "", deleted: false, dirty: false)
        _ = try db.save(sorted + [stroke])
        _ = try db.save([Sections.setDeleted(sorted[1], true)])
        var summary = try db.writer.read { try AppDatabase.notebookSummary($0, id: "n") }
        #expect(summary.sections.map(\.id) == ["a", "c"])
        // The stroke row is untouched, so undo brings the page back with its ink.
        let ink = try db.writer.read { try Entity.fetchOne($0, key: "k1") }
        #expect(ink?.deleted == false)
        let deleted = try #require(try db.writer.read { try Entity.fetchOne($0, key: "b") })
        let restored = try db.save([Sections.setDeleted(deleted, false)])[0]
        #expect(restored.dirty)
        #expect(HLC.isNewer(restored.hlc, than: deleted.hlc))
        summary = try db.writer.read { try AppDatabase.notebookSummary($0, id: "n") }
        #expect(summary.sections.map(\.id) == ["a", "b", "c"])
        #expect(summary.strokeCounts["b"] == 1)
    }
}

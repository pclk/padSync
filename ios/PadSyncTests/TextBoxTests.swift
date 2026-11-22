import Foundation
import Testing
@testable import padSync

struct TextBoxTests {
    private func box(_ data: JSONValue) -> Entity {
        Entity(id: "t1", kind: .textbox, notebookId: "n", parentId: "s", data: data, hlc: "", deleted: false, dirty: false)
    }

    @Test func newBoxesMatchTheWebDefaults() {
        let d = TextBoxes.newData(x: 120, y: 340)
        #expect(d["x"]?.double == 120)
        #expect(d["y"]?.double == 340)
        #expect(d["w"]?.double == 420)
        #expect(d["text"]?.string == "")
        #expect(d["fontSize"]?.double == 20)
        #expect(d["color"]?.string == "#1f2937")
        // Exactly the web's TextBoxData fields.
        if case .object(let o) = d { #expect(Set(o.keys) == ["x", "y", "w", "text", "fontSize", "color"]) }
    }

    @Test func movingKeepsOtherFields() {
        var d = TextBoxes.newData(x: 10, y: 20)
        d["text"] = .string("hi")
        d["extra"] = .bool(true)
        let m = TextBoxes.moved(d, dx: 5.5, dy: -20)
        #expect(m["x"]?.double == 15.5)
        #expect(m["y"]?.double == 0)
        #expect(m["text"]?.string == "hi")
        #expect(m["extra"] == .bool(true))
    }

    @Test func resizingClampsToTheMinimumAndThePageEdge() {
        let d = TextBoxes.newData(x: 1000, y: 0)
        #expect(TextBoxes.resized(d, width: 10)["w"]?.double == Double(TextBoxes.minWidth))
        #expect(TextBoxes.resized(d, width: 300.4)["w"]?.double == 300)
        #expect(TextBoxes.resized(d, width: 900)["w"]?.double == Double(SectionView.pageWidth - 1000))
    }

    @Test func blankTextDeletesTheBox() {
        let b = box(TextBoxes.newData(x: 0, y: 0))
        #expect(TextBoxes.edited(b, text: "  \n ").deleted)
        let e = TextBoxes.edited(b, text: "x = $1$")
        #expect(!e.deleted)
        #expect(e.data["text"]?.string == "x = $1$")
    }

    @Test func savedBoxesRoundTripThroughTheStore() throws {
        let db = try AppDatabase.inMemory()
        let saved = try db.save([box(TextBoxes.newData(x: 50, y: 60))])[0]
        #expect(saved.dirty)
        #expect(!saved.hlc.isEmpty)
        let read = try db.writer.read { try Entity.fetchOne($0, key: "t1") }
        #expect(read?.kind == .textbox)
        #expect(read?.parentId == "s")
        // Whole doubles come back as ints from JSON; the values are what matter.
        for key in ["x", "y", "w", "fontSize"] { #expect(read?.data[key]?.double == saved.data[key]?.double) }
        #expect(read?.data["color"]?.string == "#1f2937")
    }
}

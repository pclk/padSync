import PencilKit
import Testing
import UIKit
@testable import padSync

@MainActor
struct InkMergeTests {
    func row(_ id: String, _ hlc: String = "1", highlighter: Bool = false) -> InkMerge.Row {
        InkMerge.Row(id: id, hlc: hlc, highlighter: highlighter)
    }

    @Test func newStrokesAreAppendedInPaintOrder() {
        #expect(InkMerge.plan(current: ["a", "b"], known: ["a": "1", "b": "1"], rows: [row("a"), row("c"), row("b"), row("d")]) == .append(["c", "d"]))
        // Opening a section: everything is new.
        #expect(InkMerge.plan(current: [], known: [:], rows: [row("h", highlighter: true), row("a")]) == .append(["h", "a"]))
        #expect(InkMerge.plan(current: ["a"], known: ["a": "1"], rows: [row("a")]) == .none)
    }

    @Test func removedOrChangedStrokesRedraw() {
        // Deleted elsewhere.
        #expect(InkMerge.plan(current: ["a", "b"], known: ["a": "1", "b": "1"], rows: [row("a")]) == .redraw)
        // Moved or recoloured elsewhere: a newer clock.
        #expect(InkMerge.plan(current: ["a"], known: ["a": "1"], rows: [row("a", "2"), row("b")]) == .redraw)
        // A stroke on the canvas the store doesn't know.
        #expect(InkMerge.plan(current: ["a", nil], known: ["a": "1"], rows: [row("a")]) == .redraw)
    }

    @Test func aNewHighlighterUnderExistingInkRedraws() {
        #expect(InkMerge.plan(current: ["a"], known: ["a": "1"], rows: [row("h", highlighter: true), row("a")]) == .redraw)
        // Over highlighter only, appending keeps the order.
        #expect(InkMerge.plan(current: ["h"], known: ["h": "1"], rows: [row("h", highlighter: true), row("h2", highlighter: true), row("a")]) == .append(["h2", "a"]))
    }

    func stroke(_ t0: Int64) throws -> PKStroke {
        let data: JSONValue = .object([
            "tool": .string("pen"), "color": .string("#1d4ed8"), "size": .double(3.4), "input": .string("pen"), "t0": .int(t0),
            "pts": .array([10, 20, 0.5, 1.2, 0.5, 0, 30, 40, 0.5, 1.2, 0.5, 8].map(JSONValue.double)),
        ])
        return try #require(StrokeCodec.stroke(id: "s\(t0)", data: data))
    }

    /// The canvas's own undo step for a stroke the user drew still takes it back after a remote
    /// stroke is appended, and leaves the remote stroke; redo brings it back. After a redraw (a new
    /// drawing) the same step does nothing, which is why removals still lose undo. The step is made
    /// the way the canvas makes one (PencilKit's private `undoableAddNewStrokes:` and
    /// `registerWithUndoManager:target:selector:`), since the simulator can't draw.
    @Test(arguments: [true, false]) func undoSurvivesAnAppendedRemoteStroke(append: Bool) throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 800, height: 800))
        let vc = UIViewController()
        window.rootViewController = vc
        window.isHidden = false
        defer { window.isHidden = true }
        let canvas = PKCanvasView(frame: vc.view.bounds)
        vc.view.addSubview(canvas)
        canvas.becomeFirstResponder()
        let undo = try #require(window.undoManager)
        undo.removeAllActions()

        let a = try stroke(1), mine = try stroke(2), remote = try stroke(3)
        canvas.drawing = PKDrawing(strokes: [a])
        // The user draws `mine`: the canvas's drawing gains it and an undo step is registered.
        let live = try #require(canvas.value(forKey: "drawing") as? NSObject)
        let command = try #require(live.perform(NSSelectorFromString("undoableAddNewStrokes:"), with: [mine]).takeUnretainedValue() as? NSObject)
        typealias Register = @convention(c) (NSObject, Selector, UndoManager, AnyObject, Selector) -> Void
        let register = NSSelectorFromString("registerWithUndoManager:target:selector:")
        unsafeBitCast(try #require(command.method(for: register)), to: Register.self)(command, register, undo, canvas, NSSelectorFromString("performUndo:"))
        canvas.drawing = try #require(live as? PKDrawing)
        #expect(canvas.drawing.strokes.count == 2)

        // A stroke arrives from another device.
        var next = canvas.drawing
        if append {
            next.append(PKDrawing(strokes: [remote]))
        } else {
            next = PKDrawing(strokes: next.strokes + [remote])
        }
        canvas.drawing = next
        #expect(undo.canUndo)
        undo.undo()
        let keys = canvas.drawing.strokes.map(StrokeCodec.key)
        if append {
            #expect(keys == [StrokeCodec.key(a), StrokeCodec.key(remote)])
            undo.redo()
            #expect(canvas.drawing.strokes.count == 3)
        } else {
            #expect(keys.count == 3)
        }
    }

    /// The real section view: a remote stroke is appended to the same drawing, and a remote delete
    /// redraws without the stroke.
    @Test func sectionViewAppendsRemoteStrokesToTheSameDrawing() async throws {
        let db = try AppDatabase.inMemory()
        func strokeRow(_ id: String, _ t0: Int64) -> Entity {
            Entity(id: id, kind: .stroke, notebookId: "n", parentId: "s0",
                   data: .object(["tool": .string("pen"), "color": .string("#1d4ed8"), "size": .double(3.4), "input": .string("pen"), "t0": .int(t0),
                                  "pts": .array([10, 20, 0.5, 1.2, 0.5, 0, 30, 40, 0.5, 1.2, 0.5, 8].map(JSONValue.double))]),
                   hlc: "", deleted: false, dirty: false)
        }
        let section = Entity(id: "s0", kind: .section, notebookId: "n", parentId: "",
                             data: .object(["order": .double(0), "template": .string("lines"), "minHeight": .double(1032)]),
                             hlc: "", deleted: false, dirty: false)
        _ = try db.save([section, strokeRow("a", 1)])
        let vc = NotebookViewController(context: EditorContext(notebookId: "n", database: db, sync: SyncEngine(db: db)))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1376, height: 1032))
        window.rootViewController = vc
        window.isHidden = false
        defer { vc.stop(); window.isHidden = true }
        vc.view.layoutIfNeeded()

        func canvas() -> PKCanvasView? { vc.views["s0"]?.canvas }
        func waitFor(_ count: Int) async throws {
            for _ in 0..<150 where canvas()?.drawing.strokes.count != count { try await Task.sleep(for: .milliseconds(20)) }
            #expect(canvas()?.drawing.strokes.count == count)
        }
        func identity() -> NSUUID? { (canvas()?.drawing as NSObject?)?.value(forKey: "uuid") as? NSUUID }

        try await waitFor(1)
        let before = try #require(identity())
        _ = try db.save([strokeRow("b", 2)])
        try await waitFor(2)
        #expect(identity() == before)

        var gone = strokeRow("a", 1)
        gone.deleted = true
        _ = try db.save([gone])
        try await waitFor(1)
    }
}

import Foundation
import PencilKit
import Testing
@testable import padSync

@MainActor
struct ToolsTests {
    private func defaults() -> UserDefaults {
        let name = "ToolsTests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    private func inkItem(_ picker: PKToolPicker, _ id: String) -> PKToolPickerInkingItem? {
        picker.toolItems.first { $0.identifier == id } as? PKToolPickerInkingItem
    }

    @Test func freshPickerHasTheDefaultToolsAndHidesTheFingerToggle() {
        let picker = Tools.makePicker(state: Tools.State())
        #expect(picker.toolItems.map(\.identifier) == Tools.ids)
        #expect(picker.showsDrawingPolicyControls == false)
        #expect(picker.stateAutosaveName == Tools.autosaveName)
        let pen = inkItem(picker, "padsync.pen")
        #expect(pen?.inkingTool.color.hex == "#111827")
        #expect(abs((pen?.inkingTool.width ?? 0) - 2.2) < 0.01)
    }

    @Test func recordingSavesTheSelectionAndTheInkInUse() {
        var state = Tools.State()
        let tool = PKInkingTool(.fountainPen, color: UIColor(hex: "#16a34a")!, width: 6)
        state = Tools.recording(state, selected: "padsync.fountain", tool: tool)
        #expect(state.selected == "padsync.fountain")
        #expect(state.inks["padsync.fountain"] == Tools.Ink(color: "#16a34a", width: 6))

        // The eraser is remembered as the selection, without an ink; the ruler isn't a tool.
        state = Tools.recording(state, selected: Tools.eraserId, tool: PKEraserTool(.vector))
        #expect(state.selected == Tools.eraserId)
        #expect(state.inks.count == 1)
        #expect(Tools.recording(state, selected: Tools.rulerId, tool: nil) == state)
        // Unknown items and a tool of another type than the item change nothing.
        #expect(Tools.recording(state, selected: "other", tool: tool) == state)
        let mismatch = Tools.recording(state, selected: "padsync.pen", tool: tool)
        #expect(mismatch.selected == "padsync.pen")
        #expect(mismatch.inks["padsync.pen"] == nil)
    }

    @Test func savedStateComesBackAcrossLaunches() {
        let d = defaults()
        #expect(Tools.load(from: d) == Tools.State())
        var state = Tools.recording(Tools.State(), selected: "padsync.marker",
                                    tool: PKInkingTool(.marker, color: UIColor(hex: "#22c55e")!, width: 20))
        state = Tools.recording(state, selected: "padsync.pen", tool: PKInkingTool(.pen, color: UIColor(hex: "#7c3aed")!, width: 5))
        Tools.save(state, to: d)
        #expect(Tools.load(from: d) == state)

        let picker = Tools.makePicker(state: Tools.load(from: d))
        #expect(picker.selectedToolItemIdentifier == "padsync.pen")
        #expect(inkItem(picker, "padsync.pen")?.inkingTool.color.hex == "#7c3aed")
        #expect(abs((inkItem(picker, "padsync.pen")?.inkingTool.width ?? 0) - 5) < 0.01)
        #expect(inkItem(picker, "padsync.marker")?.inkingTool.color.hex == "#22c55e")
        #expect(inkItem(picker, "padsync.fountain")?.inkingTool.color.hex == "#1d4ed8")
    }

    @Test func badSavedValuesFallBackToTheDefaults() {
        let state = Tools.State(selected: "gone", inks: [
            "padsync.pen": Tools.Ink(color: "blue", width: 3),
            "padsync.monoline": Tools.Ink(color: "#000000", width: 10_000),
        ])
        let picker = Tools.makePicker(state: state)
        #expect(Tools.ids.contains(picker.selectedToolItemIdentifier))
        #expect(inkItem(picker, "padsync.pen")?.inkingTool.color.hex == "#111827")
        #expect(inkItem(picker, "padsync.monoline")?.inkingTool.color.hex == "#dc2626")

        let d = defaults()
        d.set(Data("not json".utf8), forKey: Tools.defaultsKey)
        #expect(Tools.load(from: d) == Tools.State())
    }

    @Test func contextSavesOnlyChanges() throws {
        let d = defaults()
        let picker = Tools.makePicker(state: Tools.State())
        let db = try AppDatabase.inMemory()
        let context = EditorContext(notebookId: "n", database: db, sync: SyncEngine(db: db), toolPicker: picker,
                                    toolState: Tools.State(), defaults: d)
        picker.selectedToolItemIdentifier = "padsync.pen"
        context.rememberTool(PKInkingTool(.pen, color: UIColor(hex: "#ef4444")!, width: 4))
        #expect(Tools.load(from: d) == Tools.State(selected: "padsync.pen", inks: ["padsync.pen": Tools.Ink(color: "#ef4444", width: 4)]))
        #expect(Tools.load(from: d) == context.toolState)
        // Nothing new: nothing written.
        d.removeObject(forKey: Tools.defaultsKey)
        context.rememberTool(PKInkingTool(.pen, color: UIColor(hex: "#ef4444")!, width: 4))
        #expect(d.data(forKey: Tools.defaultsKey) == nil)
    }

    @Test func fingersNeverDrawOnTheDeviceAndPencilGesturesLeaveTheTextTool() {
        #if targetEnvironment(simulator)
        #expect(Tools.drawingPolicy == .anyInput)
        #else
        #expect(Tools.drawingPolicy == .pencilOnly)
        #endif
        #expect(!Tools.leavesTextTool(for: .ignore))
        #expect(Tools.leavesTextTool(for: .switchEraser))
        #expect(Tools.leavesTextTool(for: .switchPrevious))
        #expect(Tools.leavesTextTool(for: .showContextualPalette))
    }
}

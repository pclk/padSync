import PencilKit
import UIKit

/// The notebook's tool picker, and the tool, colour and width it remembers across launches.
///
/// Items have fixed identifiers (the eraser, lasso and ruler keep PencilKit's own), so a saved
/// selection finds its item again. The picker's own
/// `stateAutosaveName` is set too, but what it keeps for custom items isn't documented, so the
/// app also saves its own copy (`State`) in the defaults and builds the items from it.
@MainActor
enum Tools {
    struct Ink: Codable, Equatable {
        var color: String
        var width: CGFloat
    }

    struct State: Codable, Equatable {
        var selected: String?
        var inks: [String: Ink] = [:]
    }

    struct InkItem {
        let id: String
        let type: PKInkingTool.InkType
        let ink: Ink
    }

    static let autosaveName = "padsync.notebook.tools"
    static let defaultsKey = "padsync.notebook.toolState"
    static let eraserId = PKToolPickerEraserItem(type: .vector).identifier
    static let lassoId = PKToolPickerLassoItem().identifier
    static let rulerId = PKToolPickerRulerItem().identifier

    /// Pen, fountain pen (barrel roll shapes the nib), monoline and highlighter.
    static let inkItems: [InkItem] = [
        InkItem(id: "padsync.pen", type: .pen, ink: Ink(color: "#111827", width: 2.2)),
        InkItem(id: "padsync.fountain", type: .fountainPen, ink: Ink(color: "#1d4ed8", width: PKInkingTool.InkType.fountainPen.defaultWidth)),
        InkItem(id: "padsync.monoline", type: .monoline, ink: Ink(color: "#dc2626", width: PKInkingTool.InkType.monoline.defaultWidth)),
        InkItem(id: "padsync.marker", type: .marker, ink: Ink(color: "#facc15", width: PKInkingTool.InkType.marker.defaultWidth)),
    ]

    static var ids: [String] { inkItems.map(\.id) + [eraserId, lassoId, rulerId] }

    /// The ink an item starts with: the saved one if it's valid, else the default.
    static func ink(for item: InkItem, in state: State) -> Ink {
        guard let saved = state.inks[item.id], UIColor(hex: saved.color) != nil,
              saved.width.isFinite, item.type.validWidthRange.contains(saved.width) else { return item.ink }
        return saved
    }

    /// The picker, with the saved inks and selection. Whole-stroke eraser only: strokes sync whole.
    static func makePicker(state: State) -> PKToolPicker {
        var items: [PKToolPickerItem] = inkItems.map { item in
            let ink = ink(for: item, in: state)
            return PKToolPickerInkingItem(type: item.type, color: UIColor(hex: ink.color)!, width: ink.width, identifier: item.id)
        }
        items += [PKToolPickerEraserItem(type: .vector), PKToolPickerLassoItem(), PKToolPickerRulerItem()]
        let picker = PKToolPicker(toolItems: items)
        // Fingers always scroll (drawingPolicy .pencilOnly), so "draw with finger" would do nothing.
        picker.showsDrawingPolicyControls = false
        picker.stateAutosaveName = autosaveName
        if let selected = state.selected, ids.contains(selected), selected != rulerId {
            picker.selectedToolItemIdentifier = selected
        }
        return picker
    }

    /// Records the selected item, and the ink it draws with when it's an inking item. `tool` is the
    /// canvas's tool when a stroke starts, which carries colour and width changes made in the picker.
    static func recording(_ state: State, selected: String, tool: PKTool?) -> State {
        var state = state
        guard ids.contains(selected), selected != rulerId else { return state }
        state.selected = selected
        if let ink = tool as? PKInkingTool, let item = inkItems.first(where: { $0.id == selected }), ink.inkType == item.type {
            state.inks[selected] = Ink(color: ink.color.hex, width: ink.width)
        }
        return state
    }

    static func load(from defaults: UserDefaults = .standard) -> State {
        guard let data = defaults.data(forKey: defaultsKey), let state = try? JSONDecoder().decode(State.self, from: data) else { return State() }
        return state
    }

    static func save(_ state: State, to defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(state) { defaults.set(data, forKey: defaultsKey) }
    }

    /// Fingers scroll and never draw on the device; the simulator has no Pencil.
    static var drawingPolicy: PKCanvasViewDrawingPolicy {
        #if targetEnvironment(simulator)
        .anyInput
        #else
        .pencilOnly
        #endif
    }

    /// Whether a Pencil double tap or squeeze should leave the text tool and go back to ink. The
    /// tool picker handles both itself while it shows; with the text tool it's hidden, so the app
    /// answers any action the user set in Settings → Apple Pencil, except "ignore".
    static func leavesTextTool(for action: UIPencilPreferredAction) -> Bool {
        action != .ignore
    }
}

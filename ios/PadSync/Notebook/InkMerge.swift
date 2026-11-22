import PencilKit

/// Decides how a store change reaches a canvas without needlessly losing its undo history.
///
/// PencilKit's undo steps (`PKUndoCommand`) name the drawing they belong to by its UUID. Any new
/// `PKDrawing`, including one made by editing `strokes`, gets a fresh UUID, so a redraw leaves
/// every undo step for that canvas pointing at a drawing that's gone: the two-finger tap then
/// does nothing. `PKDrawing.append` merges into the same drawing (same UUID), so new strokes from
/// another device are appended and the undo steps keep working (InkMergeTests checks both).
/// Removing or changing a stroke has no such public path, so those still redraw. (Forcing the old
/// UUID onto a new drawing upsets PencilKit's replica bookkeeping and can crash, so don't.)
enum InkMerge {
    enum Plan: Equatable {
        /// The canvas already matches the store.
        case none
        /// Only new strokes: append these row ids, in this order, on top.
        case append([String])
        /// Something was removed or changed, or order would be wrong: rebuild the drawing.
        case redraw
    }

    struct Row: Equatable {
        let id: String
        let hlc: String
        let highlighter: Bool
    }

    /// `current` is the id of each canvas stroke, in canvas order (nil for one the store doesn't
    /// know), `known` the hlc each id had when drawn or read, and `rows` the store's live strokes
    /// in paint order (highlighter first, then by start time).
    static func plan(current: [String?], known: [String: String], rows: [Row]) -> Plan {
        let byId = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var onCanvas = Set<String>()
        var canvasHasInk = false
        for id in current {
            guard let id, let row = byId[id], known[id] == row.hlc, onCanvas.insert(id).inserted else { return .redraw }
            if !row.highlighter { canvasHasInk = true }
        }
        let new = rows.filter { !onCanvas.contains($0.id) }
        if new.isEmpty { return .none }
        // A highlighter appended on top would cover pen ink; the web paints highlighters first.
        if canvasHasInk && new.contains(where: \.highlighter) { return .redraw }
        return .append(new.map(\.id))
    }
}

import PencilKit
import UIKit

/// The web's tools (pen, highlighter, eraser, lasso, text), and the iPad's painter, on PencilKit canvases.
@MainActor
enum Tools {
    /// What a canvas draws with for the tool, or nil when the canvas takes no ink (lasso, text).
    static func canvasTool(for t: ToolState) -> PKTool? {
        switch t.kind {
        case .pen:
            return PKInkingTool(.pen, color: UIColor(hex: t.penColor) ?? .black,
                                width: CGFloat(StrokeCodec.pointSize(forWidth: t.penSize, marker: false)))
        case .highlighter:
            return PKInkingTool(.marker, color: UIColor(hex: t.hlColor) ?? .yellow,
                                width: CGFloat(StrokeCodec.pointSize(forWidth: t.hlSize, marker: true)))
        case .eraser:
            // Whole strokes only: strokes sync whole. The web's eraser size is its diameter.
            return PKEraserTool(.vector, width: CGFloat(t.eraserSize))
        case .painter, .lasso, .text:
            // The painter recolours strokes it touches (NotebookViewController's painter), it adds none.
            return nil
        }
    }

    /// Fingers scroll and never draw on the device; the simulator has no Pencil.
    static var drawingPolicy: PKCanvasViewDrawingPolicy {
        #if targetEnvironment(simulator)
        .anyInput
        #else
        .pencilOnly
        #endif
    }
}

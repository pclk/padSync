import UIKit

/// What a lasso for Ask AI caught: the section it was drawn on and the cropped picture.
struct AskCapture: Identifiable {
    let id = UUID()
    let notebookId: String
    let sectionId: String
    let sectionTitle: String?
    /// 0-based, as `AskSelection.markdown` takes it.
    let index: Int
    let pdf: (name: String, page: Int)?
    let png: Data
    let pixelSize: CGSize
}

/// A see-through layer over the notebook while Ask AI is on: one finger or Pencil stroke draws a
/// dashed loop, and lifting hands its points (in this view's coordinates) to `onFinish`.
/// PencilKit's own lasso has no public API for its selection, so Ask AI draws its own.
final class AskLassoView: UIView {
    var onFinish: ([CGPoint]) -> Void = { _ in }
    private var points: [CGPoint] = []
    private let shape = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor.systemBlue.withAlphaComponent(0.04)
        shape.strokeColor = UIColor.systemBlue.cgColor
        shape.fillColor = UIColor.systemBlue.withAlphaComponent(0.08).cgColor
        shape.lineWidth = 2
        shape.lineDashPattern = [6, 4]
        layer.addSublayer(shape)
        accessibilityLabel = "Draw around what to ask about"
    }

    required init?(coder: NSCoder) { fatalError() }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        points = touches.first.map { [$0.location(in: self)] } ?? []
        redraw()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first else { return }
        points += (event?.coalescedTouches(for: touch) ?? [touch]).map { $0.location(in: self) }
        redraw()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        let loop = points
        points = []
        redraw()
        if loop.count >= 3 { onFinish(loop) }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        points = []
        redraw()
    }

    private func redraw() {
        let path = UIBezierPath()
        if let first = points.first {
            path.move(to: first)
            points.dropFirst().forEach { path.addLine(to: $0) }
            path.close()
        }
        shape.path = path.cgPath
    }
}

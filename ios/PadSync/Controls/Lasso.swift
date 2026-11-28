import PencilKit
import UIKit

/// Which strokes a lasso picks: a port of `lassoStrokes` (src/ink/geometry.ts). "touch" takes any
/// stroke the lasso reaches (a point inside, or its line running over the ink); "enclose" only
/// those with at least half their points inside.
enum LassoGeometry {
    struct Shape {
        var points: [CGPoint]
        /// Line width, for how far "touch" reaches.
        var size: CGFloat
        var box: CGRect
    }

    /// Points closer than `step` to the last kept one dropped; the last always kept.
    static func thin(_ path: [CGPoint], step: CGFloat = 2) -> [CGPoint] {
        guard path.count >= 3 else { return path }
        var out = [path[0]]
        for p in path.dropFirst().dropLast() where hypot(p.x - out.last!.x, p.y - out.last!.y) >= step { out.append(p) }
        out.append(path[path.count - 1])
        return out
    }

    /// The pictures a loop picks (`lassoImages` in src/lib/page-images.ts): "touch" takes any it
    /// crosses or that holds it, "enclose" those whose centre it circles.
    static func pickImages(_ frames: [(id: String, frame: CGRect)], drawn: [CGPoint], mode: LassoSettings.Mode) -> [String] {
        let poly = thin(drawn)
        guard poly.count >= 3 else { return [] }
        return frames.filter { f in
            let r = f.frame
            if contains(poly, CGPoint(x: r.midX, y: r.midY)) { return true }
            guard mode == .touch else { return false }
            let corners = [r.origin, CGPoint(x: r.maxX, y: r.minY), CGPoint(x: r.maxX, y: r.maxY), CGPoint(x: r.minX, y: r.maxY)]
            return corners.contains { contains(poly, $0) } || poly.contains(where: r.contains)
        }.map(\.id)
    }

    static func contains(_ poly: [CGPoint], _ p: CGPoint) -> Bool {
        var inside = false
        var j = poly.count - 1
        for i in poly.indices {
            let a = poly[i], b = poly[j]
            if (a.y > p.y) != (b.y > p.y), p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x { inside.toggle() }
            j = i
        }
        return inside
    }

    private static func distSq(_ p: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = b.x - a.x, dy = b.y - a.y
        let len = dx * dx + dy * dy
        let t = len > 0 ? max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0
        let cx = a.x + t * dx - p.x, cy = a.y + t * dy - p.y
        return cx * cx + cy * cy
    }

    /// Whether the segment a→b crosses or comes within `r` of the polyline `pts`.
    static func segmentHits(_ pts: [CGPoint], _ a: CGPoint, _ b: CGPoint, radius r: CGFloat) -> Bool {
        let r2 = r * r
        let dx = b.x - a.x, dy = b.y - a.y
        for i in pts.indices {
            let p = pts[i], n = i + 1 < pts.count ? pts[i + 1] : pts[i]
            let sx = n.x - p.x, sy = n.y - p.y
            let cross = dx * sy - dy * sx
            let qx = p.x - a.x, qy = p.y - a.y
            if cross != 0 {
                let t = (qx * sy - qy * sx) / cross, u = (qx * dy - qy * dx) / cross
                if t >= 0, t <= 1, u >= 0, u <= 1 { return true }
            }
            if distSq(a, p, n) <= r2 || distSq(b, p, n) <= r2 || distSq(p, a, b) <= r2 || distSq(n, a, b) <= r2 { return true }
        }
        return false
    }

    /// Indexes of the shapes a lasso drawn along `drawn` (closed back to its start) selects.
    static func pick(_ shapes: [Shape], drawn: [CGPoint], mode: LassoSettings.Mode) -> [Int] {
        let poly = thin(drawn)
        guard poly.count >= 3 else { return [] }
        let bounds = poly.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: .zero)) }
        return shapes.indices.filter { i in
            let s = shapes[i]
            let reach = mode == .touch ? s.size / 2 : 0
            guard s.box.intersects(bounds.insetBy(dx: -reach - 0.5, dy: -reach - 0.5)), !s.points.isEmpty else { return false }
            let every = max(1, s.points.count / 24)
            var inside = 0, total = 0
            for j in Swift.stride(from: 0, to: s.points.count, by: every) {
                total += 1
                if contains(poly, s.points[j]) {
                    if mode == .touch { return true }
                    inside += 1
                }
            }
            if mode == .enclose { return total > 0 && Double(inside) / Double(total) >= 0.5 }
            for k in 1..<poly.count {
                let a = poly[k - 1], b = poly[k]
                let e = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
                guard e.insetBy(dx: -reach - 1, dy: -reach - 1).intersects(s.box) else { continue }
                if segmentHits(s.points, a, b, radius: reach) { return true }
            }
            return false
        }
    }

    /// A PencilKit stroke as the lasso sees it: its samples where they're drawn.
    static func shape(_ stroke: PKStroke) -> Shape {
        let pts = stroke.path.interpolatedPoints(by: .parametricStep(1)).map { $0.location.applying(stroke.transform) }
        let size = stroke.path.first.map { CGFloat(StrokeCodec.width(forPointSize: Double($0.size.width), marker: stroke.ink.inkType == .marker)) } ?? 2
        return Shape(points: pts, size: size, box: stroke.renderBounds)
    }
}

/// Selected ink: the section it's in, the strokes (by key, which a move or recolour keeps) and
/// their box in section coordinates.
struct InkSelection: Equatable {
    var sectionId: String
    var keys: Set<StrokeCodec.Key>
    var box: CGRect
    /// The rectangle a rectangle lasso drew (section coordinates): it stays selected with or
    /// without ink in it, and can be copied as a picture.
    var area: CGRect?
    /// The rectangle around what was drawn (the free lasso's loop, or the rectangle itself), in
    /// section coordinates: what Copy image takes and Crop keeps.
    var bounds: CGRect?
    /// Pictures on the page that are selected too (image entity ids).
    var images: Set<String> = []
}

/// Whether the lasso draws a rectangle instead of a free loop. This iPad only.
enum LassoShape {
    private static let key = "padsync.lassoRectangle"

    static var rectangle: Bool {
        get { UserDefaults.standard.bool(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    /// The lasso tool's icon for the current shape.
    static var symbol: String { rectangle ? "rectangle.dashed" : ToolKind.lasso.symbol }
}

/// The dashed box around a selection, inside its section, so it scrolls and zooms with the
/// page. Dragging it moves the ink (finger or Pencil).
@MainActor
final class SelectionBoxView: UIView {
    private let border = CAShapeLayer()
    var onDrag: (CGPoint, UIGestureRecognizer.State) -> Void = { _, _ in }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(hex: "#3b82f6")!.withAlphaComponent(0.06)
        border.strokeColor = UIColor(hex: "#3b82f6")!.cgColor
        border.fillColor = nil
        border.lineWidth = 1.5
        border.lineDashPattern = [6, 4]
        layer.addSublayer(border)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        border.path = UIBezierPath(rect: bounds).cgPath
    }

    @objc private func panned(_ g: UIPanGestureRecognizer) {
        onDrag(g.translation(in: superview), g.state)
    }
}

/// The control floating just above a selection (LassoCircle.tsx): with Ask AI shown, a pill of
/// Ask AI (its press fans out the prompts) and ⋯ for the other actions; otherwise one circle.
/// Like the toolbar circles: hold and drag towards an item, or tap to fan them out.
@MainActor
final class LassoCircleView: UIView {
    let ask = PressView()
    let edit = PressView()
    private let divider = UIView()
    private(set) var askWidth: CGFloat = 0
    private(set) var editWidth: CGFloat = 0

    init(settings: LassoSettings) {
        super.init(frame: .zero)
        let d = CGFloat(settings.size)
        let showsAsk = settings.visible.contains(.ask)
        let edits = settings.visible.filter { $0 != .ask }
        askWidth = showsAsk ? (d * 2.1).rounded() : 0
        editWidth = !edits.isEmpty || !showsAsk ? d : 0
        bounds = CGRect(x: 0, y: 0, width: askWidth + editWidth, height: d)
        backgroundColor = UIColor.white.withAlphaComponent(0.95)
        layer.cornerRadius = d / 2
        layer.borderWidth = 1
        layer.borderColor = UIColor(hex: "#bfdbfe")!.cgColor
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.16
        layer.shadowRadius = 10
        layer.shadowOffset = CGSize(width: 0, height: 4)
        overrideUserInterfaceStyle = .light

        if showsAsk {
            ask.frame = CGRect(x: 0, y: 0, width: askWidth, height: d)
            let icon = UIImageView(image: UIImage(systemName: "bubble.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: (d * 0.36).rounded(), weight: .semibold)))
            let label = UILabel()
            label.text = "Ask AI"
            label.font = .systemFont(ofSize: (d * 0.3).rounded(), weight: .semibold)
            let stack = UIStackView(arrangedSubviews: [icon, label])
            stack.spacing = 6
            stack.alignment = .center
            stack.isUserInteractionEnabled = false
            stack.tintColor = UIColor(hex: "#4338ca")
            label.textColor = UIColor(hex: "#4338ca")
            ask.addSubview(stack)
            stack.frame.size = stack.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
            stack.center = CGPoint(x: askWidth / 2, y: d / 2)
            ask.accessibilityLabel = "Ask AI about the selection"
            addSubview(ask)
        }
        if showsAsk && editWidth > 0 {
            divider.backgroundColor = UIColor(hex: "#dbeafe")
            divider.frame = CGRect(x: askWidth - 0.5, y: 10, width: 1, height: d - 20)
            addSubview(divider)
        }
        if editWidth > 0 {
            edit.frame = CGRect(x: askWidth, y: 0, width: editWidth, height: d)
            let icon = UIImageView(image: UIImage(systemName: showsAsk ? "ellipsis" : "lasso", withConfiguration: UIImage.SymbolConfiguration(pointSize: (d * 0.4).rounded(), weight: .semibold)))
            icon.tintColor = UIColor(hex: "#1d4ed8")
            icon.sizeToFit()
            icon.center = CGPoint(x: editWidth / 2, y: d / 2)
            edit.addSubview(icon)
            edit.accessibilityLabel = "Selection actions"
            addSubview(edit)
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Centres of each part in `view`, where their fans open.
    func askCenter(in view: UIView) -> CGPoint { convert(CGPoint(x: askWidth / 2, y: bounds.midY), to: view) }
    func editCenter(in view: UIView) -> CGPoint { convert(CGPoint(x: askWidth + editWidth / 2, y: bounds.midY), to: view) }
}

/// A view that hands its touches to a FanPress (the circles and the lasso pill), in the
/// coordinates of `space` (the overlay the fans are drawn in). The tap zone reaches 12 pt past it.
@MainActor
final class PressView: UIView {
    var press: FanPress?
    weak var space: UIView?
    /// Move mode: a drag carries the view along instead of opening its fan.
    var onMoveDrag: ((CGPoint, UIGestureRecognizer.State) -> Void)?
    private var dragStart: CGPoint?

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -12, dy: -12).contains(point)
    }

    private func loc(_ touches: Set<UITouch>) -> CGPoint? {
        touches.first.map { $0.location(in: space ?? superview) }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let p = loc(touches) else { return }
        if onMoveDrag != nil { dragStart = p; onMoveDrag?(.zero, .began); return }
        press?.began(at: p)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let p = loc(touches) else { return }
        if let s = dragStart { onMoveDrag?(CGPoint(x: p.x - s.x, y: p.y - s.y), .changed); return }
        press?.moved(to: p)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let p = loc(touches) else { return }
        if let s = dragStart {
            dragStart = nil
            onMoveDrag?(CGPoint(x: p.x - s.x, y: p.y - s.y), .ended)
            return
        }
        press?.ended(at: p)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        if dragStart != nil {
            dragStart = nil
            onMoveDrag?(.zero, .cancelled)
            return
        }
        press?.cancelled()
    }
}

/// The magnifier above the finger while it lassoes (lasso-lens.ts): a still picture of the page
/// taken as the lasso starts, scaled up around the finger, with the lasso drawn over it.
@MainActor
final class LassoLensView: UIView {
    private let content: UIView
    private let path = CAShapeLayer()
    private let zoom: CGFloat
    private let cross = UILabel()

    init(snapshot: UIView, size: CGFloat, zoom: CGFloat) {
        content = snapshot
        self.zoom = zoom
        super.init(frame: CGRect(x: 0, y: 0, width: size, height: size))
        isUserInteractionEnabled = false
        clipsToBounds = true
        layer.cornerRadius = size / 2
        layer.borderWidth = 2
        layer.borderColor = UIColor(hex: "#64748b")!.cgColor
        backgroundColor = .white
        content.layer.anchorPoint = .zero
        addSubview(content)
        path.strokeColor = UIColor(hex: "#3b82f6")!.cgColor
        path.fillColor = UIColor(hex: "#3b82f6")!.withAlphaComponent(0.08).cgColor
        path.lineWidth = 1.5
        path.lineDashPattern = [5, 3]
        layer.addSublayer(path)
        cross.text = "+"
        cross.textColor = UIColor(hex: "#1d4ed8")
        cross.font = .systemFont(ofSize: 18, weight: .bold)
        cross.sizeToFit()
        cross.center = CGPoint(x: size / 2, y: size / 2)
        addSubview(cross)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Centres the lens on `p` (overlay coordinates) and places it above the finger, or beside it
    /// near the top.
    func move(to p: CGPoint, loop: [CGPoint], in container: CGSize) {
        let size = bounds.width
        content.transform = CGAffineTransform(scaleX: zoom, y: zoom)
        content.layer.position = CGPoint(x: size / 2 - p.x * zoom, y: size / 2 - p.y * zoom)
        let t = CGAffineTransform(translationX: -p.x, y: -p.y).concatenating(CGAffineTransform(scaleX: zoom, y: zoom))
            .concatenating(CGAffineTransform(translationX: size / 2, y: size / 2))
        let bp = UIBezierPath()
        if let first = loop.first {
            bp.move(to: first.applying(t))
            loop.dropFirst().forEach { bp.addLine(to: $0.applying(t)) }
        }
        path.path = bp.cgPath
        let above = p.y >= size + 26
        let left = above ? p.x - size / 2 : p.x < container.width / 2 ? p.x + 26 : p.x - size - 26
        frame.origin = CGPoint(x: max(4, min(container.width - size - 4, left)),
                               y: max(4, min(container.height - size - 4, above ? p.y - size - 22 : p.y - size / 2)))
    }
}

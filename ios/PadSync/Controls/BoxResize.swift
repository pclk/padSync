import UIKit

/// Resizing a box by one of its eight handles (src/ink/resize.ts): a corner moves two edges, a
/// side one. The selection's resize and the image crop frame share it.
enum BoxHandle: String, CaseIterable {
    case nw, n, ne, e, se, s, sw, w

    var isCorner: Bool { rawValue.count == 2 }
    /// Where the handle sits on the box, as fractions of its width and height.
    var at: CGPoint {
        CGPoint(x: rawValue.contains("e") ? 1 : rawValue.contains("w") ? 0 : 0.5,
                y: rawValue.contains("s") ? 1 : rawValue.contains("n") ? 0 : 0.5)
    }
    fileprivate var sx: CGFloat { rawValue.contains("e") ? 1 : rawValue.contains("w") ? -1 : 0 }
    fileprivate var sy: CGFloat { rawValue.contains("s") ? 1 : rawValue.contains("n") ? -1 : 0 }
}

enum BoxResize {
    /// `b` resized by dragging `handle` by `d`. It never flips over: past the opposite edge it
    /// stops at `min`. With `keepRatio` the axis dragged further sets the scale (a side handle
    /// grows the other axis about the centre). It may not grow past `within`'s edges.
    static func resize(_ b: CGRect, _ handle: BoxHandle, by d: CGPoint, keepRatio: Bool = false, min: CGFloat = 1, within: CGRect? = nil) -> CGRect {
        let w = b.width, h = b.height
        let sx = handle.sx, sy = handle.sy
        func room(_ lo: CGFloat, _ hi: CGFloat, _ wlo: CGFloat, _ whi: CGFloat, _ s: CGFloat, _ size: CGFloat) -> CGFloat {
            let r = s == 0 ? 2 * Swift.min((lo + hi) / 2 - wlo, whi - (lo + hi) / 2) : s > 0 ? whi - lo : hi - wlo
            return Swift.max(r, size)
        }
        let maxW = within.map { room(b.minX, b.maxX, $0.minX, $0.maxX, sx, w) } ?? .infinity
        let maxH = within.map { room(b.minY, b.maxY, $0.minY, $0.maxY, sy, h) } ?? .infinity
        var nw = sx != 0 ? w + sx * d.x : w
        var nh = sy != 0 ? h + sy * d.y : h
        if keepRatio, w > 0, h > 0 {
            let kx = nw / w, ky = nh / h
            var k = sy == 0 ? kx : sx == 0 ? ky : abs(kx - 1) >= abs(ky - 1) ? kx : ky
            k = Swift.min(Swift.max(k, min / w, min / h), maxW / w, maxH / h)
            nw = w * k
            nh = h * k
        } else {
            nw = Swift.min(Swift.max(nw, Swift.min(min, w)), maxW)
            nh = Swift.min(Swift.max(nh, Swift.min(min, h)), maxH)
        }
        func place(_ lo: CGFloat, _ hi: CGFloat, _ size: CGFloat, _ s: CGFloat) -> CGFloat {
            s == 0 ? (lo + hi) / 2 - size / 2 : s > 0 ? lo : hi - size
        }
        return CGRect(x: place(b.minX, b.maxX, nw, sx), y: place(b.minY, b.maxY, nh, sy), width: nw, height: nh)
    }

    /// `b` moved by `d`, kept inside `within`.
    static func move(_ b: CGRect, by d: CGPoint, within: CGRect) -> CGRect {
        let mx = Swift.min(Swift.max(d.x, within.minX - b.minX), within.maxX - b.maxX)
        let my = Swift.min(Swift.max(d.y, within.minY - b.minY), within.maxY - b.maxY)
        return b.offsetBy(dx: mx, dy: my)
    }

    /// The transform taking `from` onto `to`.
    static func map(_ from: CGRect, to: CGRect) -> CGAffineTransform {
        let kx = from.width > 0 ? to.width / from.width : 1, ky = from.height > 0 ? to.height / from.height : 1
        return CGAffineTransform(translationX: -from.minX, y: -from.minY)
            .concatenating(CGAffineTransform(scaleX: kx, y: ky))
            .concatenating(CGAffineTransform(translationX: to.minX, y: to.minY))
    }
}

/// One handle on a box: a small white knob with a finger-sized hit area around it. It keeps its
/// size on screen whatever the zoom (`layOut`).
@MainActor
final class HandleView: UIView {
    let handle: BoxHandle
    private let knob = CAShapeLayer()
    var onPan: (BoxHandle, CGPoint, UIGestureRecognizer.State) -> Void = { _, _, _ in }

    /// Points on screen.
    static let hit: CGFloat = 44
    static let knobSize: CGFloat = 14

    init(_ handle: BoxHandle) {
        self.handle = handle
        super.init(frame: .zero)
        knob.fillColor = UIColor.white.cgColor
        knob.strokeColor = UIColor(hex: "#3b82f6")!.cgColor
        knob.shadowColor = UIColor.black.cgColor
        knob.shadowOpacity = 0.2
        knob.shadowRadius = 2
        knob.shadowOffset = CGSize(width: 0, height: 1)
        layer.addSublayer(knob)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)
        isAccessibilityElement = true
        accessibilityLabel = "Resize handle"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Centres the handle on its point of `box` (the superview's coordinates), `scale` being how
    /// many screen points one of those units is.
    func layOut(on box: CGRect, scale: CGFloat) {
        let s = Swift.max(scale, 0.01)
        let size = Self.hit / s, k = Self.knobSize / s
        frame = CGRect(x: box.minX + handle.at.x * box.width - size / 2, y: box.minY + handle.at.y * box.height - size / 2, width: size, height: size)
        knob.lineWidth = 2 / s
        knob.path = UIBezierPath(roundedRect: CGRect(x: (size - k) / 2, y: (size - k) / 2, width: k, height: k), cornerRadius: 3 / s).cgPath
    }

    @objc private func panned(_ g: UIPanGestureRecognizer) {
        onPan(handle, g.translation(in: superview?.superview), g.state)
    }

    override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        // The box's own pan (moving the selection, sliding the crop) leaves a handle's press be.
        if g.view !== self, g.view is SelectionBoxView || g.view is CropView { return false }
        return super.gestureRecognizerShouldBegin(g)
    }

    /// How many screen points one unit of `v` is (the scroll view's zoom, as `v` sees it).
    static func screenScale(of v: UIView) -> CGFloat {
        guard v.window != nil else { return 1 }
        return v.convert(CGRect(x: 0, y: 0, width: 100, height: 100), to: nil).width / 100
    }

    /// Where a pan on `v` was first pressed.
    static func pressedAt(_ g: UIGestureRecognizer, in v: UIView) -> CGPoint? {
        guard let pan = g as? UIPanGestureRecognizer else { return nil }
        let at = pan.location(in: v), d = pan.translation(in: v)
        return CGPoint(x: at.x - d.x, y: at.y - d.y)
    }

    /// Whether a shown handle covers `p`: its pan, not the box's, takes the press.
    static func any(_ handles: [HandleView], at p: CGPoint) -> Bool {
        handles.contains { !$0.isHidden && $0.frame.contains(p) }
    }

    /// Below this on screen a side's middle handle would crowd its corners, so only corners show.
    static func shows(_ h: BoxHandle, on box: CGRect, scale: CGFloat) -> Bool {
        h.isCorner || (h == .n || h == .s ? box.width : box.height) * scale >= 88
    }
}

/// Cropping one picture by dragging (CropFrame.tsx): placed over the picture in its section, it
/// dims what falls outside the frame kept. Drag a handle to move an edge, or inside to slide the
/// frame. Section units: the frame zooms with the page, its handles keep their size on screen.
@MainActor
final class CropView: UIView {
    /// The picture's frame and the part of it to keep (the section's coordinates).
    let image: CGRect
    private(set) var keep: CGRect
    var onChange: (CGRect) -> Void = { _ in }
    private let dim = CAShapeLayer()
    private let border = CAShapeLayer()
    private let grid = CAShapeLayer()
    private let handles = BoxHandle.allCases.map { HandleView($0) }
    private var start: CGRect?
    static let minSize: CGFloat = 8

    init(image: CGRect, keep: CGRect) {
        self.image = image
        self.keep = keep.intersection(image)
        super.init(frame: image)
        dim.fillRule = .evenOdd
        dim.fillColor = UIColor(red: 15 / 255, green: 23 / 255, blue: 42 / 255, alpha: 0.5).cgColor
        border.fillColor = nil
        border.strokeColor = UIColor(hex: "#3b82f6")!.cgColor
        grid.strokeColor = UIColor.white.withAlphaComponent(0.7).cgColor
        grid.isHidden = true
        for l in [dim, grid, border] { layer.addSublayer(l) }
        for h in handles {
            h.onPan = { [weak self] k, d, state in self?.resize(k, by: d, state: state) }
            addSubview(h)
        }
        let pan = UIPanGestureRecognizer(target: self, action: #selector(slid(_:)))
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)
        accessibilityLabel = "Crop frame"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func setKeep(_ r: CGRect) {
        keep = r
        setNeedsLayout()
        onChange(r)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let k = keep.offsetBy(dx: -image.minX, dy: -image.minY), scale = HandleView.screenScale(of: self)
        let s = Swift.max(scale, 0.01)
        let path = UIBezierPath(rect: bounds)
        path.append(UIBezierPath(rect: k))
        dim.path = path.cgPath
        border.path = UIBezierPath(rect: k).cgPath
        border.lineWidth = 2 / s
        let lines = UIBezierPath()
        for i in 1...2 {
            let x = k.minX + k.width * CGFloat(i) / 3, y = k.minY + k.height * CGFloat(i) / 3
            lines.move(to: CGPoint(x: x, y: k.minY)); lines.addLine(to: CGPoint(x: x, y: k.maxY))
            lines.move(to: CGPoint(x: k.minX, y: y)); lines.addLine(to: CGPoint(x: k.maxX, y: y))
        }
        grid.path = lines.cgPath
        grid.lineWidth = 1 / s
        for h in handles {
            h.isHidden = !HandleView.shows(h.handle, on: k, scale: scale)
            h.layOut(on: k, scale: scale)
        }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        super.point(inside: point, with: event) || handles.contains { !$0.isHidden && $0.frame.contains(point) }
    }

    override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        // Sliding starts only inside the frame and off its handles; the dimmed rest is just shown.
        guard g.view === self, let p = HandleView.pressedAt(g, in: self) else { return super.gestureRecognizerShouldBegin(g) }
        return keep.offsetBy(dx: -image.minX, dy: -image.minY).contains(p) && !HandleView.any(handles, at: p)
    }

    private func resize(_ h: BoxHandle, by d: CGPoint, state: UIGestureRecognizer.State) {
        track(state) { BoxResize.resize($0, h, by: d, min: Self.minSize, within: image) }
    }

    @objc private func slid(_ g: UIPanGestureRecognizer) {
        let d = g.translation(in: superview)
        track(g.state) { BoxResize.move($0, by: d, within: image) }
    }

    private func track(_ state: UIGestureRecognizer.State, _ next: (CGRect) -> CGRect) {
        switch state {
        case .began:
            start = keep
            grid.isHidden = false
        case .changed:
            if let start { setKeep(next(start)) }
        default:
            start = nil
            grid.isHidden = true
        }
    }
}

import UIKit

/// Apple Pencil Pro barrel roll turns a lasso selection: hover over the selection box and roll the
/// Pencil. The turn is the change in roll since the Pencil came over the box, in 5° steps, and
/// starts only past a small roll so holding the Pencil still doesn't nudge the ink.
enum BarrelRoll {
    static let threshold: CGFloat = 10 * .pi / 180
    static let step: CGFloat = 5 * .pi / 180
    /// The haptic detents: every 45°, the straight-again angle among them.
    static let detent: CGFloat = 45 * .pi / 180

    /// `roll` minus `base`, wrapped to −π…π so rolling past the seam doesn't jump a whole turn.
    static func delta(_ roll: CGFloat, from base: CGFloat) -> CGFloat {
        var d = (roll - base).truncatingRemainder(dividingBy: 2 * .pi)
        if d > .pi { d -= 2 * .pi }
        if d < -.pi { d += 2 * .pi }
        return d
    }

    static func angle(for delta: CGFloat) -> CGFloat {
        (delta / step).rounded() * step
    }

    static func isDetent(_ angle: CGFloat) -> Bool {
        abs(angle / detent - (angle / detent).rounded()) < 0.001
    }

    /// Turns about `center`, in the strokes' own (section) coordinates.
    static func rotation(_ angle: CGFloat, about center: CGPoint) -> CGAffineTransform {
        CGAffineTransform(translationX: -center.x, y: -center.y)
            .concatenating(CGAffineTransform(rotationAngle: angle))
            .concatenating(CGAffineTransform(translationX: center.x, y: center.y))
    }
}

/// Where the Pencil will land for tools PencilKit draws no preview for: the eraser's size, or a
/// small dashed ring for the lasso. Follows Settings → Apple Pencil → Show Hover Preview.
final class HoverRingView: UIView {
    private let ring = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isHidden = true
        ring.fillColor = UIColor.systemGray.withAlphaComponent(0.12).cgColor
        ring.strokeColor = UIColor.systemGray.cgColor
        ring.lineWidth = 1.5
        layer.addSublayer(ring)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// A ring, grey and see-through; or with `dot`, a small solid dot in that colour (the
    /// painter's tip, in its paint).
    func show(at p: CGPoint, diameter: CGFloat, dashed: Bool, dot: UIColor? = nil) {
        let d = dot == nil ? max(8, diameter) : diameter
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.strokeColor = (dot == nil ? UIColor.systemGray : UIColor.white.withAlphaComponent(0.9)).cgColor
        ring.fillColor = (dot ?? UIColor.systemGray.withAlphaComponent(0.12)).cgColor
        bounds = CGRect(x: 0, y: 0, width: d, height: d)
        center = p
        ring.frame = bounds
        ring.path = UIBezierPath(ovalIn: bounds.insetBy(dx: 0.75, dy: 0.75)).cgPath
        ring.lineDashPattern = dashed ? [4, 3] : nil
        CATransaction.commit()
        isHidden = false
    }

    func hide() { isHidden = true }
}

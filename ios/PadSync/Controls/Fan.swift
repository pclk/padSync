import UIKit

// The circle menus (tools, prompts, the lasso's actions): press and hold, the items fan out around
// the press, and the direction the finger then moves picks one. A port of src/lib/tool-circle.ts
// (geometry, in screen points and degrees: 0° right, 90° down) and src/components/RadialFan.tsx.

enum FanGeometry {
    static let radius: CGFloat = 96
    /// Finger travel below this picks nothing, so a wobble while holding doesn't choose.
    static let pickDeadZone: CGFloat = 28
    /// Hold this long without moving and the fan opens; letting go sooner is a tap.
    static let holdSeconds = 0.18
    /// A press that moves further than this has started a drag.
    static let dragSlop: CGFloat = 10
    /// Pointing further than this from every item (back towards the edge) picks nothing.
    static let pickMaxOff: CGFloat = 70

    private static let step: CGFloat = 45
    private static let itemArc: CGFloat = 62
    private static let ringMargin: CGFloat = 70

    private static func deg(_ r: CGFloat) -> CGFloat { r * 180 / .pi }
    private static func rad(_ d: CGFloat) -> CGFloat { d * .pi / 180 }

    /// Angles for `n` items over up to a half circle, facing the middle of the screen.
    static func angles(_ n: Int, center: CGPoint, viewport: CGSize) -> [CGFloat] {
        guard n > 0 else { return [] }
        let dir = deg(atan2(viewport.height / 2 - center.y, viewport.width / 2 - center.x))
        if n == 1 { return [dir] }
        let span = min(180, step * CGFloat(n - 1))
        return (0..<n).map { dir - span / 2 + CGFloat($0) * span / CGFloat(n - 1) }
    }

    /// A full ring with room on every side, else a fan facing the middle; the radius grows to fit.
    static func layout(_ n: Int, center: CGPoint, viewport: CGSize, top: CGFloat = 0) -> (angles: [CGFloat], radius: CGFloat) {
        guard n > 0 else { return ([], radius) }
        let ring = 360 / CGFloat(n)
        let ringRadius = max(radius, itemArc / rad(ring))
        let room = min(center.x, center.y - top, viewport.width - center.x, viewport.height - center.y)
        if n > 2, room >= ringRadius + ringMargin { return ((0..<n).map { -90 + CGFloat($0) * ring }, ringRadius) }
        let a = angles(n, center: center, viewport: viewport)
        let s = n > 1 ? abs(a[1] - a[0]) : 180
        return (a, max(radius, itemArc / rad(s)))
    }

    /// Where the item at `angle` is drawn, clamped `inset` inside the viewport.
    static func point(_ angle: CGFloat, center: CGPoint, viewport: CGSize, inset: CGFloat = 30, radius: CGFloat = radius) -> CGPoint {
        let x = center.x + radius * cos(rad(angle)), y = center.y + radius * sin(rad(angle))
        return CGPoint(x: min(viewport.width - inset, max(inset, x)), y: min(viewport.height - inset, max(inset, y)))
    }

    private static func between(_ a: CGFloat, _ b: CGFloat) -> CGFloat {
        abs(((((a - b).truncatingRemainder(dividingBy: 360)) + 540).truncatingRemainder(dividingBy: 360)) - 180)
    }

    /// The item the finger points at, or -1 inside the dead zone or pointing away from the fan.
    static func pick(_ angles: [CGFloat], dx: CGFloat, dy: CGFloat) -> Int {
        guard !angles.isEmpty, hypot(dx, dy) >= pickDeadZone else { return -1 }
        let a = deg(atan2(dy, dx))
        var best = 0
        for i in 1..<angles.count where between(a, angles[i]) < between(a, angles[best]) { best = i }
        return between(a, angles[best]) <= pickMaxOff ? best : -1
    }
}

struct FanItem: Equatable {
    var key: String
    var label: String
    var symbol: String
    var current = false
    /// Shown as a swatch of this colour instead of the icon (the lasso's colour fan).
    var color: String?
}

struct FanState: Equatable {
    var items: [FanItem]
    var angles: [CGFloat]
    var radius: CGFloat
    var center: CGPoint
    var viewport: CGSize
    var hot = -1
    /// Open to be tapped (let go without pointing, or opened by a tap).
    var sticky: Bool

    init(items: [FanItem], center: CGPoint, viewport: CGSize, sticky: Bool = false) {
        let l = FanGeometry.layout(items.count, center: center, viewport: viewport)
        self.items = items
        self.angles = l.angles
        self.radius = l.radius
        self.center = center
        self.viewport = viewport
        self.sticky = sticky
    }

    func pointing(dx: CGFloat, dy: CGFloat) -> FanState {
        var f = self
        f.hot = FanGeometry.pick(angles, dx: dx, dy: dy)
        return f
    }
}

/// The fanned-out items. While a finger points it only shows; once sticky its items can be tapped
/// and a press anywhere else closes it.
@MainActor
final class RadialFanView: UIView {
    private(set) var fan: FanState
    var onPick: (FanItem) -> Void = { _ in }
    var onClose: () -> Void = {}
    private let halo = UIView()
    private var buttons: [UIButton] = []
    private var labels: [UILabel] = []

    init(fan: FanState, frame: CGRect) {
        self.fan = fan
        super.init(frame: frame)
        halo.backgroundColor = UIColor(red: 15 / 255, green: 23 / 255, blue: 42 / 255, alpha: 0.05)
        halo.isUserInteractionEnabled = false
        addSubview(halo)
        for (i, item) in fan.items.enumerated() {
            let b = UIButton(type: .custom)
            b.bounds = CGRect(x: 0, y: 0, width: 52, height: 52)
            b.layer.cornerRadius = 26
            b.layer.shadowColor = UIColor.black.cgColor
            b.layer.shadowOpacity = 0.18
            b.layer.shadowRadius = 8
            b.layer.shadowOffset = CGSize(width: 0, height: 3)
            if let c = item.color.flatMap({ UIColor(hex: $0) }) {
                let swatch = UIView(frame: CGRect(x: 12, y: 12, width: 28, height: 28))
                swatch.backgroundColor = c
                swatch.layer.cornerRadius = 14
                swatch.layer.borderWidth = 1
                swatch.layer.borderColor = UIColor.black.withAlphaComponent(0.1).cgColor
                swatch.isUserInteractionEnabled = false
                b.addSubview(swatch)
            } else {
                b.setImage(UIImage(systemName: item.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .medium)), for: .normal)
            }
            b.accessibilityLabel = item.label
            b.addAction(UIAction { [weak self] _ in self?.tapped(i) }, for: .touchUpInside)
            addSubview(b)
            buttons.append(b)
            let l = PaddedLabel()
            l.text = item.label
            l.font = .systemFont(ofSize: 12, weight: .medium)
            l.layer.cornerRadius = 10
            l.layer.masksToBounds = true
            l.isUserInteractionEnabled = true
            l.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(labelTapped(_:))))
            l.tag = i
            addSubview(l)
            labels.append(l)
        }
        update(fan)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(_ next: FanState) {
        fan = next
        let r = fan.radius + 40
        halo.frame = CGRect(x: fan.center.x - r, y: fan.center.y - r, width: 2 * r, height: 2 * r)
        halo.layer.cornerRadius = r
        let accent = UIColor(hex: "#4f46e5")!
        for (i, item) in fan.items.enumerated() {
            let hot = i == fan.hot
            let b = buttons[i]
            b.center = FanGeometry.point(fan.angles[i], center: fan.center, viewport: fan.viewport, radius: fan.radius)
            b.transform = hot ? CGAffineTransform(scaleX: 1.15, y: 1.15) : .identity
            b.backgroundColor = hot ? accent : .white
            b.tintColor = hot ? .white : item.current ? accent : UIColor(hex: "#475569")
            b.layer.borderWidth = item.current && !hot ? 2 : 0
            b.layer.borderColor = accent.cgColor
            let l = labels[i]
            l.backgroundColor = hot ? accent : UIColor.white.withAlphaComponent(0.95)
            l.textColor = hot ? .white : UIColor(hex: "#334155")
            let size = l.sizeThatFits(CGSize(width: 128, height: 20))
            l.bounds = CGRect(x: 0, y: 0, width: min(128, size.width), height: 20)
            l.center = FanGeometry.point(fan.angles[i], center: fan.center, viewport: fan.viewport, inset: 56, radius: fan.radius + 44)
        }
    }

    private func tapped(_ i: Int) {
        guard fan.sticky else { return }
        onPick(fan.items[i])
    }

    @objc private func labelTapped(_ g: UITapGestureRecognizer) {
        tapped(g.view?.tag ?? 0)
    }

    /// Pass-through while pointing; once sticky, items take taps and anything else closes it.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard fan.sticky else { return nil }
        for v in (buttons as [UIView]) + labels where v.frame.insetBy(dx: -6, dy: -6).contains(point) {
            return v
        }
        return nil
    }
}

/// A label with some padding on each side (the web's rounded label chips).
class PaddedLabel: UILabel {
    var insets = UIEdgeInsets(top: 2, left: 8, bottom: 2, right: 8)
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: insets)) }
    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let s = super.sizeThatFits(size)
        return CGSize(width: s.width + insets.left + insets.right, height: s.height + insets.top + insets.bottom)
    }
}

/// A press that opens a fan (`useFanPress`): held still for 180 ms or dragged past 10 pt. Moving
/// then points at an item and letting go picks it; letting go without moving leaves the fan open
/// to be tapped; letting go pointing back at the edge closes it. A quick tap calls `onTap`.
@MainActor
final class FanPress {
    /// Builds the fan to show, or nil (nothing to show).
    var open: () -> FanState? = { nil }
    var onPick: (FanItem) -> Void = { _ in }
    var onTap: () -> Void = {}
    /// Shows, updates or (nil) removes the fan on screen.
    var present: (FanState?) -> Void = { _ in }

    private(set) var fan: FanState?
    private var start: CGPoint?
    private var timer: Timer?
    private var wasOpen = false

    func setFan(_ f: FanState?) {
        fan = f
        present(f)
    }

    func close() { setFan(nil) }

    func began(at p: CGPoint) {
        guard start == nil else { return }
        wasOpen = fan != nil
        setFan(nil)
        start = p
        timer = Timer.scheduledTimer(withTimeInterval: FanGeometry.holdSeconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.openNow() }
        }
    }

    private func openNow() {
        guard fan == nil, let f = open() else { return }
        setFan(f)
    }

    func moved(to p: CGPoint) {
        guard let s = start else { return }
        let dx = p.x - s.x, dy = p.y - s.y
        if fan == nil, hypot(dx, dy) > FanGeometry.dragSlop {
            timer?.invalidate()
            openNow()
        }
        if let f = fan {
            let next = f.pointing(dx: dx, dy: dy)
            if next.hot != f.hot { setFan(next) }
        }
    }

    func ended(at p: CGPoint) {
        guard let s = start else { return }
        timer?.invalidate()
        start = nil
        guard var f = fan else {
            // A tap while the fan was open just closes it.
            if !wasOpen { onTap() }
            return
        }
        if f.hot >= 0 {
            let item = f.items[f.hot]
            setFan(nil)
            onPick(item)
        } else if hypot(p.x - s.x, p.y - s.y) <= FanGeometry.dragSlop {
            f.sticky = true
            setFan(f)
        } else {
            setFan(nil)
        }
    }

    func cancelled() {
        timer?.invalidate()
        start = nil
        if fan?.sticky != true { setFan(nil) }
    }
}

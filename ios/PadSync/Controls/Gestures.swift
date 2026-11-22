import UIKit

/// Where a gesture happened: the first finger and where it pressed.
struct GestureAt: Equatable {
    var id: ObjectIdentifier?
    var point: CGPoint
}

/// Turns finger touches into the web's gestures (`GestureRecognizer` in src/lib/touch-gestures.ts):
/// taps of two, three or four fingers, double taps, and a one-finger press and hold. Pure: fed
/// finger positions and times, with timers injected, so the tests drive it without UIKit.
@MainActor
final class GestureLogic {
    struct Finger {
        var id: ObjectIdentifier?
        var point: CGPoint
    }

    /// One of the timers the logic sets; `cancel` stops it.
    final class Handle {
        let cancel: () -> Void
        init(cancel: @escaping () -> Void) { self.cancel = cancel }
    }

    var emit: (GestureKind, GestureAt) -> Void = { _, _ in }
    var isBound: (GestureKind) -> Bool = { _ in false }
    var tuning: () -> GestureTuning = { GestureTuning() }
    /// A press and hold is counting down (true, at the finger) or stopped short of it (false).
    var onHold: (Bool, GestureAt) -> Void = { _, _ in }
    var onPageTap: () -> Void = {}
    var schedule: (TimeInterval, @escaping @MainActor () -> Void) -> Handle = { seconds, fn in
        let t = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in MainActor.assumeIsolated { fn() } }
        return Handle { t.invalidate() }
    }

    private final class Contact {
        var t0: TimeInterval
        var most = 0
        var moved = false
        var start: [ObjectIdentifier?: CGPoint] = [:]
        var first: GestureAt
        var onPage: Bool
        var pencil: Bool
        var held = false
        var holdTimer: Handle?

        init(t0: TimeInterval, first: GestureAt, onPage: Bool, pencil: Bool) {
            self.t0 = t0
            self.first = first
            self.onPage = onPage
            self.pencil = pencil
        }
    }

    private var contact: Contact?
    private var lastPencil = -TimeInterval.infinity
    private var pending: (n: Int, t: TimeInterval, at: GestureAt, timer: Handle?)?

    private func stopHold(_ c: Contact) {
        guard let t = c.holdTimer else { return }
        t.cancel()
        c.holdTimer = nil
        onHold(false, c.first)
    }

    /// The Pencil touched: one-finger gestures are off for a moment (a resting palm).
    func pencil(now: TimeInterval) {
        lastPencil = now
        if let c = contact {
            c.pencil = true
            stopHold(c)
        }
    }

    func start(_ fingers: [Finger], now: TimeInterval, onPage: Bool) {
        guard let f = fingers.first else { return }
        let t = tuning()
        if contact == nil {
            let c = Contact(t0: now, first: GestureAt(id: f.id, point: f.point), onPage: onPage, pencil: (now - lastPencil) * 1000 < t.pencilQuietMs)
            contact = c
            if fingers.count == 1, onPage, !c.pencil, isBound(.fingerHold) {
                c.holdTimer = schedule(t.holdMs / 1000) { [weak self, weak c] in
                    guard let self, let c else { return }
                    c.holdTimer = nil
                    guard self.contact === c, !c.moved, c.most == 1, !c.pencil else { return }
                    c.held = true
                    self.emit(.fingerHold, c.first)
                }
                onHold(true, c.first)
            }
        }
        guard let c = contact else { return }
        for f in fingers where c.start[f.id] == nil { c.start[f.id] = f.point }
        c.most = max(c.most, fingers.count)
        if c.most > 1 { stopHold(c) }
    }

    func move(_ fingers: [Finger]) {
        guard let c = contact, !c.moved, !c.held else { return }
        let slop = tuning().slop
        c.moved = fingers.contains { f in
            guard let s = c.start[f.id] else { return false }
            return hypot(f.point.x - s.x, f.point.y - s.y) > slop
        }
        if c.moved { stopHold(c) }
    }

    /// Call with the fingers still down after a lift; the contact ends when none are.
    func end(_ fingers: [Finger], now: TimeInterval) {
        guard let c = contact, fingers.isEmpty else { return }
        contact = nil
        stopHold(c)
        if c.held || c.moved || (now - c.t0) * 1000 >= tuning().tapMs { return }
        if c.most == 1 {
            if c.onPage && !c.pencil {
                onPageTap()
                tap(1, now: now, at: c.first, double: .fingerDoubleTap, single: nil)
            }
        } else if c.most == 2 {
            tap(2, now: now, at: c.first, double: .twoDoubleTap, single: .twoTap)
        } else {
            emit(c.most == 3 ? .threeTap : .fourTap, c.first)
        }
    }

    private func tap(_ n: Int, now: TimeInterval, at: GestureAt, double: GestureKind, single: GestureKind?) {
        let doubleMs = tuning().doubleMs
        if let p = pending, p.n == n, (now - p.t) * 1000 < doubleMs, hypot(at.point.x - p.at.point.x, at.point.y - p.at.point.y) < 40 {
            p.timer?.cancel()
            pending = nil
            emit(double, at)
            return
        }
        if pending != nil { flush() }
        guard isBound(double) else {
            if let single { emit(single, at) }
            return
        }
        let timer = schedule(doubleMs / 1000) { [weak self] in self?.flush() }
        pending = (n, now, at, timer)
    }

    private func flush() {
        guard let p = pending else { return }
        pending = nil
        p.timer?.cancel()
        if p.n == 2 { emit(.twoTap, p.at) }
    }

    /// Something else took this touch (a pinch started zooming): no longer a tap or a hold.
    func consume() {
        guard let c = contact else { return }
        c.moved = true
        stopHold(c)
    }

    func cancel() {
        if let c = contact { stopHold(c) }
        contact = nil
    }
}

/// Watches every touch on the notebook without taking any (it never recognises), feeding finger
/// touches to `GestureLogic` and telling it when the Pencil is down. While a finger is lassoing
/// after a press and hold, its moves go to `onLassoMove` instead.
@MainActor
final class TouchWatcher: UIGestureRecognizer, UIGestureRecognizerDelegate {
    let logic = GestureLogic()
    /// Whether a point (in the watcher's view) is on the page rather than a control.
    var isOnPage: (CGPoint) -> Bool = { _ in true }
    /// The finger that is drawing a lasso or pointing into a fan after a hold, if any.
    var heldFinger: UITouch?
    var onHeldMove: (UITouch, UIEvent) -> Void = { _, _ in }
    var onHeldEnd: (UITouch, Bool) -> Void = { _, _ in }
    private var fingers: [ObjectIdentifier: UITouch] = [:]

    init() {
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        delegate = self
    }

    /// A finger still down, by the id GestureLogic reports.
    func touch(_ id: ObjectIdentifier) -> UITouch? { fingers[id] }

    private func points(_ list: some Sequence<UITouch>) -> [GestureLogic.Finger] {
        list.map { GestureLogic.Finger(id: ObjectIdentifier($0), point: $0.location(in: view)) }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        let now = event.timestamp
        if touches.contains(where: { $0.type == .pencil }) { logic.pencil(now: now) }
        let direct = touches.filter { $0.type == .direct }
        guard !direct.isEmpty else { return }
        // A second finger while a held finger lassoes means a pinch or pan: drop the lasso.
        if let held = heldFinger {
            heldFinger = nil
            onHeldEnd(held, false)
        }
        for t in direct { fingers[ObjectIdentifier(t)] = t }
        let onPage = direct.allSatisfy { isOnPage($0.location(in: view)) }
        logic.start(points(fingers.values), now: now, onPage: onPage)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        if let held = heldFinger, touches.contains(held) {
            onHeldMove(held, event)
            return
        }
        let direct = touches.filter { $0.type == .direct }
        guard !direct.isEmpty else { return }
        logic.move(points(fingers.values))
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        if let held = heldFinger, touches.contains(held) {
            heldFinger = nil
            onHeldEnd(held, true)
        }
        lift(touches, now: event.timestamp)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        if let held = heldFinger, touches.contains(held) {
            heldFinger = nil
            onHeldEnd(held, false)
        }
        for t in touches { fingers[ObjectIdentifier(t)] = nil }
        if fingers.isEmpty { logic.cancel() }
    }

    private func lift(_ touches: Set<UITouch>, now: TimeInterval) {
        let direct = touches.filter { $0.type == .direct }
        guard !direct.isEmpty else { return }
        for t in direct { fingers[ObjectIdentifier(t)] = nil }
        logic.end(points(fingers.values), now: now)
    }

    override func reset() {
        super.reset()
        // UIKit resets after every touch sequence; the logic keeps its own state.
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

/// The ring that fills around a finger while a press and hold counts down, with what the hold
/// will do written above it (HoldRing in NotebookEditor.tsx).
@MainActor
final class HoldRingView: UIView {
    static let size: CGFloat = 88
    private let track = CAShapeLayer()
    private let fill = CAShapeLayer()
    private let label = PaddedLabel()

    override init(frame: CGRect) {
        super.init(frame: CGRect(x: 0, y: 0, width: Self.size, height: Self.size + 30))
        isUserInteractionEnabled = false
        let path = UIBezierPath(arcCenter: CGPoint(x: Self.size / 2, y: 30 + Self.size / 2), radius: Self.size / 2 - 4,
                                startAngle: -.pi / 2, endAngle: 1.5 * .pi, clockwise: true).cgPath
        for (l, color, width) in [(track, UIColor.black.withAlphaComponent(0.12), 6.0), (fill, UIColor(hex: "#4f46e5")!, 6.0)] {
            l.path = path
            l.fillColor = nil
            l.strokeColor = color.cgColor
            l.lineWidth = width
            l.lineCap = .round
            layer.addSublayer(l)
        }
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        label.textColor = .white
        label.backgroundColor = UIColor(hex: "#0f172a")!.withAlphaComponent(0.8)
        label.layer.cornerRadius = 10
        label.layer.masksToBounds = true
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func start(at p: CGPoint, label text: String, seconds: TimeInterval) {
        center = CGPoint(x: p.x, y: p.y - 15)
        label.text = text
        let s = label.sizeThatFits(CGSize(width: 200, height: 20))
        label.frame = CGRect(x: (Self.size - s.width) / 2, y: 0, width: s.width, height: 20)
        isHidden = false
        fill.removeAllAnimations()
        let a = CABasicAnimation(keyPath: "strokeEnd")
        a.fromValue = 0
        a.toValue = 1
        a.duration = seconds
        fill.strokeEnd = 1
        fill.add(a, forKey: "fill")
    }

    func stop() {
        isHidden = true
        fill.removeAllAnimations()
    }
}

/// A short note of what a gesture or action did, so a stray tap is noticed.
@MainActor
final class NoteView: PaddedLabel {
    private var hide: Task<Void, Never>?

    override init(frame: CGRect) {
        super.init(frame: frame)
        insets = UIEdgeInsets(top: 6, left: 14, bottom: 6, right: 14)
        font = .systemFont(ofSize: 14, weight: .semibold)
        textColor = .white
        backgroundColor = UIColor(hex: "#0f172a")!.withAlphaComponent(0.85)
        layer.cornerRadius = 16
        layer.masksToBounds = true
        isUserInteractionEnabled = false
        alpha = 0
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func show(_ text: String, seconds: TimeInterval = 0.9) {
        self.text = text
        let s = sizeThatFits(CGSize(width: 600, height: 40))
        bounds.size = CGSize(width: s.width, height: 32)
        if let sv = superview { center = CGPoint(x: sv.bounds.midX, y: sv.safeAreaInsets.top + 28) }
        alpha = 1
        hide?.cancel()
        hide = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            UIView.animate(withDuration: 0.2) { self?.alpha = 0 }
        }
    }
}

import UIKit

/// What the notebook gives the controls: its tool, history, prompts and page actions.
@MainActor
struct ControlsActions {
    var tool: () -> ToolState
    var setTool: (ToolState) -> Void
    var undo: () -> Void
    var redo: () -> Void
    var canUndo: () -> Bool
    var canRedo: () -> Bool
    var prompts: () -> [ChatPrompt]
    /// A prompt picked from the prompt circle or a gesture (not the lasso's Ask AI).
    var sendPrompt: (ChatPrompt) -> Void
    var close: () -> Void
    var syncStatus: () -> String
    var pageMenu: () -> UIMenu
}

/// Everything that floats over the page: the tool and prompt circles (ToolCircle.tsx), their
/// fans and panel, the hold ring, gesture notes, and the lasso's loop, lens and circle. Touches
/// that miss a control fall through to the page.
@MainActor
final class ControlsOverlay: UIView {
    let actions: ControlsActions
    private(set) var rail: RailLayout
    var onRailChange: (RailLayout) -> Void = { _ in }

    let toolCircle = PressView()
    let promptCircle = PressView()
    private let toolIcon = UIImageView()
    private let colorDot = UIView()
    private let toolPress = FanPress()
    private let promptPress = FanPress()
    private var fanViews: [ObjectIdentifier: RadialFanView] = [:]
    private var panel: CirclePanel?
    let holdRing = HoldRingView()
    let note = NoteView()
    let loop = CAShapeLayer()
    var lens: LassoLensView?
    var lassoCircle: LassoCircleView?
    private var arranging = false
    private let doneButton = UIButton(configuration: .filled())
    /// A sticky fan's press handler, to close it on a press elsewhere.
    private var stickyOwners: [FanPress] = []

    init(actions: ControlsActions, rail: RailLayout) {
        self.actions = actions
        self.rail = rail
        super.init(frame: .zero)
        overrideUserInterfaceStyle = .light

        loop.strokeColor = UIColor(hex: "#3b82f6")!.cgColor
        loop.fillColor = UIColor(hex: "#3b82f6")!.withAlphaComponent(0.06).cgColor
        loop.lineWidth = 1.5
        loop.lineDashPattern = [6, 4]
        layer.addSublayer(loop)

        for (v, d) in [(toolCircle, rail.diameter(.tools)), (promptCircle, rail.diameter(.prompts))] {
            v.bounds = CGRect(x: 0, y: 0, width: d, height: d)
            v.layer.cornerRadius = d / 2
            v.backgroundColor = UIColor.white.withAlphaComponent(0.92)
            v.layer.borderWidth = 1
            v.layer.borderColor = UIColor(hex: "#e2e8f0")!.cgColor
            v.layer.shadowColor = UIColor.black.cgColor
            v.layer.shadowOpacity = 0.16
            v.layer.shadowRadius = 10
            v.layer.shadowOffset = CGSize(width: 0, height: 4)
            v.space = self
            addSubview(v)
        }
        toolIcon.tintColor = UIColor(hex: "#1e293b")
        toolIcon.contentMode = .center
        toolCircle.addSubview(toolIcon)
        colorDot.layer.borderColor = UIColor.white.cgColor
        colorDot.layer.borderWidth = 2
        toolCircle.addSubview(colorDot)
        toolCircle.accessibilityLabel = "Tools: hold and drag to change tool, tap for colours and sizes"
        let promptIcon = UIImageView(image: UIImage(systemName: "bubble.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: (rail.diameter(.prompts) * 0.4).rounded(), weight: .medium)))
        promptIcon.tintColor = UIColor(hex: "#4338ca")
        promptIcon.sizeToFit()
        promptIcon.center = CGPoint(x: rail.diameter(.prompts) / 2, y: rail.diameter(.prompts) / 2)
        promptCircle.addSubview(promptIcon)
        promptCircle.accessibilityLabel = "Chat prompts: tap to choose, or hold and drag towards one"

        toolCircle.press = toolPress
        toolPress.open = { [weak self] in self?.toolFan(sticky: false) }
        toolPress.onPick = { [weak self] item in self?.pickTool(item.key) }
        toolPress.onTap = { [weak self] in self?.togglePanel() }
        toolPress.present = { [weak self] f in self?.show(f, for: self?.toolPress) }

        promptCircle.press = promptPress
        promptPress.open = { [weak self] in self?.promptFan(at: nil, sticky: false) }
        promptPress.onPick = { [weak self] item in self?.pickPrompt(item.key) }
        promptPress.onTap = { [weak self] in
            guard let self else { return }
            self.promptPress.setFan(self.promptPress.fan == nil ? self.promptFan(at: nil, sticky: true) : nil)
        }
        promptPress.present = { [weak self] f in self?.show(f, for: self?.promptPress) }

        holdRing.isHidden = true
        addSubview(holdRing)
        addSubview(note)

        var done = UIButton.Configuration.filled()
        done.title = "Done moving"
        done.cornerStyle = .capsule
        doneButton.configuration = done
        doneButton.isHidden = true
        doneButton.addAction(UIAction { [weak self] _ in self?.setArranging(false) }, for: .primaryActionTriggered)
        addSubview(doneButton)
        refreshTool()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: Layout

    func setRail(_ next: RailLayout) {
        let resized = next.size != rail.size
        rail = next
        if resized {
            // Sizes only change in the web settings; rebuild the circles' look on the next launch.
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        promptCircle.isHidden = !rail.showsPrompts
        placeCircles()
        let s = doneButton.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
        doneButton.frame = CGRect(x: (bounds.width - s.width) / 2, y: safeAreaInsets.top + 16, width: s.width, height: s.height)
        if let panel { panel.place(near: toolCircle, in: self) }
    }

    /// Docked circles share a strip along the dock edge, 12 pt apart; a moved one sits where it
    /// was put (its centre as fractions of the window).
    private func placeCircles() {
        let inset = safeAreaInsets
        var docked: [(PressView, CGFloat)] = []
        let order: [CircleKey] = rail.promptsFirst ? [.prompts, .tools] : [.tools, .prompts]
        for key in order {
            let v = key == .tools ? toolCircle : promptCircle
            if key == .prompts && !rail.showsPrompts { continue }
            if let at = rail.free[key] {
                v.center = CGPoint(x: at.x * bounds.width, y: at.y * bounds.height)
            } else {
                docked.append((v, rail.diameter(key)))
            }
        }
        guard !docked.isEmpty else { return }
        let gap: CGFloat = 12, pad: CGFloat = 12
        let length = docked.reduce(0) { $0 + $1.1 } + gap * CGFloat(docked.count - 1)
        let thickness = docked.map(\.1).max() ?? 0
        if rail.dock == .bottom {
            let y = bounds.height - inset.bottom - pad - thickness / 2
            var x: CGFloat = switch rail.align {
            case .start: inset.left + pad
            case .center: (bounds.width - length) / 2
            case .end: bounds.width - inset.right - pad - length
            }
            for (v, d) in docked {
                v.center = CGPoint(x: x + d / 2, y: y)
                x += d + gap
            }
        } else {
            let x = rail.dock == .left ? inset.left + pad + thickness / 2 : bounds.width - inset.right - pad - thickness / 2
            var y: CGFloat = switch rail.align {
            case .start: inset.top + pad + 8
            case .center: (bounds.height - length) / 2
            case .end: bounds.height - inset.bottom - pad - length
            }
            for (v, d) in docked {
                v.center = CGPoint(x: x, y: y + d / 2)
                y += d + gap
            }
        }
    }

    /// The tool circle's icon and colour dot follow the current tool.
    func refreshTool() {
        let tool = actions.tool()
        let d = rail.diameter(.tools)
        toolIcon.image = UIImage(systemName: tool.kind.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: (d * 0.4).rounded(), weight: .medium))
        toolIcon.frame = toolCircle.bounds
        let showDot = rail.showsColors && (tool.kind == .pen || tool.kind == .highlighter)
        colorDot.isHidden = !showDot
        colorDot.backgroundColor = UIColor(hex: tool.color)
        let dot = d / 5
        colorDot.frame = CGRect(x: d - d / 10 - dot, y: d - d / 10 - dot, width: dot, height: dot)
        colorDot.layer.cornerRadius = dot / 2
        panel?.refresh()
    }

    // MARK: Fans

    private func toolFan(sticky: Bool) -> FanState? {
        closePanel()
        let current = actions.tool().kind
        let items = rail.tools.map { FanItem(key: $0.rawValue, label: $0.label, symbol: $0.symbol, current: $0 == current) }
        return FanState(items: items, center: toolCircle.center, viewport: bounds.size, sticky: sticky)
    }

    /// The prompts around `at` (a gesture) or the prompt circle.
    func promptFan(at point: CGPoint?, sticky: Bool) -> FanState? {
        closePanel()
        let prompts = actions.prompts()
        guard !prompts.isEmpty else {
            note.show("No prompts: add some in the web app's toolbar settings → Prompts", seconds: 2)
            return nil
        }
        let items = prompts.map { FanItem(key: $0.id, label: $0.label, symbol: $0.symbol) }
        return FanState(items: items, center: point ?? promptCircle.center, viewport: bounds.size, sticky: sticky)
    }

    private func pickTool(_ key: String) {
        guard let kind = ToolKind(rawValue: key) else { return }
        var t = actions.tool()
        t.kind = kind
        actions.setTool(t)
    }

    private func pickPrompt(_ id: String) {
        if let p = actions.prompts().first(where: { $0.id == id }) { actions.sendPrompt(p) }
    }

    /// Shows, updates or removes the fan that belongs to `owner`.
    func show(_ fan: FanState?, for owner: FanPress?) {
        guard let owner else { return }
        let key = ObjectIdentifier(owner)
        stickyOwners.removeAll { $0 === owner }
        guard let fan else {
            fanViews.removeValue(forKey: key)?.removeFromSuperview()
            return
        }
        if fan.sticky { stickyOwners.append(owner) }
        if let v = fanViews[key] {
            v.update(fan)
        } else {
            // One fan at a time.
            for other in stickyOwners where other !== owner { other.close() }
            for (k, v) in fanViews where k != key { v.removeFromSuperview(); fanViews[k] = nil }
            let v = RadialFanView(fan: fan, frame: bounds)
            v.onPick = { [weak owner] item in
                owner?.close()
                owner?.onPick(item)
            }
            insertSubview(v, belowSubview: note)
            fanViews[key] = v
        }
    }

    func closeFans() {
        for owner in stickyOwners { owner.close() }
        stickyOwners.removeAll()
        for v in fanViews.values { v.removeFromSuperview() }
        fanViews.removeAll()
    }

    // MARK: Panel

    private func togglePanel() {
        if panel != nil { return closePanel() }
        closeFans()
        let p = CirclePanel(actions: actions, rail: rail)
        p.onClose = { [weak self] in self?.closePanel() }
        p.onArrange = { [weak self] in
            self?.closePanel()
            self?.setArranging(true)
        }
        p.onToolChange = { [weak self] in self?.refreshTool() }
        addSubview(p)
        p.place(near: toolCircle, in: self)
        panel = p
    }

    func closePanel() {
        panel?.removeFromSuperview()
        panel = nil
    }

    // MARK: Moving the circles

    private func setArranging(_ on: Bool) {
        arranging = on
        doneButton.isHidden = !on
        for (key, v) in [(CircleKey.tools, toolCircle), (.prompts, promptCircle)] {
            v.layer.borderColor = on ? UIColor(hex: "#4f46e5")!.cgColor : UIColor(hex: "#e2e8f0")!.cgColor
            v.layer.borderWidth = on ? 2 : 1
            v.onMoveDrag = on ? { [weak self, weak v] delta, state in
                guard let self, let v else { return }
                switch state {
                case .changed, .began:
                    v.transform = CGAffineTransform(translationX: delta.x, y: delta.y)
                case .ended:
                    v.transform = .identity
                    let c = CGPoint(x: v.center.x + delta.x, y: v.center.y + delta.y)
                    var next = self.rail
                    next.free[key] = RailLayout.clampPlace(CGPoint(x: c.x / self.bounds.width, y: c.y / self.bounds.height))
                    self.rail = next
                    self.onRailChange(next)
                    self.setNeedsLayout()
                default:
                    v.transform = .identity
                }
            } : nil
        }
        if on { note.show("Drag the circles where you want them", seconds: 2) }
    }

    // MARK: Touches

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        let control = hit === self ? nil : hit
        // A press outside an open fan or the panel closes it; the press still goes on to the page.
        if event?.type == .touches, !stickyOwners.isEmpty || panel != nil {
            let kept = control.map { c in
                c is PressView || c.superview is PressView || c is RadialFanView || c.superview is RadialFanView
                    || panel.map { c.isDescendant(of: $0) } == true
            } ?? false
            if !kept {
                DispatchQueue.main.async { [weak self] in
                    self?.closeFans()
                    self?.closePanel()
                }
            }
        }
        return control
    }

    /// Whether a point is on the page rather than one of the controls (for gestures).
    func isOnPage(_ point: CGPoint) -> Bool {
        let hit = super.hitTest(point, with: nil)
        return hit == nil || hit === self
    }
}

/// Whether the Pencil's double tap and squeeze do anything in the notebook. This iPad only.
enum PencilGestures {
    private static let key = "padsync.pencilGestures"

    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: key) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
}

/// The current tool's colours and sizes, from a tap on the tool circle (CirclePanel in
/// ToolCircle.tsx), with undo, redo, the page menu, moving the circles and the way back to the
/// library (there's no top bar).
@MainActor
final class CirclePanel: UIView {
    private let actions: ControlsActions
    private let rail: RailLayout
    var onClose: () -> Void = {}
    var onArrange: () -> Void = {}
    var onToolChange: () -> Void = {}
    private let stack = UIStackView()
    private let title = UILabel()
    private let swatches = UIStackView()
    private let sizes = UIStackView()
    private let undo = UIButton(type: .system)
    private let redo = UIButton(type: .system)
    private let status = UILabel()

    init(actions: ControlsActions, rail: RailLayout) {
        self.actions = actions
        self.rail = rail
        super.init(frame: .zero)
        overrideUserInterfaceStyle = .light
        backgroundColor = .white
        layer.cornerRadius = 16
        layer.borderWidth = 1
        layer.borderColor = UIColor(hex: "#e2e8f0")!.cgColor
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.18
        layer.shadowRadius = 16
        layer.shadowOffset = CGSize(width: 0, height: 6)

        stack.axis = .vertical
        stack.spacing = 8
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 10, left: 10, bottom: 8, right: 10)
        addSubview(stack)

        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.textColor = UIColor(hex: "#0f172a")
        stack.addArrangedSubview(title)
        swatches.spacing = 0
        swatches.distribution = .fillEqually
        stack.addArrangedSubview(swatches)
        sizes.spacing = 4
        sizes.alignment = .center
        stack.addArrangedSubview(sizes)

        let line = UIView()
        line.backgroundColor = UIColor(hex: "#f1f5f9")
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        stack.addArrangedSubview(line)

        let row = UIStackView()
        row.spacing = 2
        row.alignment = .center
        for (b, symbol, label, action) in [(undo, "arrow.uturn.backward", "Undo", actions.undo), (redo, "arrow.uturn.forward", "Redo", actions.redo)] {
            b.setImage(UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18)), for: .normal)
            b.accessibilityLabel = label
            b.addAction(UIAction { [weak self] _ in
                action()
                self?.refresh()
            }, for: .primaryActionTriggered)
            b.widthAnchor.constraint(equalToConstant: 44).isActive = true
            b.heightAnchor.constraint(equalToConstant: 44).isActive = true
            row.addArrangedSubview(b)
        }
        row.addArrangedSubview(UIView())
        let page = UIButton(type: .system)
        page.setImage(UIImage(systemName: "rectangle.stack", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18)), for: .normal)
        page.accessibilityLabel = "Page menu"
        page.menu = actions.pageMenu()
        page.showsMenuAsPrimaryAction = true
        let move = UIButton(type: .system)
        move.setImage(UIImage(systemName: "arrow.up.and.down.and.arrow.left.and.right", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17)), for: .normal)
        move.accessibilityLabel = "Move the circles"
        move.addAction(UIAction { [weak self] _ in self?.onArrange() }, for: .primaryActionTriggered)
        for b in [page, move] {
            b.widthAnchor.constraint(equalToConstant: 44).isActive = true
            b.heightAnchor.constraint(equalToConstant: 44).isActive = true
            row.addArrangedSubview(b)
        }
        stack.addArrangedSubview(row)

        let gestures = UIStackView()
        gestures.alignment = .center
        gestures.spacing = 8
        let gesturesLabel = UILabel()
        gesturesLabel.text = "Pencil double tap and squeeze"
        gesturesLabel.font = .systemFont(ofSize: 13, weight: .medium)
        gesturesLabel.textColor = UIColor(hex: "#334155")
        gesturesLabel.numberOfLines = 2
        let toggle = UISwitch()
        toggle.isOn = PencilGestures.enabled
        toggle.accessibilityLabel = "Pencil double tap and squeeze"
        toggle.addAction(UIAction { [weak toggle] _ in PencilGestures.enabled = toggle?.isOn ?? true }, for: .valueChanged)
        gestures.addArrangedSubview(gesturesLabel)
        gestures.addArrangedSubview(toggle)
        gestures.isLayoutMarginsRelativeArrangement = true
        gestures.layoutMargins = UIEdgeInsets(top: 0, left: 6, bottom: 0, right: 2)
        stack.addArrangedSubview(gestures)

        let footer = UIStackView()
        footer.alignment = .center
        var back = UIButton.Configuration.plain()
        back.title = "Library"
        back.image = UIImage(systemName: "chevron.left")
        back.imagePadding = 4
        back.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 4, bottom: 8, trailing: 8)
        let backButton = UIButton(configuration: back)
        backButton.addAction(UIAction { _ in actions.close() }, for: .primaryActionTriggered)
        footer.addArrangedSubview(backButton)
        footer.addArrangedSubview(UIView())
        status.font = .systemFont(ofSize: 12, weight: .medium)
        status.textColor = UIColor(hex: "#64748b")
        footer.addArrangedSubview(status)
        stack.addArrangedSubview(footer)
        refresh()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func refresh() {
        let tool = actions.tool()
        title.text = tool.kind.label
        swatches.arrangedSubviews.forEach { $0.removeFromSuperview() }
        sizes.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let colors = rail.showsColors ? tool.colors : []
        swatches.isHidden = colors.isEmpty
        for c in colors {
            let b = UIButton(type: .custom)
            let dot = UIView()
            dot.isUserInteractionEnabled = false
            dot.backgroundColor = UIColor(hex: c)
            dot.layer.cornerRadius = 16
            dot.layer.borderWidth = tool.color == c ? 3 : 1
            dot.layer.borderColor = (tool.color == c ? UIColor(hex: "#94a3b8")! : UIColor.black.withAlphaComponent(0.1)).cgColor
            b.addSubview(dot)
            dot.frame = CGRect(x: 6, y: 6, width: 32, height: 32)
            b.heightAnchor.constraint(equalToConstant: 44).isActive = true
            b.accessibilityLabel = ToolState.penColorNames[c] ?? c
            b.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                var t = self.actions.tool()
                t.setColor(c)
                self.actions.setTool(t)
                self.refresh()
                self.onToolChange()
            }, for: .primaryActionTriggered)
            swatches.addArrangedSubview(b)
        }
        let list = rail.showsSizes ? tool.sizes : []
        sizes.isHidden = list.isEmpty
        for (i, s) in list.enumerated() {
            let b = UIButton(type: .custom)
            b.layer.cornerRadius = 10
            b.backgroundColor = tool.size == s ? UIColor(hex: "#f1f5f9") : .clear
            b.layer.borderWidth = tool.size == s ? 1 : 0
            b.layer.borderColor = UIColor(hex: "#cbd5e1")!.cgColor
            let dot = UIView()
            dot.isUserInteractionEnabled = false
            let w = CGFloat(4 + i * 5)
            dot.backgroundColor = UIColor(hex: "#334155")
            dot.layer.cornerRadius = w / 2
            dot.frame = CGRect(x: 22 - w / 2, y: 22 - w / 2, width: w, height: w)
            b.addSubview(dot)
            b.widthAnchor.constraint(equalToConstant: 44).isActive = true
            b.heightAnchor.constraint(equalToConstant: 44).isActive = true
            b.accessibilityLabel = "Size \(i + 1)"
            b.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                var t = self.actions.tool()
                t.setSize(s)
                self.actions.setTool(t)
                self.refresh()
                self.onToolChange()
            }, for: .primaryActionTriggered)
            sizes.addArrangedSubview(b)
        }
        undo.isEnabled = actions.canUndo()
        redo.isEnabled = actions.canRedo()
        status.text = actions.syncStatus()
    }

    /// Beside the circle, away from the nearer edge, kept on screen.
    func place(near circle: UIView, in container: UIView) {
        let width: CGFloat = 256
        let size = stack.systemLayoutSizeFitting(CGSize(width: width, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        let c = circle.center, r = circle.bounds.width / 2 + 16
        var x = c.x < container.bounds.midX ? c.x + r : c.x - r - width
        var y = c.y - size.height / 2
        if c.y > container.bounds.height - 120 { x = c.x - width / 2; y = c.y - r - size.height }
        let inset = container.safeAreaInsets
        x = max(inset.left + 8, min(container.bounds.width - inset.right - width - 8, x))
        y = max(inset.top + 8, min(container.bounds.height - inset.bottom - size.height - 8, y))
        frame = CGRect(x: x, y: y, width: width, height: size.height)
        stack.frame = bounds
    }
}

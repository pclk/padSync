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
    /// How much a section prompt sends.
    var sectionSpan: () -> SectionSpan
    var setSectionSpan: (SectionSpan) -> Void
    /// The wheel's lasso item: switches the held finger's lasso shape, keeping the Pencil's tool.
    var switchLassoShape: () -> Void
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
        let promptIcon = UIImageView(image: UIImage(systemName: "bubble.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: (rail.diameter(.prompts) * 0.4).rounded(), weight: .medium)))
        promptIcon.tintColor = UIColor(hex: "#4338ca")
        promptIcon.sizeToFit()
        promptIcon.center = CGPoint(x: rail.diameter(.prompts) / 2, y: rail.diameter(.prompts) / 2)
        promptCircle.addSubview(promptIcon)
        promptCircle.accessibilityLabel = "Chat prompts: tap to choose, or hold and drag towards one"

        toolCircle.press = toolPress
        toolPress.open = { [weak self] in
            guard let self else { return nil }
            return ToolCircleSwipe.colors ? self.colorFan() ?? self.toolFan(sticky: false) : self.toolFan(sticky: false)
        }
        toolPress.onPick = { [weak self] item in
            if item.color != nil { self?.pickColor(item.key) } else { self?.pickTool(item.key) }
        }
        toolPress.onTap = { [weak self] in
            guard let self else { return }
            if !ToolCircleSwipe.colors { return self.togglePanel() }
            self.toolPress.setFan(self.toolPress.fan == nil ? self.toolFan(sticky: true) : nil)
        }
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
        toolIcon.image = UIImage(systemName: tool.kind == .lasso ? LassoShape.symbol : tool.kind.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: (d * 0.4).rounded(), weight: .medium))
        toolIcon.frame = toolCircle.bounds
        toolCircle.accessibilityLabel = ToolCircleSwipe.colors
            ? "Tools: hold and drag towards a colour to change it, tap to choose a tool"
            : "Tools: hold and drag to change tool, tap for colours and sizes"
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
        // The lasso item shows the finger lasso's shape and switches it; it's never the Pencil's tool.
        var items = rail.tools.map { t in
            t == .lasso
                ? FanItem(key: t.rawValue, label: LassoShape.rectangle ? "Rectangle" : t.label, symbol: LassoShape.symbol)
                : FanItem(key: t.rawValue, label: t.label, symbol: t.symbol, current: t == current)
        }
        // A tap opens this fan instead of the panel, so the panel is one more item.
        if sticky && ToolCircleSwipe.colors {
            items.append(FanItem(key: Self.panelKey, label: "Sizes and more", symbol: "slider.horizontal.3"))
        }
        return FanState(items: items, center: toolCircle.center, viewport: bounds.size, sticky: sticky)
    }

    private static let panelKey = "panel"

    /// The current tool's colours, or nil when it has none to show.
    private func colorFan() -> FanState? {
        closePanel()
        let tool = actions.tool()
        guard rail.showsColors, !tool.colors.isEmpty else { return nil }
        let items = tool.colors.map { FanItem(key: $0, label: ToolState.penColorNames[$0] ?? $0, symbol: "circle.fill", current: $0 == tool.color, color: $0) }
        return FanState(items: items, center: toolCircle.center, viewport: bounds.size)
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

    private func pickColor(_ c: String) {
        var t = actions.tool()
        t.setColor(c)
        actions.setTool(t)
        refreshTool()
    }

    private func pickTool(_ key: String) {
        if key == Self.panelKey { return togglePanel() }
        guard let kind = ToolKind(rawValue: key) else { return }
        if kind == .lasso { return actions.switchLassoShape() }
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
        p.onRail = { [weak self] next in
            guard let self else { return }
            self.setRail(next)
            self.onRailChange(next)
            self.refreshTool()
        }
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

/// Whether dragging the tool circle picks a colour (and a tap opens the tools, the panel among
/// them) rather than a tool (and a tap opens the panel). This iPad only.
enum ToolCircleSwipe {
    private static let key = "padsync.toolCircleSwipeColors"

    static var colors: Bool {
        get { UserDefaults.standard.bool(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
}

/// The current tool's colours and sizes, from a tap on the tool circle (CirclePanel in
/// ToolCircle.tsx), with undo, redo, the page menu, moving the circles and the way back to the
/// library (there's no top bar).
@MainActor
final class CirclePanel: UIView {
    private let actions: ControlsActions
    private var rail: RailLayout
    /// The wheel's tools changed (Edit tools).
    var onRail: (RailLayout) -> Void = { _ in }
    private let toolsEditor = UIStackView()
    private let editToggle = UIButton(type: .system)
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

        for (text, isOn, set) in [
            ("Pencil double tap and squeeze", PencilGestures.enabled, { PencilGestures.enabled = $0 }),
            ("Swipe the tool circle for colours, tap it for tools", ToolCircleSwipe.colors, { ToolCircleSwipe.colors = $0 }),
        ] as [(String, Bool, (Bool) -> Void)] {
            let row = UIStackView()
            row.alignment = .center
            row.spacing = 8
            let label = UILabel()
            label.text = text
            label.font = .systemFont(ofSize: 13, weight: .medium)
            label.textColor = UIColor(hex: "#334155")
            label.numberOfLines = 0
            // The label wraps; the switch keeps its size.
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            label.setContentHuggingPriority(.defaultLow, for: .horizontal)
            let toggle = UISwitch()
            toggle.setContentCompressionResistancePriority(.required, for: .horizontal)
            toggle.setContentHuggingPriority(.required, for: .horizontal)
            toggle.isOn = isOn
            toggle.accessibilityLabel = text
            toggle.addAction(UIAction { [weak self, weak toggle] _ in
                set(toggle?.isOn ?? isOn)
                self?.onToolChange()
            }, for: .valueChanged)
            row.addArrangedSubview(label)
            row.addArrangedSubview(toggle)
            row.isLayoutMarginsRelativeArrangement = true
            row.layoutMargins = UIEdgeInsets(top: 0, left: 6, bottom: 0, right: 2)
            stack.addArrangedSubview(row)
        }

        var edit = UIButton.Configuration.plain()
        edit.title = "Edit tools"
        edit.image = UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
        edit.imagePlacement = .trailing
        edit.imagePadding = 6
        edit.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 6)
        editToggle.configuration = edit
        editToggle.contentHorizontalAlignment = .leading
        editToggle.accessibilityHint = "Shows, hides and reorders the tools in the wheel"
        editToggle.addAction(UIAction { [weak self] _ in self?.toggleToolsEditor() }, for: .primaryActionTriggered)
        stack.addArrangedSubview(editToggle)
        toolsEditor.axis = .vertical
        toolsEditor.spacing = 0
        toolsEditor.isHidden = true
        stack.addArrangedSubview(toolsEditor)

        let spanLabel = UILabel()
        spanLabel.text = "Prompts send"
        spanLabel.font = .systemFont(ofSize: 13, weight: .medium)
        spanLabel.textColor = UIColor(hex: "#334155")
        let span = UISegmentedControl(items: SectionSpan.allCases.map(\.label))
        span.setTitleTextAttributes([.font: UIFont.systemFont(ofSize: 12, weight: .medium)], for: .normal)
        span.apportionsSegmentWidthsByContent = true
        span.selectedSegmentIndex = SectionSpan.allCases.firstIndex(of: actions.sectionSpan()) ?? 0
        span.accessibilityLabel = "What a section prompt sends: this section, with the one above or below, or what's on the screen"
        span.addAction(UIAction { [weak span] _ in
            guard let i = span?.selectedSegmentIndex, SectionSpan.allCases.indices.contains(i) else { return }
            actions.setSectionSpan(SectionSpan.allCases[i])
        }, for: .valueChanged)
        let spanRow = UIStackView(arrangedSubviews: [spanLabel, span])
        spanRow.axis = .vertical
        spanRow.spacing = 4
        spanRow.isLayoutMarginsRelativeArrangement = true
        spanRow.layoutMargins = UIEdgeInsets(top: 0, left: 6, bottom: 0, right: 2)
        stack.addArrangedSubview(spanRow)

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

    private func toggleToolsEditor() {
        toolsEditor.isHidden.toggle()
        editToggle.configuration?.image = UIImage(systemName: toolsEditor.isHidden ? "chevron.down" : "chevron.up",
                                                  withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
        if !toolsEditor.isHidden { buildToolsEditor() }
        // The panel's height changed: place it again.
        superview?.setNeedsLayout()
    }

    /// One row per tool in the wheel's order: up, down, and shown (the web's Toolbar settings).
    private func buildToolsEditor() {
        toolsEditor.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let tools = rail.toolOrder
        for (i, tool) in tools.enumerated() {
            let shown = !rail.hidden.contains(tool.rawValue)
            let icon = UIImageView(image: UIImage(systemName: tool.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .medium)))
            icon.tintColor = UIColor(hex: shown ? "#334155" : "#94a3b8")
            icon.contentMode = .center
            icon.widthAnchor.constraint(equalToConstant: 28).isActive = true
            let label = UILabel()
            label.text = tool.label
            label.font = .systemFont(ofSize: 13, weight: .medium)
            label.textColor = UIColor(hex: shown ? "#334155" : "#94a3b8")
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            label.setContentHuggingPriority(.defaultLow, for: .horizontal)
            let row = UIStackView(arrangedSubviews: [icon, label])
            row.alignment = .center
            row.spacing = 4
            for (step, symbol, name) in [(-1, "chevron.up", "up"), (1, "chevron.down", "down")] {
                let b = UIButton(type: .system)
                b.setImage(UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)), for: .normal)
                b.isEnabled = tools.indices.contains(i + step)
                b.accessibilityLabel = "Move \(tool.label) \(name)"
                b.addAction(UIAction { [weak self] _ in self?.changeRail(self?.rail.movingTool(tool, by: step)) }, for: .primaryActionTriggered)
                b.widthAnchor.constraint(equalToConstant: 36).isActive = true
                b.heightAnchor.constraint(equalToConstant: 40).isActive = true
                row.addArrangedSubview(b)
            }
            let toggle = UISwitch()
            toggle.isOn = shown
            toggle.isEnabled = tool != .pen
            toggle.accessibilityLabel = tool == .pen ? "The pen always shows" : "Show \(tool.label)"
            toggle.setContentCompressionResistancePriority(.required, for: .horizontal)
            toggle.addAction(UIAction { [weak self, weak toggle] _ in
                self?.changeRail(self?.rail.showingTool(tool, toggle?.isOn ?? shown))
            }, for: .valueChanged)
            row.addArrangedSubview(toggle)
            row.isLayoutMarginsRelativeArrangement = true
            row.layoutMargins = UIEdgeInsets(top: 0, left: 2, bottom: 0, right: 2)
            toolsEditor.addArrangedSubview(row)
        }
    }

    #if DEBUG
    /// Opens Edit tools, for the simulator's `-demo editTools`.
    func showToolsEditor() { if toolsEditor.isHidden { toggleToolsEditor() } }
    #endif

    private func changeRail(_ next: RailLayout?) {
        guard let next, next != rail else { return }
        rail = next
        onRail(next)
        buildToolsEditor()
    }

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
        let width: CGFloat = 300
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

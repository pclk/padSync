import GRDB
import PencilKit
import UIKit

/// The notebook as one zoomable column of sections, 24 pt apart (NotebookEditor.tsx). Only the
/// sections near the viewport exist as views. Reports where the iPad is (presence), so a Mac
/// following it keeps up, and remembers the place per notebook.
@MainActor
final class NotebookViewController: UIViewController, UIScrollViewDelegate {
    static let gap: CGFloat = 24

    let context: EditorContext
    let scrollView = UIScrollView()
    private let column = UIView()
    private var sections: [Entity] = []
    private var heights: [String: CGFloat] = [:]
    private var tops: [CGFloat] = []
    private(set) var views: [String: SectionView] = [:]
    private var observation: Task<Void, Never>?
    private var restored = false
    private var presenceTimer: Timer?
    private var lastPresence = Date.distantPast
    private var lastSectionId: String?
    private var fitted = false
    /// The width the zoom was last fitted to, and the column point at the viewport's top-left
    /// then, so a rotation or window resize keeps the reading position.
    private var layoutWidth: CGFloat = 0
    private var reading = CGPoint.zero
    private var scrollToSection: String?
    private let addButton = UIButton(configuration: .plain())
    /// Which section is current (index, count), for the page menu.
    private(set) var position = (index: 0, count: 0)
    /// Back to the library.
    var onClose: () -> Void = {}
    var notebookTitle: () -> String = { "" }
    private(set) var overlay: ControlsOverlay!
    let watcher = TouchWatcher()
    private let settings = DeviceSettingsStore.shared
    private var previousKind = ToolKind.pen
    // The lasso being drawn (overlay coordinates), by a held finger or the Pencil.
    private var loopPoints: [CGPoint] = []
    private var lassoing = false
    private let pencilLasso = PencilLassoRecognizer()
    /// The prompt fan a held finger points into, and where it pressed.
    private var heldFan: (press: CGPoint, far: CGFloat)?
    private var dragStart: PKDrawing?
    private let lassoAsk = FanPress()
    private let lassoEdit = FanPress()
    private let lassoColors = FanPress()
    private let recorder = VoiceRecorder()
    private var recorderBar: RecorderBar?
    private let pencilFan = FanPress()
    private let gestureFan = FanPress()
    /// Pencil Pro haptics; on other Pencils and fingers they do nothing.
    private lazy var haptics = UICanvasFeedbackGenerator(view: view)
    private let hover = UIHoverGestureRecognizer()
    private let hoverRing = HoverRingView()
    /// Where the Pencil was last seen (view coordinates), for where haptics play.
    private var lastPencil: CGPoint?
    /// A barrel roll over the selection box: the roll it started from, the ink before it, the turn.
    private var roll: (base: CGFloat, start: PKDrawing?, angle: CGFloat)?

    init(context: EditorContext) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0xf1 / 255, green: 0xf5 / 255, blue: 0xf9 / 255, alpha: 1)
        scrollView.delegate = self
        scrollView.minimumZoomScale = 0.5
        scrollView.maximumZoomScale = ZoomFit.maximum
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.alwaysBounceVertical = true
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.delaysContentTouches = false
        scrollView.frame = view.bounds
        scrollView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(scrollView)
        scrollView.addSubview(column)

        // The web's dashed "Blank page" button below the last section.
        var add = UIButton.Configuration.plain()
        add.title = "Blank page"
        add.image = UIImage(systemName: "plus")
        add.imagePadding = 8
        add.baseForegroundColor = UIColor(hex: "#64748b")
        add.contentInsets = NSDirectionalEdgeInsets(top: 16, leading: 32, bottom: 16, trailing: 32)
        add.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { a in
            var a = a
            a.font = .systemFont(ofSize: 16, weight: .medium)
            return a
        }
        addButton.configuration = add
        addButton.layer.cornerRadius = 16
        addButton.layer.borderWidth = 2
        addButton.layer.borderColor = UIColor(hex: "#cbd5e1")!.cgColor
        // A dashed border needs a shape layer; a solid light one reads the same at this size.
        addButton.addAction(UIAction { [weak self] _ in self?.addSectionAtEnd() }, for: .primaryActionTriggered)
        addButton.accessibilityLabel = "Add a blank page"
        column.addSubview(addButton)

        // Pencil never scrolls; fingers scroll and pinch, and their taps and holds are gestures.
        scrollView.panGestureRecognizer.allowedTouchTypes = [UITouch.TouchType.direct.rawValue as NSNumber]
        context.tool = settings.settings.tool
        context.sync.isInking = { [weak context] in !(context?.inking.isEmpty ?? true) }
        context.onSelectionDrag = { [weak self] v, d, state in self?.dragSelection(v, by: d, state: state) }
        setUpControls()
        view.addInteraction(pencil)
        observeSections()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Fit the page width; 1:1 on the 13" in landscape, smaller in portrait or a narrow window.
        let width = view.bounds.width
        if width > 0, !fitted {
            fitted = true
            layoutWidth = width
            scrollView.minimumZoomScale = ZoomFit.minimum(width: width)
            scrollView.zoomScale = ZoomFit.fit(width: width)
        } else if width > 0, abs(width - layoutWidth) > 0.5 {
            refit(to: width)
            return
        }
        layoutColumn()
    }

    /// Rotation, Split View or Stage Manager changed the width: refit the zoom if the page filled
    /// the old width (else keep the user's zoom), then put the same column point back at the top.
    private func refit(to width: CGFloat) {
        // Setting the zoom scrolls (and updates `reading`), so hold on to the position first.
        let anchor = reading
        let zoom = ZoomFit.refit(zoom: scrollView.zoomScale, oldWidth: layoutWidth, newWidth: width)
        layoutWidth = width
        scrollView.minimumZoomScale = ZoomFit.minimum(width: width)
        scrollView.zoomScale = zoom
        layoutColumn()
        scrollView.contentOffset = ZoomFit.offset(reading: anchor, zoom: zoom, viewport: scrollView.bounds.size,
                                                  contentHeight: column.bounds.height)
        mountVisible()
        placeLassoCircle()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        savePosition()
        publishPresence()
        presenceTimer?.invalidate()
    }

    func stop() {
        observation?.cancel()
        views.values.forEach { $0.teardown() }
        context.sync.isInking = { false }
    }

    // MARK: Sections

    private func observeSections() {
        let id = context.notebookId, writer = context.database.writer
        observation = Task { [weak self] in
            let values = ValueObservation.tracking { db in
                try Entity.filter(sql: "notebookId = ? AND kind = 'section' AND deleted = 0", arguments: [id]).fetchAll(db)
            }.removeDuplicates().values(in: writer)
            do {
                for try await rows in values {
                    self?.update(sections: rows.sorted { ($0.data["order"]?.double ?? 0) < ($1.data["order"]?.double ?? 0) })
                }
            } catch {}
        }
    }

    private func update(sections next: [Entity]) {
        sections = next
        for (i, s) in next.enumerated() {
            if let v = views[s.id] {
                if v.section != s { v.apply(section: s) }
            } else if heights[s.id] == nil {
                heights[s.id] = SectionView.baseHeight(s, index: i)
            }
        }
        let live = Set(next.map(\.id))
        for (id, v) in views where !live.contains(id) {
            v.teardown()
            v.removeFromSuperview()
            views[id] = nil
        }
        layoutColumn()
        if !restored, !next.isEmpty { restorePosition() }
        if let id = scrollToSection, let i = sections.firstIndex(where: { $0.id == id }) {
            scrollToSection = nil
            let y = (tops[i] - Self.gap) * scrollView.zoomScale
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: max(0, y)), animated: true)
        }
        reportPosition()
    }

    private static let addButtonHeight: CGFloat = 60

    private func layoutColumn() {
        var y: CGFloat = Self.gap
        tops = sections.enumerated().map { i, s in
            defer { y += (heights[s.id] ?? SectionView.baseHeight(s, index: i)) + Self.gap }
            return y
        }
        let addSize = addButton.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
        addButton.frame = CGRect(x: (SectionView.pageWidth - addSize.width) / 2, y: y,
                                 width: addSize.width, height: Self.addButtonHeight)
        addButton.isHidden = sections.isEmpty
        if !sections.isEmpty { y += Self.addButtonHeight + Self.gap }
        let zoom = scrollView.zoomScale
        // The column carries the zoom transform, so place it by bounds and center, never frame.
        column.bounds = CGRect(x: 0, y: 0, width: SectionView.pageWidth, height: max(y, 1))
        column.center = CGPoint(x: SectionView.pageWidth * zoom / 2, y: max(y, 1) * zoom / 2)
        scrollView.contentSize = CGSize(width: SectionView.pageWidth * zoom, height: max(y, 1) * zoom)
        centerColumn()
        for (i, s) in sections.enumerated() {
            views[s.id]?.frame.origin = CGPoint(x: 0, y: tops[i])
        }
        mountVisible()
    }

    private func centerColumn() {
        let inset = max(0, (scrollView.bounds.width - scrollView.contentSize.width) / 2)
        scrollView.contentInset = UIEdgeInsets(top: 0, left: inset, bottom: scrollView.bounds.height * 0.4, right: 0)
    }

    /// Sections within a screen of the viewport get views; the rest are dropped.
    private func mountVisible() {
        guard !sections.isEmpty else { return }
        let zoom = scrollView.zoomScale
        let visibleTop = scrollView.contentOffset.y / zoom, visibleHeight = scrollView.bounds.height / zoom
        let lower = visibleTop - visibleHeight, upper = visibleTop + 2 * visibleHeight
        var wanted = Set<String>()
        var resized = false
        for (i, s) in sections.enumerated() {
            let top = tops[i], bottom = top + (heights[s.id] ?? 0)
            guard bottom >= lower, top <= upper else { continue }
            wanted.insert(s.id)
            if views[s.id] == nil {
                let v = SectionView(section: s, index: i, context: context)
                v.onHeightChange = { [weak self, weak v] in
                    guard let self, let v else { return }
                    self.heights[v.section.id] = v.height
                    self.layoutColumn()
                }
                if heights[s.id] != v.height { resized = true }
                heights[s.id] = v.height
                v.frame.origin = CGPoint(x: 0, y: top)
                column.addSubview(v)
                views[s.id] = v
            }
            views[s.id]?.renderPDF(zoom: zoom, displayScale: traitCollection.displayScale)
        }
        for (id, v) in views where !wanted.contains(id) && !context.inking.contains(ObjectIdentifier(v.canvas)) {
            v.teardown()
            v.removeFromSuperview()
            views[id] = nil
        }
        // A mounted section can be taller than its estimate; move the ones below (and the add button).
        if resized { layoutColumn() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        mountVisible()
        #if DEBUG
        // `-demo panel|toolFan|promptFan|lasso`: shows a control after launch, for checking it in
        // the simulator, which can't tap or draw.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-demo"), i + 1 < args.count { demo(args[i + 1]) }
        #endif
    }

    #if DEBUG
    private func demo(_ what: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            switch what {
            case "panel":
                self.overlay.toolCircle.press?.onTap()
            case "toolFan":
                self.overlay.toolCircle.press?.began(at: self.overlay.toolCircle.center)
                self.overlay.toolCircle.press?.moved(to: CGPoint(x: self.overlay.toolCircle.center.x + 80, y: self.overlay.toolCircle.center.y + 10))
            case "promptFan":
                self.overlay.promptCircle.press?.onTap()
            case "lasso":
                let r = self.view.bounds.insetBy(dx: 120, dy: 160)
                let loop = (0..<64).map { i -> CGPoint in
                    let a = CGFloat(i) / 64 * 2 * .pi
                    return CGPoint(x: r.midX + r.width / 2 * cos(a), y: r.minY + 180 + 160 * sin(a))
                }
                self.beginLoop(at: loop[0], lens: false)
                self.addLoop(Array(loop.dropFirst()))
                self.endLoop(cancel: false)
                if args(contains: "-demoAsk") { self.lassoAsk.onTap() }
            default:
                break
            }
        }
    }

    private func args(contains flag: String) -> Bool { ProcessInfo.processInfo.arguments.contains(flag) }
    #endif

    // MARK: Scrolling and zoom

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { column }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centerColumn()
        placeLassoCircle()
        // A pinch that starts zooming isn't a tap.
        watcher.logic.consume()
    }

    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        mountVisible()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        // Mid-resize the offset is stale until refit puts the reading position back.
        if fitted, abs(view.bounds.width - layoutWidth) <= 0.5 {
            let zoom = scrollView.zoomScale
            reading = CGPoint(x: scrollView.contentOffset.x / zoom, y: scrollView.contentOffset.y / zoom)
        }
        mountVisible()
        placeLassoCircle()
        guard restored else { return }
        let current = currentSection()?.id
        if current != lastSectionId {
            lastSectionId = current
            if let current { try? context.database.log(event(type: "focus", sectionId: current)) }
            reportPosition()
        }
        // At most one presence report every 800 ms while scrolling (NotebookEditor.tsx).
        presenceTimer?.invalidate()
        let wait = max(0, 0.8 - Date.now.timeIntervalSince(lastPresence))
        presenceTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.publishPresence()
                self?.savePosition()
            }
        }
    }

    /// The section under a line 30% down the viewport, and how far its top is above the viewport.
    private func currentSection() -> (id: String, offsetY: CGFloat)? {
        let zoom = scrollView.zoomScale
        let top = scrollView.contentOffset.y / zoom
        let probe = top + scrollView.bounds.height / zoom * 0.3
        guard let i = tops.lastIndex(where: { $0 <= probe }) ?? tops.indices.first else { return nil }
        return (sections[i].id, top - tops[i])
    }

    // MARK: Presence and position

    private func publishPresence() {
        guard let (sectionId, offsetY) = currentSection() else { return }
        lastPresence = .now
        let db = context.database
        let presence = Entity(id: "presence-\(db.device)", kind: .presence, notebookId: context.notebookId, parentId: "",
                              data: .object(["device": .string(db.device), "deviceKind": .string("ipad"), "sectionId": .string(sectionId),
                                             "offsetY": .int(Int64(offsetY.rounded())), "at": .int(Int64(Date.now.timeIntervalSince1970 * 1000))]),
                              hlc: "", deleted: false, dirty: true)
        _ = try? db.save([presence])
        context.sync.requestSync(reason: "presence")
    }

    private var positionKey: String { "position:\(context.notebookId)" }

    private func savePosition() {
        guard restored, let (sectionId, offsetY) = currentSection() else { return }
        let key = positionKey
        try? context.database.writer.write { db in
            try AppDatabase.setMeta(db, key, .object(["sectionId": .string(sectionId), "offsetY": .double(Double(offsetY))]))
        }
    }

    private func restorePosition() {
        restored = true
        let key = positionKey
        guard let saved = try? context.database.writer.read({ db in try AppDatabase.meta(db, key) }),
              let sectionId = saved["sectionId"]?.string, let i = sections.firstIndex(where: { $0.id == sectionId }) else { return }
        let y = (tops[i] + CGFloat(saved["offsetY"]?.double ?? 0)) * scrollView.zoomScale
        scrollView.contentOffset.y = min(max(0, y), max(0, scrollView.contentSize.height - scrollView.bounds.height / 2))
    }

    private func event(type: String, sectionId: String?) -> PadEvent {
        PadEvent(id: newId(), notebookId: context.notebookId, sectionId: sectionId, type: type,
                 t: Int64(Date.now.timeIntervalSince1970 * 1000), device: context.database.device, data: .object([:]), synced: false)
    }

    // MARK: Section menu

    private func reportPosition() {
        guard let id = currentSection()?.id, let i = sections.firstIndex(where: { $0.id == id }) else { return }
        position = (i, sections.count)
    }

    /// Writes section rows, with an undo step on the window's undo manager (the same one the
    /// two-finger tap and PencilKit use) that writes the previous versions back.
    private func write(_ rows: [Entity], undoName: String) {
        let ids = rows.map(\.id)
        let before = (try? context.database.writer.read { db in try Entity.filter(keys: ids).fetchAll(db) }) ?? []
        guard (try? context.database.save(rows)) != nil else { return }
        context.sync.requestSync(reason: "section")
        let undoManager = view.window?.undoManager
        // A row that didn't exist (a new section) is undone by deleting it.
        let restore = rows.map { row in before.first { $0.id == row.id } ?? Sections.setDeleted(row, true) }
        undoManager?.registerUndo(withTarget: self) { vc in
            MainActor.assumeIsolated {
                // Restore over the current versions so the step survives a sync in between.
                let current = (try? vc.context.database.writer.read { db in try Entity.filter(keys: ids).fetchAll(db) }) ?? []
                let merged = restore.map { old in
                    guard var now = current.first(where: { $0.id == old.id }) else { return old }
                    now.data = old.data
                    now.deleted = old.deleted
                    return now
                }
                vc.write(merged, undoName: undoName)
            }
        }
        undoManager?.setActionName(undoName)
    }

    /// The current section, or the last one when nothing is on screen.
    private var current: Entity? {
        currentSection().flatMap { c in sections.first { $0.id == c.id } } ?? sections.last
    }

    func addSectionAfterCurrent() {
        let section = Sections.newSection(notebookId: context.notebookId, after: current, sorted: sections)
        scrollToSection = section.id
        write([section], undoName: "Add page")
    }

    func addSectionAtEnd() {
        let section = Sections.newSection(notebookId: context.notebookId, after: sections.last, sorted: sections)
        scrollToSection = section.id
        write([section], undoName: "Add page")
    }

    func moveCurrentSection(by step: Int) {
        guard let current, let i = sections.firstIndex(where: { $0.id == current.id }),
              sections.indices.contains(i + step) else { return }
        scrollToSection = current.id
        write(Sections.swapped(current, sections[i + step]), undoName: "Move page")
    }

    /// Flags the current section deleted. Returns its id for the bar's Undo, or nil if it's the
    /// notebook's only section.
    @discardableResult
    func deleteCurrentSection() -> String? {
        guard Sections.canDelete(count: sections.count), let current else { return nil }
        if let v = views[current.id] {
            // Save any open text box edit before the view goes.
            v.endEditing(true)
        }
        write([Sections.setDeleted(current, true)], undoName: "Delete page")
        return current.id
    }

    /// Brings a deleted section back (the bar's Undo), at its old place with its ink.
    func restoreSection(id: String) {
        guard let row = try? context.database.writer.read({ db in try Entity.fetchOne(db, key: id) }), row.deleted else { return }
        scrollToSection = id
        write([Sections.setDeleted(row, false)], undoName: "Delete page")
    }

    // MARK: Undo

    // PencilKit registers its undo steps with the window's undo manager.
    @objc func undoTap() {
        clearSelection()
        view.window?.undoManager?.undo()
    }

    @objc func redoTap() {
        clearSelection()
        view.window?.undoManager?.redo()
    }

    // MARK: Apple Pencil

    /// Double tap and squeeze do what Settings → Apple Pencil says: switch to the previous tool or
    /// the eraser, or show the tools (the tool fan around the Pencil for squeeze).
    private lazy var pencil = UIPencilInteraction(delegate: self)
}

extension NotebookViewController: UIPencilInteractionDelegate {
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        pencilAction(UIPencilInteraction.preferredTapAction, at: tap.hoverPose?.location)
    }

    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        guard squeeze.phase == .ended else { return }
        pencilAction(UIPencilInteraction.preferredSqueezeAction, at: squeeze.hoverPose?.location)
    }

    private func pencilAction(_ action: UIPencilPreferredAction, at point: CGPoint?) {
        switch action {
        case .ignore:
            break
        case .switchEraser:
            setKind(context.tool.kind == .eraser ? previousKind : .eraser)
        case .switchPrevious:
            setKind(previousKind)
        default:
            // Palettes: the tool fan where the Pencil hovers, else around the tool circle.
            let at = point ?? overlay.toolCircle.center
            let current = context.tool.kind
            let items = settings.settings.rail.tools.map { FanItem(key: $0.rawValue, label: $0.label, symbol: $0.symbol, current: $0 == current) }
            pencilFan.setFan(FanState(items: items, center: at, viewport: overlay.bounds.size, sticky: true))
        }
    }
}



// MARK: - Controls

extension NotebookViewController {
    private func setUpControls() {
        let actions = ControlsActions(
            tool: { [unowned self] in self.context.tool },
            setTool: { [unowned self] in self.setTool($0) },
            undo: { [unowned self] in self.undoTap() },
            redo: { [unowned self] in self.redoTap() },
            canUndo: { [unowned self] in self.view.window?.undoManager?.canUndo ?? false },
            canRedo: { [unowned self] in self.view.window?.undoManager?.canRedo ?? false },
            prompts: { [unowned self] in self.settings.settings.prompts },
            sendPrompt: { [unowned self] in self.sendPrompt($0, fromSelection: false) },
            close: { [unowned self] in self.onClose() },
            syncStatus: { [unowned self] in self.syncLabel },
            pageMenu: { [unowned self] in self.pageMenu() })
        let overlay = ControlsOverlay(actions: actions, rail: settings.settings.rail)
        overlay.frame = view.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(overlay)
        self.overlay = overlay
        overlay.onRailChange = { [weak self] in self?.settings.setRail($0) }
        settings.onChange = { [weak self] s in self?.overlay.setRail(s.rail) }
        Task { [weak self] in await self?.settings.refresh() }

        for press in [pencilFan, gestureFan, lassoAsk, lassoEdit, lassoColors] {
            press.present = { [weak self, weak press] f in self?.overlay.show(f, for: press) }
        }
        pencilFan.onPick = { [weak self] item in
            self?.tick()
            ToolKind(rawValue: item.key).map { self?.setKind($0) }
        }
        gestureFan.onPick = { [weak self] item in self?.pickPrompt(item.key, fromSelection: false) }
        lassoAsk.open = { [weak self] in self?.lassoPromptFan(sticky: false) }
        lassoAsk.onPick = { [weak self] item in
            self?.tick()
            self?.pickPrompt(item.key, fromSelection: true)
        }
        lassoAsk.onTap = { [weak self] in
            guard let self else { return }
            self.lassoAsk.setFan(self.lassoAsk.fan == nil ? self.lassoPromptFan(sticky: true) : nil)
        }
        lassoEdit.open = { [weak self] in self?.lassoEditFan(sticky: false) }
        lassoEdit.onPick = { [weak self] item in
            self?.tick()
            LassoAction(rawValue: item.key).map { self?.lassoAction($0) }
        }
        lassoEdit.onTap = { [weak self] in
            guard let self else { return }
            self.lassoEdit.setFan(self.lassoEdit.fan == nil ? self.lassoEditFan(sticky: true) : nil)
        }
        lassoColors.onPick = { [weak self] item in
            self?.tick()
            self?.recolorSelection(item.key)
        }

        // Finger gestures, as set in the web's Settings → Touch gestures.
        scrollView.addGestureRecognizer(watcher)
        watcher.isOnPage = { [weak self] p in
            guard let self else { return false }
            let hit = self.scrollView.hitTest(p, with: nil)
            let control = hit is SelectionBoxView || hit is TextBoxView || hit?.superview is TextBoxView || hit is TextBoxEditor
            return !control && self.overlay.isOnPage(self.scrollView.convert(p, to: self.overlay))
        }
        let logic = watcher.logic
        logic.isBound = { [weak self] g in self?.settings.settings.gestures[g] != GestureAction.none }
        logic.tuning = { [weak self] in self?.settings.settings.tuning ?? GestureTuning() }
        logic.onHold = { [weak self] started, at in
            guard let self else { return }
            if started {
                let action = self.settings.settings.gestures[.fingerHold]
                let label = action == .lassoHold ? "Hold to lasso" : "Hold: \(action.label)"
                self.overlay.holdRing.start(at: self.scrollView.convert(at.point, to: self.overlay), label: label,
                                            seconds: self.settings.settings.tuning.holdMs / 1000)
            } else {
                self.overlay.holdRing.stop()
            }
        }
        logic.onPageTap = { [weak self] in self?.clearSelection() }
        logic.emit = { [weak self] g, at in self?.gesture(g, at: at) }
        watcher.onHeldMove = { [weak self] touch, event in self?.heldMove(touch, event: event) }
        watcher.onHeldEnd = { [weak self] touch, lifted in self?.heldEnd(touch, lifted: lifted) }

        // The lasso tool: the Pencil draws a loop instead of ink.
        pencilLasso.allowedTouchTypes = [UITouch.TouchType.pencil.rawValue as NSNumber]
        pencilLasso.isEnabled = context.tool.kind == .lasso
        pencilLasso.onBegin = { [weak self] p in
            guard let self else { return }
            self.beginLoop(at: self.scrollView.convert(p, to: self.overlay), lens: false)
        }
        pencilLasso.onMove = { [weak self] ps in
            guard let self else { return }
            self.addLoop(ps.map { self.scrollView.convert($0, to: self.overlay) })
        }
        pencilLasso.onEnd = { [weak self] cancelled in self?.endLoop(cancel: cancelled) }
        scrollView.addGestureRecognizer(pencilLasso)

        // The hovering Pencil: the eraser and lasso preview, and Pencil Pro barrel roll.
        hover.allowedTouchTypes = [UITouch.TouchType.pencil.rawValue as NSNumber]
        hover.addTarget(self, action: #selector(hovered))
        scrollView.addGestureRecognizer(hover)
        overlay.insertSubview(hoverRing, at: 0)
    }

    private var syncLabel: String {
        switch context.sync.status {
        case .idle: "Starting"
        case .syncing: "Syncing"
        case .synced: "Synced"
        case .offline: "Offline"
        case .localOnly: "Local only"
        case .needsLogin: "Signed out"
        case .error: "Sync error"
        }
    }

    // MARK: Tools

    func setTool(_ t: ToolState) {
        let old = context.tool
        guard t != old else { return }
        if t.kind != old.kind { previousKind = old.kind }
        context.tool = t
        if t.kind != .lasso && t.kind != old.kind { clearSelection() }
        pencilLasso.isEnabled = t.kind == .lasso
        views.values.forEach { $0.applyTool() }
        overlay.refreshTool()
        settings.setTool(t)
    }

    func setKind(_ k: ToolKind) {
        var t = context.tool
        t.kind = k
        setTool(t)
        note(k.label)
    }

    private func note(_ text: String, seconds: TimeInterval = 0.9) {
        guard settings.settings.tuning.showNote || seconds > 1 else { return }
        overlay.note.show(text, seconds: seconds)
    }

    // MARK: Gestures

    private func gesture(_ g: GestureKind, at: GestureAt) {
        let action = settings.settings.gestures[g]
        let p = scrollView.convert(at.point, to: overlay)
        switch action {
        case .none:
            break
        case .lassoHold:
            guard g == .fingerHold, let id = at.id, let touch = watcher.touch(id) else { return }
            holdFinger(touch)
            beginLoop(at: p, lens: true)
            note("Lasso")
        case .promptMenu:
            if g == .fingerHold, let id = at.id, let touch = watcher.touch(id) {
                guard let f = overlay.promptFan(at: p, sticky: false) else { return }
                holdFinger(touch)
                heldFan = (p, 0)
                gestureFan.setFan(f)
            } else if let f = overlay.promptFan(at: p, sticky: true) {
                gestureFan.setFan(f)
            }
        case .undo:
            undoTap()
            note("Undo")
        case .redo:
            redoTap()
            note("Redo")
        case .previousTool:
            setKind(previousKind)
        case .tool(let k):
            setKind(k)
        case .resetZoom:
            scrollView.setZoomScale(ZoomFit.fit(width: view.bounds.width), animated: true)
            note("Reset zoom")
        case .togglePanel:
            note("The side panel is on the Mac")
        }
    }

    /// The held finger now lassoes or points: the page stops scrolling under it.
    private func holdFinger(_ touch: UITouch) {
        watcher.heldFinger = touch
        scrollView.panGestureRecognizer.isEnabled = false
        scrollView.pinchGestureRecognizer?.isEnabled = false
    }

    private func releaseFinger() {
        scrollView.panGestureRecognizer.isEnabled = true
        scrollView.pinchGestureRecognizer?.isEnabled = true
    }

    private func heldMove(_ touch: UITouch, event: UIEvent) {
        if lassoing {
            addLoop((event.coalescedTouches(for: touch) ?? [touch]).map { $0.location(in: overlay) })
        } else if let held = heldFan, let f = gestureFan.fan {
            let p = touch.location(in: overlay)
            let dx = p.x - held.press.x, dy = p.y - held.press.y
            heldFan = (held.press, max(held.far, hypot(dx, dy)))
            let next = f.pointing(dx: dx, dy: dy)
            if next.hot != f.hot { gestureFan.setFan(next) }
        }
    }

    private func heldEnd(_ touch: UITouch, lifted: Bool) {
        releaseFinger()
        if lassoing { endLoop(cancel: !lifted) }
        if let held = heldFan {
            heldFan = nil
            guard var f = gestureFan.fan else { return }
            if lifted, f.hot >= 0 {
                gestureFan.close()
                pickPrompt(f.items[f.hot].key, fromSelection: false)
            } else if lifted, held.far <= settings.settings.tuning.slop {
                f.sticky = true
                gestureFan.setFan(f)
            } else {
                gestureFan.close()
            }
        }
    }

    // MARK: Lasso

    private func beginLoop(at p: CGPoint, lens: Bool) {
        clearSelection()
        lassoing = true
        loopPoints = [p]
        let l = settings.settings.lasso
        if lens, l.lens, let snap = scrollView.snapshotView(afterScreenUpdates: false) {
            let lensView = LassoLensView(snapshot: snap, size: CGFloat(l.lensSize), zoom: CGFloat(l.lensZoom))
            overlay.addSubview(lensView)
            overlay.lens = lensView
        }
        drawLoop()
    }

    private func addLoop(_ ps: [CGPoint]) {
        guard lassoing else { return }
        loopPoints += ps
        drawLoop()
    }

    private func drawLoop() {
        let path = UIBezierPath()
        if let first = loopPoints.first {
            path.move(to: first)
            loopPoints.dropFirst().forEach { path.addLine(to: $0) }
        }
        overlay.loop.path = path.cgPath
        if let last = loopPoints.last { overlay.lens?.move(to: last, loop: loopPoints, in: overlay.bounds.size) }
    }

    private func endLoop(cancel: Bool) {
        guard lassoing else { return }
        lassoing = false
        overlay.lens?.removeFromSuperview()
        overlay.lens = nil
        overlay.loop.path = nil
        let loop = loopPoints
        loopPoints = []
        guard !cancel, loop.count >= 3 else { return }
        select(loop: loop)
    }

    /// Selects the strokes the loop picks in the section it was mostly drawn on.
    private func select(loop: [CGPoint]) {
        let candidates = views.values.map { v in (v, loop.map { overlay.convert($0, to: v) }) }
        guard let (v, poly) = candidates.max(by: { a, b in
            a.1.filter(a.0.bounds.contains).count < b.1.filter(b.0.bounds.contains).count
        }), poly.contains(where: v.bounds.contains) else { return }
        let strokes = v.canvas.drawing.strokes
        let picked = LassoGeometry.pick(strokes.map(LassoGeometry.shape), drawn: poly, mode: settings.settings.lasso.mode)
        guard !picked.isEmpty else { return }
        let chosen = picked.map { strokes[$0] }
        guard let box = AskSelection.box(chosen) else { return }
        context.selection = InkSelection(sectionId: v.section.id, keys: Set(chosen.map(StrokeCodec.key)), box: box)
        if let end = loop.last { haptics.pathCompleted(at: overlay.convert(end, to: view)) }
        v.showSelection()
        showLassoCircle()
        note("\(chosen.count) stroke\(chosen.count == 1 ? "" : "s") selected")
    }

    func clearSelection() {
        guard context.selection != nil else { return }
        cancelRoll()
        let id = context.selection?.sectionId
        context.selection = nil
        if let id { views[id]?.showSelection() }
        overlay.lassoCircle?.removeFromSuperview()
        overlay.lassoCircle = nil
        for f in [lassoAsk, lassoEdit, lassoColors] { f.close() }
    }

    private func showLassoCircle() {
        overlay.lassoCircle?.removeFromSuperview()
        let circle = LassoCircleView(settings: settings.settings.lasso)
        circle.ask.press = lassoAsk
        circle.edit.press = lassoEdit
        circle.ask.space = overlay
        circle.edit.space = overlay
        overlay.insertSubview(circle, belowSubview: overlay.note)
        overlay.lassoCircle = circle
        placeLassoCircle()
    }

    /// Just above the selection, or below it when there's no room above (LassoCircle.tsx).
    private func placeLassoCircle() {
        guard let circle = overlay?.lassoCircle else { return }
        guard let sel = context.selection, let v = views[sel.sectionId] else {
            circle.isHidden = true
            return
        }
        circle.isHidden = false
        let r = v.convert(sel.box, to: overlay)
        let d = circle.bounds.height, w = circle.bounds.width, gap: CGFloat = 14
        let x = min(overlay.bounds.width - w / 2 - 8, max(w / 2 + 8, r.midX))
        let above = r.minY - gap - d / 2
        let y = above - d / 2 >= overlay.safeAreaInsets.top + 8 ? above : min(overlay.bounds.height - d / 2 - 8, r.maxY + gap + d / 2)
        circle.center = CGPoint(x: x, y: y)
    }

    private func lassoPromptFan(sticky: Bool) -> FanState? {
        guard let circle = overlay.lassoCircle else { return nil }
        let prompts = settings.settings.prompts
        guard !prompts.isEmpty else {
            note("No prompts: add some in the web app's toolbar settings → Prompts", seconds: 2)
            return nil
        }
        return FanState(items: prompts.map { FanItem(key: $0.id, label: $0.label, symbol: $0.symbol) },
                        center: circle.askCenter(in: overlay), viewport: overlay.bounds.size, sticky: sticky)
    }

    private func lassoEditFan(sticky: Bool) -> FanState? {
        guard let circle = overlay.lassoCircle else { return nil }
        let edits = settings.settings.lasso.visible.filter { $0 != .ask }
        guard !edits.isEmpty else { return nil }
        return FanState(items: edits.map { FanItem(key: $0.rawValue, label: $0.label, symbol: $0.symbol) },
                        center: circle.editCenter(in: overlay), viewport: overlay.bounds.size, sticky: sticky)
    }

    private func lassoAction(_ a: LassoAction) {
        switch a {
        case .delete:
            editSelection(name: "Delete") { _ in nil }
            clearSelection()
        case .duplicate:
            duplicateSelection()
        case .recolor:
            guard let circle = overlay.lassoCircle else { return }
            let items = ToolState.penColors.map { FanItem(key: $0, label: ToolState.penColorNames[$0] ?? $0, symbol: "circle.fill", color: $0) }
            lassoColors.setFan(FanState(items: items, center: circle.editCenter(in: overlay), viewport: overlay.bounds.size, sticky: true))
        case .bigger, .smaller:
            guard let sel = context.selection else { return }
            let step = settings.settings.lasso.step / 100
            let s = CGFloat(a == .bigger ? 1 + step : 1 - step)
            let c = CGPoint(x: sel.box.midX, y: sel.box.midY)
            let scale = CGAffineTransform(translationX: -c.x, y: -c.y).concatenating(CGAffineTransform(scaleX: s, y: s)).concatenating(CGAffineTransform(translationX: c.x, y: c.y))
            editSelection(name: a.label) { stroke in
                var st = stroke
                st.transform = stroke.transform.concatenating(scale)
                return st
            }
        case .ask:
            lassoAsk.setFan(lassoPromptFan(sticky: true))
        }
    }

    private func recolorSelection(_ hex: String) {
        guard let color = UIColor(hex: hex) else { return }
        editSelection(name: "Colour") { stroke in
            var st = stroke
            st.ink = PKInk(stroke.ink.inkType, color: color)
            return st
        }
    }

    /// Changes (or, returning nil, removes) each selected stroke, as one undo step.
    private func editSelection(name: String, _ change: (PKStroke) -> PKStroke?) {
        guard let sel = context.selection, let v = views[sel.sectionId] else { return }
        let before = v.canvas.drawing
        var strokes: [PKStroke] = []
        for stroke in before.strokes {
            if sel.keys.contains(StrokeCodec.key(stroke)) {
                if let next = change(stroke) { strokes.append(next) }
            } else {
                strokes.append(stroke)
            }
        }
        commit(PKDrawing(strokes: strokes), in: v, before: before, name: name)
        refreshSelection(in: v)
    }

    private func duplicateSelection() {
        guard let sel = context.selection, let v = views[sel.sectionId] else { return }
        let before = v.canvas.drawing
        let shift = CGAffineTransform(translationX: 24, y: 24)
        let copies = before.strokes.filter { sel.keys.contains(StrokeCodec.key($0)) }.map {
            PKStroke(ink: $0.ink, path: $0.path, transform: $0.transform.concatenating(shift), mask: $0.mask, randomSeed: UInt32.random(in: 1...UInt32.max))
        }
        commit(PKDrawing(strokes: before.strokes + copies), in: v, before: before, name: "Duplicate")
        // The copies become the selection, to drag into place.
        context.selection?.keys = Set(copies.map(StrokeCodec.key))
        refreshSelection(in: v)
    }

    /// Writes a drawing change with an undo step that puts `before` back.
    private func commit(_ drawing: PKDrawing, in v: SectionView, before: PKDrawing, name: String) {
        let id = v.section.id
        view.window?.undoManager?.registerUndo(withTarget: self) { vc in
            MainActor.assumeIsolated {
                guard let v = vc.views[id] else { return }
                vc.clearSelection()
                vc.commit(before, in: v, before: v.canvas.drawing, name: name)
            }
        }
        view.window?.undoManager?.setActionName(name)
        v.setDrawing(drawing, save: true)
    }

    private func refreshSelection(in v: SectionView) {
        guard let sel = context.selection else { return }
        let chosen = v.canvas.drawing.strokes.filter { sel.keys.contains(StrokeCodec.key($0)) }
        guard let box = AskSelection.box(chosen) else { return clearSelection() }
        context.selection?.box = box
        v.showSelection()
        placeLassoCircle()
    }

    /// Dragging the selection box moves the ink with it; letting go writes the move.
    private func dragSelection(_ v: SectionView, by d: CGPoint, state: UIGestureRecognizer.State) {
        guard let sel = context.selection, sel.sectionId == v.section.id else { return }
        switch state {
        case .began:
            dragStart = v.canvas.drawing
            for f in [lassoAsk, lassoEdit, lassoColors] { f.close() }
            overlay.lassoCircle?.isHidden = true
        case .changed, .ended:
            guard let start = dragStart else { return }
            let t = CGAffineTransform(translationX: d.x, y: d.y)
            let moved = PKDrawing(strokes: start.strokes.map { stroke in
                guard sel.keys.contains(StrokeCodec.key(stroke)) else { return stroke }
                var st = stroke
                st.transform = stroke.transform.concatenating(t)
                return st
            })
            v.selectionView.frame = sel.box.offsetBy(dx: d.x, dy: d.y).insetBy(dx: -8, dy: -8)
            if state == .changed {
                v.setDrawing(moved, save: false)
            } else {
                dragStart = nil
                v.setDrawing(start, save: false)
                commit(moved, in: v, before: start, name: "Move")
                refreshSelection(in: v)
            }
        default:
            if let start = dragStart { v.setDrawing(start, save: false) }
            dragStart = nil
            v.showSelection()
            placeLassoCircle()
        }
    }

    // MARK: Prompts

    private func pickPrompt(_ id: String, fromSelection: Bool) {
        guard var p = settings.settings.prompts.first(where: { $0.id == id }) else { return }
        // From the lasso, "as set in the chat" means the selection (LassoCircle's onPrompt).
        if fromSelection && p.context == .chat { p.context = .selection }
        sendPrompt(p, fromSelection: fromSelection)
    }

    private func sendPrompt(_ p: ChatPrompt, fromSelection: Bool) {
        if p.voice {
            startRecording(p, fromSelection: fromSelection)
        } else if !p.send {
            let alert = UIAlertController(title: p.label, message: nil, preferredStyle: .alert)
            alert.addTextField { $0.text = p.text }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            alert.addAction(UIAlertAction(title: "Send", style: .default) { [weak self, weak alert] _ in
                let text = alert?.textFields?.first?.text ?? ""
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                self?.deliver(p, text: text, audio: nil, fromSelection: fromSelection)
            })
            present(alert, animated: true)
        } else {
            deliver(p, text: nil, audio: nil, fromSelection: fromSelection)
        }
    }

    private func startRecording(_ p: ChatPrompt, fromSelection: Bool) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await recorder.start()
            } catch {
                note(error.localizedDescription, seconds: 3)
                return
            }
            let bar = RecorderBar(title: p.label)
            bar.center = CGPoint(x: overlay.bounds.midX, y: overlay.bounds.height - overlay.safeAreaInsets.bottom - 56)
            bar.onCancel = { [weak self, weak bar] in
                self?.recorder.cancel()
                bar?.removeFromSuperview()
            }
            bar.onSend = { [weak self, weak bar] in
                bar?.removeFromSuperview()
                guard let self, let audio = self.recorder.finish() else { return }
                self.deliver(p, text: nil, audio: audio, fromSelection: fromSelection)
            }
            overlay.addSubview(bar)
            recorderBar = bar
        }
    }

    private func deliver(_ p: ChatPrompt, text: String?, audio: Data?, fromSelection: Bool) {
        let selection = fromSelection ? selectionCrop() : nil
        let sender = PromptSender(notebookId: context.notebookId, title: notebookTitle(), sections: sections,
                                  currentSectionId: currentSection()?.id, database: context.database,
                                  render: { [weak self] s, i, scale in await self?.renderSection(s, index: i, scale: scale) },
                                  handwriting: { [weak self] scope in await self?.handwritingNote(scope) })
        note("Sending: \(p.label)…", seconds: 30)
        Task {
            do {
                let done = try await sender.send(p, text: text, selection: selection, audio: audio)
                context.sync.requestSync(reason: "chat")
                note(done, seconds: 1.5)
            } catch {
                note(error.localizedDescription, seconds: 3)
            }
        }
    }

    /// The handwriting in what a prompt sends, read on the iPad: the selection or this section now,
    /// the whole notebook from the search index.
    private func handwritingNote(_ scope: ChatPrompt.Context) async -> JSONValue? {
        switch scope {
        case .selection:
            guard let sel = context.selection, let v = views[sel.sectionId] else { return nil }
            let ink = PKDrawing(strokes: v.canvas.drawing.strokes.filter { sel.keys.contains(StrokeCodec.key($0)) })
            return HandwritingReader.file(await HandwritingReader.read(ink), about: "the lassoed ink")
        case .section, .chat:
            guard let s = currentSection() else { return nil }
            var ink = views[s.id]?.canvas.drawing
            if ink == nil { ink = try? await context.database.writer.read { try HandwritingReader.drawing($0, sectionId: s.id) } }
            guard let ink else { return nil }
            return HandwritingReader.file(await HandwritingReader.read(ink), about: "the ink on this section")
        case .notebook:
            let ids = sections.map(\.id)
            guard let texts = try? await context.database.writer.read({ try HandwritingIndex.text($0, sectionIds: ids) }) else { return nil }
            let parts = sections.enumerated().compactMap { i, s -> String? in
                guard let t = texts[s.id], !t.isEmpty else { return nil }
                return "## Section \(i + 1)\n\(t)"
            }
            return HandwritingReader.file(parts, about: "the ink in each section (as of the last time the iPad read it)")
        case .none:
            return nil
        }
    }

    /// The selection as a picture: the section at 2× cropped to the box plus a margin.
    private func selectionCrop() -> PromptSender.Selection? {
        guard let sel = context.selection, let v = views[sel.sectionId] else { return nil }
        let scale = AskSelection.scale(for: v.bounds.size)
        guard let full = v.snapshot(scale: scale).cgImage else { return nil }
        let crop = AskSelection.cropRect(box: sel.box, section: v.bounds.size, scale: scale)
        guard let part = full.cropping(to: crop), let png = UIImage(cgImage: part).pngData() else { return nil }
        return PromptSender.Selection(sectionId: sel.sectionId, png: png, width: part.width, height: part.height)
    }

    /// A section's picture for a bundle: the mounted view, or one built off screen for it.
    private func renderSection(_ s: Entity, index: Int, scale: CGFloat) async -> (png: Data, width: Int, height: Int)? {
        let v = views[s.id] ?? SectionView(section: s, index: index, context: context)
        await v.settle(timeout: views[s.id] == nil ? 5 : 2)
        let image = v.snapshot(scale: min(scale, AskSelection.scale(for: v.bounds.size, asked: scale)))
        if views[s.id] !== v { v.teardown() }
        guard let cg = image.cgImage, let png = image.pngData() else { return nil }
        return (png, cg.width, cg.height)
    }

    // MARK: Hovering Pencil

    /// A tick in a Pencil Pro, where the Pencil last was.
    private func tick() {
        haptics.alignmentOccurred(at: lastPencil ?? overlay.convert(overlay.toolCircle.center, to: view))
    }

    @objc private func hovered(_ g: UIHoverGestureRecognizer) {
        switch g.state {
        case .began, .changed:
            lastPencil = g.location(in: view)
            showHoverRing(at: g.location(in: overlay))
            rollChanged(g)
        default:
            hoverRing.hide()
            endRoll()
        }
    }

    private func showHoverRing(at p: CGPoint) {
        let kind = context.tool.kind
        guard UIPencilInteraction.prefersHoverToolPreview, kind == .eraser || kind == .lasso, roll?.start == nil,
              let v = views.values.first(where: { $0.bounds.contains(overlay.convert(p, to: $0)) }) else { return hoverRing.hide() }
        // The page's scale on screen (the zoom), from the section to the overlay.
        let scale = v.convert(CGRect(x: 0, y: 0, width: 100, height: 0), to: overlay).width / 100
        if kind == .eraser {
            hoverRing.show(at: p, diameter: CGFloat(context.tool.eraserSize) * scale, dashed: false)
        } else {
            hoverRing.show(at: p, diameter: 18, dashed: true)
        }
    }

    /// Rolling the Pencil over the selection box turns the selection; leaving the box keeps the turn.
    private func rollChanged(_ g: UIHoverGestureRecognizer) {
        guard dragStart == nil, let sel = context.selection, let v = views[sel.sectionId],
              sel.box.insetBy(dx: -8, dy: -8).contains(g.location(in: v)) else { return endRoll() }
        let r = g.rollAngle
        guard var state = roll else {
            roll = (r, nil, 0)
            return
        }
        let delta = BarrelRoll.delta(r, from: state.base)
        if state.start == nil {
            guard abs(delta) >= BarrelRoll.threshold else { return }
            state.start = v.canvas.drawing
            hoverRing.hide()
            for f in [lassoAsk, lassoEdit, lassoColors] { f.close() }
            overlay.lassoCircle?.isHidden = true
        }
        let angle = BarrelRoll.angle(for: delta)
        if angle != state.angle, let start = state.start {
            if BarrelRoll.isDetent(angle) { haptics.alignmentOccurred(at: g.location(in: view)) }
            state.angle = angle
            v.setDrawing(rotated(start, by: angle, sel: sel), save: false)
            v.selectionView.transform = CGAffineTransform(rotationAngle: angle)
        }
        roll = state
    }

    private func rotated(_ drawing: PKDrawing, by angle: CGFloat, sel: InkSelection) -> PKDrawing {
        let t = BarrelRoll.rotation(angle, about: CGPoint(x: sel.box.midX, y: sel.box.midY))
        return PKDrawing(strokes: drawing.strokes.map { stroke in
            guard sel.keys.contains(StrokeCodec.key(stroke)) else { return stroke }
            var st = stroke
            st.transform = stroke.transform.concatenating(t)
            return st
        })
    }

    /// The Pencil left the box, touched down or went out of range: write the turn as one undo step.
    private func endRoll() {
        guard let state = roll else { return }
        roll = nil
        guard let start = state.start, let sel = context.selection, let v = views[sel.sectionId] else { return }
        v.selectionView.transform = .identity
        v.setDrawing(start, save: false)
        if state.angle != 0 {
            commit(rotated(start, by: state.angle, sel: sel), in: v, before: start, name: "Rotate")
        }
        refreshSelection(in: v)
    }

    private func cancelRoll() {
        guard let state = roll else { return }
        roll = nil
        guard let start = state.start, let sel = context.selection, let v = views[sel.sectionId] else { return }
        v.selectionView.transform = .identity
        v.setDrawing(start, save: false)
    }

    // MARK: Page menu

    private func pageMenu() -> UIMenu {
        let (i, count) = position
        let page = UIMenu(title: count > 0 ? "Page \(i + 1) of \(count)" : "Page", options: .displayInline, children: [
            UIAction(title: "Blank page after", image: UIImage(systemName: "plus.rectangle.portrait")) { [weak self] _ in self?.addSectionAfterCurrent() },
            UIAction(title: "Move up", image: UIImage(systemName: "arrow.up"), attributes: i <= 0 ? .disabled : []) { [weak self] _ in self?.moveCurrentSection(by: -1) },
            UIAction(title: "Move down", image: UIImage(systemName: "arrow.down"), attributes: i >= count - 1 ? .disabled : []) { [weak self] _ in self?.moveCurrentSection(by: 1) },
        ])
        let delete = UIAction(title: "Delete page…", image: UIImage(systemName: "trash"),
                              attributes: Sections.canDelete(count: count) ? .destructive : [.destructive, .disabled]) { [weak self] _ in
            self?.confirmDelete()
        }
        return UIMenu(children: [page, delete])
    }

    private func confirmDelete() {
        let alert = UIAlertController(title: "Delete this page?", message: "Its ink is kept, and two-finger tap undoes it.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Delete page", style: .destructive) { [weak self] _ in
            self?.overlay.closePanel()
            if self?.deleteCurrentSection() != nil { self?.note("Page deleted", seconds: 1.5) }
        })
        present(alert, animated: true)
    }
}

/// The lasso tool's Pencil: draws the loop instead of ink. A press on the selection box is the
/// box's (a drag), not a new loop.
@MainActor
final class PencilLassoRecognizer: UIGestureRecognizer {
    var onBegin: (CGPoint) -> Void = { _ in }
    var onMove: ([CGPoint]) -> Void = { _ in }
    var onEnd: (Bool) -> Void = { _ in }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard state == .possible, let t = touches.first, !(t.view is SelectionBoxView) else {
            if state == .possible { state = .failed }
            return
        }
        onBegin(t.location(in: view))
        state = .began
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = touches.first, state == .began || state == .changed else { return }
        onMove((event.coalescedTouches(for: t) ?? [t]).map { $0.location(in: view) })
        state = .changed
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard state == .began || state == .changed else { return }
        onEnd(false)
        state = .ended
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        guard state == .began || state == .changed else { return }
        onEnd(true)
        state = .cancelled
    }
}

import GRDB
import PencilKit
import UIKit

/// The notebook as one zoomable column of sections, 24 pt apart (NotebookEditor.tsx). Only the
/// sections near the viewport exist as views. Reports where the iPad is (presence), so a Mac
/// following it keeps up, and remembers the place per notebook.
@MainActor
final class NotebookViewController: UIViewController, UIScrollViewDelegate, PKToolPickerObserver {
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
    /// Tells the bar the text tool turned off (picking a pen in the tool picker does that).
    var onTextModeChange: (Bool) -> Void = { _ in }
    /// Tells the bar which section is current (index, count), for the section menu.
    var onSectionPositionChange: (Int, Int) -> Void = { _, _ in }
    private var lastPosition: (Int, Int)?

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

        // Two fingers tap to undo, three to redo (the web's defaults in Settings → Touch gestures).
        let undo = UITapGestureRecognizer(target: self, action: #selector(undoTap))
        undo.numberOfTouchesRequired = 2
        let redo = UITapGestureRecognizer(target: self, action: #selector(redoTap))
        redo.numberOfTouchesRequired = 3
        undo.require(toFail: redo)
        for g in [undo, redo] {
            g.allowedTouchTypes = [UITouch.TouchType.direct.rawValue as NSNumber]
            scrollView.addGestureRecognizer(g)
        }

        context.sync.isInking = { [weak context] in !(context?.inking.isEmpty ?? true) }
        context.toolPicker.addObserver(self)
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
        // The picker docks or floats with the new size class; keep it on the current canvas.
        if !context.textMode, let first = views.values.first(where: { $0.canvas.isFirstResponder }) {
            context.toolPicker.setVisible(true, forFirstResponder: first.canvas)
        }
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
        // The tool picker shows while a canvas is first responder; that needs the view in a window.
        // With the text tool a text box editor may hold focus, so leave it.
        if view.window != nil, !context.textMode, !views.values.contains(where: { $0.canvas.isFirstResponder }),
           let id = currentSection()?.id, let v = views[id] {
            v.canvas.becomeFirstResponder()
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        mountVisible()
        #if DEBUG
        // `-askDemo`: after launch, an Ask AI lasso around the top of the screen, for checking the
        // ask sheet in the simulator (which can't draw).
        if ProcessInfo.processInfo.arguments.contains("-askDemo") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self else { return }
                self.setAskMode(true)
                let r = self.view.bounds.insetBy(dx: 40, dy: 40)
                let loop = [CGPoint(x: r.minX, y: r.minY), CGPoint(x: r.maxX, y: r.minY), CGPoint(x: r.maxX, y: r.minY + 420), CGPoint(x: r.minX, y: r.minY + 420)]
                self.askLasso?.onFinish(loop)
            }
        }
        #endif
    }

    // MARK: Scrolling and zoom

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { column }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centerColumn()
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
        let position = (i, sections.count)
        if lastPosition.map({ $0 != position }) ?? true {
            lastPosition = position
            onSectionPositionChange(i, sections.count)
        }
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

    // MARK: Ask AI

    /// Called with what an Ask AI lasso caught; the bar shows the ask sheet for it.
    var onAsk: (AskCapture) -> Void = { _ in }
    var onAskModeChange: (Bool) -> Void = { _ in }
    private var askLasso: AskLassoView?

    /// Ask AI: a lasso drawn over the page picks what to ask about. Scrolling and ink pause until
    /// it's drawn or Ask AI is turned off.
    func setAskMode(_ on: Bool) {
        guard on != (askLasso != nil) else { return }
        if on {
            let lasso = AskLassoView(frame: scrollView.frame)
            lasso.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            lasso.onFinish = { [weak self] loop in
                guard let self else { return }
                let capture = self.capture(loop: loop, from: lasso)
                self.setAskMode(false)
                if let capture { self.onAsk(capture) }
            }
            view.addSubview(lasso)
            askLasso = lasso
        } else {
            askLasso?.removeFromSuperview()
            askLasso = nil
        }
        onAskModeChange(on)
    }

    /// The section the loop was mostly drawn on, the strokes it encloses (or, with none, the area
    /// inside it, so a printed question can be asked about too) and the picture of it.
    private func capture(loop: [CGPoint], from lasso: UIView) -> AskCapture? {
        let candidates = views.values.map { v in (v, loop.map { lasso.convert($0, to: v) }) }
        guard let (v, poly) = candidates.max(by: { a, b in
            a.1.filter(a.0.bounds.contains).count < b.1.filter(b.0.bounds.contains).count
        }), poly.contains(where: v.bounds.contains) else { return nil }
        let picked = AskSelection.enclosed(v.canvas.drawing.strokes, by: poly)
        let area = poly.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: .zero)) }.intersection(v.bounds)
        guard let box = AskSelection.box(picked) ?? (area.isNull ? nil : area),
              let png = AskSelection.png(of: v, box: box), let image = UIImage(data: png) else { return nil }
        let data = v.section.data
        let pdf = data["pdf"].flatMap { p in p["name"]?.string.map { (name: $0, page: Int(p["page"]?.int ?? 1)) } }
        return AskCapture(notebookId: context.notebookId, sectionId: v.section.id, sectionTitle: data["title"]?.string,
                          index: v.index, pdf: pdf, png: png, pixelSize: CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale))
    }

    // MARK: Text tool

    func setTextMode(_ on: Bool) {
        guard on != context.textMode else { return }
        context.textMode = on
        updatePencilInteraction()
        views.values.forEach { $0.setTextMode(on) }
        onTextModeChange(on)
        if !on { mountVisible() }
    }

    func toolPickerSelectedToolItemDidChange(_ toolPicker: PKToolPicker) {
        setTextMode(false)
        context.rememberTool()
    }

    // MARK: Apple Pencil

    /// The tool picker answers double tap and squeeze while it shows. With the text tool it's
    /// hidden, so either gesture (unless set to "ignore" in Settings) goes back to ink instead.
    private lazy var pencil: UIPencilInteraction = {
        let interaction = UIPencilInteraction(delegate: self)
        interaction.isEnabled = false
        return interaction
    }()

    private func updatePencilInteraction() {
        pencil.isEnabled = context.textMode
    }

    // MARK: Undo

    // PencilKit registers its undo steps with the window's undo manager.
    @objc func undoTap() { view.window?.undoManager?.undo() }
    @objc func redoTap() { view.window?.undoManager?.redo() }
}

extension NotebookViewController: UIPencilInteractionDelegate {
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        guard context.textMode, Tools.leavesTextTool(for: UIPencilInteraction.preferredTapAction) else { return }
        setTextMode(false)
    }

    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        guard squeeze.phase == .ended, context.textMode,
              Tools.leavesTextTool(for: UIPencilInteraction.preferredSqueezeAction) else { return }
        setTextMode(false)
    }
}

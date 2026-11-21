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
    private let scrollView = UIScrollView()
    private let column = UIView()
    private var sections: [Entity] = []
    private var heights: [String: CGFloat] = [:]
    private var tops: [CGFloat] = []
    private var views: [String: SectionView] = [:]
    private var observation: Task<Void, Never>?
    private var restored = false
    private var presenceTimer: Timer?
    private var lastPresence = Date.distantPast
    private var lastSectionId: String?
    private var fitted = false

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
        scrollView.maximumZoomScale = 4
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.alwaysBounceVertical = true
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.delaysContentTouches = false
        scrollView.frame = view.bounds
        scrollView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(scrollView)
        scrollView.addSubview(column)

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
        observeSections()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Fit the page width; 1:1 on the 13" in landscape, smaller in portrait or a narrow window.
        let fit = view.bounds.width / SectionView.pageWidth
        if !fitted || abs(scrollView.minimumZoomScale - min(0.5, fit)) > 0.001 {
            scrollView.minimumZoomScale = min(0.5, fit)
            if !fitted, view.bounds.width > 0 {
                fitted = true
                scrollView.zoomScale = fit
            }
        }
        layoutColumn()
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
        for s in next {
            if let v = views[s.id] {
                if v.section != s { v.apply(section: s) }
            } else if heights[s.id] == nil {
                heights[s.id] = SectionView.baseHeight(s)
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
    }

    private func layoutColumn() {
        var y: CGFloat = Self.gap
        tops = sections.map { s in
            defer { y += (heights[s.id] ?? SectionView.baseHeight(s)) + Self.gap }
            return y
        }
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
        for (i, s) in sections.enumerated() {
            let top = tops[i], bottom = top + (heights[s.id] ?? 0)
            guard bottom >= lower, top <= upper else { continue }
            wanted.insert(s.id)
            if views[s.id] == nil {
                let v = SectionView(section: s, context: context)
                v.onHeightChange = { [weak self, weak v] in
                    guard let self, let v else { return }
                    self.heights[v.section.id] = v.height
                    self.layoutColumn()
                }
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
        // The tool picker shows while a canvas is first responder; that needs the view in a window.
        if view.window != nil, !views.values.contains(where: { $0.canvas.isFirstResponder }),
           let id = currentSection()?.id, let v = views[id] {
            v.canvas.becomeFirstResponder()
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        mountVisible()
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
        mountVisible()
        guard restored else { return }
        let current = currentSection()?.id
        if current != lastSectionId {
            lastSectionId = current
            if let current { try? context.database.log(event(type: "focus", sectionId: current)) }
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

    // MARK: Undo

    // PencilKit registers its undo steps with the window's undo manager.
    @objc func undoTap() { view.window?.undoManager?.undo() }
    @objc func redoTap() { view.window?.undoManager?.redo() }
}

import GRDB
import PencilKit
import UIKit

/// What every section of an open notebook shares.
@MainActor
final class EditorContext {
    let notebookId: String
    let database: AppDatabase
    let sync: SyncEngine
    /// Canvases with the Pencil down; sync holds off while any is.
    var inking = Set<ObjectIdentifier>()
    /// The current tool, colours and sizes (the web's `padsync.tool`).
    var tool: ToolState
    /// The text tool: taps add and edit text boxes instead of the canvas taking input.
    var textMode: Bool { tool.kind == .text }
    /// The selection a section shows (its dashed box), and how it reports a drag of it.
    var selection: InkSelection?
    /// Waiting for a tap to paste copied ink: the Pencil doesn't draw meanwhile.
    var pasting = false
    var onSelectionDrag: (SectionView, CGPoint, UIGestureRecognizer.State) -> Void = { _, _, _ in }
    /// A handle on the selection box dragged by (section units) so far.
    var onSelectionResize: (SectionView, BoxHandle, CGPoint, UIGestureRecognizer.State) -> Void = { _, _, _, _ in }
    /// The picture whose crop frame is open: its frame stands in for the selection box.
    var cropping: String?

    init(notebookId: String, database: AppDatabase, sync: SyncEngine, tool: ToolState = ToolState()) {
        self.notebookId = notebookId
        self.database = database
        self.sync = sync
        self.tool = tool
    }
}

/// A canvas without PencilKit's own edit menu ("Select All | Insert Space"), which pops up on a
/// tap or hold; the notebook has its own lasso and page menu. Undo and redo still go through.
final class QuietCanvasView: PKCanvasView {
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        let name = NSStringFromSelector(action)
        return name == "undo:" || name == "redo:" ? super.canPerformAction(action, withSender: sender) : false
    }

    override func addInteraction(_ interaction: UIInteraction) {
        guard !(interaction is UIEditMenuInteraction) else { return }
        super.addInteraction(interaction)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        for case let menu as UIEditMenuInteraction in interactions { removeInteraction(menu) }
    }
}

/// One section of the notebook in section coordinates (1376 wide, like the web's PAGE_WIDTH):
/// paper, PDF page, title, text boxes and a PencilKit canvas. Drawing changes become entity
/// writes; rows that arrive from sync redraw the canvas.
@MainActor
final class SectionView: UIView, PKCanvasViewDelegate, UIGestureRecognizerDelegate {
    nonisolated static let pageWidth: CGFloat = 1376

    private(set) var section: Entity
    let context: EditorContext
    /// Asks the notebook to lay out again after the section's height changed.
    var onHeightChange: () -> Void = {}

    private let paper = PaperView()
    private let pdfView = UIImageView()
    private let pdfStatus = UILabel()
    private let titleLabel = UILabel()
    /// The header and blocks, rendered by the web's components (BlockRenderer).
    private let blocksView = UIImageView()
    private var blocksTask: Task<Void, Never>?
    private var contentHeight: CGFloat = 0
    /// Position in the notebook, for the "Section N" fallback title.
    let index: Int
    private var textViews: [TextBoxView] = []
    private var editor: TextBoxEditor?
    private let textTap = UITapGestureRecognizer()
    let canvas = QuietCanvasView()
    let selectionView = SelectionBoxView()
    /// Whether the ink, blocks and PDF page have loaded, for drawing the section off screen.
    private(set) var strokesLoaded = false
    private var blocksSettled = false
    private var pdfSettled = false

    /// Live strokes as last written or read: id → hlc. Matching the store means nothing to redraw.
    private var known: [String: String] = [:]
    /// Strokes on the canvas by key, so a drawing change can be told apart from the last one.
    private var idsByKey: [StrokeCodec.Key: [String]] = [:]
    /// Each stroke's transform and colour as built, to spot a lasso move without comparing to
    /// stored strings (a web colour written another way must not count as a change).
    private var transforms: [String: CGAffineTransform] = [:]
    private var colors: [String: String] = [:]
    /// Erased this session, so an undo brings the same entity back instead of a copy.
    private var erased: [StrokeCodec.Key: Entity] = [:]
    private var entities: [String: Entity] = [:]
    private var textboxes: [Entity] = []
    /// Pictures on the page (kind "image", src/lib/page-images.ts), under the ink.
    private(set) var images: [Entity] = []
    private let imageLayer = UIView()
    private var imageViews: [String: UIImageView] = [:]
    /// The src each view shows, by its hash, so a move doesn't decode again.
    private var shownSrc: [String: Int] = [:]
    private var imagesLoaded = false
    /// Pictures being dragged: drawn in the floating copy instead.
    var hiddenImages: Set<String> = [] { didSet { imageViews.forEach { $0.value.isHidden = hiddenImages.contains($0.key) } } }
    private var applying = false
    private var pendingRemote = false
    private var observation: Task<Void, Never>?
    private var pdfTask: Task<Void, Never>?
    private var renderedScale: CGFloat = 0

    private(set) var height: CGFloat

    init(section: Entity, index: Int, context: EditorContext) {
        self.section = section
        self.index = index
        self.context = context
        self.height = Self.baseHeight(section, index: index)
        super.init(frame: CGRect(x: 0, y: 0, width: Self.pageWidth, height: height))
        backgroundColor = .white
        clipsToBounds = true
        // Paper is always light (`.paper { color-scheme: light }`); in dark mode PencilKit would
        // otherwise invert the ink to near-white.
        overrideUserInterfaceStyle = .light

        addSubview(paper)
        pdfView.contentMode = .scaleToFill
        addSubview(pdfView)
        pdfStatus.font = .preferredFont(forTextStyle: .footnote)
        pdfStatus.textColor = .secondaryLabel
        addSubview(pdfStatus)
        titleLabel.font = .systemFont(ofSize: 26, weight: .semibold)
        titleLabel.textColor = UIColor(hex: "#0f172a")
        titleLabel.numberOfLines = 0
        addSubview(titleLabel)
        addSubview(blocksView)
        imageLayer.isUserInteractionEnabled = false
        addSubview(imageLayer)

        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.isScrollEnabled = false
        canvas.contentInsetAdjustmentBehavior = .never
        canvas.drawingPolicy = Tools.drawingPolicy
        canvas.scrollsToTop = false
        canvas.delegate = self
        addSubview(canvas)
        selectionView.isHidden = true
        selectionView.onDrag = { [weak self] d, state in
            guard let self else { return }
            self.context.onSelectionDrag(self, d, state)
        }
        selectionView.onResize = { [weak self] h, d, state in
            guard let self else { return }
            self.context.onSelectionResize(self, h, d, state)
        }
        addSubview(selectionView)

        textTap.addTarget(self, action: #selector(addTextBox(_:)))
        textTap.delegate = self
        addGestureRecognizer(textTap)
        applyTool()

        apply(section: section)
        observe()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Stops observing; the notebook calls this before dropping an off-screen section.
    func teardown() {
        observation?.cancel()
        pdfTask?.cancel()
        blocksTask?.cancel()
        editor?.resignFirstResponder()
        context.inking.remove(ObjectIdentifier(canvas))
    }

    // MARK: Section data

    func apply(section: Entity) {
        self.section = section
        let data = section.data
        paper.template = data["template"]?.string ?? "plain"
        if let pdf = data["pdf"] {
            titleLabel.isHidden = true
            pdfView.isHidden = false
            pdfStatus.text = "PDF page \(pdf["page"]?.int ?? 0) · loading"
        } else {
            pdfView.isHidden = true
            pdfStatus.text = nil
            titleLabel.isHidden = false
            titleLabel.text = data["title"]?.string
        }
        renderBlocks()
        relayout()
    }

    /// The section's height before ink: its minimum, or the rendered content + 80 (SectionView.tsx).
    /// Before the first render, room for the title.
    static func baseHeight(_ section: Entity, index: Int) -> CGFloat {
        let content = BlockRenderer.hasContent(section) ? BlockRenderer.shared.cachedContentHeight(section, index: index).map { $0 + 80 } ?? 136 : 136
        return CGFloat(max(section.data["minHeight"]?.double ?? 0, content))
    }

    /// Renders the header and blocks behind the canvas. The plain title label stands in until the
    /// first render, and stays if the renderer fails.
    private func renderBlocks() {
        blocksTask?.cancel()
        guard BlockRenderer.hasContent(section) else {
            blocksView.image = nil
            contentHeight = 0
            blocksSettled = true
            return
        }
        let section = section, index = index
        blocksTask = Task { [weak self] in
            do {
                let rendered = try await BlockRenderer.shared.render(section, index: index)
                guard let self, !Task.isCancelled else { return }
                self.blocksView.image = rendered.image
                self.contentHeight = rendered.contentHeight
                self.titleLabel.isHidden = true
                self.blocksSettled = true
                self.relayout()
            } catch {
                self?.blocksSettled = true
                print("padSync: block render failed for \(section.id): \(error)")
            }
        }
    }

    private func relayout() {
        let inkBottom = entities.values.map { StrokeCodec.bottom($0.data) }.max() ?? 0
        let textBottom = textboxes.map { ($0.data["y"]?.double ?? 0) + 120 }.max() ?? 0
        let imageBottom = images.map { Self.frame(ofImage: $0).maxY + 200 }.max() ?? 0
        // Sections grow as you write near the bottom, so there's always room below the ink (SectionView.tsx).
        let content = blocksView.image == nil ? Self.baseHeight(section, index: index) : max(CGFloat(section.data["minHeight"]?.double ?? 0), contentHeight + 80)
        let next = ceil(max(content, inkBottom + 360, textBottom + 200, imageBottom))
        let pdfHeight = CGFloat(section.data["pdf"]?["height"]?.double ?? 0)
        paper.frame = CGRect(x: 0, y: 0, width: Self.pageWidth, height: next)
        pdfView.frame = CGRect(x: 0, y: 0, width: Self.pageWidth, height: pdfHeight)
        pdfStatus.frame = CGRect(x: 24, y: 24, width: Self.pageWidth - 48, height: 20)
        let titleSize = titleLabel.sizeThatFits(CGSize(width: Self.pageWidth - 112, height: .greatestFiniteMagnitude))
        titleLabel.frame = CGRect(x: 56, y: 32, width: Self.pageWidth - 112, height: titleSize.height)
        if let image = blocksView.image {
            blocksView.frame = CGRect(x: 0, y: 0, width: Self.pageWidth, height: image.size.height * Self.pageWidth / max(image.size.width, 1))
        }
        canvas.frame = CGRect(x: 0, y: 0, width: Self.pageWidth, height: next)
        canvas.contentSize = canvas.bounds.size
        imageLayer.frame = canvas.frame
        if next != height {
            height = next
            bounds.size.height = next
            onHeightChange()
        }
    }

    // MARK: PDF page

    /// Renders the page for the notebook's zoom, at most once per pixel density.
    func renderPDF(zoom: CGFloat, displayScale: CGFloat) {
        guard let pdf = section.data["pdf"], let documentId = pdf["documentId"]?.string, let page = pdf["page"]?.int,
              let pageHeight = pdf["height"]?.double else {
            pdfSettled = true
            return
        }
        // Quarter steps between half and full screen density per page point, like pdfDensity.
        let scale = min(displayScale * 2, max(displayScale / 2, (displayScale * zoom * 4).rounded(.up) / 4))
        guard scale != renderedScale else { return }
        renderedScale = scale
        pdfTask?.cancel()
        let size = CGSize(width: Self.pageWidth, height: pageHeight)
        pdfTask = Task { [weak self] in
            let store = PDFStore.shared
            if self?.pdfView.image == nil, let quick = await store.cachedImage(documentId: documentId, page: Int(page), scales: [0.5, 1, 1.5, 2, 2.5, 3, 4]) {
                self?.showPDF(quick)
            }
            do {
                let image = try await store.image(documentId: documentId, page: Int(page), size: size, scale: scale)
                guard !Task.isCancelled else { return }
                self?.showPDF(image)
            } catch {
                guard !Task.isCancelled else { return }
                self?.renderedScale = 0
                self?.pdfSettled = true
                self?.pdfStatus.text = "PDF page \(page) · \(error.localizedDescription)"
            }
        }
    }

    private func showPDF(_ image: UIImage) {
        pdfView.image = image
        pdfStatus.text = nil
        pdfSettled = true
    }

    // MARK: Store → canvas

    private func observe() {
        let id = section.id, writer = context.database.writer
        observation = Task { [weak self] in
            // Track only ids and clocks; whole rows are read when something actually changed.
            let versions = ValueObservation.tracking { db in
                try Row.fetchAll(db, sql: "SELECT id, hlc, kind FROM entity WHERE parentId = ? AND deleted = 0 AND kind IN ('stroke', 'textbox', 'image')", arguments: [id])
                    .map { VersionRow(id: $0["id"], hlc: $0["hlc"], kind: $0["kind"]) }
            }.removeDuplicates().values(in: writer)
            do {
                for try await rows in versions {
                    guard let self else { return }
                    let strokes = Dictionary(uniqueKeysWithValues: rows.filter { $0.kind == "stroke" }.map { ($0.id, $0.hlc) })
                    let boxes = rows.filter { $0.kind == "textbox" }
                    if boxes.map(\.hlc) != self.textboxes.map(\.hlc) || boxes.map(\.id) != self.textboxes.map(\.id) {
                        self.textboxes = try await writer.read { db in try Entity.fetchAll(db, keys: boxes.map(\.id)) }
                        self.layoutTextboxes()
                    }
                    let pictures = rows.filter { $0.kind == "image" }
                    if pictures.map(\.hlc) != self.images.map(\.hlc) || pictures.map(\.id) != self.images.map(\.id) {
                        self.images = try await writer.read { db in try Entity.fetchAll(db, keys: pictures.map(\.id)) }
                        self.layoutImages()
                    }
                    self.imagesLoaded = true
                    guard strokes != self.known else { continue }
                    if !self.context.inking.contains(ObjectIdentifier(self.canvas)) {
                        try await self.reload(strokes: strokes)
                    } else {
                        self.pendingRemote = true
                    }
                }
            } catch {}
        }
    }

    private struct VersionRow: Equatable, Sendable {
        let id: String, hlc: String, kind: String
    }

    /// Brings the canvas up to date with the store. New strokes are appended to the drawing, which
    /// keeps PencilKit's undo for this canvas; a removed or changed stroke redraws it, which clears
    /// that undo (InkMerge).
    private func reload(strokes versions: [String: String]? = nil) async throws {
        let id = section.id
        let rows = try await context.database.writer.read { db in
            try Entity.filter(sql: "parentId = ? AND kind = 'stroke' AND deleted = 0", arguments: [id]).fetchAll(db)
        }
        // Highlighter first so pen ink stays on top, then by start time (paintStrokes).
        let ordered = rows.sorted { a, b in
            let ah = a.data["tool"]?.string == "highlighter", bh = b.data["tool"]?.string == "highlighter"
            return ah != bh ? ah : (a.data["t0"]?.double ?? 0) < (b.data["t0"]?.double ?? 0)
        }
        // The id each canvas stroke was drawn or read as.
        var unclaimed = idsByKey
        let current: [String?] = canvas.drawing.strokes.map { stroke in
            let key = StrokeCodec.key(stroke)
            guard var ids = unclaimed[key], !ids.isEmpty else { return nil }
            let id = ids.removeFirst()
            unclaimed[key] = ids
            return id
        }
        let plan = InkMerge.plan(current: current, known: known, rows: ordered.map {
            InkMerge.Row(id: $0.id, hlc: $0.hlc, highlighter: $0.data["tool"]?.string == "highlighter")
        })
        entities = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        known = entities.mapValues(\.hlc)
        var drawing = canvas.drawing
        switch plan {
        case .none:
            break
        case .append(let ids):
            var strokes: [PKStroke] = []
            for id in ids {
                guard let row = entities[id], let stroke = StrokeCodec.stroke(id: id, data: row.data) else { continue }
                strokes.append(stroke)
                track(stroke, id: id)
            }
            if !strokes.isEmpty { drawing.append(PKDrawing(strokes: strokes)) }
        case .redraw:
            var strokes: [PKStroke] = []
            idsByKey = [:]
            transforms = [:]
            colors = [:]
            for row in ordered {
                guard let stroke = StrokeCodec.stroke(id: row.id, data: row.data) else { continue }
                strokes.append(stroke)
                track(stroke, id: row.id)
            }
            drawing = PKDrawing(strokes: strokes)
        }
        if plan != .none {
            applying = true
            canvas.drawing = drawing
            applying = false
        }
        pendingRemote = false
        strokesLoaded = true
        relayout()
    }

    private func track(_ stroke: PKStroke, id: String) {
        idsByKey[StrokeCodec.key(stroke), default: []].append(id)
        transforms[id] = stroke.transform
        colors[id] = stroke.ink.color.hex
    }

    // MARK: Canvas → store

    func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
        context.inking.insert(ObjectIdentifier(canvasView))
    }

    func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        context.inking.remove(ObjectIdentifier(canvasView))
        if pendingRemote { Task { try? await reload() } }
    }

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        guard !applying else { return }
        var unmatched = idsByKey
        var nextKeys: [StrokeCodec.Key: [String]] = [:]
        var writes: [Entity] = []
        let device = context.database.device

        for stroke in canvasView.drawing.strokes {
            let key = StrokeCodec.key(stroke)
            if var ids = unmatched[key], !ids.isEmpty {
                let id = ids.removeFirst()
                unmatched[key] = ids
                nextKeys[key, default: []].append(id)
                // Moved with the lasso (or recoloured): same path, new transform or ink.
                if transforms[id] != stroke.transform || colors[id] != stroke.ink.color.hex, var e = entities[id] {
                    e.data = StrokeCodec.data(for: stroke, device: device)
                    writes.append(e)
                }
                transforms[id] = stroke.transform
                colors[id] = stroke.ink.color.hex
            } else if var restored = erased.removeValue(forKey: key) {
                // Undo of an erase: the same entity comes back.
                restored.deleted = false
                restored.data = StrokeCodec.data(for: stroke, device: device)
                writes.append(restored)
                nextKeys[key, default: []].append(restored.id)
                transforms[restored.id] = stroke.transform
                colors[restored.id] = stroke.ink.color.hex
            } else {
                let e = Entity(id: newId(), kind: .stroke, notebookId: context.notebookId, parentId: section.id,
                               data: StrokeCodec.data(for: stroke, device: device), hlc: "", deleted: false, dirty: true)
                writes.append(e)
                nextKeys[key, default: []].append(e.id)
                transforms[e.id] = stroke.transform
                colors[e.id] = stroke.ink.color.hex
            }
        }
        for (key, ids) in unmatched {
            for id in ids {
                guard var e = entities[id] else { continue }
                e.deleted = true
                writes.append(e)
                erased[key] = e
                transforms[id] = nil
                colors[id] = nil
            }
        }
        idsByKey = nextKeys
        guard !writes.isEmpty else { return }
        do {
            // Synchronous, so `known` matches before the store's observation reports this write.
            for e in try context.database.save(writes) {
                if e.deleted {
                    entities[e.id] = nil
                    known[e.id] = nil
                } else {
                    entities[e.id] = e
                    known[e.id] = e.hlc
                }
            }
            context.sync.requestSync()
            relayout()
        } catch {
            // The canvas keeps the ink; the next change retries the whole diff from what's stored.
        }
    }

    // MARK: Tools and selection

    /// Puts the current tool on the canvas: ink tools draw, the lasso and text tools take the
    /// Pencil away from PencilKit.
    func applyTool() {
        let tool = Tools.canvasTool(for: context.tool)
        if let tool { canvas.tool = tool }
        canvas.drawingGestureRecognizer.isEnabled = tool != nil && !context.pasting
        setTextMode(context.textMode)
        showSelection()
    }

    /// The dashed box when the selection is in this section.
    func showSelection() {
        guard let sel = context.selection, sel.sectionId == section.id, context.cropping == nil else {
            selectionView.isHidden = true
            return
        }
        selectionView.frame = sel.box.insetBy(dx: -8, dy: -8)
        selectionView.showsHandles = !sel.keys.isEmpty || !sel.images.isEmpty
        selectionView.setNeedsLayout()
        selectionView.isHidden = false
        bringSubviewToFront(selectionView)
    }

    /// Replaces the canvas's strokes. `save` writes the change (with the usual diff); without it
    /// the canvas only shows it, as during a drag.
    func setDrawing(_ drawing: PKDrawing, save: Bool) {
        applying = true
        canvas.drawing = drawing
        applying = false
        if save { canvasViewDrawingDidChange(canvas) }
    }

    /// Waits (up to `timeout`) for the ink, blocks and PDF page, for drawing off screen.
    func settle(timeout: TimeInterval = 5) async {
        renderPDF(zoom: 1, displayScale: 2)
        let end = Date.now.addingTimeInterval(timeout)
        while Date.now < end, !(strokesLoaded && blocksSettled && pdfSettled && imagesLoaded) {
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    /// The section as shown (paper, PDF, blocks, text boxes and ink, no selection box) at `scale`
    /// pixels per page unit. Composed from its parts so it works off screen too.
    func snapshot(scale: CGFloat) -> UIImage {
        let size = bounds.size
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        let hidden = selectionView.isHidden
        selectionView.isHidden = true
        canvas.isHidden = true
        defer {
            canvas.isHidden = false
            selectionView.isHidden = hidden
        }
        let ink = canvas.drawing.image(from: CGRect(origin: .zero, size: size), scale: scale)
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            layer.render(in: ctx.cgContext)
            ink.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    // MARK: Pictures

    /// Where a picture sits on the page.
    static func frame(ofImage e: Entity) -> CGRect {
        CGRect(x: e.data["x"]?.double ?? 0, y: e.data["y"]?.double ?? 0, width: e.data["w"]?.double ?? 0, height: e.data["h"]?.double ?? 0)
    }

    /// Decoded pictures by src, shared by every section (a duplicate decodes once).
    private static let decoded = NSCache<NSString, UIImage>()

    static func image(src: String) -> UIImage? {
        if let hit = decoded.object(forKey: src as NSString) { return hit }
        guard let comma = src.firstIndex(of: ","), src.hasPrefix("data:image/"),
              let data = Data(base64Encoded: String(src[src.index(after: comma)...])), let image = UIImage(data: data) else { return nil }
        decoded.setObject(image, forKey: src as NSString)
        return image
    }

    /// Shows image rows just written here before the store reports them: added, moved in, moved
    /// out or deleted.
    func mergeImages(_ rows: [Entity]) {
        var next = images
        for r in rows {
            next.removeAll { $0.id == r.id }
            if r.parentId == section.id && !r.deleted { next.append(r) }
        }
        images = next
        layoutImages()
    }

    private func layoutImages() {
        let live = Set(images.map(\.id))
        for (id, v) in imageViews where !live.contains(id) {
            v.removeFromSuperview()
            imageViews[id] = nil
            shownSrc[id] = nil
        }
        for e in images {
            let v = imageViews[e.id] ?? {
                let v = UIImageView()
                v.contentMode = .scaleToFill
                imageLayer.addSubview(v)
                imageViews[e.id] = v
                return v
            }()
            let src = e.data["src"]?.string ?? ""
            if shownSrc[e.id] != src.hashValue {
                v.image = Self.image(src: src)
                shownSrc[e.id] = src.hashValue
            }
            v.frame = Self.frame(ofImage: e)
            v.isHidden = hiddenImages.contains(e.id)
        }
        relayout()
    }

    // MARK: Text boxes

    /// Text boxes sit above the canvas but take touches only with the text tool, when the canvas
    /// takes none; the canvas's own input is off then, so the Pencil can't draw by mistake.
    func setTextMode(_ on: Bool) {
        canvas.isUserInteractionEnabled = !on
        textTap.isEnabled = on
        textViews.forEach { $0.interactive = on }
        if !on { editor?.resignFirstResponder() }
    }

    private func layoutTextboxes() {
        var old = Dictionary(uniqueKeysWithValues: textViews.map { ($0.box.id, $0) })
        textViews = textboxes.map { box in
            let view = old.removeValue(forKey: box.id) ?? makeTextView(box)
            if view.box != box { view.update(box) }
            // The open editor stands in for its box.
            view.isHidden = editor?.box.id == box.id
            return view
        }
        old.values.forEach { $0.removeFromSuperview() }
        relayout()
    }

    /// Taps on a box or the editor are theirs; only taps on the paper add a box.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        !(touch.view is TextBoxView || touch.view?.superview is TextBoxView || touch.view is TextBoxEditor)
    }

    private func makeTextView(_ box: Entity) -> TextBoxView {
        let view = TextBoxView(box: box)
        view.interactive = context.textMode
        let id = box.id
        view.onEdit = { [weak self] in self?.editText(id) }
        view.onMove = { [weak self] dx, dy in self?.saveText(id) { TextBoxes.moved($0, dx: dx, dy: dy) } }
        view.onResize = { [weak self] w in self?.saveText(id) { TextBoxes.resized($0, width: w) } }
        view.onDelete = { [weak self] in self?.deleteText(id) }
        insertSubview(view, aboveSubview: canvas)
        return view
    }

    /// The text tool's tap on empty paper: a new box there, opened for typing (onTextCreate).
    @objc private func addTextBox(_ g: UITapGestureRecognizer) {
        guard editor == nil else {
            editor?.resignFirstResponder()
            return
        }
        let p = g.location(in: self)
        let box = Entity(id: newId(), kind: .textbox, notebookId: context.notebookId, parentId: section.id,
                         data: TextBoxes.newData(x: p.x.rounded(), y: p.y.rounded()), hlc: "", deleted: false, dirty: true)
        guard let saved = try? context.database.save([box]).first else { return }
        logText("text_create", data: ["id": .string(saved.id)])
        context.sync.requestSync()
        textboxes.append(saved)
        layoutTextboxes()
        editText(saved.id)
    }

    private func editText(_ id: String) {
        // Tapping another box while editing saves the open one first.
        editor?.resignFirstResponder()
        guard editor == nil, let box = textboxes.first(where: { $0.id == id }) else { return }
        let editor = TextBoxEditor(box: box)
        editor.onDone = { [weak self, weak editor] text in
            guard let self, let editor else { return }
            editor.removeFromSuperview()
            self.editor = nil
            self.finishEdit(box.id, text: text)
        }
        self.editor = editor
        addSubview(editor)
        layoutTextboxes()
        editor.becomeFirstResponder()
    }

    /// Saves the edit against the newest copy of the box, so a move from another device survives.
    private func finishEdit(_ id: String, text: String) {
        guard let box = textboxes.first(where: { $0.id == id }) else { return layoutTextboxes() }
        let next = TextBoxes.edited(box, text: text)
        if next.deleted || next.data != box.data {
            write(next)
            if next.deleted { logText("text_delete", data: ["id": .string(id)]) }
            else { logText("text_edit", data: ["id": .string(id), "length": .int(Int64(text.count))]) }
        } else {
            layoutTextboxes()
        }
    }

    private func saveText(_ id: String, _ change: (JSONValue) -> JSONValue) {
        guard var box = textboxes.first(where: { $0.id == id }) else { return }
        box.data = change(box.data)
        write(box)
    }

    private func deleteText(_ id: String) {
        guard var box = textboxes.first(where: { $0.id == id }) else { return }
        box.deleted = true
        write(box)
        logText("text_delete", data: ["id": .string(id)])
    }

    /// Writes a box and shows it at once, ahead of the store's observation.
    private func write(_ box: Entity) {
        guard let saved = try? context.database.save([box]).first else { return layoutTextboxes() }
        if saved.deleted { textboxes.removeAll { $0.id == saved.id } }
        else if let i = textboxes.firstIndex(where: { $0.id == saved.id }) { textboxes[i] = saved }
        context.sync.requestSync()
        layoutTextboxes()
    }

    private func logText(_ type: String, data: [String: JSONValue]) {
        try? context.database.log(PadEvent(id: newId(), notebookId: context.notebookId, sectionId: section.id, type: type,
                                           t: Int64(Date.now.timeIntervalSince1970 * 1000), device: context.database.device,
                                           data: .object(data), synced: false))
    }
}

/// The paper templates from globals.css (.template-dots, -grid, -lines) as pattern fills.
final class PaperView: UIView {
    var template = "plain" {
        didSet { if template != oldValue { updatePattern() } }
    }
    private let pattern = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        isUserInteractionEnabled = false
        addSubview(pattern)
        updatePattern()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        // A pattern tiles from its view's origin, so shift the view by CSS's background-position
        // (less one period, to cover the top-left edge).
        let (period, offset): (CGSize, CGPoint) = switch template {
        case "dots": (CGSize(width: 28, height: 28), CGPoint(x: 14, y: 14))
        case "lines": (CGSize(width: 8, height: 36), CGPoint(x: 0, y: 24))
        default: (CGSize(width: 28, height: 28), .zero)
        }
        pattern.frame = CGRect(x: offset.x - period.width, y: offset.y - period.height,
                               width: bounds.width + 2 * period.width, height: bounds.height + 2 * period.height)
    }

    private func updatePattern() {
        pattern.backgroundColor = Self.tile(template).map(UIColor.init(patternImage:)) ?? .clear
        setNeedsLayout()
    }

    private static func tile(_ template: String) -> UIImage? {
        switch template {
        case "dots":
            return UIGraphicsImageRenderer(size: CGSize(width: 28, height: 28)).image { _ in
                UIColor(hex: "#cbd5e1")!.setFill()
                UIBezierPath(ovalIn: CGRect(x: 14 - 1.1, y: 14 - 1.1, width: 2.2, height: 2.2)).fill()
            }
        case "grid":
            return UIGraphicsImageRenderer(size: CGSize(width: 28, height: 28)).image { ctx in
                UIColor(hex: "#e2e8f0")!.setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: 28, height: 1))
                ctx.fill(CGRect(x: 0, y: 0, width: 1, height: 28))
            }
        case "lines":
            return UIGraphicsImageRenderer(size: CGSize(width: 8, height: 36)).image { ctx in
                UIColor(hex: "#dbe3ee")!.setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: 8, height: 1))
            }
        default:
            return nil
        }
    }
}

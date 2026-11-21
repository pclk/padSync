import GRDB
import PencilKit
import UIKit

/// What every section of an open notebook shares.
@MainActor
final class EditorContext {
    let notebookId: String
    let database: AppDatabase
    let sync: SyncEngine
    let toolPicker: PKToolPicker
    /// Canvases with the Pencil down; sync holds off while any is.
    var inking = Set<ObjectIdentifier>()

    init(notebookId: String, database: AppDatabase, sync: SyncEngine, toolPicker: PKToolPicker) {
        self.notebookId = notebookId
        self.database = database
        self.sync = sync
        self.toolPicker = toolPicker
    }
}

/// One section of the notebook in section coordinates (1376 wide, like the web's PAGE_WIDTH):
/// paper, PDF page, title, text boxes and a PencilKit canvas. Drawing changes become entity
/// writes; rows that arrive from sync redraw the canvas.
@MainActor
final class SectionView: UIView, PKCanvasViewDelegate {
    static let pageWidth: CGFloat = 1376

    private(set) var section: Entity
    let context: EditorContext
    /// Asks the notebook to lay out again after the section's height changed.
    var onHeightChange: () -> Void = {}

    private let paper = PaperView()
    private let pdfView = UIImageView()
    private let pdfStatus = UILabel()
    private let titleLabel = UILabel()
    private var textLabels: [UILabel] = []
    let canvas = PKCanvasView()

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
    private var applying = false
    private var pendingRemote = false
    private var observation: Task<Void, Never>?
    private var pdfTask: Task<Void, Never>?
    private var renderedScale: CGFloat = 0

    private(set) var height: CGFloat

    init(section: Entity, context: EditorContext) {
        self.section = section
        self.context = context
        self.height = Self.baseHeight(section)
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

        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.isScrollEnabled = false
        canvas.contentInsetAdjustmentBehavior = .never
        #if targetEnvironment(simulator)
        canvas.drawingPolicy = .anyInput
        #else
        canvas.drawingPolicy = .pencilOnly
        #endif
        canvas.delegate = self
        addSubview(canvas)
        context.toolPicker.addObserver(canvas)
        context.toolPicker.setVisible(true, forFirstResponder: canvas)

        apply(section: section)
        observe()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Stops observing; the notebook calls this before dropping an off-screen section.
    func teardown() {
        observation?.cancel()
        pdfTask?.cancel()
        context.toolPicker.removeObserver(canvas)
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
        relayout()
    }

    /// The section's height before ink: its minimum, or room for the title (blocks render in phase 3b).
    static func baseHeight(_ section: Entity) -> CGFloat {
        CGFloat(max(section.data["minHeight"]?.double ?? 0, 136))
    }

    private func relayout() {
        let inkBottom = entities.values.map { StrokeCodec.bottom($0.data) }.max() ?? 0
        let textBottom = textboxes.map { ($0.data["y"]?.double ?? 0) + 120 }.max() ?? 0
        // Sections grow as you write near the bottom, so there's always room below the ink (SectionView.tsx).
        let next = ceil(max(Self.baseHeight(section), inkBottom + 360, textBottom + 200))
        let pdfHeight = CGFloat(section.data["pdf"]?["height"]?.double ?? 0)
        paper.frame = CGRect(x: 0, y: 0, width: Self.pageWidth, height: next)
        pdfView.frame = CGRect(x: 0, y: 0, width: Self.pageWidth, height: pdfHeight)
        pdfStatus.frame = CGRect(x: 24, y: 24, width: Self.pageWidth - 48, height: 20)
        let titleSize = titleLabel.sizeThatFits(CGSize(width: Self.pageWidth - 112, height: .greatestFiniteMagnitude))
        titleLabel.frame = CGRect(x: 56, y: 32, width: Self.pageWidth - 112, height: titleSize.height)
        canvas.frame = CGRect(x: 0, y: 0, width: Self.pageWidth, height: next)
        canvas.contentSize = canvas.bounds.size
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
              let pageHeight = pdf["height"]?.double else { return }
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
                self?.pdfStatus.text = "PDF page \(page) · \(error.localizedDescription)"
            }
        }
    }

    private func showPDF(_ image: UIImage) {
        pdfView.image = image
        pdfStatus.text = nil
    }

    // MARK: Store → canvas

    private func observe() {
        let id = section.id, writer = context.database.writer
        observation = Task { [weak self] in
            // Track only ids and clocks; whole rows are read when something actually changed.
            let versions = ValueObservation.tracking { db in
                try Row.fetchAll(db, sql: "SELECT id, hlc, kind FROM entity WHERE parentId = ? AND deleted = 0 AND kind IN ('stroke', 'textbox')", arguments: [id])
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

    /// Redraws the canvas from the store. Clears PencilKit's undo history for this canvas.
    private func reload(strokes versions: [String: String]? = nil) async throws {
        let id = section.id
        let rows = try await context.database.writer.read { db in
            try Entity.filter(sql: "parentId = ? AND kind = 'stroke' AND deleted = 0", arguments: [id]).fetchAll(db)
        }
        entities = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        known = entities.mapValues(\.hlc)
        // Highlighter first so pen ink stays on top, then by start time (paintStrokes).
        let ordered = rows.sorted { a, b in
            let ah = a.data["tool"]?.string == "highlighter", bh = b.data["tool"]?.string == "highlighter"
            return ah != bh ? ah : (a.data["t0"]?.double ?? 0) < (b.data["t0"]?.double ?? 0)
        }
        var strokes: [PKStroke] = []
        idsByKey = [:]
        transforms = [:]
        colors = [:]
        for row in ordered {
            guard let stroke = StrokeCodec.stroke(id: row.id, data: row.data) else { continue }
            strokes.append(stroke)
            idsByKey[StrokeCodec.key(stroke), default: []].append(row.id)
            transforms[row.id] = stroke.transform
            colors[row.id] = stroke.ink.color.hex
        }
        applying = true
        canvas.drawing = PKDrawing(strokes: strokes)
        applying = false
        pendingRemote = false
        relayout()
    }

    // MARK: Canvas → store

    func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
        context.inking.insert(ObjectIdentifier(canvasView))
        if !canvasView.isFirstResponder { canvasView.becomeFirstResponder() }
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

    // MARK: Text boxes

    private func layoutTextboxes() {
        textLabels.forEach { $0.removeFromSuperview() }
        textLabels = textboxes.map { box in
            let label = UILabel()
            let d = box.data
            label.text = d["text"]?.string
            label.numberOfLines = 0
            label.font = .systemFont(ofSize: CGFloat(d["fontSize"]?.double ?? 20))
            label.textColor = UIColor(hex: d["color"]?.string) ?? .black
            let width = CGFloat(d["w"]?.double ?? 300)
            let size = label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
            label.frame = CGRect(x: d["x"]?.double ?? 0, y: d["y"]?.double ?? 0, width: width, height: size.height)
            insertSubview(label, belowSubview: canvas)
            return label
        }
        relayout()
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

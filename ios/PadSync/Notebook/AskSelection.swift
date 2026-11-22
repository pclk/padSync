import PencilKit
import UIKit

/// The native half of the web's lasso → Ask AI (`cropSelection` in src/lib/ask-bundle.ts and
/// `selectionText` in src/lib/context.ts): the section rendered at 2× and cropped to the selected
/// strokes plus a 24 pt margin, and the `selection.md` that goes with it.
enum AskSelection {
    /// Margin around the lasso box, in page units (the web's `pad`).
    nonisolated static let pad: CGFloat = 24
    /// The web renderer caps a side at 16,384 px.
    nonisolated static let maxSide: CGFloat = 16_384

    /// The selected strokes' box in section coordinates, or nil for no strokes.
    nonisolated static func box(_ strokes: [PKStroke]) -> CGRect? {
        strokes.map(\.renderBounds).filter { !$0.isNull && !$0.isEmpty }.reduce(nil) { $0?.union($1) ?? $1 }
    }

    /// The web's `pointInPolygon` (src/ink/geometry.ts): even-odd, the loop closed back to its start.
    nonisolated static func contains(_ poly: [CGPoint], _ p: CGPoint) -> Bool {
        var inside = false
        var j = poly.count - 1
        for i in poly.indices {
            let a = poly[i], b = poly[j]
            if (a.y > p.y) != (b.y > p.y), p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x { inside.toggle() }
            j = i
        }
        return inside
    }

    /// The strokes a lasso along `poly` picks, the web's "enclose" mode (`lassoStrokes`): at
    /// least half of up to 24 evenly spaced points inside.
    nonisolated static func enclosed(_ strokes: [PKStroke], by poly: [CGPoint]) -> [PKStroke] {
        guard poly.count >= 3 else { return [] }
        let bounds = poly.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: .zero)) }
        return strokes.filter { stroke in
            guard stroke.renderBounds.intersects(bounds.insetBy(dx: -1, dy: -1)) else { return false }
            let pts = stroke.path.map { $0.location.applying(stroke.transform) }
            guard !pts.isEmpty else { return false }
            let every = max(1, pts.count / 24)
            let sampled = stride(from: 0, to: pts.count, by: every).map { pts[$0] }
            return sampled.filter { contains(poly, $0) }.count * 2 >= sampled.count
        }
    }

    /// The scale a section renders at: the asked one, lowered so neither side passes `maxSide`.
    nonisolated static func scale(for section: CGSize, asked: CGFloat = 2) -> CGFloat {
        min(asked, maxSide / max(section.width, 1), maxSide / max(section.height, 1))
    }

    /// The crop in pixels of a section rendered at `scale`: the box grown by `pad`, floored and
    /// ceiled to whole pixels like the web, clamped to the image, and at least 1 × 1.
    nonisolated static func cropRect(box: CGRect, section: CGSize, scale: CGFloat) -> CGRect {
        let w = (section.width * scale).rounded(.down), h = (section.height * scale).rounded(.down)
        let x0 = max(0, ((box.minX - pad) * scale).rounded(.down))
        let y0 = max(0, ((box.minY - pad) * scale).rounded(.down))
        let x1 = min(w, ((box.maxX + pad) * scale).rounded(.up))
        let y1 = min(h, ((box.maxY + pad) * scale).rounded(.up))
        return CGRect(x: min(x0, max(w - 1, 0)), y: min(y0, max(h - 1, 0)), width: max(1, x1 - x0), height: max(1, y1 - y0))
    }

    /// The selection as a PNG: the section view (paper, PDF, blocks, ink and text boxes, as shown)
    /// drawn at 2× and cropped. Nil when there's nothing selected or drawing fails.
    @MainActor static func png(of view: UIView, box: CGRect) -> Data? {
        let size = view.bounds.size
        guard size.width > 0, size.height > 0 else { return nil }
        let s = scale(for: size)
        let crop = cropRect(box: box, section: size, scale: s)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: crop.size, format: format).image { ctx in
            ctx.cgContext.translateBy(x: -crop.minX, y: -crop.minY)
            ctx.cgContext.scaleBy(x: s, y: s)
            view.drawHierarchy(in: CGRect(origin: .zero, size: size), afterScreenUpdates: true)
        }
        return image.pngData()
    }

    /// `selection.md`, the same text as the web's `selectionText` (index is 0-based).
    nonisolated static func markdown(notebookTitle: String, sectionTitle: String?, index: Int, pdf: (name: String, page: Int)?, hasImage: Bool, text: String? = nil) -> String {
        let title = sectionTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let notebook = notebookTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        var md = [
            "# Selection from section \(index + 1): \(title.isEmpty ? "Untitled" : title)",
            "_Notebook: \(notebook.isEmpty ? "Untitled notebook" : notebook). Only this selection was shared._",
        ]
        if let pdf { md.append("PDF: \(pdf.name) · page \(pdf.page)") }
        if hasImage { md.append("![The selected area, with my handwriting](selection.png)") }
        if let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { md += ["## Selected text", t] }
        return md.joined(separator: "\n\n") + "\n"
    }
}

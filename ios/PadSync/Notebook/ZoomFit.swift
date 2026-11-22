import CoreGraphics

/// Zoom and scroll maths for the column when the window changes size (rotation, Split View,
/// Stage Manager). The column is always `SectionView.pageWidth` wide in its own space, so a
/// reading position in column points survives any zoom.
enum ZoomFit {
    static let maximum: CGFloat = 4

    /// The zoom that makes the page fill the window's width (1 on the 13" in landscape).
    nonisolated static func fit(width: CGFloat) -> CGFloat {
        width / SectionView.pageWidth
    }

    /// Pinching out stops at half size, or lower when the window is narrower than that.
    nonisolated static func minimum(width: CGFloat) -> CGFloat {
        min(0.5, fit(width: width))
    }

    /// The zoom after the width changes: a page that filled the old width fills the new one;
    /// a zoom the user picked is kept, within the new limits.
    nonisolated static func refit(zoom: CGFloat, oldWidth: CGFloat, newWidth: CGFloat) -> CGFloat {
        if oldWidth <= 0 || abs(zoom - fit(width: oldWidth)) < 0.01 { return fit(width: newWidth) }
        return min(maximum, max(minimum(width: newWidth), zoom))
    }

    /// The content offset that puts `reading` (the column point at the viewport's top-left) back
    /// at the top-left at `zoom`, kept inside the content. A column narrower than the viewport is
    /// centred by the scroll view's inset, so x is then `-inset`.
    nonisolated static func offset(reading: CGPoint, zoom: CGFloat, viewport: CGSize, contentHeight: CGFloat) -> CGPoint {
        let contentWidth = SectionView.pageWidth * zoom
        let x: CGFloat = contentWidth <= viewport.width
            ? -(viewport.width - contentWidth) / 2
            : min(max(0, reading.x * zoom), contentWidth - viewport.width)
        // The column ends with 40% of the viewport of slack (centerColumn's bottom inset).
        let maxY = max(0, contentHeight * zoom + viewport.height * 0.4 - viewport.height)
        return CGPoint(x: x, y: min(max(0, reading.y * zoom), maxY))
    }
}

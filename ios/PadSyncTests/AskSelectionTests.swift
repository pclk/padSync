import PencilKit
import Testing
import UIKit
@testable import padSync

struct AskSelectionTests {
    private let section = CGSize(width: 1376, height: 1032)

    @Test func cropIsTheBoxPlusTheMarginAtTheScale() {
        let r = AskSelection.cropRect(box: CGRect(x: 100, y: 200, width: 300, height: 50), section: section, scale: 2)
        #expect(r == CGRect(x: 152, y: 352, width: 696, height: 196))
    }

    @Test func cropRoundsOutwardToWholePixels() {
        let r = AskSelection.cropRect(box: CGRect(x: 100.3, y: 200.6, width: 10.2, height: 10.2), section: section, scale: 1)
        #expect(r == CGRect(x: 76, y: 176, width: 59, height: 59))
    }

    @Test func cropIsClampedToTheSection() {
        let r = AskSelection.cropRect(box: CGRect(x: -10, y: 1000, width: 1400, height: 100), section: section, scale: 2)
        #expect(r.minX == 0 && r.minY == 1952 && r.maxX == 2752 && r.maxY == 2064)
        // Wholly outside still gives a pixel, not an empty or negative crop.
        let out = AskSelection.cropRect(box: CGRect(x: 2000, y: 2000, width: 10, height: 10), section: section, scale: 1)
        #expect(out.width >= 1 && out.height >= 1 && out.minX < section.width && out.minY < section.height)
    }

    @Test func tallSectionsRenderSmallerLikeTheWeb() {
        #expect(AskSelection.scale(for: section) == 2)
        #expect(AskSelection.scale(for: CGSize(width: 1376, height: 16_384)) == 1)
    }

    @Test func boxUnitesTheStrokes() {
        let ink = PKInkingTool(.pen, color: .black, width: 4).ink
        func stroke(_ a: CGPoint, _ b: CGPoint) -> PKStroke {
            let pts = [a, b].enumerated().map { i, p in
                PKStrokePoint(location: p, timeOffset: Double(i), size: CGSize(width: 4, height: 4), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
            }
            return PKStroke(ink: ink, path: PKStrokePath(controlPoints: pts, creationDate: Date()))
        }
        #expect(AskSelection.box([]) == nil)
        let b = AskSelection.box([stroke(CGPoint(x: 10, y: 10), CGPoint(x: 50, y: 20)), stroke(CGPoint(x: 100, y: 300), CGPoint(x: 120, y: 310))])!
        #expect(b.minX <= 10 && b.minY <= 10 && b.maxX >= 120 && b.maxY >= 310)
    }

    @Test func markdownMatchesTheWebsSelectionText() {
        #expect(AskSelection.markdown(notebookTitle: " Physics ", sectionTitle: "Waves", index: 2, pdf: ("ch3.pdf", 4), hasImage: true) == """
        # Selection from section 3: Waves

        _Notebook: Physics. Only this selection was shared._

        PDF: ch3.pdf · page 4

        ![The selected area, with my handwriting](selection.png)

        """)
        #expect(AskSelection.markdown(notebookTitle: "", sectionTitle: nil, index: 0, pdf: nil, hasImage: false, text: " hi ") == """
        # Selection from section 1: Untitled

        _Notebook: Untitled notebook. Only this selection was shared._

        ## Selected text

        hi

        """)
    }

    @MainActor @Test func pngIsTheCropAtTwiceTheSize() throws {
        let view = UIView(frame: CGRect(origin: .zero, size: section))
        view.backgroundColor = .white
        let data = try #require(AskSelection.png(of: view, box: CGRect(x: 100, y: 100, width: 52, height: 52)))
        let image = try #require(UIImage(data: data))
        #expect(image.size == CGSize(width: 200, height: 200))
    }
}

struct AskLassoTests {
    private func stroke(_ pts: [CGPoint]) -> PKStroke {
        let ink = PKInkingTool(.pen, color: .black, width: 4).ink
        let points = pts.enumerated().map { i, p in
            PKStrokePoint(location: p, timeOffset: Double(i), size: CGSize(width: 4, height: 4), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        }
        return PKStroke(ink: ink, path: PKStrokePath(controlPoints: points, creationDate: Date()))
    }

    private let square = [CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 0), CGPoint(x: 100, y: 100), CGPoint(x: 0, y: 100)]

    @Test func pointInPolygonIsEvenOdd() {
        #expect(AskSelection.contains(square, CGPoint(x: 50, y: 50)))
        #expect(!AskSelection.contains(square, CGPoint(x: 150, y: 50)))
        // A concave U: the notch is outside.
        let u = [CGPoint(x: 0, y: 0), CGPoint(x: 30, y: 0), CGPoint(x: 30, y: 70), CGPoint(x: 70, y: 70), CGPoint(x: 70, y: 0), CGPoint(x: 100, y: 0), CGPoint(x: 100, y: 100), CGPoint(x: 0, y: 100)]
        #expect(!AskSelection.contains(u, CGPoint(x: 50, y: 30)))
        #expect(AskSelection.contains(u, CGPoint(x: 50, y: 90)))
    }

    @Test func enclosesStrokesWithHalfTheirPointsInside() {
        let inside = stroke([CGPoint(x: 10, y: 10), CGPoint(x: 50, y: 50), CGPoint(x: 90, y: 90)])
        let half = stroke([CGPoint(x: 60, y: 50), CGPoint(x: 90, y: 50), CGPoint(x: 120, y: 50), CGPoint(x: 150, y: 50)])
        let mostlyOut = stroke([CGPoint(x: 90, y: 20), CGPoint(x: 130, y: 20), CGPoint(x: 160, y: 20), CGPoint(x: 190, y: 20)])
        let away = stroke([CGPoint(x: 300, y: 300), CGPoint(x: 310, y: 310)])
        let picked = AskSelection.enclosed([inside, half, mostlyOut, away], by: square)
        #expect(picked.map(\.renderBounds) == [inside.renderBounds, half.renderBounds])
        #expect(AskSelection.enclosed([inside], by: Array(square.prefix(2))).isEmpty)
    }
}

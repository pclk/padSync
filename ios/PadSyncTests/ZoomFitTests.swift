import CoreGraphics
import Testing
@testable import padSync

struct ZoomFitTests {
    // 13" iPad Pro: 1376 pt wide in landscape, 1032 in portrait; a third of landscape in Split View.
    private let landscape: CGFloat = 1376, portrait: CGFloat = 1032, narrow: CGFloat = 438

    @Test func fillsTheWidth() {
        #expect(ZoomFit.fit(width: landscape) == 1)
        #expect(ZoomFit.fit(width: portrait) == 0.75)
    }

    @Test func minimumIsHalfOrTheFitWhenNarrower() {
        #expect(ZoomFit.minimum(width: landscape) == 0.5)
        #expect(abs(ZoomFit.minimum(width: narrow) - narrow / 1376) < 0.0001)
    }

    @Test func aFittedPageRefitsToTheNewWidth() {
        #expect(ZoomFit.refit(zoom: 1, oldWidth: landscape, newWidth: portrait) == 0.75)
        #expect(ZoomFit.refit(zoom: 0.75, oldWidth: portrait, newWidth: landscape) == 1)
        #expect(abs(ZoomFit.refit(zoom: 1, oldWidth: landscape, newWidth: narrow) - narrow / 1376) < 0.0001)
    }

    @Test func aChosenZoomIsKeptWithinTheLimits() {
        #expect(ZoomFit.refit(zoom: 2, oldWidth: landscape, newWidth: portrait) == 2)
        #expect(ZoomFit.refit(zoom: 0.6, oldWidth: landscape, newWidth: portrait) == 0.6)
        // Pinched out below half size in a narrow window, then the window widens: the new minimum wins.
        #expect(ZoomFit.refit(zoom: 0.4, oldWidth: narrow, newWidth: landscape) == 0.5)
    }

    @Test func theReadingPositionSurvivesTheZoom() {
        let offset = ZoomFit.offset(reading: CGPoint(x: 0, y: 5000), zoom: 0.75,
                                    viewport: CGSize(width: portrait, height: 1300), contentHeight: 20000)
        #expect(offset == CGPoint(x: 0, y: 3750))
    }

    @Test func aZoomedInPageKeepsItsLeftEdgeInsideTheContent() {
        let viewport = CGSize(width: portrait, height: 1300)
        #expect(ZoomFit.offset(reading: CGPoint(x: 300, y: 0), zoom: 2, viewport: viewport, contentHeight: 20000).x == 600)
        // Far right: clamped so the page's right edge meets the window's.
        #expect(ZoomFit.offset(reading: CGPoint(x: 1300, y: 0), zoom: 2, viewport: viewport, contentHeight: 20000).x == 1376 * 2 - portrait)
    }

    @Test func aNarrowPageIsCentred() {
        let offset = ZoomFit.offset(reading: CGPoint(x: 200, y: 0), zoom: 0.5,
                                    viewport: CGSize(width: landscape, height: 1000), contentHeight: 4000)
        #expect(offset.x == -344)
    }

    @Test func theOffsetStaysInsideTheColumn() {
        let viewport = CGSize(width: portrait, height: 1300)
        #expect(ZoomFit.offset(reading: CGPoint(x: 0, y: -50), zoom: 1, viewport: viewport, contentHeight: 3000).y == 0)
        // Past the end: stops where the bottom slack (40% of the viewport) ends.
        #expect(abs(ZoomFit.offset(reading: CGPoint(x: 0, y: 9000), zoom: 1, viewport: viewport, contentHeight: 3000).y - 2220) < 0.001)
    }
}

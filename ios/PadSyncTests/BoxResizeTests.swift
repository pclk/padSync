import CoreGraphics
import Testing
@testable import padSync

/// Matches tests/resize.test.ts: the web and the iPad resize a box the same way.
struct BoxResizeTests {
    let b = CGRect(x: 100, y: 100, width: 200, height: 100)
    let page = CGRect(x: 0, y: 0, width: 1000, height: 1000)

    @Test func movesOnlyTheDraggedEdges() {
        #expect(BoxResize.resize(b, .e, by: CGPoint(x: 50, y: 999)) == CGRect(x: 100, y: 100, width: 250, height: 100))
        #expect(BoxResize.resize(b, .nw, by: CGPoint(x: -10, y: -30)) == CGRect(x: 90, y: 70, width: 210, height: 130))
    }

    @Test func cornersKeepTheProportionsWhenAsked() {
        #expect(BoxResize.resize(b, .se, by: CGPoint(x: 200, y: 10), keepRatio: true) == CGRect(x: 100, y: 100, width: 400, height: 200))
        #expect(BoxResize.resize(b, .e, by: CGPoint(x: 200, y: 0), keepRatio: true) == CGRect(x: 100, y: 50, width: 400, height: 200))
    }

    @Test func neverFlipsAndStopsAtThePage() {
        #expect(BoxResize.resize(b, .e, by: CGPoint(x: -500, y: 0), min: 8).width == 8)
        #expect(BoxResize.resize(b, .e, by: CGPoint(x: 5000, y: 0), within: page).maxX == 1000)
        #expect(BoxResize.resize(b, .nw, by: CGPoint(x: -500, y: -500), keepRatio: true, within: page) == CGRect(x: 0, y: 50, width: 300, height: 150))
    }

    @Test func mapsOneBoxOntoAnother() {
        let to = CGRect(x: 0, y: 50, width: 400, height: 50)
        #expect(b.applying(BoxResize.map(b, to: to)) == to)
        #expect(BoxResize.move(b, by: CGPoint(x: -500, y: 20), within: page) == CGRect(x: 0, y: 120, width: 200, height: 100))
    }
}

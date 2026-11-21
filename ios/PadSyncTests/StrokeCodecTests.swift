import Foundation
import PencilKit
import Testing
@testable import padSync

struct StrokeCodecTests {
    /// A web pen stroke: three samples, touchdown at zero pressure.
    let web: JSONValue = .object([
        "tool": .string("pen"), "color": .string("#1d4ed8"), "size": .double(3.4), "input": .string("pen"),
        "t0": .int(1_732_000_000_000), "device": .string("web"),
        "pts": .array([10, 20, 0, 1.2, 0.5, 0, 30, 40, 0.5, 1.2, 0.5, 8, 50, 60, 0.9, 1.2, 0.5, 16].map(JSONValue.double)),
    ])

    @Test func rebuildsWebStrokesWithPerfectFreehandWidths() throws {
        let stroke = try #require(StrokeCodec.stroke(id: "s1", data: web))
        #expect(stroke.ink.inkType == .pen)
        #expect(stroke.ink.color.hex == "#1d4ed8")
        let points = Array(stroke.path)
        #expect(points.count == 3)
        #expect(points[1].location == CGPoint(x: 30, y: 40))
        // Mid pressure draws `size` wide; the zero-pressure touchdown takes the first real pressure.
        #expect(abs(StrokeCodec.width(forPointSize: points[1].size.width, marker: false) - 3.4) < 0.001)
        #expect(points[0].size.width == points[1].size.width)
        #expect(abs(points[2].timeOffset - 0.016) < 0.0001)
        #expect(stroke.path.creationDate == Date(timeIntervalSince1970: 1_732_000_000))
    }

    @Test func rebuildingKeepsTheSameKey() throws {
        let a = try #require(StrokeCodec.stroke(id: "s1", data: web))
        let b = try #require(StrokeCodec.stroke(id: "s1", data: web))
        #expect(StrokeCodec.key(a) == StrokeCodec.key(b))
        let other = try #require(StrokeCodec.stroke(id: "s2", data: web))
        #expect(StrokeCodec.key(a) != StrokeCodec.key(other))
    }

    @Test func nativeStrokesRoundTripThroughTheirOriginal() throws {
        let drawn = try #require(StrokeCodec.stroke(id: "s1", data: web))
        let data = StrokeCodec.data(for: drawn, device: "ipad1")
        #expect(data["tool"]?.string == "pen")
        #expect(data["input"]?.string == "pen")
        #expect(data["device"]?.string == "ipad1")
        #expect((data["pts"]?.array?.count ?? 0) % 6 == 0)
        let back = try #require(StrokeCodec.stroke(id: "anything", data: data))
        #expect(StrokeCodec.key(back) == StrokeCodec.key(drawn))
        #expect(back.transform == .identity)
    }

    @Test func aWebLassoMoveTranslatesTheOriginal() throws {
        let drawn = try #require(StrokeCodec.stroke(id: "s1", data: web))
        var data = StrokeCodec.data(for: drawn, device: "ipad1")
        // The web lasso shifts every sample by (dx, dy) and leaves the rest alone.
        var pts = data["pts"]!.array!
        for i in Swift.stride(from: 0, to: pts.count, by: 6) {
            pts[i] = .double(pts[i].double! + 100)
            pts[i + 1] = .double(pts[i + 1].double! - 5)
        }
        data["pts"] = .array(pts)
        let moved = try #require(StrokeCodec.stroke(id: "s1", data: data))
        #expect(moved.transform == CGAffineTransform(translationX: 100, y: -5))
    }

    @Test func highlighterBecomesAMarkerAndBack() throws {
        var hl = web
        hl["tool"] = .string("highlighter")
        hl["size"] = .double(22)
        let stroke = try #require(StrokeCodec.stroke(id: "h", data: hl))
        #expect(stroke.ink.inkType == .marker)
        #expect(abs(StrokeCodec.width(forPointSize: Array(stroke.path)[0].size.width, marker: true) - 22) < 0.001)
        #expect(StrokeCodec.data(for: stroke, device: "d")["tool"]?.string == "highlighter")
    }

    @Test func parsesHexColors() {
        #expect(UIColor(hex: "#fff")?.hex == "#ffffff")
        #expect(UIColor(hex: "#111827")?.hex == "#111827")
        #expect(UIColor(hex: "red") == nil)
    }
}

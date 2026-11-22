import PencilKit
import Testing
import UIKit
@testable import padSync

/// Renders converted strokes and measures them, so web strokes keep their width in PencilKit.
struct RenderWidthTests {
    /// Covered height in points of a horizontal stroke, measured down one pixel column.
    func renderedWidth(_ stroke: PKStroke) -> Double {
        var img = UIImage()
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            img = PKDrawing(strokes: [stroke]).image(from: CGRect(x: 0, y: 0, width: 120, height: 100), scale: 10)
        }
        let cg = img.cgImage!
        let ctx = CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        let buf = ctx.data!.assumingMemoryBound(to: UInt8.self)
        return (0..<cg.height).reduce(0.0) { $0 + Double(buf[($1 * cg.width + 600) * 4 + 3]) / 255 } / 10
    }

    func line(tool: String, size: Double, pressure: Double) -> PKStroke {
        let pts = (0..<20).flatMap { i -> [Double] in [10 + Double(i) * 5, 50, pressure, .pi / 2, 0, Double(i) * 8] }
        return StrokeCodec.stroke(id: "w", data: .object(["tool": .string(tool), "color": .string("#000000"), "size": .double(size),
                                                          "input": .string("pen"), "t0": .int(1), "pts": .array(pts.map(JSONValue.double))]))!
    }

    @Test(arguments: [2.2, 3.4, 5.5])
    func penStrokesDrawTheirWebWidth(size: Double) {
        #expect(abs(renderedWidth(line(tool: "pen", size: size, pressure: 0.5)) - size) < 0.3)
    }

    @Test(arguments: [14.0, 22, 32])
    func highlighterStrokesDrawTheirWebWidth(size: Double) {
        #expect(abs(renderedWidth(line(tool: "highlighter", size: size, pressure: 0.5)) - size) / size < 0.06)
    }
}

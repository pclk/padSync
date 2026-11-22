import PencilKit
import UIKit

/// Converts between padSync strokes (`StrokeData` in src/lib/types.ts) and PencilKit strokes.
///
/// Web strokes are rebuilt from their samples: x, y, pressure, altitude, azimuth, t (stride 6).
/// Strokes drawn here also keep their PencilKit original (`pk`, a one-stroke PKDrawing) so they
/// reopen exactly as drawn; `pkAt` is the first sample when it was saved, and the web's lasso
/// only ever translates `pts`, so any difference is applied as a move.
enum StrokeCodec {
    static let stride = 6
    /// Apple Pencil's UITouch.maximumPossibleForce; web pressure is force / max.
    static let maxForce: CGFloat = 4.166_666_7
    /// perfect-freehand's thinning for pen strokes (DEFAULT_PEN in src/ink/pen-feel.ts).
    static let defaultThinning = 0.3

    // A PKStrokePoint's size isn't the width PencilKit draws. Measured (RenderWidthTests): pen,
    // monoline and fountain pen draw 2·(size − 2) pt, so size 2 is invisible; the marker draws
    // 0.485·size. These convert a line width in points to a point size and back.
    static func pointSize(forWidth width: Double, marker: Bool) -> Double {
        marker ? width / 0.485 : width / 2 + 2
    }

    static func width(forPointSize size: Double, marker: Bool) -> Double {
        marker ? size * 0.485 : max(0.25, 2 * (size - 2))
    }

    /// Identifies a stroke across drawing changes on iPadOS 26 (PKStroke.id needs iPadOS 27).
    /// A lasso move changes the transform, not the path, so the key survives it.
    struct Key: Hashable {
        let created: TimeInterval
        let count: Int
        let seed: UInt32
    }

    static func key(_ stroke: PKStroke) -> Key {
        Key(created: stroke.path.creationDate.timeIntervalSinceReferenceDate, count: stroke.path.count, seed: stroke.randomSeed)
    }

    // MARK: padSync → PencilKit

    static func stroke(id: String, data: JSONValue) -> PKStroke? {
        guard let pts = data["pts"]?.array?.compactMap(\.double), pts.count >= stride else { return nil }
        if let original = original(data, pts: pts) { return original }

        let highlighter = data["tool"]?.string == "highlighter"
        let pen = data["input"]?.string == "pen"
        let size = data["size"]?.double ?? 2.2
        let thinning = data["pen"]?["thinning"]?.double ?? defaultThinning
        let t0 = data["t0"]?.double ?? 0
        // Touchdown and lift-off report ~0 pressure; hold the nearest real value (like smoothPressure).
        let firstReal = Swift.stride(from: 2, to: pts.count, by: stride).map { pts[$0] }.first { $0 >= 0.05 } ?? 0.5
        var pressure = firstReal
        var points: [PKStrokePoint] = []
        points.reserveCapacity(pts.count / stride)
        for i in Swift.stride(from: 0, to: pts.count - stride + 1, by: stride) {
            if pts[i + 2] >= 0.05 { pressure = pts[i + 2] }
            // perfect-freehand's radius: size · (0.5 − thinning · (0.5 − pressure)), linear easing.
            let lineWidth = highlighter || !pen ? size : 2 * size * (0.5 - thinning * (0.5 - pressure))
            let width = pointSize(forWidth: lineWidth, marker: highlighter)
            let altitude = pts[i + 3] > 0 ? pts[i + 3] : .pi / 2
            points.append(PKStrokePoint(location: CGPoint(x: pts[i], y: pts[i + 1]), timeOffset: max(0, pts[i + 5]) / 1000,
                                        size: CGSize(width: width, height: width), opacity: 1,
                                        force: pressure * maxForce, azimuth: pts[i + 4], altitude: altitude))
        }
        if points.count == 1 { points.append(points[0]) } // a tap: PencilKit needs two points for a dot
        let ink = PKInk(highlighter ? .marker : .pen, color: UIColor(hex: data["color"]?.string) ?? .black)
        let path = PKStrokePath(controlPoints: points, creationDate: Date(timeIntervalSince1970: t0 / 1000))
        return PKStroke(ink: ink, path: path, randomSeed: seed(id))
    }

    private static func original(_ data: JSONValue, pts: [Double]) -> PKStroke? {
        guard let encoded = data["pk"]?.string, let at = data["pkAt"]?.array, at.count == 2,
              let ax = at[0].double, let ay = at[1].double,
              let bytes = Data(base64Encoded: encoded), let drawing = try? PKDrawing(data: bytes),
              var stroke = drawing.strokes.first else { return nil }
        let dx = pts[0] - ax, dy = pts[1] - ay
        if dx != 0 || dy != 0 { stroke.transform = stroke.transform.concatenating(CGAffineTransform(translationX: dx, y: dy)) }
        return stroke
    }

    /// A stable seed per id, so a rebuilt stroke keeps its Key.
    static func seed(_ id: String) -> UInt32 {
        var hash: UInt32 = 2_166_136_261 // FNV-1a
        for byte in id.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
        return hash
    }

    // MARK: PencilKit → padSync

    static func data(for stroke: PKStroke, device: String) -> JSONValue {
        let highlighter = stroke.ink.inkType == .marker
        // A lasso Bigger or Smaller scales the transform; line widths scale with it.
        let t = stroke.transform
        let scale = sqrt(abs(Double(t.a * t.d - t.b * t.c)))
        // Points on the curve, one per control point; their positions include any lasso move.
        var pts: [JSONValue] = []
        var impliedSizes: [Double] = []
        for p in stroke.path.interpolatedPoints(by: .parametricStep(1)) {
            let at = p.location.applying(stroke.transform)
            let pressure = p.force > 0 ? min(1, Double(p.force / maxForce)) : 0.5
            pts += [.double(round2(at.x)), .double(round2(at.y)), .double(round3(pressure)),
                    .double(round3(p.altitude)), .double(round3(p.azimuth)), .int(Int64((p.timeOffset * 1000).rounded()))]
            let width = width(forPointSize: Double(p.size.width), marker: highlighter) * scale
            impliedSizes.append(highlighter ? width : width / (2 * (0.5 - defaultThinning * (0.5 - pressure))))
        }
        if pts.isEmpty, let p = stroke.path.first {
            let at = p.location.applying(stroke.transform)
            pts = [.double(round2(at.x)), .double(round2(at.y)), .double(0.5), .double(round3(p.altitude)), .double(round3(p.azimuth)), .int(0)]
            impliedSizes = [width(forPointSize: Double(p.size.width), marker: highlighter)]
        }
        impliedSizes.sort()
        let size = impliedSizes.isEmpty ? 2.2 : impliedSizes[impliedSizes.count / 2]
        let original = (try? PKDrawing(strokes: [stroke]).dataRepresentation().base64EncodedString()) ?? ""
        return .object([
            "tool": .string(highlighter ? "highlighter" : "pen"),
            "color": .string(stroke.ink.color.hex),
            "size": .double(round2(size)),
            "pts": .array(pts),
            "t0": .int(Int64((stroke.path.creationDate.timeIntervalSince1970 * 1000).rounded())),
            "input": .string("pen"),
            "device": .string(device),
            "ink": .string(stroke.ink.inkType.rawValue),
            "pk": .string(original),
            "pkAt": .array(Array(pts.prefix(2))),
        ])
    }

    private static func round2(_ v: CGFloat) -> Double { (Double(v) * 100).rounded() / 100 }
    private static func round2(_ v: Double) -> Double { (v * 100).rounded() / 100 }
    private static func round3(_ v: CGFloat) -> Double { (Double(v) * 1000).rounded() / 1000 }
    private static func round3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }

    /// Lowest edge of a stroke's samples plus its width, for section growth.
    static func bottom(_ data: JSONValue) -> Double {
        guard let pts = data["pts"]?.array else { return 0 }
        var maxY = 0.0
        for i in Swift.stride(from: 1, to: pts.count, by: stride) { maxY = max(maxY, pts[i].double ?? 0) }
        return maxY + (data["size"]?.double ?? 0)
    }
}

/// 21-character URL-safe ids, like nanoid() on the web.
func newId() -> String {
    let alphabet = Array("useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict")
    return String((0..<21).map { _ in alphabet.randomElement()! })
}

extension UIColor {
    /// `#rgb`, `#rrggbb` or `#rrggbbaa`.
    convenience init?(hex: String?) {
        guard var s = hex?.trimmingCharacters(in: .whitespaces), s.hasPrefix("#") else { return nil }
        s.removeFirst()
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6 || s.count == 8, let v = UInt64(s, radix: 16) else { return nil }
        let rgba = s.count == 6 ? (v << 8) | 0xff : v
        self.init(red: CGFloat((rgba >> 24) & 0xff) / 255, green: CGFloat((rgba >> 16) & 0xff) / 255,
                  blue: CGFloat((rgba >> 8) & 0xff) / 255, alpha: CGFloat(rgba & 0xff) / 255)
    }

    /// `#rrggbb`, light appearance (paper is always light).
    var hex: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)).getRed(&r, green: &g, blue: &b, alpha: &a)
        let c = { (v: CGFloat) in String(format: "%02x", Int((min(1, max(0, v)) * 255).rounded())) }
        return "#" + c(r) + c(g) + c(b)
    }
}

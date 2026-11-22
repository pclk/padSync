import Foundation
import PencilKit
import Testing
@testable import padSync

@MainActor
struct ToolsTests {
    @Test func toolsMapToPencilKitAtTheWebsWidths() throws {
        var t = ToolState()
        t.penSize = 3.4
        let pen = try #require(Tools.canvasTool(for: t) as? PKInkingTool)
        #expect(pen.inkType == .pen)
        #expect(abs(StrokeCodec.width(forPointSize: Double(pen.width), marker: false) - 3.4) < 0.001)
        t.kind = .highlighter
        let marker = try #require(Tools.canvasTool(for: t) as? PKInkingTool)
        #expect(marker.inkType == .marker)
        #expect(marker.color.hex == "#facc15")
        t.kind = .eraser
        #expect((Tools.canvasTool(for: t) as? PKEraserTool)?.eraserType == .vector)
        t.kind = .lasso
        #expect(Tools.canvasTool(for: t) == nil)
        t.kind = .text
        #expect(Tools.canvasTool(for: t) == nil)
    }

    @Test func drawingPolicyIsPencilOnlyOnTheDevice() {
        #if targetEnvironment(simulator)
        #expect(Tools.drawingPolicy == .anyInput)
        #else
        #expect(Tools.drawingPolicy == .pencilOnly)
        #endif
    }
}

struct DeviceSettingsTests {
    /// A server backup: each key's localStorage JSON under `v`.
    private func backup(_ values: [String: String]) -> JSONValue {
        .object(values.mapValues { .object(["v": .string($0), "at": .int(1)]) })
    }

    @Test func readsTheIpadsSettingsFromTheServerCopy() {
        let s = DeviceSettings(backup: backup([
            "padsync.rail": #"{"order":["lasso","pen","prompts","eraser"],"hidden":["text","pen"],"dock":"right","align":"end","style":"circle","free":{"tools":[0.9,0.5]},"size":{"tools":200}}"#,
            "padsync.prompts": #"[{"id":"a","label":"","text":"Hi","icon":"bulb","context":"selection"},{"id":"a","text":"dupe"},{"id":"v","text":"","voice":true,"send":false}]"#,
            "padsync.gestures": #"{"twoTap":"redo","threeTap":"lassoHold","fingerDoubleTap":"tool:eraser"}"#,
            "padsync.gestureTuning": #"{"holdMs":100,"showNote":false}"#,
            "padsync.lasso": #"{"mode":"enclose","hidden":["ask"],"step":10}"#,
            "padsync.tool": ##"{"kind":"highlighter","hlColor":"#4ade80","pen":{"thinning":0.5}}"##,
        ]))
        // Unknown and repeated items go, missing ones come back in their place; the pen can't hide.
        #expect(s.rail.order.prefix(4) == ["lasso", "pen", "prompts", "eraser"])
        #expect(s.rail.order.count == RailLayout.items.count)
        #expect(s.rail.hidden == ["text"])
        #expect(s.rail.tools == [.lasso, .pen, .eraser, .highlighter])
        #expect(s.rail.promptsFirst == false)
        #expect(s.rail.dock == .right && s.rail.align == .end)
        #expect(s.rail.free[.tools] == CGPoint(x: 0.9, y: 0.5))
        #expect(s.rail.size[.tools] == 112)
        #expect(s.prompts.map(\.id) == ["a", "v"])
        #expect(s.prompts[0].label == "Prompt" && s.prompts[0].context == .selection)
        // A voice prompt always sends.
        #expect(s.prompts[1].send)
        #expect(s.gestures[.twoTap] == .redo)
        #expect(s.gestures[.threeTap] == .redo) // lassoHold is only for press and hold
        #expect(s.gestures[.fingerDoubleTap] == .tool(.eraser))
        #expect(s.gestures[.fingerHold] == .lassoHold)
        #expect(s.tuning.holdMs == 200 && !s.tuning.showNote)
        #expect(s.lasso.mode == .enclose && s.lasso.visible == [.delete, .duplicate, .recolor, .bigger, .smaller] && s.lasso.step == 10)
        #expect(s.tool.kind == .highlighter && s.tool.hlColor == "#4ade80")
        // Fields the app doesn't use survive a write back.
        #expect(s.tool.json["pen"]?["thinning"]?.double == 0.5)
        #expect(RailLayout(json: s.rail.json) == s.rail)
    }

    @Test func missingSettingsAreTheWebsDefaults() {
        let s = DeviceSettings(backup: nil)
        #expect(s.prompts.count == 7)
        #expect(s.gestures[.twoTap] == .undo && s.gestures[.fingerHold] == .lassoHold)
        #expect(s.rail.tools == [.pen, .highlighter, .eraser, .lasso, .text])
        #expect(s.tool.kind == .pen && s.tool.penSize == 3.4)
    }
}

struct FanTests {
    @Test func aFanFacesTheMiddleAndPicksByDirection() {
        let viewport = CGSize(width: 1000, height: 800)
        // Docked at the left edge: a half circle opening to the right.
        let a = FanGeometry.angles(5, center: CGPoint(x: 40, y: 400), viewport: viewport)
        #expect(a.first == -90 && a.last == 90)
        #expect(FanGeometry.pick(a, dx: 100, dy: 0) == 2)
        #expect(FanGeometry.pick(a, dx: 0, dy: -100) == 0)
        // Too small a move, or pointing back at the edge, picks nothing.
        #expect(FanGeometry.pick(a, dx: 10, dy: 0) == -1)
        #expect(FanGeometry.pick(a, dx: -100, dy: 0) == -1)
        // With room on every side, a full ring from the top.
        let ring = FanGeometry.layout(6, center: CGPoint(x: 500, y: 400), viewport: viewport)
        #expect(ring.angles == [-90, -30, 30, 90, 150, 210])
    }
}

@MainActor
struct GestureLogicTests {
    final class Clock {
        var pending: [(Double, () -> Void)] = []
    }

    private func logic(_ bound: Set<GestureKind>, emitted: @escaping (GestureKind) -> Void, clock: Clock) -> GestureLogic {
        let l = GestureLogic()
        l.isBound = { bound.contains($0) }
        l.emit = { g, _ in emitted(g) }
        l.schedule = { seconds, fn in
            clock.pending.append((seconds, fn))
            return GestureLogic.Handle { clock.pending.removeAll { $0.0 == seconds } }
        }
        return l
    }

    private func finger(_ n: Int, _ x: CGFloat = 100) -> [GestureLogic.Finger] {
        (0..<n).map { GestureLogic.Finger(id: nil, point: CGPoint(x: x + CGFloat($0) * 50, y: 100)) }
    }

    @Test func twoAndThreeFingerTaps() {
        var got: [GestureKind] = []
        let clock = Clock()
        let l = logic([.twoTap, .threeTap], emitted: { got.append($0) }, clock: clock)
        l.start(finger(2), now: 0, onPage: true)
        l.end([], now: 0.1)
        l.start(finger(3), now: 1, onPage: true)
        l.end([], now: 1.1)
        // Too slow to be a tap.
        l.start(finger(2), now: 2, onPage: true)
        l.end([], now: 2.5)
        #expect(got == [.twoTap, .threeTap])
    }

    @Test func holdingStillFiresTheHoldButMovingOrThePencilDoesNot() {
        var got: [GestureKind] = []
        let clock = Clock()
        let l = logic([.fingerHold], emitted: { got.append($0) }, clock: clock)
        l.start(finger(1), now: 0, onPage: true)
        #expect(clock.pending.count == 1)
        clock.pending.removeFirst().1()
        #expect(got == [.fingerHold])
        l.end([], now: 1)

        l.start(finger(1), now: 2, onPage: true)
        l.move([GestureLogic.Finger(id: nil, point: CGPoint(x: 130, y: 100))])
        #expect(clock.pending.isEmpty)
        l.end([], now: 3)

        l.pencil(now: 4)
        l.start(finger(1), now: 4.2, onPage: true)
        #expect(clock.pending.isEmpty)
        #expect(got == [.fingerHold])
    }
}

struct LassoGeometryTests {
    private func line(_ x0: CGFloat, _ y0: CGFloat, _ x1: CGFloat, _ y1: CGFloat) -> LassoGeometry.Shape {
        let pts = (0...20).map { i in CGPoint(x: x0 + (x1 - x0) * CGFloat(i) / 20, y: y0 + (y1 - y0) * CGFloat(i) / 20) }
        return LassoGeometry.Shape(points: pts, size: 3, box: CGRect(x: min(x0, x1), y: min(y0, y1), width: abs(x1 - x0), height: abs(y1 - y0)))
    }

    @Test func encloseTakesStrokesMostlyInsideAndTouchTakesAnyItReaches() {
        let square = [CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 0), CGPoint(x: 100, y: 100), CGPoint(x: 0, y: 100)]
        let inside = line(10, 50, 90, 50)
        let across = line(50, 50, 250, 50) // a quarter inside
        let outside = line(200, 200, 300, 200)
        let crossed = line(150, -50, 150, 50) // the lasso's edge doesn't reach it
        let shapes = [inside, across, outside, crossed]
        #expect(LassoGeometry.pick(shapes, drawn: square, mode: .enclose) == [0])
        #expect(LassoGeometry.pick(shapes, drawn: square, mode: .touch) == [0, 1])
        // The drawn line (not the closing edge) running over ink counts when touching.
        let path = [CGPoint(x: 140, y: -60), CGPoint(x: 160, y: 60), CGPoint(x: 120, y: 60)]
        #expect(LassoGeometry.pick(shapes, drawn: path, mode: .touch).contains(3))
    }
}

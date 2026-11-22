import PencilKit
import Testing
import UIKit
@testable import padSync

/// Hosts the editor in a window and resizes it like a rotation or a Split View change.
@MainActor
struct ResizeTests {
    @Test func resizingRefitsTheZoomAndKeepsTheReadingPosition() async throws {
        let db = try AppDatabase.inMemory()
        let sections = (0..<10).map { i in
            Entity(id: "s\(i)", kind: .section, notebookId: "n", parentId: "",
                   data: .object(["order": .double(Double(i)), "template": .string("lines"), "minHeight": .double(1032)]),
                   hlc: "", deleted: false, dirty: false)
        }
        _ = try db.save(sections)
        let vc = NotebookViewController(context: EditorContext(notebookId: "n", database: db, sync: SyncEngine(db: db)))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1376, height: 1032))
        window.rootViewController = vc
        window.isHidden = false
        defer { vc.stop(); window.isHidden = true }
        vc.view.layoutIfNeeded()
        for _ in 0..<100 where vc.scrollView.contentSize.height < 5000 { try await Task.sleep(for: .milliseconds(20)) }
        let scroll = vc.scrollView
        #expect(scroll.zoomScale == 1)
        scroll.contentOffset = CGPoint(x: 0, y: 5000)

        func resize(_ width: CGFloat, _ height: CGFloat) {
            window.frame = CGRect(x: 0, y: 0, width: width, height: height)
            vc.view.layoutIfNeeded()
        }

        // Portrait: the page fits the narrower width and the same column point stays at the top.
        resize(1032, 1376)
        #expect(abs(scroll.zoomScale - 0.75) < 0.001)
        #expect(abs(scroll.contentOffset.y - 3750) < 1)
        #expect(scroll.contentOffset.x == 0)

        // A third of the screen in Split View.
        resize(438, 1376)
        #expect(abs(scroll.zoomScale - 438 / 1376) < 0.001)
        #expect(abs(scroll.contentOffset.y / scroll.zoomScale - 5000) < 2)

        // Back to landscape, full screen.
        resize(1376, 1032)
        #expect(abs(scroll.zoomScale - 1) < 0.001)
        #expect(abs(scroll.contentOffset.y - 5000) < 2)

        // A zoom the user chose is kept across a rotation, and so is the place on the page.
        scroll.zoomScale = 2
        scroll.contentOffset = CGPoint(x: 400, y: 12000)
        resize(1032, 1376)
        #expect(abs(scroll.zoomScale - 2) < 0.001)
        #expect(abs(scroll.contentOffset.y - 12000) < 2)
        #expect(abs(scroll.contentOffset.x - 400) < 2)
    }
}

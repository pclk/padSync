import Testing
import UIKit
@testable import padSync

/// The bundled block renderer: which sections need it, and that it renders with the web's layout.
@MainActor
struct BlockRendererTests {
    func section(_ data: [String: JSONValue], hlc: String = UUID().uuidString) -> Entity {
        var d: [String: JSONValue] = ["template": .string("plain"), "minHeight": .int(400), "blocks": .array([])]
        d.merge(data) { $1 }
        return Entity(id: "s-\(hlc)", kind: .section, notebookId: "n", parentId: "", data: .object(d), hlc: hlc, deleted: false, dirty: false)
    }

    @Test func onlySectionsWithAHeaderOrBlocksRender() {
        #expect(!BlockRenderer.hasContent(section([:])))
        #expect(BlockRenderer.hasContent(section(["title": .string("Week 1")])))
        #expect(BlockRenderer.hasContent(section(["blocks": .array([.object(["type": .string("markdown"), "text": .string("Hi")])])])))
        #expect(!BlockRenderer.hasContent(section(["pdf": .object(["documentId": .string("d"), "page": .int(1)])])))
    }

    @Test func rendersMarkdownAndMathAtThePageWidth() async throws {
        let short = section(["title": .string("Short"), "blocks": .array([.object(["type": .string("markdown"), "text": .string("One line.")])])])
        let long = section(["title": .string("Long"), "blocks": .array([
            .object(["type": .string("markdown"), "text": .string("# Heading\n\nSome text with $x^2 + y^2 = z^2$.\n\n$$\\int_0^1 x\\,dx = \\frac{1}{2}$$")]),
            .object(["type": .string("space"), "size": .int(300)]),
        ])])
        let a = try await BlockRenderer.shared.render(short, index: 0)
        let b = try await BlockRenderer.shared.render(long, index: 1)
        #expect(a.image.size.width == SectionView.pageWidth)
        #expect(a.contentHeight > 40)
        // The space block alone is 300 px.
        #expect(b.contentHeight > a.contentHeight + 300)
        #expect(BlockRenderer.shared.cachedContentHeight(long, index: 1) == b.contentHeight)
        #expect(SectionView.baseHeight(long, index: 1) == max(400, b.contentHeight + 80))
    }
}

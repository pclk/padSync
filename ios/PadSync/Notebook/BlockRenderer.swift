import CryptoKit
import UIKit
import WebKit

/// Renders a section's header and blocks (Markdown, KaTeX, code, study blocks) with the web's own
/// components: an offscreen WKWebView loads the bundled renderer (`Renderer/`, built from
/// ios/renderer by scripts/build-ios-renderer.mjs) and the result is snapshotted to an image that
/// sits behind the PencilKit canvas. Images are cached in memory and on disk by section id + hlc.
@MainActor
final class BlockRenderer: NSObject, WKNavigationDelegate {
    static let shared = BlockRenderer()

    struct Rendered {
        let image: UIImage
        /// The content column's height (`contentH` in SectionView.tsx); the section is at least this + 80.
        let contentHeight: CGFloat
    }

    private struct Meta: Codable { let contentHeight: Double }

    private var webView: WKWebView?
    private var loaded: CheckedContinuation<Void, Error>?
    private var ready = false
    /// One render at a time: the web view holds one section.
    private var queue: Task<Void, Never>?
    private let memory = NSCache<NSString, UIImage>()
    private var heights: [String: CGFloat] = [:]
    private let directory: URL = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("blocks", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    /// Bumps when the bundled renderer changes, so old snapshots aren't reused.
    private static let version: String = {
        let url = Bundle.main.url(forResource: "renderer", withExtension: "js", subdirectory: "Renderer")
        let size = (try? url?.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        return "1-\(size ?? 0)"
    }()

    /// Whether the section has anything for the renderer: a header or blocks (PDF pages have neither).
    static func hasContent(_ section: Entity) -> Bool {
        let d = section.data
        if d["pdf"] != nil { return !(d["blocks"]?.array?.isEmpty ?? true) }
        let header = ["title", "marks", "timeLimitMinutes", "kind"].contains { d[$0] != nil && d[$0] != .null }
            || !(d["objectives"]?.array?.isEmpty ?? true) || !(d["sources"]?.array?.isEmpty ?? true)
        return header || !(d["blocks"]?.array?.isEmpty ?? true) || d["margin"] != nil
    }

    private func key(_ section: Entity, index: Int) -> String {
        let digest = SHA256.hash(data: Data("\(Self.version)|\(section.id)|\(section.hlc)|\(index)".utf8))
        return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    /// The content height from an earlier render, without rendering, so the column can lay out
    /// unmounted sections at their real height.
    func cachedContentHeight(_ section: Entity, index: Int) -> CGFloat? {
        let k = key(section, index: index)
        if let h = heights[k] { return h }
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("\(k).json")),
              let meta = try? JSONDecoder().decode(Meta.self, from: data) else { return nil }
        heights[k] = meta.contentHeight
        return meta.contentHeight
    }

    func render(_ section: Entity, index: Int) async throws -> Rendered {
        let k = key(section, index: index)
        if let image = memory.object(forKey: k as NSString), let h = cachedContentHeight(section, index: index) {
            return Rendered(image: image, contentHeight: h)
        }
        let png = directory.appendingPathComponent("\(k).png")
        if let h = cachedContentHeight(section, index: index), let image = UIImage(contentsOfFile: png.path) {
            memory.setObject(image, forKey: k as NSString)
            return Rendered(image: image, contentHeight: h)
        }
        // Serialise renders through the one web view.
        let previous = queue
        let task = Task { () throws -> Rendered in
            await previous?.value
            return try await self.renderNow(section, index: index)
        }
        queue = Task { _ = try? await task.value }
        let rendered = try await task.value
        memory.setObject(rendered.image, forKey: k as NSString)
        heights[k] = rendered.contentHeight
        if let data = rendered.image.pngData() {
            try? data.write(to: png)
            try? JSONEncoder().encode(Meta(contentHeight: rendered.contentHeight)).write(to: directory.appendingPathComponent("\(k).json"))
        }
        return rendered
    }

    /// Builds an Ask AI bundle with the web's `buildBundle` (ios/renderer/main.tsx), in turn with
    /// the renders: `{files, sectionIds, skipped, bytes, tokens, error?}`.
    func bundle(input: JSONValue, scope: String, sectionId: String, span: JSONValue? = nil) async throws -> JSONValue {
        let previous = queue
        let task = Task { () throws -> JSONValue in
            await previous?.value
            let web = try await self.prepare()
            let json = String(decoding: input.serialized(), as: UTF8.self)
            let spanJSON = span.map { String(decoding: $0.serialized(), as: UTF8.self) } ?? "null"
            let result = try await web.callAsyncJavaScript("return JSON.stringify(padsyncBundle(JSON.parse(input), scope, sectionId, JSON.parse(span) ?? undefined))",
                                                            arguments: ["input": json, "scope": scope, "sectionId": sectionId, "span": spanJSON], contentWorld: .page)
            guard let text = result as? String else { throw CocoaError(.coderReadCorrupt) }
            return try JSONValue.parse(Data(text.utf8))
        }
        queue = Task { _ = try? await task.value }
        return try await task.value
    }

    private func renderNow(_ section: Entity, index: Int) async throws -> Rendered {
        let web = try await prepare()
        let entity = String(decoding: JSONValue.object(["id": .string(section.id), "kind": .string("section"), "hlc": .string(section.hlc), "data": section.data]).serialized(), as: UTF8.self)
        let result = try await web.callAsyncJavaScript("return await padsyncRender(JSON.parse(entity), index)",
                                                        arguments: ["entity": entity, "index": index], contentWorld: .page)
        guard let dict = result as? [String: Any], let content = (dict["contentHeight"] as? NSNumber)?.doubleValue,
              let snap = (dict["snapshotHeight"] as? NSNumber)?.doubleValue else {
            throw CocoaError(.coderReadCorrupt)
        }
        let height = max(1, CGFloat(snap))
        web.frame.size.height = height
        web.layoutIfNeeded()
        // Let WebKit paint at the new size before the snapshot.
        _ = try? await web.callAsyncJavaScript("await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))", contentWorld: .page)
        let config = WKSnapshotConfiguration()
        config.rect = CGRect(x: 0, y: 0, width: SectionView.pageWidth, height: height)
        config.afterScreenUpdates = true
        let image = try await web.takeSnapshot(configuration: config)
        return Rendered(image: image, contentHeight: CGFloat(content))
    }

    /// Loads the renderer page once. The web view lives off screen in the key window: WebKit
    /// doesn't paint (or snapshot) a view that isn't in a window.
    private func prepare() async throws -> WKWebView {
        if let webView, ready { return webView }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: CGRect(x: -SectionView.pageWidth - 400, y: 0, width: SectionView.pageWidth, height: 1000), configuration: config)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isUserInteractionEnabled = false
        web.overrideUserInterfaceStyle = .light
        web.navigationDelegate = self
        let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
        window?.insertSubview(web, at: 0)
        webView = web
        guard let dir = Bundle.main.url(forResource: "Renderer", withExtension: nil) else { throw CocoaError(.fileNoSuchFile) }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            loaded = c
            web.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
        }
        ready = true
        return web
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded?.resume()
        loaded = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loaded?.resume(throwing: error)
        loaded = nil
        self.webView = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.webView(webView, didFail: navigation, withError: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        self.webView?.removeFromSuperview()
        self.webView = nil
    }
}

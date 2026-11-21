import SwiftUI
import UIKit
import WebKit

/// The deployed web app in a WKWebView. Notebook links open the native editor instead of the
/// web one: the web app posts `openNotebook` when it sees the app (src/lib/native.ts), and any
/// navigation to /notebook that still gets through is turned around here.
struct WebScreen: UIViewRepresentable {
    let onOpenNotebook: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onOpenNotebook: onOpenNotebook)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.limitsNavigationsToAppBoundDomains = true
        config.applicationNameForUserAgent = "padSync-iOS"
        let scripts = config.userContentController
        scripts.add(WeakMessageHandler(context.coordinator), name: "padsync")
        scripts.addUserScript(WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isInspectable = true // Safari → Develop → (iPad) to debug the web half
        web.isOpaque = false
        web.backgroundColor = .clear
        context.coordinator.attach(web)
        web.load(URLRequest(url: Server.baseURL))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    /// Tells the web app it runs inside the native app.
    static let bridgeScript = """
    window.padsyncNative = Object.freeze({ version: 1 });
    """

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let onOpenNotebook: (String) -> Void
        private weak var web: WKWebView?
        private var urlObservation: NSKeyValueObservation?

        init(onOpenNotebook: @escaping (String) -> Void) {
            self.onOpenNotebook = onOpenNotebook
        }

        func attach(_ web: WKWebView) {
            self.web = web
            // Client-side routing (history.pushState) doesn't go through decidePolicyFor.
            urlObservation = web.observe(\.url, options: [.new]) { [weak self] web, _ in
                MainActor.assumeIsolated {
                    guard let self, let url = web.url, let id = Self.notebookId(url) else { return }
                    self.onOpenNotebook(id)
                    if web.canGoBack { web.goBack() } else { web.load(URLRequest(url: Server.baseURL)) }
                }
            }
        }

        static func notebookId(_ url: URL) -> String? {
            guard Server.isServer(url), url.path == "/notebook" else { return nil }
            return URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "id" }?.value.flatMap { $0.isEmpty ? nil : $0 }
        }

        // MARK: Messages from the web app

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "openNotebook":
                if let id = body["id"] as? String, !id.isEmpty { onOpenNotebook(id) }
            default:
                break
            }
        }

        // MARK: Navigation

        func webView(_ web: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            if action.targetFrame?.isMainFrame != false, let id = Self.notebookId(url) {
                onOpenNotebook(id)
                return .cancel
            }
            if Server.isServer(url) || url.host == "github.com" || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
                return .allow
            }
            // Anything else (lecture links, docs) opens in Safari.
            if action.targetFrame?.isMainFrame != false, ["http", "https", "mailto"].contains(url.scheme ?? "") {
                await UIApplication.shared.open(url)
                return .cancel
            }
            return .allow
        }

        /// window.open and target=_blank: same site stays in the app, the rest goes to Safari.
        func webView(_ web: WKWebView, createWebViewWith config: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if let id = Self.notebookId(url) { onOpenNotebook(id) }
                else if Server.isServer(url) { web.load(action.request) }
                else { UIApplication.shared.open(url) }
            }
            return nil
        }

        func webViewWebContentProcessDidTerminate(_ web: WKWebView) {
            web.reload()
        }
    }
}

/// WKUserContentController retains its handlers; this keeps it from retaining the coordinator.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

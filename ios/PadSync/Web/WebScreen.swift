import SwiftUI
import UIKit
import WebKit

/// The deployed web app in a WKWebView. Notebook links open the native editor instead of the
/// web one: the web app posts `openNotebook` when it sees the app (src/lib/native.ts), and any
/// navigation to /notebook that still gets through is turned around here.
struct WebScreen: UIViewRepresentable {
    let database: AppDatabase
    /// A native notebook covers the web screens. The page can't tell (it stays "visible"), so it's
    /// told, and syncs as if hidden instead of fetching every change the notebook pushes.
    let covered: Bool
    /// Called after the web app writes to the native store, to push the write.
    let onStoreWrite: () -> Void
    let onOpenNotebook: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onOpenNotebook: onOpenNotebook)
    }

    func makeUIView(context: Context) -> WebContainer {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.limitsNavigationsToAppBoundDomains = true
        config.applicationNameForUserAgent = "padSync-iOS"
        let scripts = config.userContentController
        scripts.add(WeakMessageHandler(context.coordinator), name: "padsync")
        scripts.addUserScript(WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let store = StoreBridgeHandler(db: database, onWrite: onStoreWrite)
        scripts.addScriptMessageHandler(store, contentWorld: .page, name: StoreBridge.handlerName)

        let web = WKWebView(frame: .zero, configuration: config)
        store.web = web
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isInspectable = true // Safari → Develop → (iPad) to debug the web half
        web.isOpaque = false
        web.backgroundColor = .clear
        context.coordinator.attach(web)
        web.load(URLRequest(url: Server.baseURL))
        let container = WebContainer(web: web)
        context.coordinator.container = container
        return container
    }

    func updateUIView(_ container: WebContainer, context: Context) {
        context.coordinator.setCovered(covered)
    }

    /// Tells the web app it runs inside the native app, and that the native store answers on
    /// `padsyncStore` (`store: true`, see StoreBridge). Also reports the page's background colour on load and whenever the theme changes.
    static let bridgeScript = """
    window.padsyncNative = Object.freeze({ version: 2, store: true });
    (function () {
      var last = null;
      function report() {
        if (!document.body) return;
        var c = getComputedStyle(document.body).backgroundColor;
        if (c === "transparent" || (c.indexOf("rgba(") === 0 && c.slice(-3) === " 0)")) c = getComputedStyle(document.documentElement).backgroundColor;
        if (c === last) return;
        last = c;
        window.webkit.messageHandlers.padsync.postMessage({ type: "pageColor", color: c });
      }
      document.addEventListener("DOMContentLoaded", function () {
        report();
        new MutationObserver(report).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
      });
      window.addEventListener("load", report);
    })();
    """

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let onOpenNotebook: (String) -> Void
        weak var container: WebContainer?
        private weak var web: WKWebView?
        private var urlObservation: NSKeyValueObservation?
        private var covered = false

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

        func setCovered(_ value: Bool) {
            guard value != covered else { return }
            covered = value
            tellCovered()
        }

        /// Sent again after each load, since a reload starts the page uncovered.
        private func tellCovered() {
            web?.evaluateJavaScript("window.padsyncCovered = \(covered); window.dispatchEvent(new CustomEvent('padsync-native-cover'))")
        }

        func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) {
            if covered { tellCovered() }
        }

        // MARK: Messages from the web app

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "openNotebook":
                if let id = body["id"] as? String, !id.isEmpty { onOpenNotebook(id) }
            case "pageColor":
                if let css = body["color"] as? String, let color = UIColor(css: css) { container?.pageColor = color }
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

/// Fills the screen edge to edge in the page's background colour, with the web view inside the
/// safe area, so the status bar and home indicator strips match the page instead of showing white.
/// The status bar text follows the page too: the window takes the page's light or dark style,
/// while the web view keeps the system's, so the web app's "System" appearance still sees the OS.
final class WebContainer: UIView {
    let web: WKWebView
    private var watchingScene = false
    /// The page's background, reported by the bridge script.
    var pageColor = UIColor(red: 0xf1 / 255, green: 0xf5 / 255, blue: 0xf9 / 255, alpha: 1) {
        didSet { applyPageColor() }
    }

    init(web: WKWebView) {
        self.web = web
        super.init(frame: .zero)
        backgroundColor = pageColor
        addSubview(web)
        web.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: leadingAnchor),
            web.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard let scene = window?.windowScene else { return }
        if !watchingScene {
            watchingScene = true
            scene.registerForTraitChanges([UITraitUserInterfaceStyle.self]) { [weak self] (_: UIWindowScene, _: UITraitCollection) in self?.syncWebStyle() }
        }
        syncWebStyle()
        applyPageColor()
    }

    private func applyPageColor() {
        backgroundColor = pageColor
        var white: CGFloat = 1
        pageColor.getWhite(&white, alpha: nil)
        window?.overrideUserInterfaceStyle = white < 0.5 ? .dark : .light
    }

    /// The web view reports the OS appearance, not the window's page-matched one.
    private func syncWebStyle() {
        guard let system = window?.windowScene?.traitCollection.userInterfaceStyle else { return }
        if web.overrideUserInterfaceStyle != system { web.overrideUserInterfaceStyle = system }
    }
}

extension UIColor {
    /// Parses a computed CSS colour: `rgb(r, g, b)` or `rgba(r, g, b, a)`. Transparent counts as none.
    convenience init?(css: String) {
        let parts = css.drop { $0 != "(" }.dropFirst().prefix { $0 != ")" }
            .split(whereSeparator: { $0 == "," || $0 == " " || $0 == "/" }).compactMap { Double($0) }
        guard parts.count >= 3, (parts.count < 4 || parts[3] > 0) else { return nil }
        self.init(red: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: 1)
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

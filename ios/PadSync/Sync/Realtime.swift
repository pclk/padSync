import Foundation
import UIKit
import WebKit

/// POST /api/sync/live (src/app/api/sync/live/route.ts): a short-lived sealed query on the newest
/// entity's seq, or `enabled: false` when the server has no Neon Realtime.
struct RealtimeCapability: Equatable, Sendable {
    var enabled: Bool
    var url = ""
    var login = ""
    /// The sealed query as JSON, handed to the client unchanged.
    var query = ""
    /// When the sealed query expires, in ms since 1970.
    var expiresAt: Double = 0

    init(enabled: Bool, url: String = "", login: String = "", query: String = "", expiresAt: Double = 0) {
        self.enabled = enabled
        self.url = url
        self.login = login
        self.query = query
        self.expiresAt = expiresAt
    }

    init?(json data: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let enabled = json["enabled"] as? Bool else { return nil }
        self.enabled = enabled
        guard enabled else { return }
        guard let url = json["url"] as? String, let login = json["login"] as? String,
              let query = json["query"] as? [String: Any],
              let expiresAt = (query["expiresAt"] as? NSNumber)?.doubleValue,
              let queryData = try? JSONSerialization.data(withJSONObject: query) else { return nil }
        self.url = url
        self.login = login
        self.query = String(decoding: queryData, as: UTF8.self)
        self.expiresAt = expiresAt
    }
}

/// One subscription snapshot, as the web client reports it.
struct RealtimeSnapshot: Equatable, Sendable {
    var generation: Int
    /// `connecting`, `live`, `stale`, `error` or `closed` (LiveQueryState in @neon/realtime).
    var status: String
    var error: String?
    /// The live rows as JSON; a change means the server has something new.
    var signature: String?
}

/// Holds the realtime socket: the web's own Neon client in a hidden web view, a fake in tests.
@MainActor
protocol RealtimeSocket: AnyObject {
    var onSnapshot: (RealtimeSnapshot) -> Void { get set }
    func connect(generation: Int, url: String, query: String) async throws
    func renew(generation: Int, query: String) async throws
    func close()
}

/// Live sync notifications, a port of src/lib/sync-realtime.ts. A notification only wakes the HTTP
/// sync (`onNotify`); polling stays as the fallback, slower while this is live.
@MainActor
final class Realtime {
    enum Status: String, Sendable {
        case connecting, live, fallback, disabled, suspended
    }

    private(set) var status: Status = .suspended
    var onNotify: () -> Void = {}
    var onStatus: (Status) -> Void = { _ in }

    /// Foreground with a notebook open. Turning it on connects; off closes the socket.
    var active = false {
        didSet {
            guard active != oldValue else { return }
            if active { connect() } else { suspend() }
        }
    }

    private let transport: SyncTransport
    private let socket: RealtimeSocket
    private var generation = 0
    private var timer: Task<Void, Never>?
    private var login: String?
    private var failures = 0
    private var renewing = false
    private var signature: String?

    init(transport: SyncTransport = HTTPTransport(), socket: RealtimeSocket = WebRealtimeSocket()) {
        self.transport = transport
        self.socket = socket
        socket.onSnapshot = { [weak self] snapshot in self?.received(snapshot) }
    }

    /// Back online or signed in: reconnect now instead of waiting out the backoff.
    func wake() {
        if active { connect() }
    }

    /// The fallback's wait after `failures` failures: 2 s doubling to 60 s.
    nonisolated static func backoff(failures: Int) -> TimeInterval {
        min(60, 2 * pow(2, Double(min(failures, 5))))
    }

    /// Renew 10 s before the sealed query expires, and never sooner than 1 s from now.
    nonisolated static func renewDelay(expiresAt: Double, now: Date) -> TimeInterval {
        max(1, (expiresAt - now.timeIntervalSince1970 * 1000 - 10000) / 1000)
    }

    private func publish(_ next: Status) {
        status = next
        onStatus(next)
    }

    private func clear() {
        generation += 1
        timer?.cancel()
        timer = nil
        signature = nil
        socket.close()
    }

    private func later(_ delay: TimeInterval, _ fn: @escaping @MainActor (Realtime) async -> Void) {
        timer?.cancel()
        guard active else { return }
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            await fn(self)
        }
    }

    private func failed() {
        guard active else { return }
        clear()
        publish(.fallback)
        let delay = Self.backoff(failures: failures)
        failures += 1
        later(delay) { $0.connect() }
    }

    private func suspend() {
        clear()
        publish(.suspended)
    }

    private func capability() async throws -> RealtimeCapability {
        let (data, code) = try await transport.send("POST", "/api/sync/live", body: nil)
        guard code == 200, let capability = RealtimeCapability(json: data) else { throw URLError(.badServerResponse) }
        return capability
    }

    private func connect() {
        clear()
        guard active else { return publish(.suspended) }
        publish(.connecting)
        let current = generation
        Task { await self.open(current) }
    }

    private func open(_ current: Int) async {
        do {
            let next = try await capability()
            guard current == generation, active else { return }
            guard next.enabled else {
                publish(.disabled)
                return later(60) { $0.connect() }
            }
            // A new login must never reuse the old connection or subscription.
            login = next.login
            try await socket.connect(generation: current, url: next.url, query: next.query)
            guard current == generation else { return }
            renewAt(next.expiresAt)
        } catch {
            if current == generation { failed() }
        }
    }

    private func renewAt(_ expiresAt: Double) {
        later(Self.renewDelay(expiresAt: expiresAt, now: .now)) { await $0.renew() }
    }

    private func renew() async {
        let current = generation
        renewing = true
        defer { renewing = false }
        do {
            let next = try await capability()
            guard current == generation, active else { return }
            guard next.enabled, next.login == login else { return failed() }
            try await socket.renew(generation: current, query: next.query)
            if current == generation { renewAt(next.expiresAt) }
        } catch {
            if current == generation { failed() }
        }
    }

    private func received(_ snapshot: RealtimeSnapshot) {
        guard snapshot.generation == generation, active else { return }
        switch snapshot.status {
        case "error", "closed":
            failed()
        case "stale":
            // The capability ran out before the renewal timer (a slow device clock): renew now.
            publish(.connecting)
            if !renewing { Task { await self.renew() } }
        case "live":
            let wasLive = status == .live
            publish(.live)
            failures = 0
            if !wasLive || snapshot.signature != signature {
                signature = snapshot.signature
                onNotify()
            }
        default:
            publish(.connecting)
        }
    }
}

/// The Neon realtime client (`Renderer/realtime.js`, bundled from ios/realtime by
/// scripts/build-ios-renderer.mjs) in a hidden web view. The page is loaded with the server as its
/// base URL, so the socket opens from the same origin as the web app's.
@MainActor
final class WebRealtimeSocket: NSObject, RealtimeSocket, WKNavigationDelegate {
    var onSnapshot: (RealtimeSnapshot) -> Void = { _ in }

    private var webView: WKWebView?
    private var ready = false
    private var generation = 0
    private var loaded: CheckedContinuation<Void, Error>?

    /// The script handler is retained by the web view; this keeps it from retaining the socket.
    private final class Handler: NSObject, WKScriptMessageHandler {
        weak var owner: WebRealtimeSocket?
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let generation = (body["generation"] as? NSNumber)?.intValue,
                  let status = body["status"] as? String else { return }
            let snapshot = RealtimeSnapshot(generation: generation, status: status, error: body["error"] as? String,
                                            signature: body["signature"] as? String)
            MainActor.assumeIsolated { owner?.onSnapshot(snapshot) }
        }
    }

    func connect(generation: Int, url: String, query: String) async throws {
        let web = try await prepare()
        self.generation = generation
        _ = try await web.callAsyncJavaScript("padsyncRealtime.connect(generation, url, JSON.parse(query))",
                                              arguments: ["generation": generation, "url": url, "query": query], contentWorld: .page)
    }

    func renew(generation: Int, query: String) async throws {
        guard let webView, ready else { throw URLError(.networkConnectionLost) }
        _ = try await webView.callAsyncJavaScript("await padsyncRealtime.renew(generation, JSON.parse(query))",
                                                  arguments: ["generation": generation, "query": query], contentWorld: .page)
    }

    func close() {
        guard let webView, ready else { return }
        webView.evaluateJavaScript("padsyncRealtime.close()")
    }

    /// Loads the page once. It sits off screen in the key window, so WebKit treats it as visible
    /// and doesn't throttle its timers.
    private func prepare() async throws -> WKWebView {
        if let webView, ready { return webView }
        guard let script = Bundle.main.url(forResource: "realtime", withExtension: "js", subdirectory: "Renderer"),
              let js = try? String(contentsOf: script, encoding: .utf8) else { throw CocoaError(.fileNoSuchFile) }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let handler = Handler()
        handler.owner = self
        config.userContentController.add(handler, name: "realtime")
        let web = WKWebView(frame: CGRect(x: -400, y: 0, width: 1, height: 1), configuration: config)
        web.isUserInteractionEnabled = false
        web.navigationDelegate = self
        let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
        window?.insertSubview(web, at: 0)
        webView = web
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            loaded = c
            web.loadHTMLString("<!doctype html><meta charset=\"utf-8\"><script>\(js)</script>", baseURL: Server.baseURL)
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
        reset()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.webView(webView, didFail: navigation, withError: error)
    }

    /// The page died, so the socket did too: report it closed so Realtime falls back and reconnects.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reset()
        onSnapshot(RealtimeSnapshot(generation: generation, status: "closed"))
    }

    private func reset() {
        ready = false
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "realtime")
        webView?.removeFromSuperview()
        webView = nil
    }
}

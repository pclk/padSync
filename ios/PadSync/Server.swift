import Foundation
import WebKit

/// The padSync deployment the app talks to (PADSYNC_HOST in Config/Base.xcconfig).
enum Server {
    static let host: String = Bundle.main.object(forInfoDictionaryKey: "PadSyncHost") as? String ?? "p.siew.dev"
    static let baseURL = URL(string: "https://\(host)")!

    static func url(_ path: String) -> URL {
        URL(string: path, relativeTo: baseURL)!.absoluteURL
    }

    static func isServer(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == host
    }

    /// Same name as SESSION_COOKIE in src/server/auth.ts.
    static let sessionCookieName = "padsync_session"

    /// The session the user signed in with in the web view. Native requests send it as a Cookie
    /// header, so there's one sign-in for both halves of the app.
    @MainActor
    static func sessionCookie() async -> HTTPCookie? {
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        return cookies.first { $0.name == sessionCookieName && host.hasSuffix($0.domain.trimmingPrefix(".")) }
    }

    /// A request to the server carrying the web view's session.
    @MainActor
    static func request(_ path: String) async -> URLRequest {
        var req = URLRequest(url: url(path))
        if let cookie = await sessionCookie() {
            req.setValue("\(cookie.name)=\(cookie.value)", forHTTPHeaderField: "Cookie")
        }
        return req
    }
}

/// GET /api/status (src/app/api/status/route.ts), the fields the app uses.
struct ServerStatus: Decodable {
    let authed: Bool
    let login: String?
    let db: Bool
}

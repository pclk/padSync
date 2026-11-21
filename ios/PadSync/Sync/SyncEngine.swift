import Foundation
import Network
import Observation

/// Sync timing from /api/sync-config, in ms (src/lib/sync-policy.ts).
struct SyncConfig: Decodable, Sendable, Equatable {
    var debounceMs = 100
    var visiblePollMs = 2000
    var hiddenPollMs = 60000
    var retryBaseMs = 2000
}

/// How the engine reaches the server; a stub in tests.
protocol SyncTransport: Sendable {
    /// Returns the body and HTTP status. Throws only when the server can't be reached.
    func send(_ method: String, _ path: String, body: Data?) async throws -> (Data, Int)
}

struct HTTPTransport: SyncTransport {
    func send(_ method: String, _ path: String, body: Data?) async throws -> (Data, Int) {
        var req = await Server.request(path)
        req.httpMethod = method
        req.timeoutInterval = 15
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, res) = try await URLSession.shared.data(for: req)
        return (data, (res as? HTTPURLResponse)?.statusCode ?? 0)
    }
}

/// Offline-first sync, a port of src/lib/sync.ts. Local writes land in SQLite marked dirty; this
/// pushes them (after a short delay) and pulls everything the server has seen since our cursor,
/// in one POST /api/sync per round trip.
@MainActor @Observable
final class SyncEngine {
    enum Status: String, Sendable {
        case idle, syncing, synced, offline, localOnly, needsLogin, error
    }

    private(set) var status: Status = .idle
    private(set) var lastSyncedAt: Date?
    private(set) var config = SyncConfig()

    /// Poll at the visible rate (a notebook is open) or the hidden one (only web screens show,
    /// and they sync themselves).
    var active = false {
        didSet { if active != oldValue, started { schedule(after: pollDelay, reason: "activity") } }
    }

    /// True while the Pencil is down; a sync waits (at most 3 s) for the stroke to end.
    @ObservationIgnored var isInking: () -> Bool = { false }

    @ObservationIgnored private let db: AppDatabase
    @ObservationIgnored private let transport: SyncTransport
    @ObservationIgnored private var started = false
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var dueAt = Date.distantFuture
    @ObservationIgnored private var running = false
    @ObservationIgnored private var again = false
    @ObservationIgnored private var failures = 0
    @ObservationIgnored private var retryAt = Date.distantPast
    @ObservationIgnored private var inkHeldSince: Date?
    @ObservationIgnored private var configCheckedAt = Date.distantPast
    @ObservationIgnored private var pathMonitor: NWPathMonitor?

    static let entityBatch = 100 // strokes are a few KB; stay under Vercel's 4.5 MB body limit
    static let eventBatch = 500
    static let inkHoldMax: TimeInterval = 3

    init(db: AppDatabase, transport: SyncTransport = HTTPTransport()) {
        self.db = db
        self.transport = transport
    }

    func start() {
        guard !started else { return }
        started = true
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.wake(reason: "online") }
        }
        monitor.start(queue: .global(qos: .utility))
        pathMonitor = monitor
        requestSync(after: 0, reason: "start")
    }

    func stop() {
        started = false
        timer?.cancel()
        timer = nil
        dueAt = .distantFuture
        pathMonitor?.cancel()
        pathMonitor = nil
    }

    /// Back online, back in the foreground, or just signed in: skip any backoff.
    func wake(reason: String) {
        retryAt = .distantPast
        configCheckedAt = .distantPast
        requestSync(after: 0, reason: reason)
    }

    /// A local edit (default delay: the send delay) or an explicit request.
    func requestSync(after delay: TimeInterval? = nil, reason: String = "local edit") {
        schedule(after: delay ?? Double(config.debounceMs) / 1000, reason: reason)
    }

    private var pollDelay: TimeInterval {
        Double(active ? config.visiblePollMs : config.hiddenPollMs) / 1000
    }

    /// A later request never postpones an earlier deadline, which bounds latency while writing.
    private func schedule(after delay: TimeInterval, reason: String) {
        guard started else { return }
        let due = max(Date.now.addingTimeInterval(delay), retryAt)
        if timer != nil, due >= dueAt { return }
        timer?.cancel()
        dueAt = due
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, due.timeIntervalSinceNow)))
            guard !Task.isCancelled, let self else { return }
            self.timer = nil
            self.dueAt = .distantFuture
            await self.run(reason: reason)
        }
    }

    private func run(reason: String) async {
        if Date.now < retryAt { return schedule(after: retryAt.timeIntervalSinceNow, reason: reason) }
        if isInking() {
            let since = inkHeldSince ?? .now
            inkHeldSince = since
            let left = Self.inkHoldMax - Date.now.timeIntervalSince(since)
            if left > 0 { return schedule(after: min(0.25, left), reason: reason) }
        }
        inkHeldSince = nil
        if running { again = true; return }
        running = true
        await refreshConfig()
        do {
            while started, try await syncOnce() {}
        } catch {
            status = .error
        }
        running = false
        if status == .synced {
            failures = 0
            retryAt = .distantPast
        } else {
            failures += 1
            let backoff = Double(config.retryBaseMs) / 1000 * pow(2, Double(min(failures - 1, 16)))
            retryAt = Date.now.addingTimeInterval(min(60, backoff))
        }
        if again {
            again = false
            schedule(after: 0, reason: "follow-up")
        } else {
            schedule(after: max(pollDelay, retryAt.timeIntervalSinceNow), reason: "poll")
        }
    }

    private func refreshConfig() async {
        guard Date.now.timeIntervalSince(configCheckedAt) > 60 else { return }
        configCheckedAt = .now
        guard let (data, code) = try? await transport.send("GET", "/api/sync-config", body: nil), code == 200,
              let next = try? JSONDecoder().decode(SyncConfig.self, from: data) else { return }
        config = next
    }

    /// One push+pull round trip; true when there's more to do.
    func syncOnce() async throws -> Bool {
        let batch = try db.pendingBatch(entityLimit: Self.entityBatch, eventLimit: Self.eventBatch)
        if status != .synced || !batch.isEmpty { status = .syncing }
        let body = try JSONSerialization.data(withJSONObject: [
            "since": batch.since,
            "changes": batch.entities.map(\.wire),
            "events": batch.events.map(\.wire),
        ] as [String: Any])

        let data: Data, code: Int
        do {
            (data, code) = try await transport.send("POST", "/api/sync", body: body)
        } catch {
            status = .offline
            return false
        }
        switch code {
        case 200..<300: break
        case 401: status = .needsLogin; return false
        case 503: status = .localOnly; return false
        default: status = .error; return false
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let changes = json["changes"] as? [[String: Any]],
              let cursor = (json["cursor"] as? NSNumber)?.int64Value else {
            status = .error
            return false
        }
        let remote = changes.compactMap(Entity.init(wire:))
        let db = db
        _ = try await Task.detached { try db.applySync(sent: batch, changes: remote, cursor: cursor) }.value
        status = .synced
        lastSyncedAt = .now
        return (json["more"] as? Bool ?? false) || batch.entities.count == Self.entityBatch || batch.events.count == Self.eventBatch
    }
}

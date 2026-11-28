import Foundation
import Network
import Observation

/// Sync timing from /api/sync-config, in ms (src/lib/sync-policy.ts).
struct SyncConfig: Decodable, Sendable, Equatable {
    var debounceMs = 2000
    var visiblePollMs = 5000
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

    /// While realtime notifications are live they wake sync, and polling only recovers missed ones.
    var realtimeLive = false {
        didSet { if oldValue, !realtimeLive, started { schedule(after: pollDelay, reason: "realtime lost") } }
    }

    /// Called on every wake, so realtime can reconnect when the network comes back.
    @ObservationIgnored var onWake: (String) -> Void = { _ in }

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
    /// The server cursor after the last applied pull, and the newest seq a notification announced
    /// while a request was in flight. Every push echoes back as a notification; its own response
    /// already moved the cursor past it, so fetching again would only bring back nothing.
    @ObservationIgnored private var syncedCursor: Int64 = -1
    /// The last local edit, request or incoming change. Every poll reaches Postgres, and anything more
    /// often than every 5 minutes keeps Neon from scaling to zero, so polls slow down once it's old.
    @ObservationIgnored private var activeAt = Date.now
    static let idleAfter: TimeInterval = 5 * 60
    static let idlePoll: TimeInterval = 10 * 60
    @ObservationIgnored private var notifiedSeq: Int64 = 0
    @ObservationIgnored private var pathMonitor: NWPathMonitor?

    static let entityBatch = 100 // strokes are a few KB; stay under Vercel's 4.5 MB body limit
    /// Pasted images ride in their rows: a push also stops once its rows pass this size.
    static let pushBytes = 2_500_000
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
        onWake(reason)
        retryAt = .distantPast
        configCheckedAt = .distantPast
        requestSync(after: 0, reason: reason)
    }

    /// A realtime notification, with the newest seq it announced when the hint carried one.
    func notified(seq: Int64?) {
        if let seq, seq <= syncedCursor { return }
        // The request in flight may be the push that caused it; decide once its response is in.
        if let seq, running { notifiedSeq = max(notifiedSeq, seq); return }
        requestSync(after: 0, reason: "realtime notification")
    }

    /// A local edit (default delay: the send delay) or an explicit request.
    func requestSync(after delay: TimeInterval? = nil, reason: String = "local edit") {
        activeAt = .now
        schedule(after: delay ?? Double(config.debounceMs) / 1000, reason: reason)
    }

    /// The poll while realtime is live: 5 s with a notebook open (Neon can drop a notification while
    /// looking live; FOLLOW_RECOVERY_MS in sync.ts), 30 s otherwise (REALTIME_RECOVERY_MS).
    static let realtimeRecovery: (active: TimeInterval, hidden: TimeInterval) = (5, 30)

    var pollDelay: TimeInterval {
        let configured = Double(active ? config.visiblePollMs : config.hiddenPollMs) / 1000
        let delay = realtimeLive ? max(active ? Self.realtimeRecovery.active : Self.realtimeRecovery.hidden, configured) : configured
        return Date.now.timeIntervalSince(activeAt) > Self.idleAfter ? max(delay, Self.idlePoll) : delay
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
        let pending = again || notifiedSeq > syncedCursor
        again = false
        notifiedSeq = 0
        if pending {
            schedule(after: 0, reason: "follow-up")
        } else {
            schedule(after: max(pollDelay, retryAt.timeIntervalSinceNow), reason: "poll")
        }
    }

    private func refreshConfig() async {
        // Timing changes rarely; waking (foreground, online, sign-in) refreshes it sooner.
        guard Date.now.timeIntervalSince(configCheckedAt) > 600 else { return }
        configCheckedAt = .now
        guard let (data, code) = try? await transport.send("GET", "/api/sync-config", body: nil), code == 200,
              let next = try? JSONDecoder().decode(SyncConfig.self, from: data) else { return }
        config = next
    }

    /// One push+pull round trip; true when there's more to do.
    func syncOnce() async throws -> Bool {
        var batch = try db.pendingBatch(entityLimit: Self.entityBatch, eventLimit: Self.eventBatch)
        let read = batch.entities.count
        var used = 0
        batch.entities = Array(batch.entities.prefix { e in
            used += e.data.serialized().count
            return used <= Self.pushBytes || e.id == batch.entities.first?.id
        })
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
        let sent = batch
        _ = try await Task.detached { try db.applySync(sent: sent, changes: remote, cursor: cursor) }.value
        syncedCursor = cursor
        if !remote.isEmpty { activeAt = .now }
        status = .synced
        lastSyncedAt = .now
        return (json["more"] as? Bool ?? false) || read == Self.entityBatch || batch.entities.count < read || batch.events.count == Self.eventBatch
    }
}

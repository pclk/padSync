import Foundation
import Testing
@testable import padSync

/// Answers POST /api/sync/live with queued capabilities.
final class LiveTransport: SyncTransport, @unchecked Sendable {
    var responses: [(Int, String)]
    var calls = 0

    init(_ responses: [(Int, String)]) { self.responses = responses }

    func send(_ method: String, _ path: String, body: Data?) async throws -> (Data, Int) {
        guard method == "POST", path == "/api/sync/live" else { return (Data(), 404) }
        calls += 1
        let (code, json) = responses.count > 1 ? responses.removeFirst() : responses[0]
        return (Data(json.utf8), code)
    }

    static func enabled(login: String = "me", expiresAt: Double = Date.now.timeIntervalSince1970 * 1000 + 600_000) -> (Int, String) {
        (200, #"{"enabled":true,"url":"wss://rt.example","login":"\#(login)","query":{"v":2,"sealed":"abc","expiresAt":\#(expiresAt)}}"#)
    }
}

@MainActor
final class FakeSocket: RealtimeSocket {
    var onSnapshot: (RealtimeSnapshot) -> Void = { _ in }
    var connects: [(generation: Int, url: String, query: String)] = []
    var renews: [String] = []
    var closes = 0

    func connect(generation: Int, url: String, query: String) async throws { connects.append((generation, url, query)) }
    func renew(generation: Int, query: String) async throws { renews.append(query) }
    func close() { closes += 1 }

    func send(_ status: String, signature: String? = nil) {
        onSnapshot(RealtimeSnapshot(generation: connects.last!.generation, status: status, signature: signature))
    }
}

@MainActor
struct RealtimeTests {
    /// Lets the realtime tasks run until `done` holds (or 2 s pass).
    private func settle(_ done: () -> Bool) async {
        for _ in 0..<200 where !done() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func decodesTheServerCapability() throws {
        let (_, json) = LiveTransport.enabled(expiresAt: 1_800_000_000_000)
        let capability = try #require(RealtimeCapability(json: Data(json.utf8)))
        #expect(capability.enabled && capability.url == "wss://rt.example" && capability.login == "me")
        #expect(capability.expiresAt == 1_800_000_000_000)
        let query = try JSONSerialization.jsonObject(with: Data(capability.query.utf8)) as! [String: Any]
        #expect(query["sealed"] as? String == "abc" && query["v"] as? Int == 2)
        #expect(RealtimeCapability(json: Data(#"{"enabled":false}"#.utf8)) == RealtimeCapability(enabled: false))
        #expect(RealtimeCapability(json: Data(#"{"enabled":true}"#.utf8)) == nil)
        #expect(RealtimeCapability(json: Data("nope".utf8)) == nil)
    }

    @Test func timingMatchesTheWebClient() {
        #expect(Realtime.backoff(failures: 0) == 2)
        #expect(Realtime.backoff(failures: 3) == 16)
        #expect(Realtime.backoff(failures: 9) == 60)
        let now = Date(timeIntervalSince1970: 1000)
        #expect(Realtime.renewDelay(expiresAt: 1_000_000 + 300_000, now: now) == 290)
        #expect(Realtime.renewDelay(expiresAt: 1_000_000, now: now) == 1)
    }

    @Test func notifiesOnFirstLiveAndOnEachChange() async {
        let socket = FakeSocket()
        let realtime = Realtime(transport: LiveTransport([LiveTransport.enabled()]), socket: socket)
        var notes = 0, statuses: [Realtime.Status] = []
        realtime.onNotify = { _ in notes += 1 }
        realtime.onStatus = { statuses.append($0) }
        realtime.active = true
        await settle { !socket.connects.isEmpty }
        #expect(socket.connects.first?.url == "wss://rt.example")
        #expect(socket.connects.first?.query.contains("\"sealed\":\"abc\"") == true)
        socket.send("connecting")
        #expect(notes == 0 && realtime.status == .connecting)
        socket.send("live", signature: #"[{"id":"a","seq":"1"}]"#)
        #expect(notes == 1 && realtime.status == .live)
        socket.send("live", signature: #"[{"id":"a","seq":"1"}]"#)
        #expect(notes == 1)
        socket.send("live", signature: #"[{"id":"b","seq":"2"}]"#)
        #expect(notes == 2)
        #expect(statuses.contains(.live))
        realtime.active = false
        #expect(realtime.status == .suspended)
        // A snapshot from the closed subscription is ignored.
        socket.send("live", signature: "late")
        #expect(notes == 2 && realtime.status == .suspended)
    }

    @Test func fallsBackOnErrorAndReconnects() async {
        let socket = FakeSocket()
        let realtime = Realtime(transport: LiveTransport([LiveTransport.enabled()]), socket: socket)
        realtime.active = true
        await settle { !socket.connects.isEmpty }
        socket.send("live", signature: "[]")
        let closes = socket.closes
        socket.send("error")
        #expect(realtime.status == .fallback)
        #expect(socket.closes == closes + 1)
        // The first retry waits 2 s; waking (back online) reconnects now.
        realtime.wake()
        await settle { socket.connects.count == 2 }
        #expect(socket.connects.count == 2)
        #expect(socket.connects[1].generation > socket.connects[0].generation)
        realtime.active = false
    }

    @Test func staysOffWhenTheServerHasNoRealtime() async {
        let socket = FakeSocket()
        let transport = LiveTransport([(200, #"{"enabled":false}"#)])
        let realtime = Realtime(transport: transport, socket: socket)
        realtime.active = true
        await settle { realtime.status == .disabled }
        #expect(realtime.status == .disabled)
        #expect(socket.connects.isEmpty)
        realtime.active = false
    }

    @Test func signedOutFallsBack() async {
        let realtime = Realtime(transport: LiveTransport([(401, "{}")]), socket: FakeSocket())
        realtime.active = true
        await settle { realtime.status == .fallback }
        #expect(realtime.status == .fallback)
        realtime.active = false
    }

    @Test func renewsBeforeExpiryAndDropsOnLoginChange() async {
        let socket = FakeSocket()
        let soon = Date.now.timeIntervalSince1970 * 1000 + 10_500 // renews after the 1 s minimum
        let transport = LiveTransport([LiveTransport.enabled(expiresAt: soon), LiveTransport.enabled(login: "someone-else")])
        let realtime = Realtime(transport: transport, socket: socket)
        realtime.active = true
        await settle { !socket.connects.isEmpty }
        socket.send("live", signature: "[]")
        await settle { realtime.status == .fallback }
        #expect(transport.calls == 2)
        #expect(socket.renews.isEmpty)
        #expect(realtime.status == .fallback)
        realtime.active = false
    }

    @Test func staleRenewsAtOnce() async {
        let socket = FakeSocket()
        let transport = LiveTransport([LiveTransport.enabled()])
        let realtime = Realtime(transport: transport, socket: socket)
        realtime.active = true
        await settle { !socket.connects.isEmpty }
        socket.send("stale")
        #expect(realtime.status == .connecting)
        await settle { !socket.renews.isEmpty }
        #expect(socket.renews.count == 1)
        realtime.active = false
    }

    @Test func livePollsSlowerButStillPolls() {
        let sync = SyncEngine(db: try! AppDatabase.inMemory(), transport: LiveTransport([(404, "")]))
        sync.active = true
        #expect(sync.pollDelay == 5) // the 5 s default now matches the live recovery poll
        sync.realtimeLive = true
        #expect(sync.pollDelay == 5)
        sync.active = false
        #expect(sync.pollDelay == 60)
        sync.realtimeLive = false
        #expect(sync.pollDelay == 60)
    }

    /// The bundled Neon client loads in WebKit and takes a well-formed subscription (its own
    /// validateSealedQuery passes). Nothing listens on the URL, so it never goes live.
    @Test func theBundledClientLoadsInAWebView() async throws {
        let socket = WebRealtimeSocket()
        var snapshots: [RealtimeSnapshot] = []
        socket.onSnapshot = { snapshots.append($0) }
        // A compact JWE whose header is {"alg":"dir","enc":"A256GCM","v":2}, as seal() makes.
        let header = "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwidiI6Mn0"
        let expiresAt = Int(Date.now.timeIntervalSince1970 * 1000) + 60000
        let query = #"{"capability":"\#(header)..aXY.Y2lwaGVy.dGFn","queryFingerprint":"\#(String(repeating: "ab", count: 32))","expiresAt":\#(expiresAt)}"#
        try await socket.connect(generation: 7, url: "ws://127.0.0.1:9/live", query: query)
        await settle { !snapshots.isEmpty }
        #expect(!snapshots.isEmpty)
        #expect(snapshots.allSatisfy { $0.generation == 7 && $0.status != "live" })
        socket.close()
    }

    @Test func readsTheAnnouncedSeq() {
        #expect(RealtimeSnapshot(generation: 1, status: "live", signature: #"[{"id":"a","seq":"42"}]"#).latestSeq == 42)
        #expect(RealtimeSnapshot(generation: 1, status: "live", signature: "[]").latestSeq == nil)
        #expect(RealtimeSnapshot(generation: 1, status: "live").latestSeq == nil)
    }

    /// A push echoes back as a notification; the device already has it, so it doesn't fetch again.
    @Test func skipsANotificationItAlreadyHas() async {
        let transport = SyncCounter(cursor: 7)
        let sync = SyncEngine(db: try! AppDatabase.inMemory(), transport: transport)
        sync.start()
        await settle { transport.syncs >= 1 && sync.status == .synced }
        // Starting also wakes for the network coming up; let that land before counting.
        try? await Task.sleep(for: .milliseconds(300))
        let before = transport.syncs
        sync.notified(seq: 7)
        try? await Task.sleep(for: .milliseconds(100))
        #expect(transport.syncs == before)
        sync.notified(seq: 8)
        await settle { transport.syncs == before + 1 }
        #expect(transport.syncs == before + 1)
        sync.stop()
    }
}

/// Answers /api/sync with nothing new at a fixed cursor, and counts the calls.
final class SyncCounter: SyncTransport, @unchecked Sendable {
    let cursor: Int
    var syncs = 0
    init(cursor: Int) { self.cursor = cursor }

    func send(_ method: String, _ path: String, body: Data?) async throws -> (Data, Int) {
        guard path == "/api/sync" else { return (Data(), 404) }
        syncs += 1
        return (Data(#"{"changes":[],"cursor":\#(cursor),"more":false}"#.utf8), 200)
    }
}

import CoreGraphics
import PencilKit
import Foundation
import Testing
@testable import padSync

struct BarrelRollTests {
    @Test func rollingPastTheSeamIsASmallTurn() {
        #expect(abs(BarrelRoll.delta(-3.1, from: 3.1) - (2 * .pi - 6.2)) < 1e-9)
        #expect(abs(BarrelRoll.delta(0.5, from: 0.2) - 0.3) < 1e-9)
    }

    @Test func turnsInFiveDegreeStepsWithDetentsEvery45() {
        let deg = CGFloat.pi / 180
        #expect(abs(BarrelRoll.angle(for: 12 * deg) - 10 * deg) < 1e-9)
        #expect(abs(BarrelRoll.angle(for: 13 * deg) - 15 * deg) < 1e-9)
        #expect(BarrelRoll.isDetent(BarrelRoll.angle(for: 44 * deg)))
        #expect(BarrelRoll.isDetent(0))
        #expect(!BarrelRoll.isDetent(BarrelRoll.angle(for: 40 * deg)))
    }

    @Test func turnsAboutTheBoxCentre() {
        let t = BarrelRoll.rotation(.pi / 2, about: CGPoint(x: 10, y: 10))
        let p = CGPoint(x: 20, y: 10).applying(t)
        #expect(abs(p.x - 10) < 1e-9 && abs(p.y - 20) < 1e-9)
        #expect(CGPoint(x: 10, y: 10).applying(t) == CGPoint(x: 10, y: 10))
    }
}

struct SigningExpiryTests {
    @Test func readsTheDateOutOfTheSignedEnvelope() throws {
        let plist = try PropertyListSerialization.data(fromPropertyList: ["ExpirationDate": Date(timeIntervalSince1970: 1_800_000_000), "Name": "x"],
                                                       format: .xml, options: 0)
        let profile = Data([0x30, 0x82, 0x01, 0x00]) + plist + Data([0x00, 0xa0, 0x82])
        #expect(SigningExpiry.date(profile: profile) == Date(timeIntervalSince1970: 1_800_000_000))
        #expect(SigningExpiry.date(profile: Data("nothing here".utf8)) == nil)
    }

    @Test func onlyRemindersStillAheadAreScheduled() {
        let expiry = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(SigningExpiry.reminders(expiry: expiry, now: expiry.addingTimeInterval(-3 * 86400)).count == 2)
        #expect(SigningExpiry.reminders(expiry: expiry, now: expiry.addingTimeInterval(-5 * 3600)).map(\.id) == ["padsync.expiry.hours"])
        #expect(SigningExpiry.reminders(expiry: expiry, now: expiry).isEmpty)
    }
}

struct HandwritingIndexTests {
    func row(_ id: String, _ kind: Entity.Kind, notebook: String, parent: String = "", hlc: String, deleted: Bool = false) -> Entity {
        Entity(id: id, kind: kind, notebookId: notebook, parentId: parent, data: .object([:]), hlc: hlc, deleted: deleted, dirty: false)
    }

    func store() throws -> AppDatabase {
        let db = try AppDatabase.inMemory()
        _ = try db.applySync(sent: .init(since: 0, entities: [], events: []), changes: [
            row("nb", .notebook, notebook: "nb", hlc: "1000000000001-0000-mac"),
            row("s1", .section, notebook: "nb", hlc: "1000000000001-0000-mac"),
            row("s2", .section, notebook: "nb", hlc: "1000000000001-0000-mac"),
            row("k1", .stroke, notebook: "nb", parent: "s1", hlc: "1000000000005-0000-mac"),
        ], cursor: 1)
        return db
    }

    @Test func aSectionIsReadAgainOnlyWhenItsInkChanges() throws {
        let db = try store()
        var stale = try db.writer.read { try HandwritingIndex.stale($0) }
        #expect(stale.map(\.0).sorted() == ["s1", "s2"])
        #expect(stale.first { $0.0 == "s1" }?.2 == "1000000000005-0000-mac")
        try db.writer.write { db in
            for (id, stamp) in [("s1", "1000000000005-0000-mac"), ("s2", "")] {
                try db.execute(sql: "INSERT INTO inkText (sectionId, notebookId, text, stamp) VALUES (?, 'nb', '', ?)", arguments: [id, stamp])
            }
        }
        #expect(try db.writer.read { try HandwritingIndex.stale($0) }.isEmpty)
        // Erasing restamps the stroke.
        _ = try db.applySync(sent: .init(since: 0, entities: [], events: []),
                             changes: [row("k1", .stroke, notebook: "nb", parent: "s1", hlc: "1000000000009-0000-mac", deleted: true)], cursor: 2)
        stale = try db.writer.read { try HandwritingIndex.stale($0) }
        #expect(stale.map(\.0) == ["s1"])
    }

    @Test func searchFindsTheLineInAnyCaseOncePerNotebook() throws {
        let db = try store()
        try db.writer.write { db in
            try db.execute(sql: "INSERT INTO inkText VALUES ('s1', 'nb', 'Intro\nEigenvalues of A', 'x')")
            try db.execute(sql: "INSERT INTO inkText VALUES ('s2', 'nb', 'more eigenvalues', 'x')")
        }
        let hits = try db.writer.read { try HandwritingIndex.search($0, query: " EIGEN ") }
        #expect(hits.count == 1)
        #expect(hits[0].notebookId == "nb")
        #expect(["Eigenvalues of A", "more eigenvalues"].contains(hits[0].line))
        #expect(try db.writer.read { try HandwritingIndex.search($0, query: "fourier") }.isEmpty)
    }
}

@MainActor
struct HandwritingReaderTests {
    /// Block capitals from straight lines, 40 pt tall.
    func stroke(_ pts: [(CGFloat, CGFloat)], at x: CGFloat) -> PKStroke {
        var out: [PKStrokePoint] = []
        for (a, b) in zip(pts, pts.dropFirst()) {
            for i in 0...10 {
                let t = CGFloat(i) / 10
                out.append(PKStrokePoint(location: CGPoint(x: x + a.0 + (b.0 - a.0) * t, y: 20 + a.1 + (b.1 - a.1) * t), timeOffset: 0,
                                         size: CGSize(width: 4, height: 4), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2))
            }
        }
        return PKStroke(ink: PKInk(.pen, color: .black), path: PKStrokePath(controlPoints: out, creationDate: .now))
    }

    @Test func readsBlockCapitals() async {
        let letters: [[[(CGFloat, CGFloat)]]] = [
            [[(0, 0), (0, 40)], [(24, 0), (24, 40)], [(0, 20), (24, 20)]], // H
            [[(24, 0), (0, 0), (0, 40), (24, 40)], [(0, 20), (18, 20)]], // E
            [[(0, 0), (0, 40), (22, 40)]], // L
            [[(0, 0), (0, 40), (22, 40)]], // L
            [[(12, 0), (0, 10), (0, 30), (12, 40), (24, 30), (24, 10), (12, 0)]], // O
        ]
        let strokes = letters.enumerated().flatMap { i, parts in parts.map { stroke($0, at: 20 + CGFloat(i) * 40) } }
        let lines = await HandwritingReader.read(PKDrawing(strokes: strokes))
        #expect(lines.joined().uppercased().contains("HELLO"))
    }
}

struct WidgetAndInboxTests {
    @Test func widgetLinksRoundTrip() {
        let nb = RecentNotebook(id: "abc_123", title: "T", edited: .now)
        #expect(RecentNotebook.id(from: nb.url) == "abc_123")
        #expect(RecentNotebook.id(from: URL(string: "https://p.siew.dev/notebook?id=x")!) == nil)
        #expect(RecentNotebook.id(from: URL(string: "padsync://notebook/")!) == nil)
    }

    @Test func recentNotebooksAreNewestEditFirstWithTheirTitles() throws {
        let db = try AppDatabase.inMemory()
        func nb(_ id: String, _ title: String, _ hlc: String) -> Entity {
            Entity(id: id, kind: .notebook, notebookId: id, parentId: "", data: .object(["title": .string(title), "createdAt": .int(5)]),
                   hlc: hlc, deleted: false, dirty: false)
        }
        _ = try db.applySync(sent: .init(since: 0, entities: [], events: []), changes: [
            nb("a", "Algebra", "1000000000001-0000-mac"), nb("b", "Biology", "1000000002000-0000-mac"),
        ], cursor: 1)
        let rows = try db.writer.read { try AppDatabase.recentNotebooks($0, limit: 6) }
        #expect(rows.map(\.title) == ["Biology", "Algebra"])
        #expect(rows[0].edited == Date(timeIntervalSince1970: 1_000_000_002))
    }

    @Test func inboxListsPdfsByOriginalNameAndRemovesOnlyPlainNames() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("%PDF".utf8).write(to: folder.appendingPathComponent("1700-week 3-notes.pdf"))
        try Data("x".utf8).write(to: folder.appendingPathComponent("1701-photo.jpg"))
        let list = Inbox.list(in: folder)
        #expect(list.map(\.name) == ["week 3-notes.pdf"])
        #expect(list.first?.base64 == Data("%PDF".utf8).base64EncodedString())
        Inbox.remove(["../1701-photo.jpg", list[0].id], in: folder)
        #expect(Inbox.files(in: folder).isEmpty)
        #expect(FileManager.default.fileExists(atPath: folder.appendingPathComponent("1701-photo.jpg").path))
    }
}

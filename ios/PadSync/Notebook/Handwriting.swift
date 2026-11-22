import GRDB
import PencilKit
import UIKit
import Vision

/// Reads handwriting on the iPad with Vision, no server involved. Used to search ink from the
/// library and to send the words along with the picture when you Ask AI. Maths and diagrams read
/// poorly, so the picture stays the source of truth.
enum HandwritingReader {
    /// Lines of text in the ink, top to bottom, left to right.
    static func read(_ drawing: PKDrawing) async -> [String] {
        guard let image = await image(of: drawing) else { return [] }
        var request = RecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        guard let found = try? await request.perform(on: image) else { return [] }
        return found
            .sorted { a, b in
                let ra = a.boundingBox.cgRect, rb = b.boundingBox.cgRect
                // Vision's origin is bottom left: higher y is higher on the page.
                return abs(ra.midY - rb.midY) > min(ra.height, rb.height) / 2 ? ra.midY > rb.midY : ra.minX < rb.minX
            }
            .compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// Dark ink on white at 2×, light mode so dark-mode ink colours don't invert. Large pages are
    /// capped so a long section stays a few megapixels.
    @MainActor
    static func image(of drawing: PKDrawing) -> CGImage? {
        let bounds = drawing.bounds.insetBy(dx: -12, dy: -12)
        guard !drawing.strokes.isEmpty, bounds.width > 0, bounds.height > 0 else { return nil }
        let scale = min(2, sqrt(8_000_000 / (bounds.width * bounds.height)))
        var ink: UIImage?
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            ink = drawing.image(from: bounds, scale: scale)
        }
        guard let ink else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
        return UIGraphicsImageRenderer(size: size, format: format).image { c in
            UIColor.white.setFill()
            c.fill(CGRect(origin: .zero, size: size))
            ink.draw(in: CGRect(origin: .zero, size: size))
        }.cgImage
    }

    /// A section's live ink, rebuilt from the store.
    static func drawing(_ db: Database, sectionId: String) throws -> PKDrawing {
        let rows = try Entity
            .filter(sql: "parentId = ? AND kind = 'stroke' AND deleted = 0", arguments: [sectionId])
            .fetchAll(db)
        return PKDrawing(strokes: rows.compactMap { StrokeCodec.stroke(id: $0.id, data: $0.data) })
    }

    /// The note that goes with a picture in an Ask AI bundle.
    static func file(_ lines: [String], about what: String) -> JSONValue? {
        guard !lines.isEmpty else { return nil }
        let text = "# Handwriting read on the iPad\n\nOn-device text recognition of \(what). It can misread, especially maths and diagrams; the picture is what was written.\n\n" + lines.joined(separator: "\n") + "\n"
        return .object(["path": .string("handwriting.md"), "mime": .string("text/markdown"), "text": .string(text)])
    }
}

/// Keeps the words in every section's ink, for search. Local to the iPad: a section is read again
/// when its newest stroke stamp changes (writing, erasing or a sync), one section at a time, in
/// the background.
@MainActor
final class HandwritingIndex {
    private let database: AppDatabase
    private var running = false
    private var again = false

    init(database: AppDatabase) {
        self.database = database
    }

    /// Reads whatever changed since the last pass. Safe to call often.
    func update() {
        guard !running else { again = true; return }
        running = true
        Task { [weak self] in
            await self?.pass()
        }
    }

    private func pass() async {
        defer {
            running = false
            if again { again = false; update() }
        }
        guard let stale = try? await database.writer.read({ try Self.stale($0) }) else { return }
        for (sectionId, notebookId, stamp) in stale {
            guard let drawing = try? await database.writer.read({ try HandwritingReader.drawing($0, sectionId: sectionId) }) else { continue }
            let text = await HandwritingReader.read(drawing).joined(separator: "\n")
            try? await database.writer.write { db in
                try db.execute(sql: "INSERT OR REPLACE INTO inkText (sectionId, notebookId, text, stamp) VALUES (?, ?, ?, ?)",
                               arguments: [sectionId, notebookId, text, stamp])
            }
        }
    }

    /// Live sections whose ink changed since they were read: (section, notebook, newest stroke stamp).
    nonisolated static func stale(_ db: Database) throws -> [(String, String, String)] {
        try Row.fetchAll(db, sql: """
            SELECT * FROM (
                SELECT s.id, s.notebookId, t.stamp AS done,
                       coalesce((SELECT max(e.hlc) FROM entity e WHERE e.parentId = s.id AND e.kind = 'stroke'), '') AS newest
                FROM entity s LEFT JOIN inkText t ON t.sectionId = s.id
                WHERE s.kind = 'section' AND s.deleted = 0
            ) WHERE done IS NULL OR done != newest
            """).map { ($0["id"], $0["notebookId"], $0["newest"]) }
    }

    /// Notebooks whose ink contains `query` (any case), with the line it was found on.
    nonisolated static func search(_ db: Database, query: String) throws -> [(notebookId: String, sectionId: String, line: String)] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return [] }
        let rows = try Row.fetchAll(db, sql: """
            SELECT t.notebookId, t.sectionId, t.text FROM inkText t
            JOIN entity n ON n.id = t.notebookId AND n.kind = 'notebook' AND n.deleted = 0
            WHERE instr(lower(t.text), lower(?)) > 0
            """, arguments: [term])
        var seen = Set<String>()
        return rows.compactMap { row in
            let notebookId: String = row["notebookId"]
            guard seen.insert(notebookId).inserted else { return nil }
            let text: String = row["text"]
            let line = text.split(separator: "\n").first { $0.localizedCaseInsensitiveContains(term) }.map(String.init) ?? ""
            return (notebookId, row["sectionId"], line)
        }
    }

    /// The stored words of these sections, in the order given (sections never read are skipped).
    nonisolated static func text(_ db: Database, sectionIds: [String]) throws -> [String: String] {
        guard !sectionIds.isEmpty else { return [:] }
        let marks = sectionIds.map { _ in "?" }.joined(separator: ",")
        let rows = try Row.fetchAll(db, sql: "SELECT sectionId, text FROM inkText WHERE sectionId IN (\(marks))",
                                    arguments: StatementArguments(sectionIds))
        return Dictionary(uniqueKeysWithValues: rows.map { ($0["sectionId"] as String, $0["text"] as String) })
    }
}

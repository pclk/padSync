import CryptoKit
import Foundation
import PDFKit
import UIKit

/// PDF backgrounds for imported pages. Files download once through /api/pdfs (checked against
/// the stored size and SHA-256, like openPdf in src/lib/pdf.ts) and stay in Application Support;
/// pages render with PDFKit, one at a time, into a memory-bounded cache.
actor PDFStore {
    static let shared = PDFStore()

    enum Failure: LocalizedError {
        case unavailable(String)
        var errorDescription: String? { if case .unavailable(let m) = self { m } else { nil } }
    }

    private var documents: [String: PDFDocument] = [:]
    private var order: [String] = [] // most recent last; two open documents at most
    private var downloads: [String: Task<URL, Error>] = [:]
    private let images = NSCache<NSString, UIImage>()

    init() {
        images.totalCostLimit = 256 * 1024 * 1024
    }

    private static let folder: URL = {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        let dir = base.appendingPathComponent("pdfs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    /// A rendered page `width` points wide at `scale` pixels per point, cached by scale.
    func image(documentId: String, page: Int, size: CGSize, scale: CGFloat) async throws -> UIImage {
        let key = "\(documentId):\(page):\(scale)" as NSString
        if let hit = images.object(forKey: key) { return hit }
        let doc = try await document(documentId)
        guard let pdfPage = doc.page(at: page - 1) else { throw Failure.unavailable("Page \(page) is missing from the PDF") }
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            let box = pdfPage.bounds(for: .cropBox)
            let rotated = pdfPage.rotation % 180 != 0
            let pageWidth = rotated ? box.height : box.width
            let cg = ctx.cgContext
            // PDF space is bottom-up; flip, then scale the page to the section's width.
            cg.translateBy(x: 0, y: size.height)
            cg.scaleBy(x: size.width / pageWidth, y: -size.width / pageWidth)
            pdfPage.draw(with: .cropBox, to: cg)
        }
        images.setObject(image, forKey: key, cost: Int(size.width * size.height * scale * scale * 4))
        return image
    }

    /// A cached image at any scale, sharpest first, to show while the wanted one renders.
    func cachedImage(documentId: String, page: Int, scales: [CGFloat]) -> UIImage? {
        for s in scales.sorted(by: >) {
            if let hit = images.object(forKey: "\(documentId):\(page):\(s)" as NSString) { return hit }
        }
        return nil
    }

    private func document(_ id: String) async throws -> PDFDocument {
        if let doc = documents[id] {
            order.removeAll { $0 == id }
            order.append(id)
            return doc
        }
        let file = try await localFile(id)
        guard let doc = PDFDocument(url: file) else { throw Failure.unavailable("The PDF couldn't be opened") }
        documents[id] = doc
        order.append(id)
        if order.count > 2 { documents[order.removeFirst()] = nil }
        return doc
    }

    private func localFile(_ id: String) async throws -> URL {
        let file = Self.folder.appendingPathComponent("\(id.replacingOccurrences(of: "/", with: "_")).pdf")
        if FileManager.default.fileExists(atPath: file.path) { return file }
        if let running = downloads[id] { return try await running.value }
        let task = Task { try await Self.download(id, to: file) }
        downloads[id] = task
        defer { downloads[id] = nil }
        return try await task.value
    }

    private static func download(_ id: String, to file: URL) async throws -> URL {
        var comps = URLComponents()
        comps.path = "/api/pdfs"
        comps.queryItems = [URLQueryItem(name: "id", value: id)]
        let (meta, res) = try await URLSession.shared.data(for: await Server.request(comps.string!))
        let info = try JSONSerialization.jsonObject(with: meta) as? [String: Any] ?? [:]
        guard (res as? HTTPURLResponse)?.statusCode == 200, let urlString = info["url"] as? String, let url = URL(string: urlString) else {
            throw Failure.unavailable(info["error"] as? String ?? "PDF unavailable (it may be stored on another device only)")
        }
        let (bytes, download) = try await URLSession.shared.data(from: url)
        guard (download as? HTTPURLResponse)?.statusCode == 200 else { throw Failure.unavailable("PDF download failed") }
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard bytes.starts(with: Data("%PDF-".utf8)), (info["size"] as? NSNumber)?.intValue == bytes.count, hash == info["sha256"] as? String else {
            throw Failure.unavailable("PDF integrity check failed")
        }
        try bytes.write(to: file, options: .atomic)
        return file
    }
}

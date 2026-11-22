import Foundation

/// A file the chat agent gets in its folder (`jobFileSchema` in src/server/jobs.ts).
struct ChatFile: Codable, Equatable, Sendable {
    var path: String
    var mime: String
    var text: String?
    var base64: String?

    /// The web's `fileBytes`: base64 length, or the UTF-8 length of the text as JSON.
    var bytes: Int {
        if let base64 { return base64.utf8.count }
        let enc = JSONEncoder()
        enc.outputFormatting = .withoutEscapingSlashes
        return (try? enc.encode(text ?? ""))?.count ?? 0
    }
}

/// What a turn says it was given (`newTurnSchema.context` in src/server/chat.ts).
struct ChatContextSummary: Codable, Equatable, Sendable {
    var scope: String
    var sectionIds: [String]
    var label: String
    var bytes: Int
    var tokens: Int
}

/// The files and summary for asking about a lasso selection, the same as the web's
/// `buildBundle` with scope "selection" (src/lib/context.ts): README.md, selection.md and
/// selection.png.
struct AskBundle: Equatable, Sendable {
    var files: [ChatFile]
    var context: ChatContextSummary

    /// `MAX_BUNDLE_BYTES` in src/lib/context.ts.
    nonisolated static let maxBytes = 3_200_000

    enum Failure: Error, Equatable {
        /// Only an image, and it's over the size limit (the web's "Lasso a smaller area").
        case tooLarge
    }

    /// The web's `readme(o, true)` without "Returning changes" (the app doesn't take edits back).
    nonisolated static let readme = """
    # padSync export

    Files in this folder:
    - `selection.md`: only the part of the notebook I selected (and `selection.png`, the selected area, if present).

    """

    /// `imageTokens` in src/lib/context.ts.
    nonisolated static func imageTokens(width: Int, height: Int) -> Int {
        min(1600, Int((Double(width * height) / 750).rounded(.up)))
    }

    /// png is the cropped selection with its pixel size; text is typed text in the selection.
    nonisolated static func make(notebookTitle: String, sectionId: String, sectionTitle: String?, index: Int, pdf: (name: String, page: Int)?, png: (data: Data, width: Int, height: Int)?, text: String? = nil) throws(Failure) -> AskBundle {
        let markdown = { (hasImage: Bool) in
            ChatFile(path: "selection.md", mime: "text/markdown", text: AskSelection.markdown(notebookTitle: notebookTitle, sectionTitle: sectionTitle, index: index, pdf: pdf, hasImage: hasImage, text: text))
        }
        let readme = ChatFile(path: "README.md", mime: "text/markdown", text: Self.readme)
        // Like the web: the text is sized with the image reference in place, plus a 4 KB margin.
        let textCost = readme.bytes + markdown(true).bytes + 4096
        var image = png.map { ChatFile(path: "selection.png", mime: "image/png", base64: $0.data.base64EncodedString()) }
        if let i = image, textCost + i.bytes > maxBytes { image = nil }
        let hasText = !(text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        if image == nil && !hasText { throw .tooLarge }

        let files = [readme, markdown(image != nil)] + (image.map { [$0] } ?? [])
        let textChars = files.reduce(0) { $0 + ($1.text?.utf16.count ?? 0) }
        let tokens = Int((Double(textChars) / 4).rounded(.up)) + (image != nil ? png.map { imageTokens(width: $0.width, height: $0.height) } ?? 0 : 0)
        let context = ChatContextSummary(
            scope: "selection", sectionIds: [sectionId],
            label: "1 section · ~\(tokens.formatted(.number.locale(Locale(identifier: "en_US")))) tokens",
            bytes: files.reduce(0) { $0 + $1.bytes }, tokens: tokens)
        return AskBundle(files: files, context: context)
    }
}

import AVFoundation
import GRDB
import UIKit

/// How much a section prompt covers: the section, it and a neighbour, or what the screen shows
/// (`SectionSpan` in src/lib/section-span.ts, the "padsync.sectionSpan" device setting).
enum SectionSpan: String, CaseIterable, Sendable {
    case section, above, below, viewport

    var label: String {
        switch self {
        case .section: "Section"
        case .above: "+ Above"
        case .below: "+ Below"
        case .viewport: "Screen"
        }
    }
}

/// What the screen shows (`ScreenView` in src/lib/section-span.ts): each section's visible part
/// in section-local page units, with its whole height, and the visible width of the page.
struct ScreenView: Sendable {
    struct Slice: Sendable {
        var sectionId: String
        var y0: CGFloat
        var y1: CGFloat
        var h: CGFloat
    }

    var slices: [Slice]
    var x0: CGFloat
    var x1: CGFloat

    var json: JSONValue {
        .object([
            "slices": .array(slices.map {
                .object(["sectionId": .string($0.sectionId), "y0": .int(Int64($0.y0.rounded())), "y1": .int(Int64($0.y1.rounded())), "h": .int(Int64($0.h.rounded()))])
            }),
            "x0": .int(Int64(x0.rounded())), "x1": .int(Int64(x1.rounded())),
        ])
    }

    /// `spanSectionIds`: the sections a span covers around `focused`, in notebook order.
    static func ids(_ sections: [Entity], focused: String, span: SectionSpan, view: ScreenView?) -> [String] {
        if span == .viewport, let view {
            let on = Set(view.slices.map(\.sectionId))
            let ids = sections.map(\.id).filter(on.contains)
            if !ids.isEmpty { return ids }
        }
        guard let i = sections.firstIndex(where: { $0.id == focused }) else { return focused.isEmpty ? [] : [focused] }
        switch span {
        case .above: return sections[max(0, i - 1)...i].map(\.id)
        case .below: return sections[i..<min(sections.count, i + 2)].map(\.id)
        default: return [focused]
        }
    }
}

/// Sends a chat prompt from the notebook the way the web's composer does (`sendPrompt` in
/// Composer.tsx): the bundle for the prompt's context, built by the web's own `buildBundle`, as
/// a new turn in the chat the Mac has open on this notebook, so the reply shows in the Mac's side
/// panel as it streams. With no chat open there, the notebook's latest chat, else a new one.
@MainActor
struct PromptSender {
    let notebookId: String
    let title: String
    /// The notebook's live sections, in order.
    let sections: [Entity]
    /// The section the screen is on.
    let currentSectionId: String?
    let database: AppDatabase
    /// A section's image at a scale: the mounted view's, or one made off screen.
    let render: (Entity, Int, CGFloat) async -> (png: Data, width: Int, height: Int)?
    /// The words in the ink the scope covers, read on the iPad (HandwritingReader.file), or nil.
    var handwriting: (ChatPrompt.Context) async -> JSONValue? = { _ in nil }
    /// How much a section prompt covers, and what the screen shows for `.viewport`.
    var span: SectionSpan = .section
    var view: ScreenView?
    var client = ChatClient()

    struct Selection {
        var sectionId: String
        var png: Data
        var width: Int
        var height: Int
    }

    enum Failure: LocalizedError {
        case nothingSelected
        case bundle(String)
        case tooLong

        var errorDescription: String? {
            switch self {
            case .nothingSelected: "Nothing is selected. Lasso some ink first."
            case .bundle(let m): m
            case .tooLong: "The voice message is too long to send. Keep it under about four minutes."
            }
        }
    }

    /// `MAX_BUNDLE_BYTES` in src/lib/context.ts.
    static let maxBytes = 3_200_000

    /// Builds and sends the turn; returns a short note of what was sent.
    func send(_ prompt: ChatPrompt, text: String? = nil, selection: Selection? = nil, audio: Data? = nil) async throws -> String {
        let scope: ChatPrompt.Context = prompt.context == .chat ? (selection != nil ? .selection : .section) : prompt.context
        if scope == .selection && selection == nil { throw Failure.nothingSelected }
        var (files, context) = try await bundle(scope: scope, selection: selection)
        if scope != .none, let note = await handwriting(scope) { files.append(note) }
        if let audio {
            let b64 = audio.base64EncodedString()
            let size = files.reduce(0) { $0 + (($1["text"]?.string ?? $1["base64"]?.string ?? "").utf8.count) }
            guard b64.utf8.count <= 1_500_000, size + b64.utf8.count <= Self.maxBytes else { throw Failure.tooLong }
            files.append(.object(["path": .string("voice-message.m4a"), "mime": .string("audio/mp4"), "base64": .string(b64)]))
        }
        let thread = try await targetThread()
        var options: [String: JSONValue] = if case .object(let o)? = thread["options"] { o } else { [:] }
        // toolsOf: web search and code are on unless turned off; edits come with the bundle.
        options["webSearch"] = .bool(options["webSearch"]?.bool != false)
        options["allowCode"] = .bool(options["allowCode"]?.bool != false)
        options["allowEdits"] = .bool(true)
        let body: JSONValue = .object([
            "question": .string((text ?? prompt.text).trimmingCharacters(in: .whitespacesAndNewlines)),
            "files": .array(files),
            "uploads": .array([]),
            "context": context,
            "options": .object(options),
            "trace": .object(["client.pressed": .int(Int64(Date.now.timeIntervalSince1970 * 1000)), "client.sent": .int(Int64(Date.now.timeIntervalSince1970 * 1000))]),
        ])
        guard let id = thread["id"]?.string else { throw ChatClient.Failure.server("No chat to send to.") }
        _ = try await client.json("/api/chat/threads/\(id)/turns", method: "POST", body: body)
        // Tells a computer showing this notebook's chat to open this one (src/lib/chat-handoff.ts).
        let device = database.device
        _ = try? database.save([Entity(id: "chatping-\(device)", kind: .presence, notebookId: notebookId, parentId: "",
                                       data: .object(["device": .string(device), "deviceKind": .string("chat"), "chatThreadId": .string(id),
                                                      "at": .int(Int64(Date.now.timeIntervalSince1970 * 1000))]),
                                       hlc: "", deleted: false, dirty: true)])
        return audio != nil ? "Sent: \(prompt.label)" : "Asked: \(prompt.label)"
    }

    // MARK: Bundle

    private func bundle(scope: ChatPrompt.Context, selection: Selection?) async throws -> (files: [JSONValue], context: JSONValue) {
        if scope == .none {
            return ([], .object(["scope": .string("none"), "sectionIds": .array([]), "label": .string("No context"), "bytes": .int(0), "tokens": .int(0)]))
        }
        let current = currentSectionId ?? sections.first?.id ?? ""
        var inputs = try await gather()
        let spanIds = ScreenView.ids(sections, focused: current, span: span, view: view)
        let shown = span == .viewport ? view.map { v in ScreenView(slices: v.slices.filter { spanIds.contains($0.sectionId) }, x0: v.x0, x1: v.x1) } : nil
        switch scope {
        case .section:
            for id in spanIds {
                guard let i = sections.firstIndex(where: { $0.id == id }) else { continue }
                // On the screen, only the part showing, at full detail.
                let slice = shown?.slices.first { $0.sectionId == id }
                guard let r = await render(sections[i], i, spanIds.count == 1 || slice != nil ? 2 : 1) else {
                    inputs[i]["renderNote"] = .string("could not render")
                    continue
                }
                inputs[i]["render"] = raster(slice.flatMap { Self.crop(r, y0: $0.y0, y1: $0.y1, x0: shown!.x0, x1: shown!.x1) } ?? r)
            }
        case .notebook:
            var used = 0
            for (i, s) in sections.enumerated() {
                if used >= Self.maxBytes {
                    inputs[i]["renderNote"] = .string("size limit")
                    continue
                }
                guard let r = await render(s, i, 1) else {
                    inputs[i]["renderNote"] = .string("could not render")
                    continue
                }
                inputs[i]["render"] = raster(r)
                used += r.png.count * 4 / 3
            }
        default:
            break
        }
        var input: [String: JSONValue] = ["title": .string(title), "sections": .array(inputs)]
        if let selection {
            input["selection"] = .object(["sectionId": .string(selection.sectionId),
                                          "crop": raster((selection.png, selection.width, selection.height))])
        }
        let target = scope == .selection ? (selection?.sectionId ?? current) : current
        let extra: JSONValue? = scope == .section
            ? .object(["sectionIds": .array(spanIds.map(JSONValue.string)), "view": shown?.json ?? .null])
            : nil
        let b = try await BlockRenderer.shared.bundle(input: .object(input), scope: scope.rawValue, sectionId: target, span: extra)
        if let error = b["error"]?.string { throw Failure.bundle(error) }
        let ids = b["sectionIds"]?.array ?? []
        let tokens = b["tokens"]?.int ?? 0
        let tokenText = "~\(tokens.formatted(.number.locale(Locale(identifier: "en_US")))) tokens"
        let label: String = if scope == .section && ids.count == 1 {
            "\(sectionTitle(ids.first?.string ?? target)) · \(tokenText)"
        } else {
            "\(ids.count) section\(ids.count == 1 ? "" : "s") · \(tokenText)"
        }
        let context: JSONValue = .object([
            "scope": .string(scope.rawValue), "sectionIds": .array(ids), "label": .string(label),
            "bytes": .int(b["bytes"]?.int ?? 0), "tokens": .int(tokens),
        ])
        return (b["files"]?.array ?? [], context)
    }

    /// A render cut down to a part of its section, in page units.
    private static func crop(_ r: (png: Data, width: Int, height: Int), y0: CGFloat, y1: CGFloat, x0: CGFloat, x1: CGFloat) -> (png: Data, width: Int, height: Int)? {
        guard let image = UIImage(data: r.png)?.cgImage else { return nil }
        let scale = CGFloat(image.width) / SectionView.pageWidth
        let rect = CGRect(x: x0 * scale, y: y0 * scale, width: (x1 - x0) * scale, height: (y1 - y0) * scale).integral
            .intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !rect.isEmpty, let cut = image.cropping(to: rect), let png = UIImage(cgImage: cut).pngData() else { return nil }
        return (png, cut.width, cut.height)
    }

    private func raster(_ r: (png: Data, width: Int, height: Int)) -> JSONValue {
        .object(["base64": .string(r.png.base64EncodedString()), "width": .int(Int64(r.width)), "height": .int(Int64(r.height))])
    }

    /// The chat panel's title for a section: its title, or "Section N".
    private func sectionTitle(_ id: String) -> String {
        guard let i = sections.firstIndex(where: { $0.id == id }) else { return "Section" }
        let t = sections[i].data["title"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? "Section \(i + 1)" : t
    }

    /// `gatherSections`: each section's data, typed notes top to bottom, and last activity.
    private func gather() async throws -> [JSONValue] {
        let ids = sections.map(\.id)
        let children = try await database.writer.read { db in
            try Entity.filter(sql: "kind IN ('stroke', 'textbox')").filter(ids.contains(Column("parentId"))).fetchAll(db)
        }
        let byParent = Dictionary(grouping: children, by: \.parentId)
        return sections.map { s in
            let kids = byParent[s.id] ?? []
            let latest = kids.map(\.hlc).max() ?? ""
            let notes = kids.filter { $0.kind == .textbox && !$0.deleted }
                .sorted { ($0.data["y"]?.double ?? 0) < ($1.data["y"]?.double ?? 0) }
                .map { JSONValue.string($0.data["text"]?.string ?? "") }
            let last = max(HLC.wall(s.hlc) ?? 0, HLC.wall(latest) ?? 0)
            return .object(["id": .string(s.id), "data": s.data, "notes": .array(notes), "lastActivity": .int(last)])
        }
    }

    // MARK: Which chat

    /// The chat the Mac has open on this notebook (its `chatfocus-` row, written by the web's chat
    /// panel), else the notebook's most recent chat, else a new one on the default model.
    private func targetThread() async throws -> JSONValue {
        let notebookId = notebookId
        let focus = try? await database.writer.read { db in
            try Entity.filter(sql: "kind = 'presence' AND notebookId = ? AND id LIKE 'chatfocus-%' AND deleted = 0", arguments: [notebookId]).fetchAll(db)
        }
        let recent = (focus ?? [])
            .filter { Date.now.timeIntervalSince1970 * 1000 - Double($0.data["at"]?.int ?? 0) < 12 * 3600 * 1000 }
            .max { ($0.data["at"]?.int ?? 0) < ($1.data["at"]?.int ?? 0) }
        let list = try await client.json("/api/chat/threads?notebookId=\(notebookId)&archived=0")["threads"]?.array ?? []
        if let id = recent?.data["chatThreadId"]?.string, !id.isEmpty {
            if let t = list.first(where: { $0["id"]?.string == id }) { return t }
            if let t = try? await client.json("/api/chat/threads/\(id)")["thread"] { return t }
        }
        if let latest = list.filter({ $0["notebookId"]?.string == notebookId }).max(by: { ($0["updatedAt"]?.string ?? "") < ($1["updatedAt"]?.string ?? "") }) {
            return latest
        }
        let model = await client.defaultModel()
        var options = model.options.mapValues(JSONValue.string)
        options["webSearch"] = .bool(true)
        options["allowCode"] = .bool(true)
        let made = try await client.json("/api/chat/threads", method: "POST", body: .object([
            "notebookId": .string(notebookId), "title": .string(""), "agent": .string(model.agent), "options": .object(options),
        ]))
        guard let t = made["thread"] else { throw ChatClient.Failure.server("Couldn't start a chat.") }
        return t
    }
}

/// Records a voice message for a voice prompt: AAC in an .m4a, small enough to ride in the turn.
@MainActor
final class VoiceRecorder: NSObject {
    private var recorder: AVAudioRecorder?
    private let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-message.m4a")
    var duration: TimeInterval { recorder?.currentTime ?? 0 }

    func start() async throws {
        guard await AVAudioApplication.requestRecordPermission() else {
            throw ChatClient.Failure.server("padSync needs the microphone for voice messages. Turn it on in Settings → padSync.")
        }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker])
        try session.setActive(true)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 22_050, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000,
        ]
        let r = try AVAudioRecorder(url: url, settings: settings)
        guard r.record() else { throw ChatClient.Failure.server("Couldn't start recording.") }
        recorder = r
    }

    /// Stops and returns the recording.
    func finish() -> Data? {
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        defer { try? FileManager.default.removeItem(at: url) }
        return try? Data(contentsOf: url)
    }

    func cancel() {
        recorder?.stop()
        recorder?.deleteRecording()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// The bar shown while a voice prompt records (PromptRecorder.tsx): time, Cancel and Send.
@MainActor
final class RecorderBar: UIView {
    var onSend: () -> Void = {}
    var onCancel: () -> Void = {}
    private let label = UILabel()
    private var timer: Timer?
    private let started = Date.now

    init(title: String) {
        super.init(frame: CGRect(x: 0, y: 0, width: 360, height: 56))
        overrideUserInterfaceStyle = .light
        backgroundColor = .white
        layer.cornerRadius = 28
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.2
        layer.shadowRadius = 14
        layer.shadowOffset = CGSize(width: 0, height: 4)
        let dot = UIView(frame: CGRect(x: 20, y: 22, width: 12, height: 12))
        dot.backgroundColor = .systemRed
        dot.layer.cornerRadius = 6
        addSubview(dot)
        UIView.animate(withDuration: 0.6, delay: 0, options: [.autoreverse, .repeat]) { dot.alpha = 0.3 }
        label.frame = CGRect(x: 42, y: 0, width: 150, height: 56)
        label.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
        label.textColor = UIColor(hex: "#0f172a")
        addSubview(label)
        let cancel = UIButton(configuration: .plain())
        cancel.configuration?.title = "Cancel"
        cancel.frame = CGRect(x: 180, y: 8, width: 80, height: 40)
        cancel.addAction(UIAction { [weak self] _ in self?.onCancel() }, for: .primaryActionTriggered)
        addSubview(cancel)
        var send = UIButton.Configuration.filled()
        send.title = "Send"
        send.cornerStyle = .capsule
        let sendButton = UIButton(configuration: send)
        sendButton.frame = CGRect(x: 266, y: 8, width: 80, height: 40)
        sendButton.addAction(UIAction { [weak self] _ in self?.onSend() }, for: .primaryActionTriggered)
        addSubview(sendButton)
        label.text = "\(title) 0:00"
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let s = Int(Date.now.timeIntervalSince(self.started))
                self.label.text = "\(title) \(s / 60):\(String(format: "%02d", s % 60))"
            }
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func removeFromSuperview() {
        timer?.invalidate()
        super.removeFromSuperview()
    }
}

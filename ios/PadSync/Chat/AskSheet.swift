import SwiftUI

/// Asks about a lasso selection: shows the picture, takes the question, posts the turn to the
/// web's chat (a new chat on the notebook, so it's also in the web chat panel) and shows the reply.
struct AskSheet: View {
    let capture: AskCapture
    let notebookTitle: String
    @Environment(\.dismiss) private var dismiss
    @State private var question = ""
    @State private var phase = Phase.composing
    @FocusState private var focused: Bool
    @State private var work: Task<Void, Never>?

    enum Phase: Equatable {
        case composing
        case sending
        case waiting(status: String, output: String)
        case answered(String)
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let image = UIImage(data: capture.png) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 260)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator))
                            .accessibilityLabel("The selected area")
                    }
                    if phase == .composing || phase.failed != nil {
                        TextField("Ask about this selection…", text: $question, axis: .vertical)
                            .lineLimit(2...6)
                            .textFieldStyle(.roundedBorder)
                            .focused($focused)
                            .onSubmit(send)
                    } else {
                        Text(question).font(.headline)
                    }
                    content
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("Ask AI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                if phase == .composing || phase.failed != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Ask", action: send).disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
        .onAppear { focused = true }
        .onDisappear { work?.cancel() }
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .composing:
            Text("Only this selection is shared. The chat also appears in the notebook's chat panel on the web.")
                .font(.footnote).foregroundStyle(.secondary)
        case .sending:
            ProgressView("Sending…")
        case let .waiting(status, output):
            if output.isEmpty {
                ProgressView(status == "running" ? "Thinking…" : "Waiting for the Mac to pick it up…")
            } else {
                answer(output)
                ProgressView().controlSize(.small)
            }
        case let .answered(output):
            answer(output)
        case let .failed(message):
            Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
        }
    }

    /// Plain Markdown: inline styles kept, line breaks kept (no KaTeX yet).
    private func answer(_ text: String) -> some View {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return Text((try? AttributedString(markdown: text, options: options)) ?? AttributedString(text))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func send() {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, phase == .composing || phase.failed != nil else { return }
        phase = .sending
        work = Task {
            do {
                let bundle = try AskBundle.make(notebookTitle: notebookTitle, sectionId: capture.sectionId, sectionTitle: capture.sectionTitle,
                                                index: capture.index, pdf: capture.pdf,
                                                png: (capture.png, Int(capture.pixelSize.width), Int(capture.pixelSize.height)))
                let client = ChatClient()
                let (thread, turn) = try await client.ask(notebookId: capture.notebookId, question: q, bundle: bundle)
                try await follow(thread: thread, jobId: turn.jobId, client: client)
            } catch AskBundle.Failure.tooLarge {
                phase = .failed("The selected area is too large to send. Lasso a smaller area.")
            } catch is CancellationError {
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }

    /// Polls the thread (as the web chat does without its live channel) until the turn finishes
    /// or the sheet closes.
    private func follow(thread: String, jobId: String, client: ChatClient) async throws {
        phase = .waiting(status: "queued", output: "")
        while !Task.isCancelled {
            try await Task.sleep(for: .seconds(1.5))
            guard let turn = try await client.turns(thread: thread).first(where: { $0.jobId == jobId }) else { continue }
            if !turn.finished {
                phase = .waiting(status: turn.status, output: turn.output)
            } else if turn.status == "done" {
                phase = .answered(turn.output)
                return
            } else {
                phase = .failed(turn.error ?? (turn.status == "cancelled" ? "The reply was cancelled." : "The reply failed."))
                return
            }
        }
    }
}

private extension AskSheet.Phase {
    var failed: String? { if case let .failed(m) = self { m } else { nil } }
}

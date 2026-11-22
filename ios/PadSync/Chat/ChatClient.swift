import Foundation

/// The chat endpoints the app needs to ask about a selection, as `useChat` uses them
/// (src/lib/chat-api.ts): read the default model, make a thread, send a turn, poll the reply.
/// Requests carry the web view's session (`Server.request`).
@MainActor
struct ChatClient {
    struct ModelChoice: Codable, Equatable, Sendable {
        var agent: String
        /// model, effort and account: the parts of the options a default model keeps.
        var options: [String: String]
    }

    struct Thread: Decodable, Equatable, Sendable {
        let id: String
    }

    struct Turn: Decodable, Equatable, Sendable {
        let jobId: String
        let turn: Int
        let status: String
        let output: String
        let error: String?

        /// The turn won't change any more (`TurnStatus` in src/lib/chat-types.ts).
        var finished: Bool { ["done", "error", "cancelled"].contains(status) }
    }

    enum Failure: Error, Equatable, LocalizedError {
        case signedOut
        case unavailable
        case server(String)

        var errorDescription: String? {
            switch self {
            case .signedOut: "Sign in to padSync to ask AI."
            case .unavailable: "padSync's database is unavailable. Try again shortly."
            case let .server(message): message
            }
        }
    }

    /// Sends a request and returns the body and status. Tests swap it for a fake server.
    var transport: (URLRequest) async throws -> (Data, Int) = { req in
        let (data, res) = try await URLSession.shared.data(for: req)
        return (data, (res as? HTTPURLResponse)?.statusCode ?? 0)
    }

    /// What a new chat starts on: the synced `chat.defaultModel`, else Claude with the bridge's
    /// default model (the web's catalog default needs the catalog; the bridge picks the same).
    func defaultModel() async -> ModelChoice {
        struct Prefs: Decodable {
            struct Values: Decodable {
                let model: ModelChoice?
                enum CodingKeys: String, CodingKey { case model = "chat.defaultModel" }
            }
            let prefs: Values
        }
        return (try? await call(Prefs.self, "/api/prefs"))?.prefs.model ?? ModelChoice(agent: "claude", options: [:])
    }

    func createThread(notebookId: String, model: ModelChoice) async throws -> Thread {
        struct Body: Encodable { let notebookId: String; let title = ""; let agent: String; let options: [String: String] }
        struct Res: Decodable { let thread: Thread }
        return try await call(Res.self, "/api/chat/threads", body: Body(notebookId: notebookId, agent: model.agent, options: model.options)).thread
    }

    func sendTurn(thread: String, question: String, bundle: AskBundle) async throws -> Turn {
        struct Body: Encodable { let question: String; let files: [ChatFile]; let context: ChatContextSummary }
        struct Res: Decodable { let turn: Turn }
        return try await call(Res.self, "/api/chat/threads/\(thread)/turns", body: Body(question: question, files: bundle.files, context: bundle.context)).turn
    }

    /// The thread's turns, whole (no `since`/`from` deltas: one short reply is cheap to refetch).
    func turns(thread: String) async throws -> [Turn] {
        struct Res: Decodable { let turns: [Turn] }
        return try await call(Res.self, "/api/chat/threads/\(thread)").turns
    }

    /// Makes a thread for the notebook and asks the question with the bundle; returns the thread
    /// id and the new turn, which `turns(thread:)` then follows.
    func ask(notebookId: String, question: String, bundle: AskBundle) async throws -> (thread: String, turn: Turn) {
        let thread = try await createThread(notebookId: notebookId, model: defaultModel())
        return (thread.id, try await sendTurn(thread: thread.id, question: question, bundle: bundle))
    }

    private struct ErrorBody: Decodable { let error: String? }

    private func call<T: Decodable>(_: T.Type, _ path: String, body: (some Encodable)? = Optional<Int>.none) async throws -> T {
        var req = await Server.request(path)
        req.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let enc = JSONEncoder()
            enc.outputFormatting = .withoutEscapingSlashes
            req.httpBody = try enc.encode(body)
        }
        let (data, status) = try await transport(req)
        guard (200..<300).contains(status) else {
            // The statuses the web's `call` (chat-api.ts) names.
            if status == 401 { throw Failure.signedOut }
            if status == 503 { throw Failure.unavailable }
            throw Failure.server((try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "HTTP \(status)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

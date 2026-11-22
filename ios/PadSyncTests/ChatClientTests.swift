import Foundation
import Testing
@testable import padSync

struct AskBundleTests {
    private let png = (data: Data(repeating: 7, count: 300), width: 696, height: 196)

    @Test func selectionBundleHasTheWebsFilesAndSummary() throws {
        let b = try AskBundle.make(notebookTitle: "Physics", sectionId: "s1", sectionTitle: "Waves", index: 2, pdf: nil, png: png)
        #expect(b.files.map(\.path) == ["README.md", "selection.md", "selection.png"])
        #expect(b.files[0].text == "# padSync export\n\nFiles in this folder:\n- `selection.md`: only the part of the notebook I selected (and `selection.png`, the selected area, if present).\n")
        #expect(b.files[1].text?.contains("![The selected area, with my handwriting](selection.png)") == true)
        #expect(b.files[2].base64 == png.data.base64EncodedString() && b.files[2].mime == "image/png")
        // ceil(textChars / 4) + min(1600, ceil(696·196 / 750)) = … + 182
        let textChars = b.files.compactMap(\.text).reduce(0) { $0 + $1.utf16.count }
        #expect(b.context.tokens == (textChars + 3) / 4 + 182)
        #expect(b.context == ChatContextSummary(scope: "selection", sectionIds: ["s1"], label: "1 section · ~\(b.context.tokens) tokens", bytes: b.files.reduce(0) { $0 + $1.bytes }, tokens: b.context.tokens))
    }

    @Test func fileBytesMatchTheWeb() {
        // JSON.stringify("a/\"b\"\n") is "a/\"b\"\n" with quotes: 11 bytes, slash unescaped.
        #expect(ChatFile(path: "x.md", mime: "text/markdown", text: "a/\"b\"\n").bytes == 11)
        #expect(ChatFile(path: "x.png", mime: "image/png", base64: "QUJD").bytes == 4)
        #expect(AskBundle.imageTokens(width: 4000, height: 4000) == 1600)
    }

    @Test func anImageOverTheLimitIsDroppedOrRefused() throws {
        let big = (data: Data(count: AskBundle.maxBytes), width: 100, height: 100)
        #expect(throws: AskBundle.Failure.tooLarge) {
            try AskBundle.make(notebookTitle: "N", sectionId: "s", sectionTitle: nil, index: 0, pdf: nil, png: big)
        }
        // With typed text it still goes, as text only.
        let b = try AskBundle.make(notebookTitle: "N", sectionId: "s", sectionTitle: nil, index: 0, pdf: nil, png: big, text: "F = ma")
        #expect(b.files.map(\.path) == ["README.md", "selection.md"])
        #expect(b.files[1].text?.contains("selection.png") == false)
    }
}

@MainActor
struct ChatClientTests {
    /// A fake server: records requests and answers from a table of path → (status, body).
    @MainActor final class Fake {
        var routes: [String: (Int, String)] = [:]
        var requests: [URLRequest] = []
        func client() -> ChatClient {
            var c = ChatClient()
            c.transport = { [self] req in
                requests.append(req)
                let (status, body) = routes[req.url!.path] ?? (404, #"{"error":"Not found"}"#)
                return (Data(body.utf8), status)
            }
            return c
        }
        func body(_ i: Int) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: requests[i].httpBody!) as! [String: Any]
        }
    }

    private let turnJSON = #"{"jobId":"j1","turn":1,"question":"q","status":"queued","output":"","outputOffset":0,"error":null,"attachments":[],"agent":"claude","options":{}}"#

    @Test func askMakesAThreadOnTheDefaultModelAndSendsTheBundle() async throws {
        let fake = Fake()
        fake.routes = [
            "/api/prefs": (200, #"{"prefs":{"chat.defaultModel":{"agent":"codex","options":{"model":"gpt-5","effort":"high"}}},"updatedAt":{}}"#),
            "/api/chat/threads": (201, #"{"thread":{"id":"chat_1","title":""}}"#),
            "/api/chat/threads/chat_1/turns": (201, #"{"turn":\#(turnJSON)}"#),
        ]
        let bundle = try AskBundle.make(notebookTitle: "N", sectionId: "s1", sectionTitle: "T", index: 0, pdf: nil, png: (Data([1, 2, 3]), 10, 10))
        let (thread, turn) = try await fake.client().ask(notebookId: "nb1", question: "Check my working", bundle: bundle)
        #expect(thread == "chat_1" && turn.jobId == "j1" && !turn.finished)
        #expect(fake.requests.map(\.url!.path) == ["/api/prefs", "/api/chat/threads", "/api/chat/threads/chat_1/turns"])
        #expect(fake.requests[1].httpMethod == "POST" && fake.requests[1].value(forHTTPHeaderField: "Content-Type") == "application/json")
        let created = try fake.body(1)
        #expect(created["notebookId"] as? String == "nb1" && created["agent"] as? String == "codex")
        #expect(created["options"] as? [String: String] == ["model": "gpt-5", "effort": "high"])
        let sent = try fake.body(2)
        #expect(sent["question"] as? String == "Check my working")
        #expect((sent["files"] as? [[String: Any]])?.compactMap { $0["path"] as? String } == ["README.md", "selection.md", "selection.png"])
        #expect((sent["context"] as? [String: Any])?["scope"] as? String == "selection")
    }

    @Test func noSavedDefaultStartsOnClaude() async {
        let fake = Fake()
        fake.routes = ["/api/prefs": (200, #"{"prefs":{},"updatedAt":{}}"#)]
        #expect(await fake.client().defaultModel() == ChatClient.ModelChoice(agent: "claude", options: [:]))
        fake.routes = [:]
        #expect(await fake.client().defaultModel().agent == "claude")
    }

    @Test func pollingReadsTheTurnsAndErrorsAreNamed() async throws {
        let fake = Fake()
        let done = turnJSON.replacingOccurrences(of: #""queued","output":"""#, with: #""done","output":"Looks right.""#)
        fake.routes = ["/api/chat/threads/chat_1": (200, #"{"thread":{"id":"chat_1"},"turns":[\#(done)],"bridgeSeenAt":null,"now":"x"}"#)]
        let turns = try await fake.client().turns(thread: "chat_1")
        #expect(turns.first?.output == "Looks right." && turns.first?.finished == true)

        fake.routes = ["/api/chat/threads/chat_1": (401, #"{"error":"Unauthorized"}"#)]
        await #expect(throws: ChatClient.Failure.signedOut) { try await fake.client().turns(thread: "chat_1") }
        fake.routes = ["/api/chat/threads/chat_1": (400, #"{"error":"Invalid attachments"}"#)]
        await #expect(throws: ChatClient.Failure.server("Invalid attachments")) { try await fake.client().turns(thread: "chat_1") }
    }
}

import PencilKit
import SwiftUI

/// The native notebook editor. Phase 1 stub: a PencilKit scratch canvas to try the Pencil, plus
/// a check that the web sign-in reaches native requests. Ink here isn't saved yet.
struct NotebookScreen: View {
    let notebookId: String
    let onClose: () -> Void
    @State private var status = "Checking sign-in…"

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                Button(action: onClose) {
                    Label("Library", systemImage: "chevron.left")
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Native editor preview").font(.headline)
                    Text("Notebook \(notebookId) · \(status) · ink here isn't saved yet")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(.bar)
            Divider()
            ScratchCanvas()
                .ignoresSafeArea(edges: .bottom)
        }
        .task { status = await Self.checkSignIn() }
    }

    static func checkSignIn() async -> String {
        do {
            let (data, _) = try await URLSession.shared.data(for: Server.request("/api/status"))
            let s = try JSONDecoder().decode(ServerStatus.self, from: data)
            return s.authed ? "signed in as \(s.login ?? "?")" : "not signed in"
        } catch {
            return "offline"
        }
    }
}

/// A full-size PencilKit canvas with the system tool picker. Fingers scroll, the Pencil draws.
struct ScratchCanvas: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> PKCanvasView {
        let canvas = PKCanvasView()
        canvas.drawingPolicy = .pencilOnly
        canvas.backgroundColor = .white
        canvas.isOpaque = true
        canvas.alwaysBounceVertical = true
        canvas.contentSize = CGSize(width: 1376, height: 4000)
        canvas.tool = PKInkingTool(.pen, color: .black, width: 3)
        let picker = context.coordinator.picker
        picker.addObserver(canvas)
        picker.setVisible(true, forFirstResponder: canvas)
        DispatchQueue.main.async { canvas.becomeFirstResponder() }
        return canvas
    }

    func updateUIView(_ canvas: PKCanvasView, context: Context) {}

    @MainActor
    final class Coordinator {
        let picker = PKToolPicker()
    }
}

import PencilKit
import SwiftUI

/// The native notebook editor. Phase 2 stub: shows what the native store holds for the notebook
/// and the sync state over a PencilKit scratch canvas. Ink here isn't saved yet.
struct NotebookScreen: View {
    let notebookId: String
    let database: AppDatabase
    let sync: SyncEngine
    let onClose: () -> Void
    @State private var summary: AppDatabase.NotebookSummary?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                Button(action: onClose) {
                    Label("Library", systemImage: "chevron.left")
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary?.notebook == nil ? "Waiting for this notebook to sync…" : summary!.title)
                        .font(.headline)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                SyncBadge(sync: sync)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(.bar)
            Divider()
            ScratchCanvas()
                .ignoresSafeArea(edges: .bottom)
        }
        .task {
            do {
                for try await next in database.observeNotebook(id: notebookId) { summary = next }
            } catch {}
        }
    }

    private var detail: String {
        guard let summary, summary.notebook != nil else { return "Native editor preview · ink here isn't saved yet" }
        let strokes = summary.strokeCounts.values.reduce(0, +)
        return "\(summary.sections.count) sections · \(strokes) strokes in the native store · ink here isn't saved yet"
    }
}

struct SyncBadge: View {
    let sync: SyncEngine

    var body: some View {
        Label(label, systemImage: icon)
            .font(.caption)
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(color.opacity(0.1), in: Capsule())
    }

    private var label: String {
        switch sync.status {
        case .idle: "Starting"
        case .syncing: "Syncing"
        case .synced: "Synced"
        case .offline: "Offline"
        case .localOnly: "Local only"
        case .needsLogin: "Signed out"
        case .error: "Sync error"
        }
    }

    private var icon: String {
        switch sync.status {
        case .synced: "checkmark.icloud"
        case .syncing, .idle: "arrow.triangle.2.circlepath.icloud"
        case .offline, .localOnly: "icloud.slash"
        case .needsLogin, .error: "exclamationmark.icloud"
        }
    }

    private var color: Color {
        switch sync.status {
        case .synced: .green
        case .needsLogin, .error: .red
        default: .secondary
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

import PencilKit
import SwiftUI

/// The native notebook editor: a bar with the title, undo/redo and sync state over the
/// section column. Waits for the notebook if it hasn't synced to this device yet.
struct NotebookScreen: View {
    let notebookId: String
    let database: AppDatabase
    let sync: SyncEngine
    let onClose: () -> Void
    @State private var summary: AppDatabase.NotebookSummary?
    @State private var editor: EditorBox?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                Button(action: onClose) {
                    Label("Library", systemImage: "chevron.left")
                }
                Text(summary?.notebook == nil ? "Waiting for this notebook to sync…" : summary!.title)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Button { editor?.controller.undoTap() } label: { Image(systemName: "arrow.uturn.backward") }
                    .accessibilityLabel("Undo")
                Button { editor?.controller.redoTap() } label: { Image(systemName: "arrow.uturn.forward") }
                    .accessibilityLabel("Redo")
                SyncBadge(sync: sync)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
            .background(.bar)
            Divider()
            if let editor {
                NotebookCanvas(controller: editor.controller)
                    .ignoresSafeArea(edges: .bottom)
            } else {
                Spacer()
            }
        }
        .task {
            do {
                for try await next in database.observeNotebook(id: notebookId) {
                    summary = next
                    if editor == nil, next.notebook != nil { editor = EditorBox(notebookId: notebookId, database: database, sync: sync) }
                }
            } catch {}
        }
        .onDisappear { editor?.controller.stop() }
    }
}

/// Holds the UIKit editor for the screen's lifetime.
@MainActor
final class EditorBox {
    let controller: NotebookViewController
    private let picker: PKToolPicker

    init(notebookId: String, database: AppDatabase, sync: SyncEngine) {
        // Pen, fountain pen (barrel roll shapes the nib), monoline, highlighter, whole-stroke eraser
        // (strokes sync whole, so no pixel eraser), lasso and ruler.
        picker = PKToolPicker(toolItems: [
            PKToolPickerInkingItem(type: .pen, color: UIColor(hex: "#111827")!, width: 2.2),
            PKToolPickerInkingItem(type: .fountainPen, color: UIColor(hex: "#1d4ed8")!),
            PKToolPickerInkingItem(type: .monoline, color: UIColor(hex: "#dc2626")!),
            PKToolPickerInkingItem(type: .marker, color: UIColor(hex: "#facc15")!),
            PKToolPickerEraserItem(type: .vector),
            PKToolPickerLassoItem(),
            PKToolPickerRulerItem(),
        ])
        controller = NotebookViewController(context: EditorContext(notebookId: notebookId, database: database, sync: sync, toolPicker: picker))
    }
}

struct NotebookCanvas: UIViewControllerRepresentable {
    let controller: NotebookViewController
    func makeUIViewController(context: Context) -> NotebookViewController { controller }
    func updateUIViewController(_ controller: NotebookViewController, context: Context) {}
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

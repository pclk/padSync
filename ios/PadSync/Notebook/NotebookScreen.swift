import PencilKit
import SwiftUI

/// The native notebook editor, full screen: the section column with the web's floating tool and
/// prompt circles over it (no bar; the tool circle's panel has the way back to the library).
/// Waits for the notebook if it hasn't synced to this device yet.
struct NotebookScreen: View {
    let notebookId: String
    let database: AppDatabase
    let sync: SyncEngine
    let onClose: () -> Void
    @State private var summary: AppDatabase.NotebookSummary?
    @State private var editor: EditorBox?

    var body: some View {
        ZStack {
            Color(red: 0xf1 / 255, green: 0xf5 / 255, blue: 0xf9 / 255).ignoresSafeArea()
            if let editor {
                NotebookCanvas(controller: editor.controller)
                    .ignoresSafeArea()
            } else {
                VStack(spacing: 16) {
                    ProgressView()
                    Text("Waiting for this notebook to sync…").foregroundStyle(.secondary)
                    Button("Back to the library", action: onClose)
                }
            }
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .task {
            do {
                for try await next in database.observeNotebook(id: notebookId) {
                    summary = next
                    if editor == nil, next.notebook != nil {
                        let box = EditorBox(notebookId: notebookId, database: database, sync: sync)
                        box.controller.onClose = onClose
                        editor = box
                    }
                    if let editor {
                        let title = next.title
                        editor.controller.notebookTitle = { title }
                    }
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

    init(notebookId: String, database: AppDatabase, sync: SyncEngine) {
        controller = NotebookViewController(context: EditorContext(notebookId: notebookId, database: database, sync: sync))
    }
}

struct NotebookCanvas: UIViewControllerRepresentable {
    let controller: NotebookViewController
    func makeUIViewController(context: Context) -> NotebookViewController { controller }
    func updateUIViewController(_ controller: NotebookViewController, context: Context) {}
}

/// Icon only when `compact`, else title and icon.
struct AdaptiveLabelStyle: LabelStyle {
    let compact: Bool
    func makeBody(configuration: Configuration) -> some View {
        if compact { Label(configuration).labelStyle(.iconOnly) } else { Label(configuration).labelStyle(.titleAndIcon) }
    }
}

extension LabelStyle where Self == AdaptiveLabelStyle {
    static func adaptive(compact: Bool) -> AdaptiveLabelStyle { AdaptiveLabelStyle(compact: compact) }
}

struct SyncBadge: View {
    let sync: SyncEngine
    var compact = false

    var body: some View {
        Label(label, systemImage: icon)
            .labelStyle(.adaptive(compact: compact))
            .accessibilityLabel(label)
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

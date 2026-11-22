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
    @State private var textMode = false
    @State private var position = (index: 0, count: 0)
    @State private var confirmDelete = false
    @State private var deletedSection: String?
    @State private var askMode = false
    @State private var asking: AskCapture?
    /// Compact in a narrow Split View or Stage Manager window: the bar drops its labels.
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: sizeClass == .compact ? 12 : 16) {
                Button(action: onClose) {
                    Label("Library", systemImage: "chevron.left")
                        .labelStyle(.adaptive(compact: sizeClass == .compact))
                }
                Text(summary?.notebook == nil ? "Waiting for this notebook to sync…" : summary!.title)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                sectionMenu
                Button { editor?.controller.setAskMode(!askMode) } label: {
                    Image(systemName: "sparkles")
                        .padding(6)
                        .background(askMode ? Color.accentColor.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 8))
                }
                .accessibilityLabel(askMode ? "Ask AI: draw around what to ask about" : "Ask AI")
                Button { editor?.controller.setTextMode(!textMode) } label: {
                    Image(systemName: "character.textbox")
                        .padding(6)
                        .background(textMode ? Color.accentColor.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 8))
                }
                .accessibilityLabel(textMode ? "Text tool on" : "Text tool")
                Button { editor?.controller.undoTap() } label: { Image(systemName: "arrow.uturn.backward") }
                    .accessibilityLabel("Undo")
                Button { editor?.controller.redoTap() } label: { Image(systemName: "arrow.uturn.forward") }
                    .accessibilityLabel("Redo")
                SyncBadge(sync: sync, compact: sizeClass == .compact)
            }
            .padding(.horizontal, sizeClass == .compact ? 12 : 20)
            .padding(.vertical, 10)
            .background(.bar)
            Divider()
            if let editor {
                NotebookCanvas(controller: editor.controller)
                    .ignoresSafeArea(edges: .bottom)
                    .overlay(alignment: .bottom) { undoBanner }
            } else {
                Spacer()
            }
        }
        .task {
            do {
                for try await next in database.observeNotebook(id: notebookId) {
                    summary = next
                    if editor == nil, next.notebook != nil {
                        let box = EditorBox(notebookId: notebookId, database: database, sync: sync)
                        box.controller.onTextModeChange = { textMode = $0 }
                        box.controller.onSectionPositionChange = { position = ($0, $1) }
                        box.controller.onAskModeChange = { askMode = $0 }
                        box.controller.onAsk = { asking = $0 }
                        editor = box
                    }
                }
            } catch {}
        }
        .onDisappear { editor?.controller.stop() }
        .sheet(item: $asking) { AskSheet(capture: $0, notebookTitle: summary?.title ?? "") }
        .confirmationDialog("Delete this page?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete page", role: .destructive) {
                withAnimation { deletedSection = editor?.controller.deleteCurrentSection() }
            }
        } message: {
            Text("Its ink is kept, and you can undo this.")
        }
    }

    /// Acts on the current section (the one 30% down the screen), like the web's side panel.
    private var sectionMenu: some View {
        Menu {
            Section(position.count > 0 ? "Page \(position.index + 1) of \(position.count)" : "Page") {
                Button { editor?.controller.addSectionAfterCurrent() } label: { Label("Blank page after", systemImage: "plus.rectangle.portrait") }
                Button { editor?.controller.moveCurrentSection(by: -1) } label: { Label("Move up", systemImage: "arrow.up") }
                    .disabled(position.index <= 0)
                Button { editor?.controller.moveCurrentSection(by: 1) } label: { Label("Move down", systemImage: "arrow.down") }
                    .disabled(position.index >= position.count - 1)
            }
            Button(role: .destructive) { confirmDelete = true } label: { Label("Delete page…", systemImage: "trash") }
                .disabled(!Sections.canDelete(count: position.count))
        } label: {
            Image(systemName: "rectangle.stack").padding(6)
        }
        .accessibilityLabel("Page menu")
    }

    @ViewBuilder private var undoBanner: some View {
        if let id = deletedSection {
            HStack(spacing: 16) {
                Text("Page deleted")
                Button("Undo") {
                    editor?.controller.restoreSection(id: id)
                    withAnimation { deletedSection = nil }
                }
                .bold()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(.regularMaterial, in: Capsule())
            .shadow(radius: 8, y: 2)
            .padding(.bottom, 40)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .task(id: id) {
                try? await Task.sleep(for: .seconds(6))
                if deletedSection == id { withAnimation { deletedSection = nil } }
            }
        }
    }
}

/// Holds the UIKit editor for the screen's lifetime.
@MainActor
final class EditorBox {
    let controller: NotebookViewController
    private let picker: PKToolPicker

    init(notebookId: String, database: AppDatabase, sync: SyncEngine) {
        picker = Tools.makePicker(state: Tools.load())
        controller = NotebookViewController(context: EditorContext(notebookId: notebookId, database: database, sync: sync, toolPicker: picker))
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

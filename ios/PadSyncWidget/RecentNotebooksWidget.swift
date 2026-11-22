import SwiftUI
import WidgetKit

/// The notebooks edited last, from the list the app keeps in the App Group (AppModel.publishRecent).
/// Tapping one opens it in the editor.
struct RecentEntry: TimelineEntry {
    let date: Date
    let notebooks: [RecentNotebook]
}

struct RecentProvider: TimelineProvider {
    func placeholder(in context: Context) -> RecentEntry {
        RecentEntry(date: .now, notebooks: [RecentNotebook(id: "", title: "Linear algebra", edited: .now)])
    }

    func getSnapshot(in context: Context, completion: @escaping (RecentEntry) -> Void) {
        completion(RecentEntry(date: .now, notebooks: RecentNotebook.load()))
    }

    /// The app reloads the widget whenever the list changes; the hourly refresh keeps "edited" fresh.
    func getTimeline(in context: Context, completion: @escaping (Timeline<RecentEntry>) -> Void) {
        let entry = RecentEntry(date: .now, notebooks: RecentNotebook.load())
        completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(3600))))
    }
}

struct RecentNotebooksView: View {
    @Environment(\.widgetFamily) private var family
    let entry: RecentEntry

    private var count: Int {
        switch family {
        case .systemSmall: 1
        case .systemMedium: 3
        default: 6
        }
    }

    var body: some View {
        let shown = Array(entry.notebooks.prefix(count))
        VStack(alignment: .leading, spacing: family == .systemSmall ? 6 : 10) {
            Label("padSync", systemImage: "pencil.and.scribble")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if shown.isEmpty {
                Text("Open padSync to see your notebooks here.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else if family == .systemSmall, let nb = shown.first {
                Spacer(minLength: 0)
                Text(nb.title).font(.headline).lineLimit(3)
                edited(nb)
            } else {
                ForEach(shown, id: \.id) { nb in
                    Link(destination: nb.url) {
                        HStack {
                            Image(systemName: "book.closed").foregroundStyle(.tint)
                            Text(nb.title).font(.subheadline.weight(.medium)).lineLimit(1)
                            Spacer(minLength: 8)
                            edited(nb)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(family == .systemSmall ? shown.first?.url : nil)
        .containerBackground(.fill.tertiary, for: .widget)
    }

    private func edited(_ nb: RecentNotebook) -> some View {
        Text(nb.edited, style: .relative)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }
}

@main
struct RecentNotebooksWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RecentNotebooks", provider: RecentProvider()) { entry in
            RecentNotebooksView(entry: entry)
        }
        .configurationDisplayName("Recent notebooks")
        .description("The notebooks you edited last, on any device.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

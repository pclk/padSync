import Foundation

/// The folder the app shares with its widget and Share extension (an App Group). The id is
/// `group.` + the app's bundle id, set in Config/Base.xcconfig and put in each Info.plist.
enum AppGroup {
    static var id: String? { Bundle.main.object(forInfoDictionaryKey: "PadSyncAppGroup") as? String }

    static var folder: URL? {
        id.flatMap { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) }
    }

    /// PDFs shared from other apps, waiting for the library to import them.
    static var inbox: URL? {
        guard let url = folder?.appendingPathComponent("Inbox", isDirectory: true) else { return nil }
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static var recentFile: URL? { folder?.appendingPathComponent("recent.json") }
}

/// A notebook as the widget shows it.
struct RecentNotebook: Codable, Hashable, Sendable {
    var id: String
    var title: String
    var edited: Date

    static func load() -> [RecentNotebook] {
        guard let url = AppGroup.recentFile, let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([RecentNotebook].self, from: data)) ?? []
    }

    static func save(_ list: [RecentNotebook]) {
        guard let url = AppGroup.recentFile, let data = try? JSONEncoder().encode(list) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// `padsync://notebook/<id>`, which the app opens in the editor.
    var url: URL { URL(string: "padsync://notebook/\(id)")! }

    static func id(from url: URL) -> String? {
        guard url.scheme == "padsync", url.host == "notebook" else { return nil }
        let id = url.lastPathComponent
        return id.isEmpty || id == "/" ? nil : id
    }
}

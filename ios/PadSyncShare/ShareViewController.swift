import UIKit
import UniformTypeIdentifiers

/// "padSync" in the Share sheet. Copies the shared PDFs into the App Group inbox; the next time
/// padSync opens, the library imports them as notebooks (AppModel.checkInbox, Library.tsx).
/// A Share extension can't open its app, so it says where they went and closes.
final class ShareViewController: UIViewController {
    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        label.font = .preferredFont(forTextStyle: .headline)
        label.textAlignment = .center
        label.numberOfLines = 0
        label.text = "Saving to padSync…"
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),
        ])
        Task { await save() }
    }

    private func save() async {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        var saved = 0
        if let inbox = AppGroup.inbox {
            for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
                if await copy(provider, into: inbox) { saved += 1 }
            }
        }
        label.text = saved == 0
            ? "Couldn't save that to padSync."
            : "Saved \(saved == 1 ? "the PDF" : "\(saved) PDFs"). Open padSync and it imports \(saved == 1 ? "it" : "them") as notebooks."
        try? await Task.sleep(for: .seconds(saved == 0 ? 2.5 : 1.8))
        extensionContext?.completeRequest(returningItems: nil)
    }

    /// Copies the file under its own name, with a prefix so two shares of "notes.pdf" don't collide.
    private func copy(_ provider: NSItemProvider, into inbox: URL) async -> Bool {
        await withCheckedContinuation { done in
            _ = provider.loadFileRepresentation(for: .pdf, openInPlace: false) { url, _, _ in
                guard let url else { return done.resume(returning: false) }
                let name = provider.suggestedName.map { $0.hasSuffix(".pdf") ? $0 : $0 + ".pdf" } ?? url.lastPathComponent
                let target = inbox.appendingPathComponent("\(Int(Date.now.timeIntervalSince1970 * 1000))-\(name)")
                done.resume(returning: (try? FileManager.default.copyItem(at: url, to: target)) != nil)
            }
        }
    }
}

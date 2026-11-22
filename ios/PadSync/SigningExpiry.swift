import Foundation
import UserNotifications

/// A free Apple ID signs the app for 7 days; after that it won't open until it's reinstalled from
/// the Mac. The date is in the provisioning profile Xcode embeds in the app, so the app reminds
/// you the day before and again two hours before.
enum SigningExpiry {
    /// When the embedded profile expires; nil in the simulator or an App Store build (no profile).
    static func date(bundle: Bundle = .main) -> Date? {
        guard let url = bundle.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url) else { return nil }
        return date(profile: data)
    }

    /// The profile is a signed (CMS) envelope around an XML plist; the plist sits in it as is.
    static func date(profile data: Data) -> Date? {
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
              let plist = try? PropertyListSerialization.propertyList(from: data[start.lowerBound..<end.upperBound], format: nil),
              let dict = plist as? [String: Any] else { return nil }
        return dict["ExpirationDate"] as? Date
    }

    /// The reminders still ahead of `now`: (id, when, message).
    static func reminders(expiry: Date, now: Date = .now) -> [(id: String, at: Date, body: String)] {
        let time = expiry.formatted(date: .omitted, time: .shortened)
        return [
            ("padsync.expiry.day", expiry.addingTimeInterval(-24 * 3600), "padSync stops opening tomorrow at \(time). Plug the iPad into the Mac and reinstall it."),
            ("padsync.expiry.hours", expiry.addingTimeInterval(-2 * 3600), "padSync stops opening at \(time). Plug the iPad into the Mac and reinstall it."),
        ].filter { $0.1 > now }
    }

    /// Replaces any earlier reminders with ones for this install's profile.
    static func schedule() async {
        guard let expiry = date() else { return }
        let center = UNUserNotificationCenter.current()
        guard (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return }
        center.removePendingNotificationRequests(withIdentifiers: ["padsync.expiry.day", "padsync.expiry.hours"])
        for r in reminders(expiry: expiry) {
            let content = UNMutableNotificationContent()
            content.title = "Reinstall padSync"
            content.body = r.body
            content.sound = .default
            let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: r.at)
            let trigger = UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)
            try? await center.add(UNNotificationRequest(identifier: r.id, content: content, trigger: trigger))
        }
    }
}

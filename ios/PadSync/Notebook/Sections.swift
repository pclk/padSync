import Foundation

/// Section writes, the same as the web's store.ts. Deleting only flags the section, so its ink,
/// text boxes and history stay and undo brings it all back.
enum Sections {
    /// `SCREEN_HEIGHT` in types.ts: the default section height.
    static let screenHeight = 1032

    static func order(_ section: Entity) -> Double { section.data["order"]?.double ?? 0 }

    /// `insertSectionAfter`: a blank dotted page halfway between `after` and the next section, or
    /// after the last one when `after` is nil. `sorted` is the live sections in order.
    static func newSection(notebookId: String, after: Entity?, sorted: [Entity], now: Date = .now) -> Entity {
        let idx = after.flatMap { a in sorted.firstIndex { $0.id == a.id } } ?? sorted.count - 1
        let prev = sorted.indices.contains(idx) ? order(sorted[idx]) : 0
        let next = sorted.indices.contains(idx + 1) ? order(sorted[idx + 1]) : prev + 2
        let data: JSONValue = .object([
            "blocks": .array([]), "template": .string("dots"), "minHeight": .int(Int64(screenHeight)),
            "order": .double((prev + next) / 2), "createdAt": .int(Int64(now.timeIntervalSince1970 * 1000)),
        ])
        return Entity(id: newId(), kind: .section, notebookId: notebookId, parentId: "", data: data,
                      hlc: "", deleted: false, dirty: true)
    }

    /// `swapSectionOrder`: the two sections with their orders exchanged.
    static func swapped(_ a: Entity, _ b: Entity) -> [Entity] {
        var x = a, y = b
        x.data["order"] = b.data["order"] ?? .double(order(b))
        y.data["order"] = a.data["order"] ?? .double(order(a))
        return [x, y]
    }

    /// The web won't delete a notebook's last section.
    static func canDelete(count: Int) -> Bool { count > 1 }

    static func setDeleted(_ section: Entity, _ deleted: Bool) -> Entity {
        var s = section
        s.deleted = deleted
        return s
    }
}

import Foundation
import Synchronization

/// Hybrid logical clock, the same encoding as src/lib/hlc.ts:
/// `<13-digit wall ms>-<4-digit counter>-<device id>`. Comparing strings compares clocks.
final class HLC: Sendable {
    let device: String
    private let state = Mutex<(wall: Int64, counter: Int)>((0, 0))
    private let clock: @Sendable () -> Int64

    private static let maxCounter = 9999 // four digits; a fifth would break string order

    init(device: String, clock: @escaping @Sendable () -> Int64 = { Int64(Date.now.timeIntervalSince1970 * 1000) }) {
        self.device = device
        self.clock = clock
    }

    func now() -> String {
        let now = clock()
        let (wall, counter) = state.withLock { s in
            if now > s.wall {
                s = (now, 0)
            } else if s.counter < Self.maxCounter {
                s.counter += 1
            } else {
                // Over 10k stamps in one millisecond (a bulk write): borrow the next millisecond.
                s = (s.wall + 1, 0)
            }
            return s
        }
        return Self.encode(wall: wall, counter: counter, device: device)
    }

    /// Advances the clock past a remote stamp so the next local write sorts after it.
    func observe(_ remote: String) {
        guard let (wall, counter) = Self.decode(remote) else { return }
        state.withLock { s in
            if wall > s.wall || (wall == s.wall && counter > s.counter) { s = (wall, counter) }
        }
    }

    static func encode(wall: Int64, counter: Int, device: String) -> String {
        let w = String(wall), c = String(counter)
        return String(repeating: "0", count: max(0, 13 - w.count)) + w + "-" + String(repeating: "0", count: max(0, 4 - c.count)) + c + "-" + device
    }

    static func decode(_ hlc: String) -> (wall: Int64, counter: Int)? {
        let parts = hlc.split(separator: "-", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 13, parts[1].count == 4, !parts[2].isEmpty,
              parts[0].allSatisfy(\.isASCIIDigit), parts[1].allSatisfy(\.isASCIIDigit),
              let wall = Int64(parts[0]), let counter = Int(parts[1]) else { return nil }
        return (wall, counter)
    }

    /// Wall-clock ms of a stamp, or nil for a malformed one.
    static func wall(_ hlc: String) -> Int64? { decode(hlc)?.wall }

    /// The device that wrote a stamp.
    static func device(_ hlc: String) -> String {
        hlc.split(separator: "-", maxSplits: 2).dropFirst(2).first.map(String.init) ?? ""
    }

    /// Byte order, like the server's `collate "C"` (and JS string comparison for these ASCII stamps).
    static func isNewer(_ a: String, than b: String) -> Bool {
        b.utf8.lexicographicallyPrecedes(a.utf8)
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}

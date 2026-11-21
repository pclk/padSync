import Foundation

/// An entity's `data`, kept as JSON so fields the native app doesn't know about survive a
/// native edit (section data has many). Parsed with JSONSerialization, which is much faster
/// than Codable on stroke point arrays.
enum JSONValue: Sendable, Hashable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    static func parse(_ data: Data) throws -> JSONValue {
        JSONValue(any: try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
    }

    init(any: Any) {
        switch any {
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) }
            else if CFNumberIsFloatType(n) { self = .double(n.doubleValue) }
            else { self = .int(n.int64Value) }
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map(JSONValue.init(any:)))
        case let o as [String: Any]: self = .object(o.mapValues(JSONValue.init(any:)))
        default: self = .null
        }
    }

    var any: Any {
        switch self {
        case .null: NSNull()
        case .bool(let b): b
        case .int(let i): i
        case .double(let d): d
        case .string(let s): s
        case .array(let a): a.map(\.any)
        case .object(let o): o.mapValues(\.any)
        }
    }

    func serialized() -> Data {
        // Every case maps to a valid JSON value, so this can't throw.
        (try? JSONSerialization.data(withJSONObject: any, options: [.fragmentsAllowed])) ?? Data("null".utf8)
    }

    /// Decodes into a typed struct (see Models.swift).
    func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: serialized())
    }

    init<T: Encodable>(encoding value: T) throws {
        self = try .parse(JSONEncoder().encode(value))
    }

    subscript(key: String) -> JSONValue? {
        get { if case .object(let o) = self { o[key] } else { nil } }
        set {
            guard case .object(var o) = self else { return }
            o[key] = newValue
            self = .object(o)
        }
    }

    var string: String? { if case .string(let s) = self { s } else { nil } }
    var double: Double? {
        switch self {
        case .double(let d): d
        case .int(let i): Double(i)
        default: nil
        }
    }
    var int: Int64? {
        switch self {
        case .int(let i): i
        case .double(let d) where d.rounded() == d: Int64(d)
        default: nil
        }
    }
    var bool: Bool? { if case .bool(let b) = self { b } else { nil } }
    var array: [JSONValue]? { if case .array(let a) = self { a } else { nil } }
}

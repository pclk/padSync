import Foundation

// The iPad's own settings, the same ones the web keeps in localStorage and backs up to the server
// per kind of device (src/lib/device-settings.ts): the toolbar circles (padsync.rail), chat
// prompts, finger gestures and their tuning, the lasso, and the current tool. The app reads the
// server's "device.ipad" copy, so the circles, prompts and gestures are the ones set up in the
// iPad web app, and writes back what it changes (a moved circle, the tool).

enum ToolKind: String, Codable, CaseIterable, Sendable {
    case pen, highlighter, eraser, lasso, text

    var label: String {
        switch self {
        case .pen: "Pen"
        case .highlighter: "Highlighter"
        case .eraser: "Eraser"
        case .lasso: "Lasso"
        case .text: "Text"
        }
    }

    /// The web's icons for each tool (RAIL_ITEM_INFO) as SF Symbols.
    var symbol: String {
        switch self {
        case .pen: "pencil"
        case .highlighter: "highlighter"
        case .eraser: "eraser"
        case .lasso: "lasso"
        case .text: "textformat"
        }
    }
}

/// The current tool and each tool's colour and size (`ToolState` in src/ink/controller.ts).
struct ToolState: Equatable, Sendable {
    var kind: ToolKind = .pen
    var penColor = "#111827"
    var penSize = 3.4
    var hlColor = "#facc15"
    var hlSize = 22.0
    var eraserSize = 24.0
    /// Fields this app doesn't use (the pen feel), kept so writing back doesn't drop them.
    var extra: [String: JSONValue] = [:]

    /// Toolbar.tsx's palettes.
    static let penColors = ["#111827", "#1d4ed8", "#dc2626", "#047857", "#7c3aed"]
    static let penColorNames = ["#111827": "Black", "#1d4ed8": "Blue", "#dc2626": "Red", "#047857": "Green", "#7c3aed": "Purple"]
    static let hlColors = ["#facc15", "#4ade80", "#f472b6", "#60a5fa"]
    static let penSizes = [2.2, 3.4, 5.5]
    static let hlSizes = [14.0, 22, 32]
    static let eraserSizes = [12.0, 24, 48]

    var colors: [String] { kind == .highlighter ? Self.hlColors : kind == .pen ? Self.penColors : [] }
    var sizes: [Double] {
        switch kind {
        case .pen: Self.penSizes
        case .highlighter: Self.hlSizes
        case .eraser: Self.eraserSizes
        default: []
        }
    }
    var color: String { kind == .highlighter ? hlColor : penColor }
    var size: Double {
        switch kind {
        case .highlighter: hlSize
        case .eraser: eraserSize
        default: penSize
        }
    }

    mutating func setColor(_ c: String) {
        if kind == .highlighter { hlColor = c } else { penColor = c }
    }

    mutating func setSize(_ s: Double) {
        switch kind {
        case .highlighter: hlSize = s
        case .eraser: eraserSize = s
        default: penSize = s
        }
    }

    init() {}

    init(json: JSONValue?) {
        guard case .object(let o)? = json else { return }
        extra = o.filter { !["kind", "penColor", "penSize", "hlColor", "hlSize", "eraserSize"].contains($0.key) }
        if let k = o["kind"]?.string.flatMap(ToolKind.init(rawValue:)) { kind = k }
        if let c = o["penColor"]?.string, c.hasPrefix("#") { penColor = c }
        if let c = o["hlColor"]?.string, c.hasPrefix("#") { hlColor = c }
        if let v = o["penSize"]?.double, v.isFinite, v > 0 { penSize = v }
        if let v = o["hlSize"]?.double, v.isFinite, v > 0 { hlSize = v }
        if let v = o["eraserSize"]?.double, v.isFinite, v > 0 { eraserSize = v }
    }

    var json: JSONValue {
        var o = extra
        o["kind"] = .string(kind.rawValue)
        o["penColor"] = .string(penColor)
        o["penSize"] = .double(penSize)
        o["hlColor"] = .string(hlColor)
        o["hlSize"] = .double(hlSize)
        o["eraserSize"] = .double(eraserSize)
        return .object(o)
    }
}

// MARK: Toolbar circles (src/lib/rail-layout.ts)

enum CircleKey: String, CaseIterable, Sendable { case tools, prompts }

struct RailLayout: Equatable, Sendable {
    enum Dock: String, Sendable { case left, right, bottom }
    enum Align: String, Sendable { case start, center, end }

    static let items = ["pen", "highlighter", "eraser", "lasso", "text", "colors", "sizes", "history", "prompts"]
    static let sizeRange: [CircleKey: ClosedRange<Double>] = [.tools: 44...112, .prompts: 36...96]

    var order = RailLayout.items
    var hidden: [String] = []
    var dock = Dock.left
    var align = Align.center
    /// Circle centres placed by hand, as fractions of the window's width and height.
    var free: [CircleKey: CGPoint] = [:]
    var size: [CircleKey: Double] = [.tools: 60, .prompts: 48]
    /// The rest of the stored layout (its style), kept when writing back.
    var extra: [String: JSONValue] = [:]

    var visible: [String] { order.filter { !hidden.contains($0) } }

    /// The tools in the wheel's order, shown or not (the panel's Edit tools list).
    var toolOrder: [ToolKind] { order.compactMap(ToolKind.init(rawValue:)) }

    /// `item` swapped with the tool before (-1) or after (1) it, as the web's toolbar settings do.
    func movingTool(_ item: ToolKind, by step: Int) -> RailLayout {
        let tools = toolOrder
        guard let i = tools.firstIndex(of: item), tools.indices.contains(i + step),
              let a = order.firstIndex(of: item.rawValue), let b = order.firstIndex(of: tools[i + step].rawValue) else { return self }
        var next = self
        next.order.swapAt(a, b)
        return next
    }

    /// `item` shown or hidden in the wheel; the pen always shows.
    func showingTool(_ item: ToolKind, _ shown: Bool) -> RailLayout {
        guard item != .pen else { return self }
        var next = self
        next.hidden.removeAll { $0 == item.rawValue }
        if !shown { next.hidden.append(item.rawValue) }
        return next
    }
    /// The circle's fan: the tools it shows, in its order.
    var tools: [ToolKind] { visible.compactMap(ToolKind.init(rawValue:)) }
    var showsPrompts: Bool { visible.contains("prompts") }
    var showsColors: Bool { visible.contains("colors") }
    var showsSizes: Bool { visible.contains("sizes") }
    /// The prompt circle goes before the tool circle when it comes before the tools in the order.
    var promptsFirst: Bool {
        guard let p = visible.firstIndex(of: "prompts"), let t = visible.firstIndex(where: { ToolKind(rawValue: $0) != nil }) else { return false }
        return p < t
    }

    static let placeMargin = 0.03
    static func clampPlace(_ p: CGPoint) -> CGPoint {
        CGPoint(x: min(1 - placeMargin, max(placeMargin, p.x)), y: min(1 - placeMargin, max(placeMargin, p.y)))
    }

    init() {}

    init(json: JSONValue?) {
        guard case .object(let o)? = json else { return }
        extra = o.filter { !["order", "hidden", "dock", "align", "free", "size"].contains($0.key) }
        var order: [String] = []
        for v in o["order"]?.array ?? [] { if let s = v.string, Self.items.contains(s), !order.contains(s) { order.append(s) } }
        for item in Self.items where !order.contains(item) { order.append(item) }
        self.order = order
        var hidden: [String] = []
        for v in o["hidden"]?.array ?? [] { if let s = v.string, Self.items.contains(s), s != "pen", !hidden.contains(s) { hidden.append(s) } }
        self.hidden = hidden
        if let d = o["dock"]?.string.flatMap(Dock.init(rawValue:)) { dock = d }
        if let a = o["align"]?.string.flatMap(Align.init(rawValue:)) { align = a }
        for key in CircleKey.allCases {
            if let p = o["free"]?[key.rawValue]?.array, p.count == 2, let x = p[0].double, let y = p[1].double, x.isFinite, y.isFinite {
                free[key] = Self.clampPlace(CGPoint(x: x, y: y))
            }
            if let s = o["size"]?[key.rawValue]?.double, s.isFinite, let r = Self.sizeRange[key] {
                size[key] = min(r.upperBound, max(r.lowerBound, s.rounded()))
            }
        }
    }

    var json: JSONValue {
        var o = extra
        o["order"] = .array(order.map(JSONValue.string))
        o["hidden"] = .array(hidden.map(JSONValue.string))
        o["dock"] = .string(dock.rawValue)
        o["align"] = .string(align.rawValue)
        var f: [String: JSONValue] = [:]
        for (k, p) in free { f[k.rawValue] = .array([.double(Double(p.x)), .double(Double(p.y))]) }
        o["free"] = .object(f)
        var s: [String: JSONValue] = [:]
        for (k, v) in size { s[k.rawValue] = .double(v) }
        o["size"] = .object(s)
        if o["style"] == nil { o["style"] = .string("circle") }
        return .object(o)
    }

    func diameter(_ key: CircleKey) -> CGFloat { CGFloat(size[key] ?? (key == .tools ? 60 : 48)) }
}

// MARK: Chat prompts (src/lib/prompts.ts)

struct ChatPrompt: Equatable, Sendable, Identifiable {
    /// What a prompt sends from the notebook: the chat's own choice, or one of its scopes.
    enum Context: String, Sendable { case chat, section, selection, notebook, none }

    var id: String
    var label: String
    var text: String
    /// Send at once; otherwise it opens to be finished first.
    var send: Bool
    /// Record a voice message first, sent with the text.
    var voice: Bool
    var context: Context
    var icon: String

    static let maxPrompts = 8

    static let defaults: [ChatPrompt] = [
        ChatPrompt(id: "check", label: "Check my work", text: "Check my working on this page. Point out each mistake and where it is, but don't give me the full answer.", send: true, voice: false, context: .chat, icon: "check"),
        ChatPrompt(id: "hint", label: "Hint", text: "Give me a hint for the next step on this page, without solving it.", send: true, voice: false, context: .chat, icon: "bulb"),
        ChatPrompt(id: "explain", label: "Explain", text: "Explain the idea behind this question step by step, as if I'm seeing it for the first time.", send: true, voice: false, context: .chat, icon: "help"),
        ChatPrompt(id: "solve", label: "Solve", text: "Solve this question fully, showing every step and why it follows.", send: true, voice: false, context: .chat, icon: "sparkles"),
        ChatPrompt(id: "summary", label: "Summarise", text: "Summarise my notes on this page into the key points.", send: true, voice: false, context: .chat, icon: "list"),
        ChatPrompt(id: "voice", label: "Voice message", text: "", send: true, voice: true, context: .chat, icon: "mic"),
        ChatPrompt(id: "ask", label: "Ask…", text: "About this page: ", send: false, voice: false, context: .chat, icon: "message"),
    ]

    /// Stored prompts made whole, as `normalizePrompts`: bad entries dropped, missing fields filled.
    static func normalize(_ json: JSONValue?) -> [ChatPrompt] {
        guard let list = json?.array else { return defaults }
        var seen = Set<String>()
        var out: [ChatPrompt] = []
        for r in list {
            guard let id = r["id"]?.string, !seen.contains(id), let text = r["text"]?.string else { continue }
            seen.insert(id)
            let voice = r["voice"]?.bool == true
            let label = r["label"]?.string.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? "Prompt"
            out.append(ChatPrompt(id: id, label: label, text: text, send: voice || r["send"]?.bool != false, voice: voice,
                                  context: r["context"]?.string.flatMap(Context.init(rawValue:)) ?? .chat,
                                  icon: r["icon"]?.string ?? "message"))
        }
        return Array(out.prefix(maxPrompts))
    }

    /// The web's prompt icons (PROMPT_ICONS) as SF Symbols.
    var symbol: String {
        switch icon {
        case "check": "checkmark.circle"
        case "bulb": "lightbulb"
        case "help": "questionmark.circle"
        case "sparkles": "sparkles"
        case "list": "list.bullet"
        case "search": "magnifyingglass"
        case "edit": "pencil"
        case "layers": "square.3.layers.3d"
        case "code": "chevron.left.forwardslash.chevron.right"
        case "mic": "mic"
        default: "bubble.left"
        }
    }
}

// MARK: Finger gestures (src/lib/touch-gestures.ts)

enum GestureKind: String, CaseIterable, Sendable {
    case twoTap, threeTap, fourTap, twoDoubleTap, fingerDoubleTap, fingerHold
}

enum GestureAction: Equatable, Sendable {
    case none, undo, redo, previousTool, togglePanel, resetZoom, promptMenu, lassoHold
    case tool(ToolKind)

    init?(_ raw: String) {
        switch raw {
        case "none": self = .none
        case "undo": self = .undo
        case "redo": self = .redo
        case "previousTool": self = .previousTool
        case "togglePanel": self = .togglePanel
        case "resetZoom": self = .resetZoom
        case "promptMenu": self = .promptMenu
        case "lassoHold": self = .lassoHold
        default:
            guard raw.hasPrefix("tool:"), let k = ToolKind(rawValue: String(raw.dropFirst(5))) else { return nil }
            self = .tool(k)
        }
    }

    var label: String {
        switch self {
        case .none: "Nothing"
        case .lassoHold: "Lasso"
        case .undo: "Undo"
        case .redo: "Redo"
        case .previousTool: "Previous tool"
        case .togglePanel: "Side panel"
        case .resetZoom: "Reset zoom"
        case .promptMenu: "Prompt menu"
        case .tool(let k): k.label
        }
    }
}

struct GestureBindings: Equatable, Sendable {
    var actions: [GestureKind: GestureAction] = GestureBindings.defaults

    static let defaults: [GestureKind: GestureAction] = [
        .twoTap: .undo, .threeTap: .redo, .fourTap: .none, .twoDoubleTap: .none, .fingerDoubleTap: .none, .fingerHold: .lassoHold,
    ]

    subscript(g: GestureKind) -> GestureAction { actions[g] ?? .none }

    init() {}

    init(json: JSONValue?) {
        for g in GestureKind.allCases {
            guard let raw = json?[g.rawValue]?.string, let a = GestureAction(raw) else { continue }
            // Lasso while held only makes sense for press and hold.
            if a == .lassoHold && g != .fingerHold { continue }
            actions[g] = a
        }
    }
}

/// How gestures are told apart (`GestureTuning`).
struct GestureTuning: Equatable, Sendable {
    var tapMs = 280.0
    var doubleMs = 300.0
    var holdMs = 250.0
    var slop = 10.0
    var pencilQuietMs = 800.0
    var showNote = true

    init() {}

    init(json: JSONValue?) {
        func num(_ key: String, _ range: ClosedRange<Double>, _ fallback: Double) -> Double {
            guard let v = json?[key]?.double, v.isFinite else { return fallback }
            return min(range.upperBound, max(range.lowerBound, v))
        }
        holdMs = num("holdMs", 200...1500, holdMs)
        slop = num("slop", 4...30, slop)
        tapMs = num("tapMs", 120...500, tapMs)
        doubleMs = num("doubleMs", 150...600, doubleMs)
        pencilQuietMs = num("pencilQuietMs", 0...2000, pencilQuietMs)
        if let b = json?["showNote"]?.bool { showNote = b }
    }
}

// MARK: Lasso (src/lib/lasso-settings.ts)

enum LassoAction: String, CaseIterable, Sendable {
    case delete, duplicate, copy, copyImage, crop, recolor, bigger, smaller, ask

    var label: String {
        switch self {
        case .delete: "Delete"
        case .duplicate: "Duplicate"
        case .copy: "Copy"
        case .copyImage: "Copy image"
        case .crop: "Crop"
        case .recolor: "Colour"
        case .bigger: "Bigger"
        case .smaller: "Smaller"
        case .ask: "Ask AI"
        }
    }

    var symbol: String {
        switch self {
        case .delete: "trash"
        case .duplicate: "plus.square.on.square"
        case .copy: "doc.on.doc"
        case .copyImage: "photo.on.rectangle"
        case .crop: "crop"
        case .recolor: "paintpalette"
        case .bigger: "plus"
        case .smaller: "minus"
        case .ask: "bubble.left"
        }
    }
}

struct LassoSettings: Equatable, Sendable {
    enum Mode: String, Sendable { case touch, enclose }

    var lens = true
    var lensSize = 104.0
    var lensZoom = 2.0
    var mode = Mode.touch
    var order = LassoAction.allCases
    var hidden: [LassoAction] = []
    /// The lasso circle's diameter.
    var size = 52.0
    /// Bigger and Smaller scale by this percentage.
    var step = 25.0

    var visible: [LassoAction] { order.filter { !hidden.contains($0) } }

    init() {}

    init(json: JSONValue?) {
        guard let o = json else { return }
        func num(_ key: String, _ range: ClosedRange<Double>, _ fallback: Double) -> Double {
            guard let v = o[key]?.double, v.isFinite else { return fallback }
            return min(range.upperBound, max(range.lowerBound, v.rounded()))
        }
        if let b = o["lens"]?.bool { lens = b }
        lensSize = num("lensSize", 72...160, lensSize)
        lensZoom = num("lensZoom", 2...4, lensZoom)
        if let m = o["mode"]?.string.flatMap(Mode.init(rawValue:)) { mode = m }
        var order: [LassoAction] = []
        for v in o["order"]?.array ?? [] { if let a = v.string.flatMap(LassoAction.init(rawValue:)), !order.contains(a) { order.append(a) } }
        for a in LassoAction.allCases where !order.contains(a) { order.append(a) }
        self.order = order
        var hidden: [LassoAction] = []
        for v in o["hidden"]?.array ?? [] { if let a = v.string.flatMap(LassoAction.init(rawValue:)), !hidden.contains(a) { hidden.append(a) } }
        self.hidden = hidden
        size = num("size", 36...96, size)
        step = num("step", 5...100, step)
    }
}

// MARK: The whole set

struct DeviceSettings: Equatable, Sendable {
    var rail = RailLayout()
    var prompts = ChatPrompt.defaults
    var gestures = GestureBindings()
    var tuning = GestureTuning()
    var lasso = LassoSettings()
    var tool = ToolState()
    var sectionSpan = SectionSpan.section

    static let railKey = "padsync.rail"
    static let promptsKey = "padsync.prompts"
    static let gesturesKey = "padsync.gestures"
    static let tuningKey = "padsync.gestureTuning"
    static let lassoKey = "padsync.lasso"
    static let toolKey = "padsync.tool"
    static let sectionSpanKey = "padsync.sectionSpan"

    init() {}

    /// From the server's backup: each key's localStorage JSON string under `v`, with `at`.
    init(backup: JSONValue?) {
        func value(_ key: String) -> JSONValue? {
            guard let v = backup?[key]?["v"]?.string else { return nil }
            return try? JSONValue.parse(Data(v.utf8))
        }
        rail = RailLayout(json: value(Self.railKey))
        prompts = ChatPrompt.normalize(value(Self.promptsKey))
        gestures = GestureBindings(json: value(Self.gesturesKey))
        tuning = GestureTuning(json: value(Self.tuningKey))
        lasso = LassoSettings(json: value(Self.lassoKey))
        tool = ToolState(json: value(Self.toolKey))
        sectionSpan = value(Self.sectionSpanKey)?.string.flatMap(SectionSpan.init(rawValue:)) ?? .section
    }
}

/// Loads the settings (the server copy, else the last one seen, else the web's defaults) and
/// writes back the keys the app changes, stamped so the web app takes them as newer.
@MainActor
final class DeviceSettingsStore {
    static let shared = DeviceSettingsStore()
    static let prefKey = "device.ipad"
    private static let cacheKey = "padsync.native.deviceSettings"

    private(set) var settings: DeviceSettings
    private var backup: JSONValue?
    private var pending: [String: JSONValue] = [:]
    private var writeTask: Task<Void, Never>?
    var onChange: (DeviceSettings) -> Void = { _ in }

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.cacheKey), let json = try? JSONValue.parse(data) {
            backup = json
            settings = DeviceSettings(backup: json)
        } else {
            settings = DeviceSettings()
        }
    }

    /// Fetches the server copy; keeps the cached one when offline or signed out.
    func refresh() async {
        guard let json = try? await fetch() else { return }
        backup = json
        UserDefaults.standard.set(json.serialized(), forKey: Self.cacheKey)
        // Changes made here that haven't reached the server yet stay.
        var next = DeviceSettings(backup: json)
        if let v = pending[DeviceSettings.toolKey] { next.tool = ToolState(json: v) }
        if let v = pending[DeviceSettings.railKey] { next.rail = RailLayout(json: v) }
        if let v = pending[DeviceSettings.sectionSpanKey]?.string.flatMap(SectionSpan.init(rawValue:)) { next.sectionSpan = v }
        guard next != settings else { return }
        settings = next
        onChange(next)
    }

    func setTool(_ tool: ToolState) {
        guard tool != settings.tool else { return }
        settings.tool = tool
        write(DeviceSettings.toolKey, tool.json)
    }

    func setSectionSpan(_ span: SectionSpan) {
        guard span != settings.sectionSpan else { return }
        settings.sectionSpan = span
        write(DeviceSettings.sectionSpanKey, .string(span.rawValue))
    }

    func setRail(_ rail: RailLayout) {
        guard rail != settings.rail else { return }
        settings.rail = rail
        write(DeviceSettings.railKey, rail.json)
        onChange(settings)
    }

    /// Batches writes for a couple of seconds (a tool change often comes with a colour change).
    private func write(_ key: String, _ value: JSONValue) {
        pending[key] = value
        writeTask?.cancel()
        writeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            await self?.flush()
        }
    }

    private func flush() async {
        let changes = pending
        guard !changes.isEmpty else { return }
        // Read, merge, write: the web may have changed other keys since.
        guard let current = try? await fetch() else { return }
        var record: [String: JSONValue] = if case .object(let o) = current { o } else { [:] }
        let at = JSONValue.int(Int64(Date.now.timeIntervalSince1970 * 1000))
        for (key, value) in changes {
            record[key] = .object(["v": .string(String(decoding: value.serialized(), as: UTF8.self)), "at": at])
        }
        var req = await Server.request("/api/prefs")
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = JSONValue.object(["key": .string(Self.prefKey), "value": .object(record)]).serialized()
        guard let (_, res) = try? await URLSession.shared.data(for: req), (res as? HTTPURLResponse)?.statusCode == 200 else { return }
        for (key, value) in changes where pending[key] == value { pending[key] = nil }
        backup = .object(record)
        UserDefaults.standard.set(JSONValue.object(record).serialized(), forKey: Self.cacheKey)
    }

    private func fetch() async throws -> JSONValue? {
        var req = await Server.request("/api/prefs")
        req.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let (data, res) = try await URLSession.shared.data(for: req)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.userAuthenticationRequired) }
        let json = try JSONValue.parse(data)
        return json["prefs"]?[Self.prefKey] ?? .object([:])
    }
}

import UIKit

/// Text box data, the same shape as the web's `TextBoxData` (types.ts): x, y, w, text, fontSize,
/// color. Edits keep any other fields.
enum TextBoxes {
    /// `addTextBox` in store.ts.
    static func newData(x: CGFloat, y: CGFloat) -> JSONValue {
        .object(["x": .double(Double(x)), "y": .double(Double(y)), "w": .int(420), "text": .string(""),
                 "fontSize": .int(20), "color": .string("#1f2937")])
    }

    static func moved(_ data: JSONValue, dx: CGFloat, dy: CGFloat) -> JSONValue {
        var d = data
        d["x"] = .double((data["x"]?.double ?? 0) + Double(dx))
        d["y"] = .double((data["y"]?.double ?? 0) + Double(dy))
        return d
    }

    static let minWidth: CGFloat = 80

    /// A new width, at least `minWidth` and not past the page's right edge.
    static func resized(_ data: JSONValue, width: CGFloat) -> JSONValue {
        var d = data
        let x = CGFloat(data["x"]?.double ?? 0)
        let maxWidth = max(minWidth, SectionView.pageWidth - x)
        d["w"] = .double(Double(min(maxWidth, max(minWidth, width)).rounded()))
        return d
    }

    /// The box after an edit: blank text deletes it, like the web's TextEditor.
    static func edited(_ box: Entity, text: String) -> Entity {
        var e = box
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            e.deleted = true
        } else {
            e.data["text"] = .string(text)
        }
        return e
    }

    /// The web's `.textbox` style: `p-1 leading-snug` in the system font.
    static let padding: CGFloat = 4

    static func attributes(_ data: JSONValue) -> [NSAttributedString.Key: Any] {
        let size = CGFloat(data["fontSize"]?.double ?? 20)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = size * 1.375
        paragraph.maximumLineHeight = size * 1.375
        return [.font: UIFont.systemFont(ofSize: size), .foregroundColor: UIColor(hex: data["color"]?.string) ?? .black,
                .paragraphStyle: paragraph]
    }
}

/// One text box on a section. Outside the text tool it's only drawn; with the text tool, tap to
/// edit, drag to move, drag the right edge to resize, and long-press for Edit and Delete.
@MainActor
final class TextBoxView: UIView, UIGestureRecognizerDelegate, UIContextMenuInteractionDelegate {
    private(set) var box: Entity
    private let label = UILabel()
    private let handle = UIView()
    var onMove: (CGFloat, CGFloat) -> Void = { _, _ in }
    var onResize: (CGFloat) -> Void = { _ in }
    var onEdit: () -> Void = {}
    var onDelete: () -> Void = {}

    var interactive = false {
        didSet {
            isUserInteractionEnabled = interactive
            layer.borderWidth = interactive ? 1 : 0
            handle.isHidden = !interactive
        }
    }

    init(box: Entity) {
        self.box = box
        super.init(frame: .zero)
        layer.cornerRadius = 4
        layer.borderColor = UIColor(hex: "#cbd5e1")!.cgColor
        label.numberOfLines = 0
        addSubview(label)
        handle.backgroundColor = UIColor(hex: "#60a5fa")
        handle.layer.cornerRadius = 3
        addSubview(handle)

        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        let move = UIPanGestureRecognizer(target: self, action: #selector(moved(_:)))
        move.delegate = self
        let resize = UIPanGestureRecognizer(target: self, action: #selector(resized(_:)))
        resize.delegate = self
        handle.addGestureRecognizer(resize)
        move.require(toFail: resize)
        addGestureRecognizer(tap)
        addGestureRecognizer(move)
        addInteraction(UIContextMenuInteraction(delegate: self))
        interactive = false
        update(box)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(_ box: Entity) {
        self.box = box
        label.attributedText = NSAttributedString(string: box.data["text"]?.string ?? "", attributes: TextBoxes.attributes(box.data))
        let d = box.data, width = CGFloat(d["w"]?.double ?? 420), pad = TextBoxes.padding
        let size = label.sizeThatFits(CGSize(width: width - 2 * pad, height: .greatestFiniteMagnitude))
        transform = .identity
        frame = CGRect(x: d["x"]?.double ?? 0, y: d["y"]?.double ?? 0, width: width, height: max(size.height, CGFloat(d["fontSize"]?.double ?? 20) * 1.375) + 2 * pad)
        label.frame = bounds.insetBy(dx: pad, dy: pad)
        handle.frame = CGRect(x: bounds.width - 5, y: bounds.midY - 14, width: 10, height: 28)
    }

    // Wider touch target for the resize handle than it draws.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -12, dy: 0).contains(point)
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard interactive, self.point(inside: point, with: event) else { return nil }
        return point.x > bounds.width - 16 ? handle : self
    }

    @objc private func tapped() { onEdit() }

    @objc private func moved(_ g: UIPanGestureRecognizer) {
        let t = g.translation(in: superview)
        switch g.state {
        case .changed: transform = CGAffineTransform(translationX: t.x, y: t.y)
        case .ended:
            if abs(t.x) < 3, abs(t.y) < 3 { transform = .identity } else { onMove(t.x, t.y) }
        case .cancelled, .failed: transform = .identity
        default: break
        }
    }

    @objc private func resized(_ g: UIPanGestureRecognizer) {
        let width = CGFloat(box.data["w"]?.double ?? 420) + g.translation(in: superview).x
        switch g.state {
        case .changed:
            let d = TextBoxes.resized(box.data, width: width)
            frame.size.width = CGFloat(d["w"]?.double ?? 420)
            label.frame.size.width = frame.width - 2 * TextBoxes.padding
            handle.frame.origin.x = frame.width - 5
        case .ended: onResize(width)
        case .cancelled, .failed: update(box)
        default: break
        }
    }

    /// The scroll view's pan waits, so a drag on a box moves the box instead of the page.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        other.view is UIScrollView && other is UIPanGestureRecognizer
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard interactive else { return nil }
        return UIContextMenuConfiguration(actionProvider: { [weak self] _ in
            UIMenu(children: [
                UIAction(title: "Edit", image: UIImage(systemName: "pencil")) { _ in self?.onEdit() },
                UIAction(title: "Delete", image: UIImage(systemName: "trash"), attributes: .destructive) { _ in self?.onDelete() },
            ])
        })
    }
}

/// Edits a text box in place: a text view over the box (Scribble works in it), saved when it
/// loses focus.
@MainActor
final class TextBoxEditor: UITextView, UITextViewDelegate {
    let box: Entity
    var onDone: (String) -> Void = { _ in }
    private var finished = false

    init(box: Entity) {
        self.box = box
        super.init(frame: .zero, textContainer: nil)
        delegate = self
        backgroundColor = UIColor.white.withAlphaComponent(0.9)
        layer.borderColor = UIColor(hex: "#60a5fa")!.cgColor
        layer.borderWidth = 1
        layer.cornerRadius = 4
        isScrollEnabled = false
        textContainerInset = UIEdgeInsets(top: TextBoxes.padding, left: TextBoxes.padding, bottom: TextBoxes.padding, right: TextBoxes.padding)
        textContainer.lineFragmentPadding = 0
        typingAttributes = TextBoxes.attributes(box.data)
        attributedText = NSAttributedString(string: box.data["text"]?.string ?? "", attributes: TextBoxes.attributes(box.data))
        let d = box.data
        frame = CGRect(x: d["x"]?.double ?? 0, y: d["y"]?.double ?? 0, width: d["w"]?.double ?? 420, height: 0)
        fit()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func fit() {
        let fontSize = CGFloat(box.data["fontSize"]?.double ?? 20)
        frame.size.height = max(sizeThatFits(CGSize(width: frame.width, height: .greatestFiniteMagnitude)).height, fontSize * 1.375 + 2 * TextBoxes.padding)
    }

    func textViewDidChange(_ textView: UITextView) { fit() }

    func textViewDidEndEditing(_ textView: UITextView) { finish() }

    override var keyCommands: [UIKeyCommand]? {
        [UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escape))]
    }

    @objc private func escape() { resignFirstResponder() }

    func finish() {
        guard !finished else { return }
        finished = true
        onDone(text)
    }
}

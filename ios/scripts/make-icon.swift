// Renders the app icon to match src/app/icon.tsx (a white ∫ on slate-900).
// Usage: swift ios/scripts/make-icon.swift ios/PadSync/Assets.xcassets/AppIcon.appiconset/icon-1024.png
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let out = CommandLine.arguments.dropFirst().first ?? "icon-1024.png"
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.setFillColor(CGColor(srgbRed: 0x0f / 255, green: 0x17 / 255, blue: 0x2a / 255, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

let font = CTFontCreateUIFontForLanguage(.system, CGFloat(size) * 0.5, nil)!
let bold = CTFontCreateCopyWithSymbolicTraits(font, 0, nil, .traitBold, .traitBold) ?? font
let text = NSAttributedString(string: "∫", attributes: [
    NSAttributedString.Key(kCTFontAttributeName as String): bold,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(srgbRed: 0xf8 / 255, green: 0xfa / 255, blue: 0xfc / 255, alpha: 1),
])
let line = CTLineCreateWithAttributedString(text)
let glyph = CTLineGetImageBounds(line, ctx)
ctx.textPosition = CGPoint(x: (CGFloat(size) - glyph.width) / 2 - glyph.minX, y: (CGFloat(size) - glyph.height) / 2 - glyph.minY)
CTLineDraw(line, ctx)

let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
precondition(CGImageDestinationFinalize(dest), "could not write \(out)")

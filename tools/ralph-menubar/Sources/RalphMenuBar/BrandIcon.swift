import AppKit

enum BrandIcon {
  static func statusTemplateImage(size: CGFloat = 18) -> NSImage {
    if let bundled = bundledTemplateImage(size: size) {
      return bundled
    }

    return fallbackTemplateImage(size: size)
  }

  private static func bundledTemplateImage(size: CGFloat) -> NSImage? {
    guard let url = Bundle.main.url(forResource: "ralph-menubar-glyph-v1", withExtension: "png"),
      let image = NSImage(contentsOf: url)
    else {
      return nil
    }

    image.size = NSSize(width: size, height: size)
    image.isTemplate = true
    return image
  }

  private static func fallbackTemplateImage(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()

    NSColor.black.setStroke()
    NSColor.black.setFill()

    let lineWidth = max(1.55, size * 0.095)
    let nodeRadius = max(0.95, size * 0.058)
    let headRadius = max(1.7, size * 0.105)
    let headCenter = NSPoint(x: size * 0.50, y: size * 0.71)
    let leftNode = NSPoint(x: size * 0.22, y: size * 0.37)
    let bottomNode = NSPoint(x: size * 0.46, y: size * 0.22)
    let rightNode = NSPoint(x: size * 0.75, y: size * 0.38)

    NSBezierPath(ovalIn: NSRect(
      x: headCenter.x - headRadius,
      y: headCenter.y - headRadius,
      width: headRadius * 2,
      height: headRadius * 2
    )).fill()

    let shoulders = NSBezierPath()
    shoulders.lineWidth = lineWidth
    shoulders.lineCapStyle = .round
    shoulders.lineJoinStyle = .round
    shoulders.move(to: NSPoint(x: size * 0.32, y: size * 0.50))
    shoulders.line(to: NSPoint(x: size * 0.41, y: size * 0.43))
    shoulders.line(to: NSPoint(x: size * 0.59, y: size * 0.43))
    shoulders.line(to: NSPoint(x: size * 0.68, y: size * 0.50))
    shoulders.stroke()

    let loop = NSBezierPath()
    loop.lineWidth = lineWidth
    loop.lineCapStyle = .round
    loop.lineJoinStyle = .round
    loop.move(to: NSPoint(x: size * 0.16, y: size * 0.44))
    loop.line(to: NSPoint(x: size * 0.26, y: size * 0.29))
    loop.line(to: NSPoint(x: size * 0.40, y: size * 0.23))
    loop.line(to: NSPoint(x: size * 0.60, y: size * 0.23))
    loop.line(to: NSPoint(x: size * 0.70, y: size * 0.26))
    loop.line(to: NSPoint(x: size * 0.83, y: size * 0.43))
    loop.stroke()

    for node in [leftNode, bottomNode, rightNode] {
      NSBezierPath(ovalIn: NSRect(
        x: node.x - nodeRadius,
        y: node.y - nodeRadius,
        width: nodeRadius * 2,
        height: nodeRadius * 2
      )).fill()
    }

    let check = NSBezierPath()
    check.lineWidth = max(1.45, size * 0.09)
    check.lineCapStyle = .round
    check.lineJoinStyle = .round
    check.move(to: NSPoint(x: size * 0.61, y: size * 0.26))
    check.line(to: NSPoint(x: size * 0.68, y: size * 0.19))
    check.line(to: NSPoint(x: size * 0.81, y: size * 0.33))
    check.stroke()

    image.unlockFocus()
    image.isTemplate = true
    return image
  }
}

import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Foundation

// Composite the approved transparent logo over the product's charcoal ground.
let args = CommandLine.arguments
guard args.count == 3,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let logo = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fatalError("Usage: render-record-keeper-assets.swift <logo.png> <asset-catalog>")
}
func render(size: Int, markSize: Int, path: String) throws {
    let context = CGContext(data: nil, width: size, height: size,
        bitsPerComponent: 8, bytesPerRow: size * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(CGColor(red: 23.0 / 255, green: 23.0 / 255, blue: 23.0 / 255, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))
    let offset = (size - markSize) / 2
    context.interpolationQuality = .high
    context.draw(logo, in: CGRect(x: offset, y: offset, width: markSize, height: markSize))
    let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL,
        UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("Could not write " + path) }
}
try render(size: 1024, markSize: 1024,
    path: args[2] + "/AppIcon.appiconset/AppIcon-512@2x.png")
for name in ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"] {
    try render(size: 2732, markSize: 800, path: args[2] + "/Splash.imageset/" + name)
}

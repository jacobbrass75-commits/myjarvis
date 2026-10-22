// 4-bit grayscale BMP, the format G2 image containers accept (uncompressed BITMAPINFOHEADER with a
// 16-entry grey palette; compressMode = 0). Port of native/driver/src/bmp.ts.

import Foundation

public struct GrayImage: Equatable {
    public let width: Int
    public let height: Int
    /// 8-bit luminance, row-major, top row first.
    public let pixels: [UInt8]

    public init(width: Int, height: Int, pixels: [UInt8]) {
        precondition(pixels.count == width * height, "pixel buffer size mismatch")
        self.width = width; self.height = height; self.pixels = pixels
    }

    public static func solid(width: Int, height: Int, level: UInt8) -> GrayImage {
        GrayImage(width: width, height: height, pixels: [UInt8](repeating: level, count: width * height))
    }
}

public func build4BitBmp(_ img: GrayImage) -> [UInt8] {
    let rowBytes = ((img.width + 1) / 2 + 3) & ~3
    let dataSize = rowBytes * img.height
    let headerSize = 14 + 40 + 16 * 4
    var out = [UInt8](repeating: 0, count: headerSize + dataSize)
    func u32(_ off: Int, _ v: UInt32) { for i in 0..<4 { out[off + i] = UInt8(truncatingIfNeeded: v >> (8 * UInt32(i))) } }
    func u16(_ off: Int, _ v: UInt16) { out[off] = UInt8(v & 0xFF); out[off + 1] = UInt8(v >> 8) }
    out[0] = 0x42 // B
    out[1] = 0x4D // M
    u32(2, UInt32(out.count))
    u32(10, UInt32(headerSize))
    u32(14, 40)
    u32(18, UInt32(img.width))
    u32(22, UInt32(img.height)) // positive = bottom-up
    u16(26, 1)
    u16(28, 4)
    u32(30, 0) // BI_RGB
    u32(34, UInt32(dataSize))
    u32(38, 2835)
    u32(42, 2835)
    u32(46, 16)
    u32(50, 0)
    for i in 0..<16 {
        let g = UInt8(i * 17)
        out[54 + i * 4] = g; out[55 + i * 4] = g; out[56 + i * 4] = g; out[57 + i * 4] = 0
    }
    for row in 0..<img.height {
        let src = (img.height - 1 - row) * img.width
        let dst = headerSize + row * rowBytes
        for x in 0..<img.width {
            let idx = img.pixels[src + x] >> 4
            out[dst + (x >> 1)] |= (x & 1) != 0 ? idx : idx << 4
        }
    }
    return out
}

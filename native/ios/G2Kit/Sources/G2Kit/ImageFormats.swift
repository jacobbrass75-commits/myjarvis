// Experimental, opt-in image payloads for the same updateImageRawData command (EvenHub cmd 3; no new
// command ids, no new fields). Every 288x144 tile is ~20.9 KB as a plain 4-bit BMP and the glasses ACK a
// 4 KB fragment in ~0.4 s, so fewer bytes is the lever. None of these is confirmed on our glasses:
//
//   rle4      4-bit BMP, BI_RLE4 (biCompression 2). Maps are mostly black: a few KB.
//   rle8      8-bit BMP with a 16-entry palette, BI_RLE8 (biCompression 1).
//   1bit      1-bit BMP, black/white palette, 4x4 Bayer-dithered from the 16 levels (~5.2 KB per tile).
//   lz4       the plain 4-bit BMP as one LZ4 block, CompressMode = 2, MapTotalSize = compressed size.
//             Even Hub SDK 0.0.12+ README: "Image raw data is compressed with LZ4 internally" and its
//             ImageRawDataUpdate.toJson sets compressMode: 2; hub.evenrealities.com/docs/build/display:
//             "Raw data is LZ4-compressed in transit automatically". The framing is not documented.
//   lz4-frag  each 4 KB BMP fragment as its own LZ4 block, CompressMode = 2, MapTotalSize = BMP size,
//             MapFragmentPacketSize = the compressed fragment size (the other guess at that framing).
//
// G2Driver falls back to the standard BMP for the session when the glasses NAK or time out on one.

import Foundation

public enum ImageFormat: String, CaseIterable, Codable, Sendable {
    case standard
    case rle4
    case rle8
    case mono = "1bit"
    case lz4
    case lz4Frag = "lz4-frag"

    public var label: String {
        switch self {
        case .standard: return "Standard (4-bit BMP)"
        case .rle4: return "RLE4 (experimental)"
        case .rle8: return "RLE8 (experimental)"
        case .mono: return "1-bit (experimental)"
        case .lz4: return "LZ4 (experimental)"
        case .lz4Frag: return "LZ4 per fragment (experimental)"
        }
    }

    /// EvenHub CompressMode (field 5): 0 = raw, 2 = LZ4 (SDK 0.0.12+).
    public var compressMode: Int { self == .lz4 || self == .lz4Frag ? 2 : 0 }
}

/// A plain 4-bit BMP (what build4BitBmp makes) read back as levels 0..15, top row first.
public struct Levels4: Equatable {
    public let width: Int
    public let height: Int
    public let px: [UInt8]

    public init(width: Int, height: Int, px: [UInt8]) {
        precondition(px.count == width * height, "pixel buffer size mismatch")
        self.width = width; self.height = height; self.px = px
    }

    public init?(bmp b: [UInt8]) {
        guard b.count >= 54, b[0] == 0x42, b[1] == 0x4D else { return nil }
        let off = Int(le32(b, 10)), w = Int(Int32(bitPattern: le32(b, 18))), hRaw = Int(Int32(bitPattern: le32(b, 22)))
        guard le16(b, 28) == 4, le32(b, 30) == 0, w > 0, hRaw != 0 else { return nil }
        let h = abs(hRaw), stride = ((w + 1) / 2 + 3) & ~3
        guard off + stride * h <= b.count else { return nil }
        var px = [UInt8](repeating: 0, count: w * h)
        for row in 0..<h {
            let y = hRaw > 0 ? h - 1 - row : row
            for x in 0..<w {
                let byte = b[off + row * stride + x / 2]
                px[y * w + x] = x & 1 == 0 ? byte >> 4 : byte & 15
            }
        }
        self.init(width: w, height: h, px: px)
    }
}

func le32(_ b: [UInt8], _ o: Int) -> UInt32 { UInt32(b[o]) | UInt32(b[o + 1]) << 8 | UInt32(b[o + 2]) << 16 | UInt32(b[o + 3]) << 24 }
func le16(_ b: [UInt8], _ o: Int) -> UInt16 { UInt16(b[o]) | UInt16(b[o + 1]) << 8 }

/// BITMAPFILEHEADER + BITMAPINFOHEADER + a grey palette (entry i = grey(i)) + `data`.
func bmpFile(width: Int, height: Int, bpp: Int, compression: UInt32, palette: [UInt8], data: [UInt8]) -> [UInt8] {
    let header = 14 + 40 + palette.count * 4
    var out = [UInt8](repeating: 0, count: header)
    func u32(_ o: Int, _ v: UInt32) { for i in 0..<4 { out[o + i] = UInt8(truncatingIfNeeded: v >> (8 * UInt32(i))) } }
    out[0] = 0x42; out[1] = 0x4D
    u32(2, UInt32(header + data.count))
    u32(10, UInt32(header))
    u32(14, 40)
    u32(18, UInt32(width))
    u32(22, UInt32(height)) // bottom-up (RLE bitmaps must be)
    out[26] = 1
    out[28] = UInt8(bpp)
    u32(30, compression)
    u32(34, UInt32(data.count))
    u32(38, 2835); u32(42, 2835)
    u32(46, UInt32(palette.count))
    for (i, g) in palette.enumerated() { out[54 + i * 4] = g; out[55 + i * 4] = g; out[56 + i * 4] = g }
    return out + data
}

private let grey16 = (0..<16).map { UInt8($0 * 17) }

public enum ImageEncoder {
    /// The bytes sent for `format` (whole-image formats; lz4Frag compresses per fragment in EvenHub).
    public static func payload(_ bmp: [UInt8], format: ImageFormat) -> [UInt8]? {
        switch format {
        case .standard, .lz4Frag: return bmp
        case .lz4: return lz4Compress(bmp)
        case .rle4, .rle8, .mono:
            guard let img = Levels4(bmp: bmp) else { return nil }
            return format == .rle4 ? rle4Bmp(img) : format == .rle8 ? rle8Bmp(img) : monoBmp(img)
        }
    }

    // MARK: RLE (BMP spec: encoded runs <count, value>; escapes 0,0 end of line / 0,1 end of bitmap /
    // 0,n>=3 absolute run padded to a 16-bit boundary)

    public static func rle4Bmp(_ img: Levels4) -> [UInt8] {
        bmpFile(width: img.width, height: img.height, bpp: 4, compression: 2, palette: grey16, data: rle(img, bits: 4))
    }

    public static func rle8Bmp(_ img: Levels4) -> [UInt8] {
        bmpFile(width: img.width, height: img.height, bpp: 8, compression: 1, palette: grey16, data: rle(img, bits: 8))
    }

    static func rle(_ img: Levels4, bits: Int) -> [UInt8] {
        var out: [UInt8] = []
        let w = img.width
        for row in 0..<img.height {
            let y = img.height - 1 - row
            let v = Array(img.px[(y * w)..<(y * w + w)])
            func runAt(_ i: Int) -> Int {
                var n = 1
                while i + n < w, n < 255, v[i + n] == v[i] { n += 1 }
                return n
            }
            var i = 0
            while i < w {
                let run = runAt(i)
                if run >= 3 {
                    out += [UInt8(run), bits == 4 ? v[i] << 4 | v[i] : v[i]]
                    i += run
                    continue
                }
                var j = i
                while j < w, j - i < 255, runAt(j) < 3 { j += 1 }
                let lit = j - i
                if lit >= 3 {
                    out += [0, UInt8(lit)]
                    var data: [UInt8] = []
                    if bits == 4 {
                        for k in stride(from: i, to: j, by: 2) { data.append(v[k] << 4 | (k + 1 < j ? v[k + 1] : 0)) }
                    } else {
                        data = Array(v[i..<j])
                    }
                    if data.count % 2 == 1 { data.append(0) }
                    out += data
                } else if bits == 4 {
                    // One or two pixels: an encoded run of `lit` alternating nibbles.
                    out += [UInt8(lit), v[i] << 4 | (lit == 2 ? v[i + 1] : 0)]
                } else {
                    for k in i..<j { out += [1, v[k]] }
                }
                i = j
            }
            out += [0, 0]
        }
        out += [0, 1]
        return out
    }

    /// Decode BI_RLE4/BI_RLE8 data back to levels (tests; also documents what we expect the firmware to do).
    static func unrle(_ d: [UInt8], width: Int, height: Int, bits: Int) -> [UInt8]? {
        var px = [UInt8](repeating: 0, count: width * height)
        var x = 0, row = 0, i = 0
        func put(_ c: UInt8) {
            if x < width, row < height { px[(height - 1 - row) * width + x] = c }
            x += 1
        }
        while i + 1 < d.count {
            let a = Int(d[i]), b = d[i + 1]
            i += 2
            if a > 0 {
                for k in 0..<a { put(bits == 4 ? (k & 1 == 0 ? b >> 4 : b & 15) : b) }
            } else if b == 0 { x = 0; row += 1 }
            else if b == 1 { return px }
            else if b == 2 { guard i + 1 < d.count else { return nil }; x += Int(d[i]); row += Int(d[i + 1]); i += 2 }
            else {
                let n = Int(b), bytes = bits == 4 ? (n + 1) / 2 : n
                guard i + bytes <= d.count else { return nil }
                for k in 0..<n { put(bits == 4 ? (k & 1 == 0 ? d[i + k / 2] >> 4 : d[i + k / 2] & 15) : d[i + k]) }
                i += bytes + (bytes & 1)
            }
        }
        return nil
    }

    // MARK: 1-bit

    private static let bayer4: [Int] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

    /// Level 0 stays off and 15 on; the levels between are ordered-dithered (stable frame to frame).
    public static func monoBit(level: UInt8, x: Int, y: Int) -> Bool {
        Int(level) > bayer4[(y & 3) * 4 + (x & 3)]
    }

    public static func monoBmp(_ img: Levels4) -> [UInt8] {
        let stride = ((img.width + 7) / 8 + 3) & ~3
        var data = [UInt8](repeating: 0, count: stride * img.height)
        for row in 0..<img.height {
            let y = img.height - 1 - row
            for x in 0..<img.width where monoBit(level: img.px[y * img.width + x], x: x, y: y) {
                data[row * stride + x / 8] |= 0x80 >> UInt8(x & 7)
            }
        }
        return bmpFile(width: img.width, height: img.height, bpp: 1, compression: 0, palette: [0, 255], data: data)
    }

    // MARK: LZ4 block format (no frame header): sequences of token, literals, 2-byte offset, match length.

    public static func lz4Compress(_ src: [UInt8]) -> [UInt8] {
        let n = src.count
        var out: [UInt8] = []
        out.reserveCapacity(n / 2 + 16)
        func length(_ v: Int) { var v = v; while v >= 255 { out.append(255); v -= 255 }; out.append(UInt8(v)) }
        func sequence(_ litStart: Int, _ litEnd: Int, offset: Int, match: Int) {
            let lit = litEnd - litStart
            let m = match - 4
            out.append(UInt8(min(lit, 15) << 4 | (match > 0 ? min(m, 15) : 0)))
            if lit >= 15 { length(lit - 15) }
            out += src[litStart..<litEnd]
            guard match > 0 else { return }
            out += [UInt8(offset & 0xFF), UInt8(offset >> 8)]
            if m >= 15 { length(m - 15) }
        }
        func read32(_ i: Int) -> UInt32 { UInt32(src[i]) | UInt32(src[i + 1]) << 8 | UInt32(src[i + 2]) << 16 | UInt32(src[i + 3]) << 24 }
        var anchor = 0, i = 0
        if n >= 13 {
            var table = [Int](repeating: -1, count: 1 << 12)
            let matchLimit = n - 12 // the last match starts >= 12 bytes before the end
            let endLimit = n - 5 // and the last 5 bytes are literals
            while i < matchLimit {
                let seq = read32(i)
                let h = Int((seq &* 2_654_435_761) >> 20)
                let ref = table[h]
                table[h] = i
                if ref >= 0, i - ref <= 65535, read32(ref) == seq {
                    var len = 4
                    while i + len < endLimit, src[ref + len] == src[i + len] { len += 1 }
                    sequence(anchor, i, offset: i - ref, match: len)
                    i += len
                    anchor = i
                } else {
                    i += 1
                }
            }
        }
        sequence(anchor, n, offset: 0, match: 0)
        return out
    }

    public static func lz4Decompress(_ src: [UInt8], maxSize: Int = 1 << 20) -> [UInt8]? {
        var out: [UInt8] = []
        var i = 0
        func length(_ base: Int) -> Int? {
            var v = base
            guard base == 15 else { return v }
            while true {
                guard i < src.count else { return nil }
                let b = Int(src[i]); i += 1; v += b
                if b != 255 { return v }
            }
        }
        while i < src.count {
            let token = Int(src[i]); i += 1
            guard let lit = length(token >> 4), i + lit <= src.count else { return nil }
            out += src[i..<(i + lit)]; i += lit
            if i == src.count { return out }
            guard i + 1 < src.count else { return nil }
            let off = Int(src[i]) | Int(src[i + 1]) << 8; i += 2
            guard off > 0, off <= out.count, let m = length(token & 15) else { return nil }
            let start = out.count - off
            for k in 0..<(m + 4) { out.append(out[start + k]) }
            if out.count > maxSize { return nil }
        }
        return out
    }
}

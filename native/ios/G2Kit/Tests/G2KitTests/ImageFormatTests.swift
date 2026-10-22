import Foundation
import Testing
@testable import G2Kit
#if canImport(ImageIO)
import CoreGraphics
import ImageIO
#endif

/// The experimental image payloads (ImageFormats.swift): each decodes back to the tile it came from.
@Suite struct ImageFormatTests {
    /// A map-like 288x144 tile: mostly black, roads, a label block, a 16-level ramp and some noise.
    static func mapTile() -> Levels4 {
        let w = 288, h = 144
        var px = [UInt8](repeating: 0, count: w * h)
        var seed: UInt32 = 7
        for y in 0..<h {
            for x in 0..<w {
                var v: UInt8 = 0
                if y == 40 || y == 41 || x == 100 || (x + y) % 97 == 0 { v = 6 } // roads
                if (120..<200).contains(x) && (90..<110).contains(y) { v = UInt8((x / 5 + y) % 2 == 0 ? 15 : 0) } // text-ish
                if y >= 130 { v = UInt8(x * 16 / w) } // ramp
                if (220..<260).contains(x) && (10..<30).contains(y) {
                    seed = seed &* 1_103_515_245 &+ 12345
                    v = UInt8((seed >> 16) & 15)
                }
                px[y * w + x] = v
            }
        }
        return Levels4(width: w, height: h, px: px)
    }

    static func bmp(_ img: Levels4) -> [UInt8] {
        build4BitBmp(GrayImage(width: img.width, height: img.height, pixels: img.px.map { $0 * 17 }))
    }

    @Test func plainBmpReadsBackAsLevels() {
        let img = Self.mapTile()
        #expect(Levels4(bmp: Self.bmp(img)) == img)
        #expect(Levels4(bmp: [UInt8](repeating: 0, count: 10)) == nil)
    }

    @Test func rle4RoundTripsAndShrinksAMapTile() throws {
        let img = Self.mapTile()
        let file = ImageEncoder.rle4Bmp(img)
        #expect(file[0] == 0x42 && file[1] == 0x4D)
        #expect(le16(file, 28) == 4 && le32(file, 30) == 2) // 4 bpp, BI_RLE4
        #expect(Int(le32(file, 2)) == file.count && Int(le32(file, 34)) == file.count - 118)
        let back = try #require(ImageEncoder.unrle(Array(file[118...]), width: 288, height: 144, bits: 4))
        #expect(back == img.px)
        #expect(file.count < Self.bmp(img).count / 3)
        #expect(Array(file.suffix(2)) == [0, 1])
    }

    @Test func rle4HandlesOddWidthsAndEveryRunLength() throws {
        // Runs of 1..300, literals of 1..5 and an odd width exercise every encoder branch.
        let w = 37, h = 9
        var px: [UInt8] = []
        for y in 0..<h { for x in 0..<w { px.append(UInt8(y < 3 ? (x * 7 + y) % 16 : y < 6 ? (x / (y + 1)) % 16 : x % 3 == 0 ? 15 : 0)) } }
        let img = Levels4(width: w, height: h, px: px)
        for bits in [4, 8] {
            let data = ImageEncoder.rle(img, bits: bits)
            #expect(ImageEncoder.unrle(data, width: w, height: h, bits: bits) == px, "bits \(bits)")
        }
        let wide = Levels4(width: 600, height: 2, px: [UInt8](repeating: 9, count: 1200))
        #expect(ImageEncoder.unrle(ImageEncoder.rle(wide, bits: 4), width: 600, height: 2, bits: 4) == wide.px)
    }

    @Test func rle8RoundTrips() throws {
        let img = Self.mapTile()
        let file = ImageEncoder.rle8Bmp(img)
        #expect(le16(file, 28) == 8 && le32(file, 30) == 1 && le32(file, 46) == 16)
        #expect(ImageEncoder.unrle(Array(file[118...]), width: 288, height: 144, bits: 8) == img.px)
    }

    @Test func monoIsAThresholdedDitherOfTheLevels() {
        // 0 never lights, 15 always does, a level lights level/16 of a 4x4 cell.
        for level in 0...15 {
            var on = 0
            for y in 0..<4 { for x in 0..<4 where ImageEncoder.monoBit(level: UInt8(level), x: x, y: y) { on += 1 } }
            #expect(on == level, "level \(level)")
        }
        let img = Self.mapTile()
        let file = ImageEncoder.monoBmp(img)
        #expect(le16(file, 28) == 1 && le32(file, 30) == 0 && le32(file, 46) == 2)
        #expect(file.count == 14 + 40 + 8 + 36 * 144) // 5246 bytes
        #expect(Array(file[54..<62]) == [0, 0, 0, 0, 255, 255, 255, 0])
        // Pixel (x, y) = bit 7 - x%8 of byte x/8 in stored row 143 - y.
        for (x, y) in [(0, 0), (130, 95), (287, 143), (100, 5), (230, 20)] {
            let byte = file[62 + (143 - y) * 36 + x / 8]
            let bit = byte & (0x80 >> UInt8(x & 7)) != 0
            #expect(bit == ImageEncoder.monoBit(level: img.px[y * 288 + x], x: x, y: y), "(\(x), \(y))")
        }
    }

    @Test func lz4RoundTripsAndFollowsTheBlockRules() throws {
        let bmp = Self.bmp(Self.mapTile())
        let packed = ImageEncoder.lz4Compress(bmp)
        #expect(ImageEncoder.lz4Decompress(packed) == bmp)
        #expect(packed.count < bmp.count / 3)
        for n in [0, 1, 5, 12, 13, 20, 300] {
            let src = (0..<n).map { UInt8(($0 / 7) % 3) }
            #expect(ImageEncoder.lz4Decompress(ImageEncoder.lz4Compress(src)) == src, "n \(n)")
        }
        var seed: UInt32 = 1
        let noise = (0..<5000).map { _ -> UInt8 in seed = seed &* 1_103_515_245 &+ 12345; return UInt8(seed >> 24) }
        #expect(ImageEncoder.lz4Decompress(ImageEncoder.lz4Compress(noise)) == noise)
        // The reference decoder's end rule: the block ends with a literal run of at least 5 bytes.
        let zeros = [UInt8](repeating: 0, count: 4096)
        let z = ImageEncoder.lz4Compress(zeros)
        #expect(z.count < 40)
        #expect(ImageEncoder.lz4Decompress(z) == zeros)
        #expect(Array(z.suffix(5)) == [0, 0, 0, 0, 0])
    }

    @Test func messagesCarryTheCompressModeAndPayloadSize() throws {
        let bmp = Self.bmp(Self.mapTile())
        for format in ImageFormat.allCases {
            let built = try #require(EvenHub.imageMessages(containerId: 4, bmp: bmp, sessionId: 9, containerName: "tile0", format: format))
            var joined: [UInt8] = []
            for (i, msg) in built.messages.enumerated() {
                let m = PbMessage(msg)
                let f = try #require(m.message(5))
                #expect(f.int(5) == format.compressMode)
                #expect(f.int(6) == i && f.int(3) == 9)
                let data = try #require(f.bytes(8))
                #expect(f.int(7) == data.count && data.count <= 4096)
                #expect(f.int(4) == (format == .lz4Frag ? bmp.count : built.bytes))
                joined += format == .lz4Frag ? try #require(ImageEncoder.lz4Decompress(data)) : data
            }
            switch format {
            case .standard, .lz4Frag: #expect(joined == bmp)
            case .lz4: #expect(ImageEncoder.lz4Decompress(joined) == bmp)
            default: #expect(joined == ImageEncoder.payload(bmp, format: format))
            }
        }
        #expect(EvenHub.imageMessages(containerId: 4, bmp: [1, 2, 3], sessionId: 1, format: .rle4) == nil)
    }

    /// Sizes per format for real lens previews (576x288 drawn 2x, levels from the green channel):
    /// `G2_IMAGE_SIZES_DIR=/path/to/pngs swift test --filter sizesForPreviews`. Skipped otherwise.
    @Test func sizesForPreviews() throws {
        #if canImport(ImageIO)
        guard let dir = ProcessInfo.processInfo.environment["G2_IMAGE_SIZES_DIR"] else { return }
        let files = try FileManager.default.contentsOfDirectory(atPath: dir).filter { $0.hasSuffix(".png") }.sorted()
        var lines = ["file tile " + ImageFormat.allCases.map(\.rawValue).joined(separator: " ")]
        for f in files {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(f)
            guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { continue }
            let W = 576, H = 288
            var rgba = [UInt8](repeating: 0, count: W * H * 4)
            rgba.withUnsafeMutableBytes { buf in
                let ctx = CGContext(data: buf.baseAddress, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4,
                                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
                ctx.interpolationQuality = .none
                ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
            }
            for (tx, ty) in [(0, 0), (288, 0), (0, 144), (288, 144)] {
                var px = [UInt8](repeating: 0, count: 288 * 144)
                for y in 0..<144 { for x in 0..<288 { px[y * 288 + x] = UInt8(min(15, (Int(rgba[((ty + y) * W + tx + x) * 4 + 1]) + 8) / 17)) } }
                let bmp = Self.bmp(Levels4(width: 288, height: 144, px: px))
                let sizes = ImageFormat.allCases.map { EvenHub.imageMessages(containerId: 4, bmp: bmp, sessionId: 1, format: $0)!.bytes }
                lines.append("\(f) \(tx / 288),\(ty / 144) " + sizes.map(String.init).joined(separator: " "))
            }
        }
        print(lines.joined(separator: "\n"))
        #endif
    }
}

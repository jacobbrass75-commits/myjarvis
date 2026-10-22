// Minimal protobuf (proto3 wire format) writer/reader. Port of native/driver/src/protobuf.ts.
// Field ORDER matters for byte-exact fixtures: write fields in the order MentraOS does.

import Foundation

public final class PbWriter {
    private(set) var buf: [UInt8] = []

    public init() {}

    /// Negative values are encoded as 10-byte two's complement varints (proto3 int32 semantics).
    @discardableResult
    public func varint(_ value: Int) -> PbWriter {
        varintU(UInt64(bitPattern: Int64(value)))
    }

    @discardableResult
    public func varintU(_ value: UInt64) -> PbWriter {
        var v = value
        while v > 0x7F {
            buf.append(UInt8(v & 0x7F) | 0x80)
            v >>= 7
        }
        buf.append(UInt8(v))
        return self
    }

    @discardableResult
    private func tag(_ field: Int, _ wire: Int) -> PbWriter { varint(field << 3 | wire) }

    @discardableResult
    public func int(_ field: Int, _ value: Int) -> PbWriter { tag(field, 0).varint(value) }

    @discardableResult
    public func bool(_ field: Int, _ value: Bool) -> PbWriter { int(field, value ? 1 : 0) }

    @discardableResult
    public func bytes(_ field: Int, _ value: [UInt8]) -> PbWriter {
        tag(field, 2).varint(value.count)
        buf.append(contentsOf: value)
        return self
    }

    @discardableResult
    public func string(_ field: Int, _ value: String) -> PbWriter { bytes(field, Array(value.utf8)) }

    @discardableResult
    public func message(_ field: Int, _ sub: PbWriter) -> PbWriter { bytes(field, sub.finish()) }

    @discardableResult
    public func message(_ field: Int, _ sub: [UInt8]) -> PbWriter { bytes(field, sub) }

    @discardableResult
    public func float(_ field: Int, _ value: Float) -> PbWriter {
        tag(field, 5)
        let bits = value.bitPattern
        for i in 0..<4 { buf.append(UInt8(truncatingIfNeeded: bits >> (8 * UInt32(i)))) }
        return self
    }

    public func finish() -> [UInt8] { buf }
}

public struct PbField: Equatable {
    public let field: Int
    public let wire: Int
    /// varint fields (int32-truncated, like Kotlin `toInt()`) and fixed32 (raw uint32).
    public let number: Int64
    /// length-delimited fields.
    public let data: [UInt8]
}

public struct PbReader {
    private var off = 0
    private let data: [UInt8]

    public init(_ data: [UInt8]) { self.data = data }

    var done: Bool { off >= data.count }

    struct Truncated: Error {}

    mutating func varint() throws -> UInt64 {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        while off < data.count {
            let b = data[off]
            off += 1
            result |= UInt64(b & 0x7F) << shift
            if b & 0x80 == 0 { return result }
            shift += 7
            if shift > 63 { throw Truncated() }
        }
        throw Truncated()
    }

    private mutating func take(_ n: Int) throws -> [UInt8] {
        guard n >= 0, off + n <= data.count else { throw Truncated() }
        defer { off += n }
        return Array(data[off..<off + n])
    }

    /// Read every field. Malformed tails stop parsing and are reported via `truncated`.
    public mutating func fields() -> (fields: [PbField], truncated: Bool) {
        var out: [PbField] = []
        do {
            while !done {
                let tag = try varint()
                let field = Int(tag >> 3)
                let wire = Int(tag & 7)
                switch wire {
                case 0:
                    let v = try varint()
                    out.append(PbField(field: field, wire: 0, number: Int64(Int32(truncatingIfNeeded: v)), data: []))
                case 2:
                    let n = try varint()
                    guard n <= UInt64(Int32.max) else { throw Truncated() }
                    out.append(PbField(field: field, wire: 2, number: 0, data: try take(Int(n))))
                case 5:
                    let b = try take(4)
                    let v = UInt32(b[0]) | UInt32(b[1]) << 8 | UInt32(b[2]) << 16 | UInt32(b[3]) << 24
                    out.append(PbField(field: field, wire: 5, number: Int64(v), data: []))
                case 1:
                    _ = try take(8)
                default:
                    throw Truncated()
                }
            }
            return (out, false)
        } catch {
            return (out, true)
        }
    }
}

/// Parsed message as a multimap: field number -> values in order.
public struct PbMessage {
    public let map: [Int: [PbField]]
    public let truncated: Bool

    public init(_ data: [UInt8]) {
        var r = PbReader(data)
        let (fields, truncated) = r.fields()
        var m: [Int: [PbField]] = [:]
        for f in fields { m[f.field, default: []].append(f) }
        self.map = m
        self.truncated = truncated
    }

    public func has(_ field: Int) -> Bool { map[field] != nil }

    /// Last varint value for a field (proto3 "last one wins").
    public func int(_ field: Int) -> Int? {
        guard let f = map[field]?.last, f.wire == 0 else { return nil }
        return Int(f.number)
    }

    public func bytes(_ field: Int) -> [UInt8]? {
        guard let f = map[field]?.last, f.wire == 2 else { return nil }
        return f.data
    }

    public func allBytes(_ field: Int) -> [[UInt8]] {
        (map[field] ?? []).filter { $0.wire == 2 }.map(\.data)
    }

    public func string(_ field: Int) -> String? {
        bytes(field).map { String(decoding: $0, as: UTF8.self) }
    }

    public func message(_ field: Int) -> PbMessage? {
        bytes(field).map(PbMessage.init)
    }

    /// A fixed32 float field (what MentraOS observed for IMU).
    public func float(_ field: Int) -> Float? {
        guard let f = map[field]?.last, f.wire == 5 else { return nil }
        return Float(bitPattern: UInt32(truncatingIfNeeded: f.number))
    }
}

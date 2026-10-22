// Transport framing for the G2 write (…5401) / notify (…5402) characteristics.
// Port of native/driver/src/framing.ts.
//
//   byte 0   0xAA
//   byte 1   (dest << 4) | src   0x21 phone->glasses, 0x12 glasses->phone
//   byte 2   sync id: one value per logical message, SAME on every fragment of it
//   byte 3   length of this packet's data after the header, INCLUDING the 2 CRC bytes on the last packet
//   byte 4   total packet count of the message (1..255)
//   byte 5   packet serial, 1-based
//   byte 6   service id
//   byte 7   flag. Host->glasses: 0x20, or 0x00 for device-settings (0x80).
//            Glasses->host: bits 1..4 are a result code; non-zero means the message failed.
//   data     protobuf chunk (<= 236 bytes)
//   [crc]    last packet only: CRC-16/CCITT-FALSE of the WHOLE payload, little-endian

import Foundation

public enum FramingError: Error, Equatable {
    case badChunkSize
    case payloadTooLarge(Int)
}

public func defaultFlag(service: UInt8) -> UInt8 {
    service == Service.deviceSettings ? 0x00 : Frame.reserveFlag
}

public func buildPackets(_ payload: [UInt8], syncId: UInt8, service: UInt8, flag: UInt8? = nil, maxChunk: Int = Frame.maxChunk) throws -> [[UInt8]] {
    guard (1...253).contains(maxChunk) else { throw FramingError.badChunkSize }
    var chunks: [ArraySlice<UInt8>] = stride(from: 0, to: payload.count, by: maxChunk).map {
        payload[$0..<min($0 + maxChunk, payload.count)]
    }
    if chunks.isEmpty { chunks.append([]) }
    // A full last chunk would exceed the packet budget once the CRC is added (8 + 236 + 2 > 244),
    // so MentraOS sends the CRC in an extra, data-less packet. Same rule for any max.
    if chunks.last!.count == maxChunk { chunks.append([]) }
    guard chunks.count <= 255 else { throw FramingError.payloadTooLarge(payload.count) }

    let crc = crc16(payload)
    let flag = flag ?? defaultFlag(service: service)
    return chunks.enumerated().map { i, chunk in
        let last = i == chunks.count - 1
        var out: [UInt8] = [
            Frame.magic, Frame.phoneToGlasses, syncId,
            UInt8(chunk.count + (last ? 2 : 0)), UInt8(chunks.count), UInt8(i + 1), service, flag,
        ]
        out.append(contentsOf: chunk)
        if last {
            out.append(UInt8(crc & 0xFF))
            out.append(UInt8(crc >> 8))
        }
        return out
    }
}

public struct RawPacket: Equatable {
    public let route: UInt8
    public let syncId: UInt8
    public let total: Int
    public let serial: Int
    public let service: UInt8
    public let status: UInt8
    /// (status >> 1) & 0x0f — non-zero means the glasses reported an error for this message.
    public var resultCode: Int { Int((status >> 1) & 0x0F) }
    public var isLast: Bool { serial == total }
    /// Protobuf chunk without header/CRC.
    public let chunk: [UInt8]
    /// CRC bytes as received on the last packet.
    public let crc: UInt16?
}

public func parsePacket(_ raw: [UInt8]) -> RawPacket? {
    guard raw.count >= Frame.headerLen, raw[0] == Frame.magic else { return nil }
    let len = Int(raw[3])
    guard raw.count >= Frame.headerLen + len else { return nil }
    let total = Int(raw[4])
    let serial = Int(raw[5])
    let isLast = serial == total
    if isLast && len < 2 { return nil }
    let end = Frame.headerLen + len - (isLast ? 2 : 0)
    return RawPacket(
        route: raw[1], syncId: raw[2], total: total, serial: serial, service: raw[6], status: raw[7],
        chunk: Array(raw[Frame.headerLen..<end]),
        crc: isLast ? UInt16(raw[end]) | UInt16(raw[end + 1]) << 8 : nil
    )
}

public struct FramedMessage: Equatable {
    public let service: UInt8
    public let syncId: UInt8
    public let payload: [UInt8]
    /// CRC check over the reassembled payload (nil if no CRC was present).
    public let crcOk: Bool?
    public let source: String
    public let status: UInt8
}

/// Reassembles fragmented notifications. Keyed by source (lens) + service + sync id so concurrent
/// L/R replies with the same sync id do not cross-merge (a bug MentraOS hit).
public final class Reassembler {
    private struct Partial {
        var parts: [[UInt8]]
        var next: Int
        let total: Int
    }

    private var partial: [String: Partial] = [:]
    /// Messages whose status carried a non-zero result code are dropped (as MentraOS does).
    public private(set) var rejected = 0
    /// Called for every dropped packet with a non-zero result code (packet, source), so the
    /// driver can log what the glasses refused instead of losing it silently.
    public var onRejected: ((RawPacket, String) -> Void)?

    public init() {}

    public func reset() { partial.removeAll() }

    public func push(_ raw: [UInt8], source: String = "") -> FramedMessage? {
        guard let p = parsePacket(raw) else { return nil }
        if p.resultCode != 0 {
            rejected += 1
            onRejected?(p, source)
            return nil
        }
        let key = "\(source)|\(p.service)|\(p.syncId)"
        if p.total <= 1 { return finish([p.chunk], p, source) }
        if p.serial == 1 {
            partial[key] = Partial(parts: [p.chunk], next: 2, total: p.total)
            return nil
        }
        guard var st = partial[key], st.next == p.serial, st.total == p.total else {
            partial[key] = nil
            return nil
        }
        st.parts.append(p.chunk)
        st.next += 1
        if !p.isLast {
            partial[key] = st
            return nil
        }
        partial[key] = nil
        return finish(st.parts, p, source)
    }

    private func finish(_ parts: [[UInt8]], _ last: RawPacket, _ source: String) -> FramedMessage {
        let payload = parts.flatMap { $0 }
        return FramedMessage(
            service: last.service, syncId: last.syncId, payload: payload,
            crcOk: last.crc.map { crc16(payload) == $0 }, source: source, status: last.status
        )
    }
}

/// One-byte rolling counter (sync id / magic random).
public final class Counter8 {
    private var v: UInt8
    public init(_ start: Int = 0) { v = UInt8(truncatingIfNeeded: start) }
    public func next() -> UInt8 {
        defer { v &+= 1 }
        return v
    }
}

public func hex<C: Collection>(_ b: C) -> String where C.Element == UInt8 {
    b.map { String(format: "%02x", $0) }.joined()
}

public func fromHex(_ s: String) -> [UInt8] {
    let clean = s.filter { !" \n\t:-".contains($0) }
    precondition(clean.count % 2 == 0, "odd hex length")
    var out: [UInt8] = []
    var i = clean.startIndex
    while i < clean.endIndex {
        let j = clean.index(i, offsetBy: 2)
        out.append(UInt8(clean[i..<j], radix: 16)!)
        i = j
    }
    return out
}

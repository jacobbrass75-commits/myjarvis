// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR.
// Check value: crc16("123456789") == 0x29B1.
//
// G2 computes it over the protobuf payload only (not the 8-byte header), concatenated across all
// fragments of a message, and appends it little-endian to the LAST fragment.
// Port of native/driver/src/crc.ts.

private let crcTable: [UInt16] = (0..<256).map { i -> UInt16 in
    var c = UInt16(i) << 8
    for _ in 0..<8 { c = (c & 0x8000) != 0 ? (c << 1) ^ 0x1021 : c << 1 }
    return c
}

public func crc16<C: Collection>(_ data: C, initial: UInt16 = 0xFFFF) -> UInt16 where C.Element == UInt8 {
    var crc = initial
    for b in data {
        crc = (crc << 8) ^ crcTable[Int(UInt8(truncatingIfNeeded: crc >> 8) ^ b)]
    }
    return crc
}

/// The byte-wise shift/xor formulation MentraOS uses (G2.kt `g2Crc16`). Kept so tests prove it is
/// the same CRC as the table version.
public func crc16Mentra<C: Collection>(_ data: C) -> UInt16 where C.Element == UInt8 {
    var crc: UInt16 = 0xFFFF
    for b in data {
        crc = ((crc >> 8) | (crc << 8)) ^ UInt16(b)
        crc ^= (crc & 0xFF) >> 4
        crc ^= crc << 12
        crc ^= (crc & 0xFF) << 5
    }
    return crc
}

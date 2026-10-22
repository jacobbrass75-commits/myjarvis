// Mic audio. After an EvenHub audioControl(true) (with a live page), each lens notifies on …6402
// with UNFRAMED packets: 5 x 40-byte LC3 frames (10 ms each, 16 kHz mono, 32 kbps) = 50 ms per
// notification. Some captures show a few trailing bytes (205 total); MentraOS takes the first 200.
// Both lenses may stream the same packet: MentraOS drops exact duplicates.
// Port of native/driver/src/audio.ts. The decoder itself is in LC3.swift (liblc3).

import Foundation

private let usableAudioBytes = AudioFormat.frameBytes * AudioFormat.framesPerPacket

/// Split one 6402 notification into LC3 frames. Returns [] for runts.
public func splitAudioPacket(_ data: [UInt8]) -> [[UInt8]] {
    let n = min(data.count, usableAudioBytes) / AudioFormat.frameBytes
    return (0..<n).map { Array(data[$0 * AudioFormat.frameBytes..<($0 + 1) * AudioFormat.frameBytes]) }
}

/// Trailer after the 200 LC3 bytes, if present (meaning unknown; the last byte looks like a counter).
public func audioTrailer(_ data: [UInt8]) -> [UInt8] {
    Array(data[min(data.count, usableAudioBytes)...])
}

public protocol Lc3Decoding: AnyObject {
    /// Decode one 40-byte frame to 160 s16 samples. `nil` = packet loss concealment.
    func decodeFrame(_ frame: [UInt8]?) -> [Int16]
}

/// Drops a packet identical to the previous one (both lenses can deliver the same audio).
public final class AudioDeduper {
    private var last: [UInt8]?
    public init() {}
    public func accept(_ data: [UInt8]) -> Bool {
        let usable = Array(data.prefix(usableAudioBytes))
        if usable.count < AudioFormat.frameBytes { return false }
        if usable == last { return false }
        last = usable
        return true
    }
}

/// Int16 samples -> s16le bytes (the format the hub expects on its audio WebSocket frames).
public func pcmToBytes(_ pcm: [Int16]) -> [UInt8] {
    var out = [UInt8]()
    out.reserveCapacity(pcm.count * 2)
    for s in pcm {
        let u = UInt16(bitPattern: s)
        out.append(UInt8(u & 0xFF))
        out.append(UInt8(u >> 8))
    }
    return out
}

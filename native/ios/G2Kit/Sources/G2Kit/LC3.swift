// LC3 decoding for the glasses' mic (16 kHz, 10 ms frames, 40 bytes each) with Google's reference
// liblc3 (Apache-2.0), vendored in Sources/CLiblc3. The Even App does the same on the phone and
// hands the WebView s16le PCM; we do it here so the page gets the same audioEvent.

import CLiblc3
import Foundation

public final class Liblc3Decoder: Lc3Decoding {
    private let mem: UnsafeMutableRawPointer
    private let decoder: lc3_decoder_t
    private let samples: Int

    public init?(frameUs: Int = AudioFormat.frameMs * 1000, sampleRate: Int = AudioFormat.sampleRate) {
        let size = Int(lc3_decoder_size(Int32(frameUs), Int32(sampleRate)))
        guard size > 0 else { return nil }
        mem = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 16)
        guard let d = lc3_setup_decoder(Int32(frameUs), Int32(sampleRate), 0, mem) else {
            mem.deallocate()
            return nil
        }
        decoder = d
        samples = Int(lc3_frame_samples(Int32(frameUs), Int32(sampleRate)))
    }

    deinit { mem.deallocate() }

    public func decodeFrame(_ frame: [UInt8]?) -> [Int16] {
        var pcm = [Int16](repeating: 0, count: samples)
        pcm.withUnsafeMutableBytes { out in
            if let frame {
                frame.withUnsafeBytes { inp in
                    _ = lc3_decode(decoder, inp.baseAddress, Int32(frame.count), LC3_PCM_FORMAT_S16, out.baseAddress, 1)
                }
            } else {
                // NULL input = packet loss concealment.
                _ = lc3_decode(decoder, nil, 0, LC3_PCM_FORMAT_S16, out.baseAddress, 1)
            }
        }
        return pcm
    }
}

/// Encoder, used only by self-tests (the glasses encode; we never send audio to them).
public final class Liblc3Encoder {
    private let mem: UnsafeMutableRawPointer
    private let encoder: lc3_encoder_t
    private let bytesPerFrame: Int

    public init?(bytesPerFrame: Int = AudioFormat.frameBytes, frameUs: Int = AudioFormat.frameMs * 1000, sampleRate: Int = AudioFormat.sampleRate) {
        let size = Int(lc3_encoder_size(Int32(frameUs), Int32(sampleRate)))
        guard size > 0 else { return nil }
        mem = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 16)
        guard let e = lc3_setup_encoder(Int32(frameUs), Int32(sampleRate), 0, mem) else {
            mem.deallocate()
            return nil
        }
        encoder = e
        self.bytesPerFrame = bytesPerFrame
    }

    deinit { mem.deallocate() }

    public func encode(_ pcm: [Int16]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: bytesPerFrame)
        pcm.withUnsafeBytes { inp in
            out.withUnsafeMutableBytes { o in
                _ = lc3_encode(encoder, LC3_PCM_FORMAT_S16, inp.baseAddress, 1, Int32(bytesPerFrame), o.baseAddress)
            }
        }
        return out
    }
}

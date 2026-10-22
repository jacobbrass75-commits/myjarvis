/**
 * LC3 decoding for the glasses' mic (16 kHz, 10 ms frames, 40 bytes each) using lc3codec
 * (pure JavaScript, BSD-3-Clause, https://github.com/xiaojsoft/lc3codec.js). Plugs into the
 * driver's `lc3` option so `startMic` delivers PCM.
 */
import { createRequire } from "node:module";
import type { Lc3Decoder } from "./driver/src/audio.ts";

const require = createRequire(import.meta.url);

export function createLc3Decoder(): Lc3Decoder {
  const LC3 = require("lc3codec");
  const dec = new LC3.Decoder.LC3Decoder(LC3.Core.LC3FrameDuration.NMS_10000US, LC3.Core.LC3SampleRate.FS_16000);
  const bec = new LC3.Decoder.LC3BEC();
  const frame: number[] = new Array(dec.getFrameSize());
  const out = new Int16Array(frame.length);
  return {
    decodeFrame(bytes: Uint8Array | null): Int16Array {
      if (!bytes) {
        out.fill(0); // simple concealment: silence for a lost frame
        return out.slice();
      }
      bec.reset?.();
      dec.decode(Buffer.from(bytes), bec, frame);
      for (let i = 0; i < frame.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(frame[i]!)));
      return out.slice();
    },
  };
}

/** Encoder, only for self-tests. */
export function createLc3Encoder(bytesPerFrame = 40) {
  const LC3 = require("lc3codec");
  const enc = new LC3.Encoder.LC3Encoder(LC3.Core.LC3FrameDuration.NMS_10000US, LC3.Core.LC3SampleRate.FS_16000);
  return (pcm: Int16Array) => {
    const out = Buffer.alloc(bytesPerFrame);
    enc.encode(Array.from(pcm), bytesPerFrame, out);
    return new Uint8Array(out);
  };
}

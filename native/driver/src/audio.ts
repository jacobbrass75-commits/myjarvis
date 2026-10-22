/**
 * Mic audio. After an EvenHub audioControl(true) (with a live page), each lens notifies on
 * …6402 with UNFRAMED packets: 5 x 40-byte LC3 frames (10 ms each, 16 kHz mono, 32 kbps) =
 * 50 ms of speech per notification. Some captures show a few trailing bytes (g2-kit: 205 bytes,
 * last byte = packet counter); MentraOS just takes the first 200 bytes. Both lenses may stream
 * the same packet: MentraOS drops exact duplicates.
 *
 * The Even App hands the WebView already-decoded PCM (s16le, 16 kHz). To do the same here you
 * need an LC3 decoder: pass anything implementing `Lc3Decoder`. `loadLiblc3Wasm` below binds the
 * reference liblc3 (google/liblc3, Apache-2.0) compiled to WebAssembly - NOT TESTED in this repo.
 */
import { readFile } from "node:fs/promises";
import { AUDIO } from "./constants.ts";

/** Split one 6402 notification into LC3 frames. Returns [] for runts. */
export function splitAudioPacket(data: Uint8Array): Uint8Array[] {
  const usable = Math.min(data.length, AUDIO.frameBytes * AUDIO.framesPerPacket);
  const n = Math.floor(usable / AUDIO.frameBytes);
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) out.push(data.subarray(i * AUDIO.frameBytes, (i + 1) * AUDIO.frameBytes));
  return out;
}

/** Trailer after the 200 LC3 bytes, if present (meaning not fully reversed; last byte looks like a counter). */
export function audioTrailer(data: Uint8Array): Uint8Array {
  return data.subarray(Math.min(data.length, AUDIO.frameBytes * AUDIO.framesPerPacket));
}

export interface Lc3Decoder {
  /** Decode one 40-byte frame to 160 s16 samples. `null` = packet loss concealment. */
  decodeFrame(frame: Uint8Array | null): Int16Array;
}

/** Drops a packet identical to the previous one (both lenses can deliver the same audio). */
export class AudioDeduper {
  private last: Uint8Array | null = null;
  accept(data: Uint8Array): boolean {
    const usable = data.subarray(0, Math.min(data.length, AUDIO.frameBytes * AUDIO.framesPerPacket));
    if (usable.length < AUDIO.frameBytes) return false;
    const l = this.last;
    if (l && l.length === usable.length && l.every((b, i) => b === usable[i])) return false;
    this.last = Uint8Array.from(usable);
    return true;
  }
}

/** Int16 samples -> s16le bytes (the format the hub expects on its audio WebSocket frames). */
export function pcmToBytes(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) v.setInt16(i * 2, pcm[i]!, true);
  return out;
}

interface Liblc3Exports {
  memory: WebAssembly.Memory;
  lc3_decoder_size(dtUs: number, srHz: number): number;
  lc3_setup_decoder(dtUs: number, srHz: number, srPcmHz: number, mem: number): number;
  lc3_decode(dec: number, inPtr: number, nbytes: number, fmt: number, pcmPtr: number, stride: number): number;
}

/**
 * Bind a liblc3 WebAssembly build that exports the C API from lc3.h plus `memory`
 * (e.g. `emcc -O2 src/*.c -Iinclude -sSTANDALONE_WASM --no-entry -sEXPORTED_FUNCTIONS=...`).
 * Untested here: no wasm is vendored and downloaded binaries were deliberately not executed.
 */
export async function loadLiblc3Wasm(path: string): Promise<Lc3Decoder> {
  const { instance } = await WebAssembly.instantiate(await readFile(path), {});
  const x = instance.exports as unknown as Liblc3Exports;
  const dt = AUDIO.frameMs * 1000;
  const sr = AUDIO.sampleRate;
  const size = x.lc3_decoder_size(dt, sr);
  const base = x.memory.buffer.byteLength;
  const need = size + AUDIO.samplesPerFrame * 2 + 64;
  x.memory.grow(Math.ceil(need / 65536));
  const decPtr = base;
  const pcmPtr = decPtr + size;
  const inPtr = pcmPtr + AUDIO.samplesPerFrame * 2;
  const dec = x.lc3_setup_decoder(dt, sr, sr, decPtr);
  if (!dec) throw new Error("lc3_setup_decoder failed");
  return {
    decodeFrame(frame) {
      if (frame) new Uint8Array(x.memory.buffer, inPtr, frame.length).set(frame);
      // fmt 0 = LC3_PCM_FORMAT_S16, stride 1 (mono)
      x.lc3_decode(dec, frame ? inPtr : 0, frame ? frame.length : 0, 0, pcmPtr, 1);
      return new Int16Array(x.memory.buffer.slice(pcmPtr, pcmPtr + AUDIO.samplesPerFrame * 2));
    },
  };
}

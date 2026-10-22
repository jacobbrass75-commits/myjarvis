// Simple energy-based voice activity detection and segmentation for 16-bit mono PCM.
// Speaker-agnostic: it only cuts the stream into utterances at pauses.

export interface VADOptions {
  sampleRate: number;
  /** Silence after speech that closes a segment. */
  silenceMs?: number;
  /** Segments are force-cut at this length (whisper works best on <30 s windows). */
  maxSegmentMs?: number;
  /** Audio kept before speech onset so the first syllable isn't clipped. */
  preRollMs?: number;
  /** Speech must last this long to count (filters clicks). */
  minSpeechMs?: number;
}

export type VADEvent =
  | { type: "start"; startSample: number }
  | { type: "end"; startSample: number; endSample: number; pcm: Buffer; forced: boolean };

export class EnergySegmenter {
  readonly sampleRate: number;
  private frame: number;
  private silenceFrames: number;
  private maxSamples: number;
  private preRollFrames: number;
  private minSpeechFrames: number;

  private noiseFloor = 0.003;
  private pos = 0; // samples consumed
  private carry = Buffer.alloc(0);
  private preRoll: Buffer[] = [];
  private seg: Buffer[] | null = null;
  private segStart = 0;
  private segSamples = 0;
  private speechFrames = 0;
  private quietFrames = 0;
  private started = false; // emitted "start" for the current candidate segment

  constructor(o: VADOptions) {
    this.sampleRate = o.sampleRate;
    this.frame = Math.round(o.sampleRate * 0.02);
    this.silenceFrames = Math.round((o.silenceMs ?? 600) / 20);
    this.maxSamples = Math.round(((o.maxSegmentMs ?? 15000) / 1000) * o.sampleRate);
    this.preRollFrames = Math.round((o.preRollMs ?? 200) / 20);
    this.minSpeechFrames = Math.max(1, Math.round((o.minSpeechMs ?? 120) / 20));
  }

  /** Samples consumed so far. */
  get samples(): number {
    return this.pos;
  }

  /** True while inside a (confirmed) speech segment. */
  get inSpeech(): boolean {
    return this.started;
  }

  /** PCM of the in-progress segment (for partial transcripts). */
  current(): Buffer | null {
    return this.started && this.seg ? Buffer.concat(this.seg) : null;
  }

  currentStart(): number {
    return this.segStart;
  }

  push(pcm: Buffer): VADEvent[] {
    const out: VADEvent[] = [];
    let buf = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    const fb = this.frame * 2;
    let off = 0;
    for (; off + fb <= buf.length; off += fb) {
      const f = buf.subarray(off, off + fb);
      this.frameIn(Buffer.from(f), out);
    }
    this.carry = Buffer.from(buf.subarray(off));
    return out;
  }

  /** Close any open segment (end of stream). */
  flush(): VADEvent[] {
    const out: VADEvent[] = [];
    if (this.carry.length >= 2) {
      const f = this.carry.subarray(0, this.carry.length - (this.carry.length % 2));
      this.carry = Buffer.alloc(0);
      this.frameIn(Buffer.from(f), out, true);
    }
    if (this.seg && this.started) out.push(this.close(false));
    this.seg = null;
    this.started = false;
    return out;
  }

  private rms(f: Buffer): number {
    let acc = 0;
    const n = f.length >> 1;
    for (let i = 0; i < n; i++) {
      const v = f.readInt16LE(i * 2) / 32768;
      acc += v * v;
    }
    return Math.sqrt(acc / Math.max(1, n));
  }

  private frameIn(f: Buffer, out: VADEvent[], last = false) {
    const n = f.length >> 1;
    const r = this.rms(f);
    const thresh = Math.max(0.008, this.noiseFloor * 3);
    const voiced = r > thresh;
    if (!voiced) {
      this.noiseFloor = r < this.noiseFloor ? this.noiseFloor * 0.9 + r * 0.1 : this.noiseFloor * 0.995 + r * 0.005;
    }

    if (!this.seg) {
      this.preRoll.push(f);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      if (voiced) {
        this.seg = [...this.preRoll];
        this.segSamples = this.preRoll.reduce((a, b) => a + (b.length >> 1), 0);
        this.segStart = this.pos + n - this.segSamples;
        this.preRoll = [];
        this.speechFrames = 1;
        this.quietFrames = 0;
        this.started = false;
      }
      this.pos += n;
      return;
    }

    this.seg.push(f);
    this.segSamples += n;
    this.pos += n;
    if (voiced) {
      this.speechFrames++;
      this.quietFrames = 0;
    } else {
      this.quietFrames++;
    }
    if (!this.started && this.speechFrames >= this.minSpeechFrames) {
      this.started = true;
      out.push({ type: "start", startSample: this.segStart });
    }
    if (!this.started && this.quietFrames >= this.minSpeechFrames * 2) {
      // A click, not speech: discard.
      this.seg = null;
      return;
    }
    if (this.started && this.quietFrames >= this.silenceFrames) {
      out.push(this.close(false));
    } else if (this.started && this.segSamples >= this.maxSamples && !last) {
      out.push(this.close(true));
    }
  }

  private close(forced: boolean): VADEvent {
    const pcm = Buffer.concat(this.seg!);
    const ev: VADEvent = { type: "end", startSample: this.segStart, endSample: this.segStart + (pcm.length >> 1), pcm, forced };
    if (forced) {
      // Continue the utterance in a fresh segment.
      this.seg = [];
      this.segStart = this.pos;
      this.segSamples = 0;
      this.speechFrames = this.minSpeechFrames;
      this.quietFrames = 0;
    } else {
      this.seg = null;
      this.started = false;
    }
    return ev;
  }
}

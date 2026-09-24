/**
 * audio/framing.ts - streaming re-framing and rate conversion. Promoted from spikes/openai/client.ts (made
 * isomorphic: Uint8Array instead of Buffer) so browser, server and scripts share one implementation.
 * `FrameBatcher` (AssemblyAI 50-1000 ms frames) lives in src/core/aai/streaming.ts.
 */
import { mulawEncode } from "./mulaw";
import { blackmanSinc } from "./resample";
import { clamp16 } from "./units";

/**
 * Integer-factor streaming decimator (zero-phase FIR, same taps as lowpassFir). Bit-identical to the batch path
 * `resampleLinear(x, fromRate, fromRate / factor)` for any chunking (the output may be ≤1 sample longer at flush).
 */
export class StreamingDecimator {
  private readonly h: Float64Array;
  private readonly half: number;
  private buf: Int16Array = new Int16Array(0);
  private base = 0; // absolute index of buf[0]
  private next = 0; // absolute input index of the next output sample
  private total = 0;
  readonly factor: number;

  constructor(factor: number, fromRate: number, taps = 63) {
    this.factor = factor;
    this.h = blackmanSinc(taps, (0.45 * (fromRate / factor)) / fromRate);
    this.half = (this.h.length - 1) / 2;
  }

  push(samples: Int16Array): Int16Array {
    const merged = new Int16Array(this.buf.length + samples.length);
    merged.set(this.buf);
    merged.set(samples, this.buf.length);
    this.buf = merged;
    this.total += samples.length;
    return this.drain(false);
  }

  flush(): Int16Array {
    return this.drain(true);
  }

  private drain(final: boolean): Int16Array {
    const out: number[] = [];
    const taps = this.h.length;
    while (this.next < this.total && (final || this.next + this.half < this.total)) {
      let acc = 0;
      const start = this.next - this.half;
      for (let k = 0; k < taps; k++) {
        const j = start + k;
        if (j >= 0 && j < this.total) acc += this.buf[j - this.base]! * this.h[k]!;
      }
      out.push(clamp16(acc));
      this.next += this.factor;
    }
    // keep only the history the next output still needs
    const keepFrom = Math.max(this.base, this.next - this.half);
    if (keepFrom > this.base) {
      this.buf = this.buf.slice(keepFrom - this.base);
      this.base = keepFrom;
    }
    return Int16Array.from(out);
  }
}

/** Streaming PCM16 24 kHz -> G.711 mu-law 8 kHz, for Twilio Media Streams (20 ms = 160 bytes). */
export class Pcm24kToMulaw8k {
  private readonly dec = new StreamingDecimator(3, 24_000);
  push(pcm24k: Int16Array): Uint8Array {
    return mulawEncode(this.dec.push(pcm24k));
  }
  flush(): Uint8Array {
    return mulawEncode(this.dec.flush());
  }
}

/** Re-frame an arbitrary byte stream into fixed-size frames (e.g. 160-byte mu-law frames, 2400-byte VA frames). */
export class ByteFramer {
  private carry: Uint8Array = new Uint8Array(0);
  readonly frameBytes: number;
  constructor(frameBytes: number) {
    if (!Number.isInteger(frameBytes) || frameBytes <= 0) throw new RangeError("ByteFramer: frameBytes must be a positive integer");
    this.frameBytes = frameBytes;
  }
  push(bytes: Uint8Array): Uint8Array[] {
    let buf: Uint8Array;
    if (this.carry.length) {
      buf = new Uint8Array(this.carry.length + bytes.length);
      buf.set(this.carry);
      buf.set(bytes, this.carry.length);
    } else {
      buf = bytes;
    }
    const frames: Uint8Array[] = [];
    let off = 0;
    for (; off + this.frameBytes <= buf.length; off += this.frameBytes) frames.push(buf.slice(off, off + this.frameBytes));
    this.carry = buf.slice(off);
    return frames;
  }
  /** The remainder (shorter than one frame), or null. */
  flush(): Uint8Array | null {
    const rest = this.carry;
    this.carry = new Uint8Array(0);
    return rest.length ? rest : null;
  }
  get pendingBytes(): number {
    return this.carry.length;
  }
}

/**
 * Keeps PCM16 byte streams sample-aligned: HTTP chunks of OpenAI TTS are often odd-length (10d t06), so the
 * odd trailing byte is carried into the next chunk. `unit` may be any even frame size.
 */
export class EvenByteAligner {
  private readonly framer: ByteFramer;
  constructor(unit = 2) {
    if (unit % 2 !== 0) throw new RangeError("EvenByteAligner: unit must be even");
    this.framer = new ByteFramer(unit);
  }
  /** Returns the aligned prefix of carry + bytes (possibly empty). */
  push(bytes: Uint8Array): Uint8Array {
    const frames = this.framer.push(bytes);
    if (frames.length === 0) return new Uint8Array(0);
    if (frames.length === 1) return frames[0]!;
    const out = new Uint8Array(frames.length * this.framer.frameBytes);
    frames.forEach((f, i) => out.set(f, i * this.framer.frameBytes));
    return out;
  }
  /** The even-length part of whatever is left (a dangling odd byte is dropped). */
  flush(): Uint8Array {
    const rest = this.framer.flush();
    if (!rest) return new Uint8Array(0);
    return rest.subarray(0, rest.length - (rest.length % 2));
  }
}

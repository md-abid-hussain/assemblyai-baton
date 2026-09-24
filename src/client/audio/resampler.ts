/**
 * resampler.ts - stateful streaming resampler for mic capture (device rate → 16/24 kHz PCM16), chunk-size
 * independent. Integer factors (48k → 24k/16k) use the core `StreamingDecimator` (FIR, bit-identical to the batch
 * path); other ratios (44.1k) use a 6th-order Butterworth low-pass at 0.42·target (three biquads) + linear
 * interpolation with a carried fractional position.
 */
import "client-only";

import { StreamingDecimator, clamp16, float32ToPcm16 } from "@/core/audio";

class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  constructor(fc: number, fs: number, q: number) {
    const w = (2 * Math.PI * fc) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = (1 - cos) / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

export class StreamingResampler {
  readonly fromRate: number;
  readonly toRate: number;
  private readonly decimator: StreamingDecimator | null;
  private readonly lp: Biquad[] | null;
  private readonly step: number;
  private pos = 0; // fractional read position relative to `prev` history
  private prev = 0;
  private hasPrev = false;

  constructor(fromRate: number, toRate: number) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    const factor = fromRate / toRate;
    this.decimator = Number.isInteger(factor) && factor > 1 ? new StreamingDecimator(factor, fromRate) : null;
    this.lp = !this.decimator && toRate < fromRate ? [0.5176, 0.7071, 1.9319].map((q) => new Biquad(0.42 * toRate, fromRate, q)) : null;
    this.step = fromRate / toRate;
  }

  /** Push device-rate Float32 samples; returns target-rate PCM16. */
  push(input: Float32Array): Int16Array {
    if (this.fromRate === this.toRate) return float32ToPcm16(input);
    if (this.decimator) return this.decimator.push(float32ToPcm16(input));
    const x = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let v = input[i]!;
      if (this.lp) for (const f of this.lp) v = f.step(v);
      x[i] = v;
    }
    // Virtual stream = [prev, ...x]; `pos` indexes it (0 = prev).
    const out: number[] = [];
    if (!this.hasPrev) {
      this.prev = x[0] ?? 0;
      this.hasPrev = true;
      this.pos = 0;
      // first sample of the stream is x[0] at virtual index 0 when there is no history: shift by one
      const tail = x.subarray(1);
      return this.interp(tail, out);
    }
    return this.interp(x, out);
  }

  private interp(x: Float32Array, out: number[]): Int16Array {
    const n = x.length; // virtual length = n + 1
    while (this.pos < n) {
      const i0 = Math.floor(this.pos);
      const a = i0 === 0 ? this.prev : x[i0 - 1]!;
      const b = x[i0]!;
      out.push(clamp16((a + (b - a) * (this.pos - i0)) * 32768));
      this.pos += this.step;
    }
    if (n > 0) {
      this.prev = x[n - 1]!;
      this.pos -= n;
    }
    return Int16Array.from(out);
  }
}

/** RMS (dBFS, floored at −120) of Float32 samples. */
export function float32Db(x: Float32Array): number {
  if (x.length === 0) return -120;
  let acc = 0;
  for (let i = 0; i < x.length; i++) acc += x[i]! * x[i]!;
  if (acc === 0) return -120;
  return Math.max(-120, 20 * Math.log10(Math.sqrt(acc / x.length)));
}

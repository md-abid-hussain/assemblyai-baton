/**
 * audio/resample.ts - windowed-sinc low-pass + linear-interpolation resampling (promoted verbatim from
 * spikes/lib/audio.ts; the Float32 variant is new for the playback path of DESIGN §5.1.2). Pure; isomorphic.
 */
import { deinterleave, interleave } from "./pcm";
import { clamp16 } from "./units";

/** Normalized Blackman-windowed sinc low-pass taps (`cutoffNorm` = cutoffHz / sampleRate). */
export function blackmanSinc(taps: number, cutoffNorm: number): Float64Array {
  if (taps % 2 === 0) taps += 1;
  const M = taps - 1;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const m = i - M / 2;
    const sinc = m === 0 ? 2 * Math.PI * cutoffNorm : Math.sin(2 * Math.PI * cutoffNorm * m) / m;
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / M) + 0.08 * Math.cos((4 * Math.PI * i) / M);
    h[i] = sinc * w;
    sum += h[i]!;
  }
  for (let i = 0; i < taps; i++) h[i] = h[i]! / sum;
  return h;
}

/** Windowed-sinc (Blackman) low-pass FIR, zero-phase-delay compensated. Mono. */
export function lowpassFir(input: Int16Array, sampleRate: number, cutoffHz: number, taps = 63): Int16Array {
  const h = blackmanSinc(taps, cutoffHz / sampleRate);
  const n = input.length;
  const out = new Int16Array(n);
  const half = (h.length - 1) / 2;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const start = i - half;
    for (let k = 0; k < h.length; k++) {
      const j = start + k;
      if (j >= 0 && j < n) acc += input[j]! * h[k]!;
    }
    out[i] = clamp16(acc);
  }
  return out;
}

export interface ResampleOptions {
  /** Low-pass at 0.45 * targetRate before downsampling (default true). Avoids aliasing, e.g. 24k -> 8k. */
  antiAlias?: boolean;
}

/** Linear-interpolation resampler (mono PCM16). Output length = floor(len * to / from). */
export function resampleLinear(input: Int16Array, fromRate: number, toRate: number, opts: ResampleOptions = {}): Int16Array {
  if (fromRate === toRate) return input.slice();
  const src = toRate < fromRate && (opts.antiAlias ?? true) ? lowpassFir(input, fromRate, 0.45 * toRate) : input;
  const outLen = Math.floor((src.length * toRate) / fromRate);
  const out = new Int16Array(outLen);
  const step = fromRate / toRate;
  const last = src.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = src[i0]!;
    const b = src[i0 + 1 > last ? last : i0 + 1]!;
    out[i] = clamp16(a + (b - a) * frac);
  }
  return out;
}

/** Resample interleaved multichannel PCM16. */
export function resampleInterleaved(samples: Int16Array, channels: number, fromRate: number, toRate: number, opts: ResampleOptions = {}): Int16Array {
  if (channels === 1) return resampleLinear(samples, fromRate, toRate, opts);
  return interleave(...deinterleave(samples, channels).map((c) => resampleLinear(c, fromRate, toRate, opts)));
}

/**
 * Linear-interpolation resampler for Float32 mono (e.g. decoded 8 kHz mu-law → the device rate for playback).
 * Downsampling low-passes first (same taps as lowpassFir) unless `antiAlias:false`.
 */
export function resampleLinearFloat32(input: Float32Array, fromRate: number, toRate: number, opts: ResampleOptions = {}): Float32Array {
  if (fromRate === toRate) return input.slice();
  let src = input;
  if (toRate < fromRate && (opts.antiAlias ?? true)) {
    const h = blackmanSinc(63, (0.45 * toRate) / fromRate);
    const half = (h.length - 1) / 2;
    src = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let acc = 0;
      for (let k = 0; k < h.length; k++) {
        const j = i - half + k;
        if (j >= 0 && j < input.length) acc += input[j]! * h[k]!;
      }
      src[i] = acc;
    }
  }
  const outLen = Math.floor((src.length * toRate) / fromRate);
  const out = new Float32Array(outLen);
  const step = fromRate / toRate;
  const last = src.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = src[i0]!;
    const b = src[i0 + 1 > last ? last : i0 + 1]!;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

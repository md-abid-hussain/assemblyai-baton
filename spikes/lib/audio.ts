/**
 * audio.ts - small, dependency-free PCM16 / G.711 mu-law utilities for voice pipelines.
 *
 * Conventions:
 *  - PCM16 audio is an Int16Array of samples; multichannel audio is interleaved (L R L R ...).
 *  - Wire format for AssemblyAI / OpenAI PCM is little-endian bytes: use pcm16ToBytes/bytesToPcm16.
 *  - "ms" is always milliseconds of *audio*, not wall-clock, unless named otherwise.
 */
import { setTimeout as sleep } from "node:timers/promises";

// ---------------------------------------------------------------------------------------------
// Byte <-> sample conversion
// ---------------------------------------------------------------------------------------------

/** Little-endian PCM16 bytes -> Int16Array (copies; safe for any byteOffset). */
export function bytesToPcm16(buf: Uint8Array): Int16Array {
  const n = buf.byteLength >> 1;
  const out = new Int16Array(n);
  const dv = new DataView(buf.buffer, buf.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

/** Int16Array -> little-endian PCM16 bytes. */
export function pcm16ToBytes(samples: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i]!, i * 2);
  return out;
}

export const pcm16ToBase64 = (samples: Int16Array): string => pcm16ToBytes(samples).toString("base64");
export const base64ToPcm16 = (b64: string): Int16Array => bytesToPcm16(Buffer.from(b64, "base64"));

/** Float [-1, 1] -> PCM16 (clamped). */
export function float32ToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** PCM16 -> float [-1, 1). */
export function pcm16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! / 0x8000;
  return out;
}

const clamp16 = (v: number): number => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v));

// ---------------------------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------------------------

export const msToFrames = (ms: number, sampleRate: number): number => Math.round((ms * sampleRate) / 1000);
export const framesToMs = (frames: number, sampleRate: number): number => (frames * 1000) / sampleRate;
/** Duration of an interleaved PCM16 array. */
export const durationMs = (samples: Int16Array, sampleRate: number, channels = 1): number =>
  framesToMs(samples.length / channels, sampleRate);
/** Bytes per millisecond for a given encoding (PCM16 = 2 bytes/sample, mu-law = 1). */
export const bytesPerMs = (sampleRate: number, bytesPerSample = 2, channels = 1): number =>
  (sampleRate * bytesPerSample * channels) / 1000;

// ---------------------------------------------------------------------------------------------
// Filtering & resampling
// ---------------------------------------------------------------------------------------------

/** Windowed-sinc (Blackman) low-pass FIR, zero-phase-delay compensated. Mono. */
export function lowpassFir(input: Int16Array, sampleRate: number, cutoffHz: number, taps = 63): Int16Array {
  if (taps % 2 === 0) taps += 1;
  const fc = cutoffHz / sampleRate;
  const M = taps - 1;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const m = i - M / 2;
    const sinc = m === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * m) / m;
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / M) + 0.08 * Math.cos((4 * Math.PI * i) / M);
    h[i] = sinc * w;
    sum += h[i]!;
  }
  for (let i = 0; i < taps; i++) h[i] = h[i]! / sum;
  const n = input.length;
  const out = new Int16Array(n);
  const half = M / 2;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const start = i - half;
    for (let k = 0; k < taps; k++) {
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

// ---------------------------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------------------------

/** Interleave N mono channels (shorter channels are zero-padded to the longest). */
export function interleave(...channels: Int16Array[]): Int16Array {
  const n = channels.length;
  if (n === 0) return new Int16Array(0);
  const frames = Math.max(...channels.map((c) => c.length));
  const out = new Int16Array(frames * n);
  for (let c = 0; c < n; c++) {
    const ch = channels[c]!;
    for (let i = 0; i < ch.length; i++) out[i * n + c] = ch[i]!;
  }
  return out;
}

/** Split interleaved PCM16 into N mono channels. */
export function deinterleave(samples: Int16Array, channels: number): Int16Array[] {
  const frames = Math.floor(samples.length / channels);
  const out = Array.from({ length: channels }, () => new Int16Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) out[c]![i] = samples[i * channels + c]!;
  return out;
}

/** Average all channels to mono. */
export function downmixToMono(samples: Int16Array, channels: number): Int16Array {
  if (channels === 1) return samples.slice();
  const frames = Math.floor(samples.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += samples[i * channels + c]!;
    out[i] = clamp16(acc / channels);
  }
  return out;
}

export function concatPcm16(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// G.711 mu-law (telephony, e.g. Twilio Media Streams: audio/x-mulaw 8 kHz mono)
// ---------------------------------------------------------------------------------------------

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export function mulawEncodeSample(pcm: number): number {
  let s = pcm | 0;
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const MULAW_DECODE_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const mag = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
    t[i] = sign ? -mag : mag;
  }
  return t;
})();

export const mulawDecodeSample = (byte: number): number => MULAW_DECODE_TABLE[byte & 0xff]!;

/** PCM16 -> mu-law bytes (1 byte per sample). */
export function mulawEncode(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = mulawEncodeSample(samples[i]!);
  return out;
}

/** mu-law bytes -> PCM16. */
export function mulawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = MULAW_DECODE_TABLE[bytes[i]!]!;
  return out;
}

/** mu-law byte value for digital silence. */
export const MULAW_SILENCE = 0xff;

// ---------------------------------------------------------------------------------------------
// Silence
// ---------------------------------------------------------------------------------------------

/** `ms` of PCM16 digital silence (interleaved if channels > 1). */
export const silencePcm16 = (ms: number, sampleRate: number, channels = 1): Int16Array =>
  new Int16Array(msToFrames(ms, sampleRate) * channels);

/** `ms` of mu-law silence (0xFF bytes). */
export const silenceMulaw = (ms: number, sampleRate = 8000): Uint8Array =>
  new Uint8Array(msToFrames(ms, sampleRate)).fill(MULAW_SILENCE);

export interface SilenceChunkOptions {
  encoding?: "pcm16" | "mulaw";
  channels?: number;
  /** Stop after this much audio (default: infinite). */
  totalMs?: number;
}

/**
 * Generator of silent wire-format chunks (bytes), e.g. to keep a stream fed while waiting.
 * Combine with `pace()` to emit at real time:  `for await (const c of pace(silenceChunks(50, 16000), 50)) ws.send(c.data)`
 */
export function* silenceChunks(chunkMs: number, sampleRate: number, opts: SilenceChunkOptions = {}): Generator<Uint8Array> {
  const enc = opts.encoding ?? "pcm16";
  const chunk =
    enc === "mulaw"
      ? silenceMulaw(chunkMs, sampleRate)
      : new Uint8Array(msToFrames(chunkMs, sampleRate) * (opts.channels ?? 1) * 2);
  const total = opts.totalMs ?? Infinity;
  for (let sent = 0; sent < total; sent += chunkMs) yield chunk.slice();
}

// ---------------------------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------------------------

export interface ChunkOptions {
  /** Zero-pad (or 0xFF-pad for mu-law) the last short chunk to full length (default false). */
  padLast?: boolean;
  /** Drop the last chunk if shorter than full length (default false). */
  dropLast?: boolean;
}

/** Split interleaved PCM16 into chunks of `chunkMs` (subarray views; last may be short). */
export function chunkPcm16(samples: Int16Array, sampleRate: number, chunkMs: number, channels = 1, opts: ChunkOptions = {}): Int16Array[] {
  const per = msToFrames(chunkMs, sampleRate) * channels;
  if (per <= 0) throw new Error("chunkPcm16: chunk size is 0");
  const out: Int16Array[] = [];
  for (let off = 0; off < samples.length; off += per) {
    let c = samples.subarray(off, off + per);
    if (c.length < per) {
      if (opts.dropLast) break;
      if (opts.padLast) {
        const p = new Int16Array(per);
        p.set(c);
        c = p;
      }
    }
    out.push(c);
  }
  return out;
}

/** Split wire bytes into chunks of `chunkMs` (PCM16: bytesPerSample=2; mu-law: 1). */
export function chunkBytes(bytes: Uint8Array, sampleRate: number, chunkMs: number, bytesPerSample = 2, channels = 1, opts: ChunkOptions = {}): Uint8Array[] {
  const per = msToFrames(chunkMs, sampleRate) * bytesPerSample * channels;
  if (per <= 0) throw new Error("chunkBytes: chunk size is 0");
  const out: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; off += per) {
    let c = bytes.subarray(off, off + per);
    if (c.length < per) {
      if (opts.dropLast) break;
      if (opts.padLast) {
        const p = new Uint8Array(per).fill(bytesPerSample === 1 ? MULAW_SILENCE : 0);
        p.set(c);
        c = p;
      }
    }
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Real-time pacing
// ---------------------------------------------------------------------------------------------

export interface PaceOptions {
  /** 1 = real time (default). 1.2 = 20% faster than real time. */
  speed?: number;
  /**
   * "end" (default): release a chunk once its audio would have been *recorded* (mic-like; never ahead
   * of the wall clock -> cannot trip Voice Agent `audio_rate_violation`). "start": release at the start
   * of its slot (one chunk ahead; first chunk immediately).
   */
  release?: "end" | "start";
  /** If the consumer falls behind by more than this, re-anchor the clock instead of bursting (default 250 ms). */
  resyncAfterLateMs?: number;
  signal?: AbortSignal;
}

export interface PacedChunk<T> {
  data: T;
  index: number;
  /** Audio position of this chunk's start (ms). */
  audioOffsetMs: number;
  /** Audio duration of this chunk (ms). */
  durationMs: number;
  /** Wall-clock ms since the pacer started, at release. */
  wallMs: number;
  /** How late the release was vs. schedule (ms, >= 0). */
  lateMs: number;
}

/**
 * Async generator that yields chunks at wall-clock pace. Drift-free: the schedule is absolute
 * (t0 + cumulative audio ms / speed), so timer jitter does not accumulate.
 */
export async function* pace<T>(
  chunks: Iterable<T> | AsyncIterable<T>,
  durationOf: number | ((chunk: T) => number),
  opts: PaceOptions = {},
): AsyncGenerator<PacedChunk<T>> {
  const speed = opts.speed ?? 1;
  const release = opts.release ?? "end";
  const resync = opts.resyncAfterLateMs ?? 250;
  const start = performance.now();
  let t0 = start;
  let audioMs = 0; // audio time already scheduled relative to t0
  let offset = 0; // total audio position
  let index = 0;
  for await (const c of chunks) {
    opts.signal?.throwIfAborted();
    const d = typeof durationOf === "number" ? durationOf : durationOf(c);
    const due = t0 + (release === "end" ? audioMs + d : audioMs) / speed;
    const wait = due - performance.now();
    if (wait > 0.5) await sleep(wait, undefined, opts.signal ? { signal: opts.signal } : undefined);
    const now = performance.now();
    const late = Math.max(0, now - due);
    if (late > resync) {
      t0 = now - (release === "end" ? audioMs + d : audioMs) / speed; // forgive the debt, no burst
    }
    yield { data: c, index: index++, audioOffsetMs: offset, durationMs: d, wallMs: now - start, lateMs: late };
    audioMs += d;
    offset += d;
  }
}

export interface PaceAudioOptions extends PaceOptions, ChunkOptions {
  sampleRate: number;
  chunkMs?: number;
  bytesPerSample?: number;
  channels?: number;
}

/** Chunk wire bytes (PCM16 or mu-law) and yield them at real-time pace. Default 50 ms chunks. */
export function paceAudio(bytes: Uint8Array, opts: PaceAudioOptions): AsyncGenerator<PacedChunk<Uint8Array>> {
  const chunkMs = opts.chunkMs ?? 50;
  const bps = opts.bytesPerSample ?? 2;
  const ch = opts.channels ?? 1;
  const chunks = chunkBytes(bytes, opts.sampleRate, chunkMs, bps, ch, opts);
  const perMs = bytesPerMs(opts.sampleRate, bps, ch);
  return pace(chunks, (c) => c.length / perMs, opts);
}

// ---------------------------------------------------------------------------------------------
// Levels & trimming
// ---------------------------------------------------------------------------------------------

/** RMS level in dBFS (-Infinity for digital silence). */
export function rmsDbfs(samples: Int16Array): number {
  if (samples.length === 0) return -Infinity;
  let acc = 0;
  for (let i = 0; i < samples.length; i++) acc += samples[i]! * samples[i]!;
  const rms = Math.sqrt(acc / samples.length);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms / 32768);
}

/** Peak level in dBFS. */
export function peakDbfs(samples: Int16Array): number {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > p) p = a;
  }
  return p === 0 ? -Infinity : 20 * Math.log10(p / 32768);
}

export interface TrimOptions {
  thresholdDb?: number;
  windowMs?: number;
  padMs?: number;
}

/** Trim leading/trailing near-silence from mono PCM16. Returns the trimmed view + frame offsets. */
export function trimSilence(samples: Int16Array, sampleRate: number, opts: TrimOptions = {}): { samples: Int16Array; start: number; end: number } {
  const thr = opts.thresholdDb ?? -45;
  const win = Math.max(1, msToFrames(opts.windowMs ?? 10, sampleRate));
  const pad = msToFrames(opts.padMs ?? 40, sampleRate);
  const loud = (i: number) => rmsDbfs(samples.subarray(i, Math.min(samples.length, i + win))) > thr;
  let s = 0;
  while (s < samples.length && !loud(s)) s += win;
  let e = samples.length;
  while (e > s && !loud(Math.max(0, e - win))) e -= win;
  if (s >= e) return { samples: samples.subarray(0, 0), start: 0, end: 0 };
  const start = Math.max(0, s - pad);
  const end = Math.min(samples.length, e + pad);
  return { samples: samples.subarray(start, end), start, end };
}

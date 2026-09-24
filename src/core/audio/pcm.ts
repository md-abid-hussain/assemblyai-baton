/**
 * audio/pcm.ts - PCM16 conversion, channels, silence, chunking, levels and trimming.
 * Promoted from spikes/lib/audio.ts with the DESIGN §3.2 fix: everything is isomorphic, `pcm16ToBytes` returns a
 * Uint8Array (not a Buffer) and base64 goes through audio/base64.ts. The real-time pacer is in audio/pace.ts.
 */
import { base64ToBytes, bytesToBase64 } from "./base64";
import { MULAW_SILENCE, silenceMulaw } from "./mulaw";
import { clamp16, msToFrames } from "./units";

// ---------------------------------------------------------------------------------------------
// Byte <-> sample conversion
// ---------------------------------------------------------------------------------------------

/** Little-endian PCM16 bytes -> Int16Array (copies; safe for any byteOffset; a trailing odd byte is ignored). */
export function bytesToPcm16(buf: Uint8Array): Int16Array {
  const n = buf.byteLength >> 1;
  const out = new Int16Array(n);
  const dv = new DataView(buf.buffer, buf.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

/** Int16Array -> little-endian PCM16 bytes. */
export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) dv.setInt16(i * 2, samples[i]!, true);
  return out;
}

export const pcm16ToBase64 = (samples: Int16Array): string => bytesToBase64(pcm16ToBytes(samples));
export const base64ToPcm16 = (b64: string): Int16Array => bytesToPcm16(base64ToBytes(b64));

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

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Silence
// ---------------------------------------------------------------------------------------------

/** `ms` of PCM16 digital silence (interleaved if channels > 1). */
export const silencePcm16 = (ms: number, sampleRate: number, channels = 1): Int16Array =>
  new Int16Array(msToFrames(ms, sampleRate) * channels);

/** `ms` of silence in wire bytes: 0x00 for PCM16, 0xFF for mu-law (DESIGN §5.1.4). */
export function silenceBytes(ms: number, sampleRate: number, encoding: "pcm16" | "mulaw"): Uint8Array {
  return encoding === "mulaw" ? silenceMulaw(ms, sampleRate) : new Uint8Array(msToFrames(ms, sampleRate) * 2);
}

export interface SilenceChunkOptions {
  encoding?: "pcm16" | "mulaw";
  channels?: number;
  /** Stop after this much audio (default: infinite). */
  totalMs?: number;
}

/** Generator of silent wire-format chunks (bytes), e.g. to keep a stream fed while waiting. */
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
  /** Analysis step in ms (default 10). Named `windowMs` in the spike. */
  stepMs?: number;
  padMs?: number;
}

/** Trim leading/trailing near-silence from mono PCM16. Returns the trimmed view + frame offsets. */
export function trimSilence(samples: Int16Array, sampleRate: number, opts: TrimOptions = {}): { samples: Int16Array; start: number; end: number } {
  const thr = opts.thresholdDb ?? -45;
  const step = Math.max(1, msToFrames(opts.stepMs ?? 10, sampleRate));
  const pad = msToFrames(opts.padMs ?? 40, sampleRate);
  const loud = (i: number) => rmsDbfs(samples.subarray(i, Math.min(samples.length, i + step))) > thr;
  let s = 0;
  while (s < samples.length && !loud(s)) s += step;
  let e = samples.length;
  while (e > s && !loud(Math.max(0, e - step))) e -= step;
  if (s >= e) return { samples: samples.subarray(0, 0), start: 0, end: 0 };
  const start = Math.max(0, s - pad);
  const end = Math.min(samples.length, e + pad);
  return { samples: samples.subarray(start, end), start, end };
}

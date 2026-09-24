/**
 * wav.ts - dependency-free WAV reader/writer plus the helpers the kit needs:
 * split a 2-channel recording into per-role mono 8 kHz PCM16 files and measure levels.
 *
 * Reads: PCM 16-bit, PCM 8-bit (unsigned), G.711 mu-law (tag 7), G.711 A-law (tag 6),
 *        WAVE_FORMAT_EXTENSIBLE wrapping any of those. Always returns interleaved PCM16.
 * Writes: PCM 16-bit little-endian, 44-byte header.
 */

export interface Wav {
  sampleRate: number;
  channels: number;
  /** WAVE format tag found in the file (1 PCM, 6 A-law, 7 mu-law). */
  formatTag: number;
  /** Bits per sample in the file (before conversion to PCM16). */
  sourceBits: number;
  /** Interleaved PCM16 samples. */
  samples: Int16Array;
  frames: number;
  durationS: number;
}

const FMT_PCM = 1;
const FMT_ALAW = 6;
const FMT_MULAW = 7;
const FMT_EXTENSIBLE = 0xfffe;

export const formatName = (tag: number, bits: number): string =>
  tag === FMT_PCM ? `pcm${bits}` : tag === FMT_MULAW ? "mulaw" : tag === FMT_ALAW ? "alaw" : `tag${tag}`;

// ------------------------------------------------------------------------------------------ G.711

export function mulawDecodeByte(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign ? -magnitude : magnitude;
}

export function mulawEncodeSample(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function alawDecodeByte(byte: number): number {
  const a = byte ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else {
    t += 0x108;
    if (seg > 1) t <<= seg - 1;
  }
  return a & 0x80 ? t : -t;
}

// ------------------------------------------------------------------------------------------ decode / encode

export function decodeWav(input: Uint8Array): Wav {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let off = 12;
  let fmt: { tag: number; channels: number; rate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (size === 0xffffffff || body + size > buf.length || (id === "data" && size === 0)) size = buf.length - body;
    if (id === "fmt ") {
      let tag = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (tag === FMT_EXTENSIBLE && size >= 26) tag = buf.readUInt16LE(body + 24);
      fmt = { tag, channels, rate, bits };
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
      break;
    }
    off = body + size + (size & 1);
  }
  if (!fmt) throw new Error("WAV has no fmt chunk");
  if (!data) throw new Error("WAV has no data chunk");
  if (fmt.channels < 1) throw new Error("WAV reports 0 channels");

  let samples: Int16Array;
  if (fmt.tag === FMT_PCM && fmt.bits === 16) {
    const n = data.length >> 1;
    samples = new Int16Array(n);
    for (let i = 0; i < n; i++) samples[i] = data.readInt16LE(i * 2);
  } else if (fmt.tag === FMT_PCM && fmt.bits === 8) {
    samples = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) samples[i] = (data[i]! - 128) << 8;
  } else if (fmt.tag === FMT_MULAW && fmt.bits === 8) {
    samples = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) samples[i] = mulawDecodeByte(data[i]!);
  } else if (fmt.tag === FMT_ALAW && fmt.bits === 8) {
    samples = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) samples[i] = alawDecodeByte(data[i]!);
  } else {
    throw new Error(`unsupported WAV encoding: format tag ${fmt.tag}, ${fmt.bits}-bit`);
  }
  const frames = Math.floor(samples.length / fmt.channels);
  if (frames * fmt.channels !== samples.length) samples = samples.subarray(0, frames * fmt.channels);
  return {
    sampleRate: fmt.rate,
    channels: fmt.channels,
    formatTag: fmt.tag,
    sourceBits: fmt.bits,
    samples,
    frames,
    durationS: frames / fmt.rate,
  };
}

export function encodeWavPcm16(samples: Int16Array, sampleRate: number, channels = 1): Buffer {
  if (!Number.isInteger(channels) || channels < 1) throw new Error("bad channel count");
  if (samples.length % channels !== 0) throw new Error("sample count not divisible by channel count");
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(FMT_PCM, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i]!, 44 + i * 2);
  return out;
}

// ------------------------------------------------------------------------------------------ channels / rate

export function deinterleave(samples: Int16Array, channels: number): Int16Array[] {
  const frames = Math.floor(samples.length / channels);
  const out = Array.from({ length: channels }, () => new Int16Array(frames));
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) out[c]![f] = samples[f * channels + c]!;
  return out;
}

export function interleave(chs: Int16Array[]): Int16Array {
  const n = chs.length;
  const frames = Math.min(...chs.map((c) => c.length));
  const out = new Int16Array(frames * n);
  for (let f = 0; f < frames; f++) for (let c = 0; c < n; c++) out[f * n + c] = chs[c]![f]!;
  return out;
}

/** Windowed-sinc (Blackman) low-pass, zero-phase. `cutoff` is a fraction of the sample rate (0..0.5). */
function lowpass(x: Int16Array, cutoff: number, taps = 63): Float64Array {
  const M = taps - 1;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const m = i - M / 2;
    const sinc = m === 0 ? 2 * Math.PI * cutoff : Math.sin(2 * Math.PI * cutoff * m) / m;
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / M) + 0.08 * Math.cos((4 * Math.PI * i) / M);
    h[i] = sinc * w;
    sum += h[i]!;
  }
  for (let i = 0; i < taps; i++) h[i]! /= sum;
  const y = new Float64Array(x.length);
  const half = M / 2;
  for (let n = 0; n < x.length; n++) {
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const idx = n + k - half;
      if (idx >= 0 && idx < x.length) acc += h[k]! * x[idx]!;
    }
    y[n] = acc;
  }
  return y;
}

/** Mono resample (anti-aliased when downsampling, linear interpolation). Identity when rates match. */
export function resample(x: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return x.slice();
  const src: ArrayLike<number> = to < from ? lowpass(x, (0.45 * to) / from) : x;
  const outLen = Math.floor((x.length * to) / from);
  const out = new Int16Array(outLen);
  const step = from / to;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, x.length - 1);
    const frac = pos - i0;
    const v = (src[i0] ?? 0) * (1 - frac) + (src[i1] ?? 0) * frac;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out;
}

// ------------------------------------------------------------------------------------------ level stats

export interface ChannelStats {
  rms_dbfs: number;
  peak_dbfs: number;
  /** Fraction of 20 ms frames above the speech threshold. */
  active_ratio: number;
  /** Seconds until the first active frame, null if never active. */
  first_active_s: number | null;
  /** Fraction of samples at (or within 1% of) full scale. */
  clipped_ratio: number;
}

export const SPEECH_THRESHOLD_DBFS = -42;
const FRAME_MS = 20;

const toDb = (v: number): number => (v <= 0 ? -120 : Math.max(-120, 20 * Math.log10(v / 32768)));
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function channelStats(x: Int16Array, sampleRate: number): { stats: ChannelStats; activity: Uint8Array } {
  const frameLen = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const nFrames = Math.floor(x.length / frameLen);
  const activity = new Uint8Array(nFrames);
  let sumSq = 0;
  let peak = 0;
  let clipped = 0;
  let firstActive: number | null = null;
  let active = 0;
  for (let f = 0; f < nFrames; f++) {
    let fs = 0;
    for (let i = f * frameLen; i < (f + 1) * frameLen; i++) {
      const v = x[i]!;
      fs += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= 32440) clipped++;
    }
    sumSq += fs;
    if (toDb(Math.sqrt(fs / frameLen)) > SPEECH_THRESHOLD_DBFS) {
      activity[f] = 1;
      active++;
      if (firstActive === null) firstActive = (f * frameLen) / sampleRate;
    }
  }
  const n = nFrames * frameLen || 1;
  return {
    stats: {
      rms_dbfs: round1(toDb(Math.sqrt(sumSq / n))),
      peak_dbfs: round1(toDb(peak)),
      active_ratio: round3(nFrames ? active / nFrames : 0),
      first_active_s: firstActive === null ? null : round1(firstActive),
      clipped_ratio: round3(clipped / n),
    },
    activity,
  };
}

/** Of the frames where anyone is talking, the fraction where both channels are active. */
export function overlapRatio(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let either = 0;
  let both = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] || b[i]) either++;
    if (a[i] && b[i]) both++;
  }
  return either ? round3(both / either) : 0;
}

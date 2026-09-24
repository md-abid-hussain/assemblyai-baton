/**
 * audio/wav-decode.ts - minimal RIFF/WAVE reader & writer for 16-bit PCM (mono or stereo) and 8-bit mu-law.
 * Promoted from spikes/lib/wav.ts, made isomorphic (DataView instead of Buffer; no filesystem access here:
 * readWav/writeWav live in scripts/lib/wav-fs.ts).
 *
 * - Reads WAVE_FORMAT_PCM (1) and WAVE_FORMAT_EXTENSIBLE (0xFFFE) with a PCM sub-format, 16-bit.
 * - Also reads G.711 mu-law WAVs (format 7, 8-bit) and decodes them to PCM16.
 * - Tolerates streaming-style headers whose RIFF/data sizes are 0 or 0xFFFFFFFF (clamps to the input size).
 * - Samples are always returned as an interleaved Int16Array (L R L R ... for stereo).
 */
import { mulawDecode } from "./mulaw";
import { bytesToPcm16, pcm16ToBytes } from "./pcm";

export interface WavData {
  sampleRate: number;
  channels: number;
  /** Bits per sample of the *returned* samples (always 16). */
  bitsPerSample: 16;
  /** WAVE format tag found in the file (1 = PCM, 7 = mu-law, 0xFFFE = extensible). */
  formatTag: number;
  /** Interleaved PCM16 samples. */
  samples: Int16Array;
  /** Sample frames (samples.length / channels). */
  frames: number;
  durationMs: number;
}

export const WAVE_FORMAT_PCM = 1;
export const WAVE_FORMAT_MULAW = 7;
export const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

const ascii = (b: Uint8Array, off: number, len: number): string => {
  let s = "";
  for (let i = off; i < off + len && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

/** Parse a WAV file from bytes. */
export function decodeWav(input: Uint8Array): WavData {
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const len = input.byteLength;
  if (len < 12 || ascii(input, 0, 4) !== "RIFF" || ascii(input, 8, 4) !== "WAVE") {
    throw new Error("decodeWav: not a RIFF/WAVE file");
  }
  let off = 12;
  let fmt: { tag: number; channels: number; rate: number; bits: number } | undefined;
  let data: Uint8Array | undefined;
  while (off + 8 <= len) {
    const id = ascii(input, off, 4);
    let size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (size === 0xffffffff || body + size > len || (id === "data" && size === 0)) size = len - body;
    if (id === "fmt ") {
      let tag = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true);
      const rate = dv.getUint32(body + 4, true);
      const bits = dv.getUint16(body + 14, true);
      if (tag === WAVE_FORMAT_EXTENSIBLE && size >= 26) tag = dv.getUint16(body + 24, true); // SubFormat GUID first 2 bytes
      fmt = { tag, channels, rate, bits };
    } else if (id === "data") {
      data = input.subarray(body, body + size);
      break;
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt) throw new Error("decodeWav: missing fmt chunk");
  if (!data) throw new Error("decodeWav: missing data chunk");
  let samples: Int16Array;
  if (fmt.tag === WAVE_FORMAT_PCM && fmt.bits === 16) {
    samples = bytesToPcm16(data);
  } else if (fmt.tag === WAVE_FORMAT_MULAW && fmt.bits === 8) {
    samples = mulawDecode(data);
  } else {
    throw new Error(`decodeWav: unsupported format tag=${fmt.tag} bits=${fmt.bits} (need PCM16 or mu-law)`);
  }
  // Drop a trailing partial frame, if any.
  const frames = Math.floor(samples.length / fmt.channels);
  if (frames * fmt.channels !== samples.length) samples = samples.subarray(0, frames * fmt.channels);
  return {
    sampleRate: fmt.rate,
    channels: fmt.channels,
    bitsPerSample: 16,
    formatTag: fmt.tag,
    samples,
    frames,
    durationMs: (frames / fmt.rate) * 1000,
  };
}

/** Build a 44-byte-header PCM16 WAV. `samples` must be interleaved if channels > 1. */
export function encodeWav(samples: Int16Array, sampleRate: number, channels = 1): Uint8Array {
  if (!Number.isInteger(channels) || channels < 1) throw new Error("encodeWav: bad channel count");
  if (samples.length % channels !== 0) throw new Error("encodeWav: sample count not divisible by channels");
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const dv = new DataView(out.buffer);
  const put = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  put(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  put(8, "WAVE");
  put(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, WAVE_FORMAT_PCM, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true); // byte rate
  dv.setUint16(32, channels * 2, true); // block align
  dv.setUint16(34, 16, true);
  put(36, "data");
  dv.setUint32(40, dataBytes, true);
  out.set(pcm16ToBytes(samples), 44);
  return out;
}

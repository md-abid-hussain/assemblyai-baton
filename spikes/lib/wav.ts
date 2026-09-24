/**
 * wav.ts - minimal, dependency-free RIFF/WAVE reader & writer for 16-bit PCM (mono or stereo).
 *
 * - Reads WAVE_FORMAT_PCM (1) and WAVE_FORMAT_EXTENSIBLE (0xFFFE) with a PCM sub-format, 16-bit.
 * - Also reads G.711 mu-law WAVs (format 7, 8-bit) and decodes them to PCM16.
 * - Tolerates streaming-style headers whose RIFF/data sizes are 0 or 0xFFFFFFFF (clamps to file size).
 * - Samples are always returned as an interleaved Int16Array (L R L R ... for stereo).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bytesToPcm16, mulawDecode, pcm16ToBytes } from "./audio.ts";

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

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_MULAW = 7;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export { bytesToPcm16, pcm16ToBytes };

/** Parse a WAV file from bytes. */
export function decodeWav(input: Uint8Array): WavData {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("decodeWav: not a RIFF/WAVE file");
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
      if (tag === WAVE_FORMAT_EXTENSIBLE && size >= 26) tag = buf.readUInt16LE(body + 24); // SubFormat GUID first 2 bytes
      fmt = { tag, channels, rate, bits };
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
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

/** Read a WAV file from disk. */
export function readWav(path: string): WavData {
  return decodeWav(readFileSync(path));
}

/** Build a 44-byte-header PCM16 WAV. `samples` must be interleaved if channels > 1. */
export function encodeWav(samples: Int16Array, sampleRate: number, channels = 1): Buffer {
  if (!Number.isInteger(channels) || channels < 1) throw new Error("encodeWav: bad channel count");
  if (samples.length % channels !== 0) throw new Error("encodeWav: sample count not divisible by channels");
  const dataBytes = samples.length * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  h.writeUInt16LE(channels * 2, 32); // block align
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([h, pcm16ToBytes(samples)]);
}

/** Write a PCM16 WAV to disk (creates parent directories). */
export function writeWav(path: string, samples: Int16Array, sampleRate: number, channels = 1): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodeWav(samples, sampleRate, channels));
}

/**
 * audio/mulaw.ts - G.711 mu-law (telephony: Twilio 8 kHz, AssemblyAI `pcm_mulaw`, Voice Agent `audio/pcmu`).
 * Promoted verbatim from spikes/lib/audio.ts. Pure; isomorphic.
 */
import { msToFrames } from "./units";

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** mu-law byte value for digital silence. */
export const MULAW_SILENCE = 0xff;

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

/** mu-law bytes -> Float32 in [-1, 1) (playback path, DESIGN §5.1.2). */
export function mulawDecodeToFloat32(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = MULAW_DECODE_TABLE[bytes[i]!]! / 0x8000;
  return out;
}

/** `ms` of mu-law silence (0xFF bytes). */
export const silenceMulaw = (ms: number, sampleRate = 8000): Uint8Array =>
  new Uint8Array(msToFrames(ms, sampleRate)).fill(MULAW_SILENCE);

/** G.711 A-law byte -> linear (Voice Agent `audio/pcma` level metering). */
export function alawDecodeSample(a: number): number {
  a ^= 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else t = (t + 0x108) << (seg - 1);
  return a & 0x80 ? t : -t;
}

/** A-law byte value for digital silence. */
export const ALAW_SILENCE = 0xd5;

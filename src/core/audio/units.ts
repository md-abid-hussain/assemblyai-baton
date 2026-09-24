/**
 * audio/units.ts - duration and sample-count helpers (promoted from spikes/lib/audio.ts). Pure; isomorphic.
 *
 * Conventions for all of src/core/audio:
 *  - PCM16 audio is an Int16Array of samples; multichannel audio is interleaved (L R L R ...).
 *  - Wire format for AssemblyAI / OpenAI PCM is little-endian bytes (Uint8Array): pcm16ToBytes / bytesToPcm16.
 *  - "ms" is always milliseconds of *audio*, not wall-clock, unless named otherwise.
 */

export const msToFrames = (ms: number, sampleRate: number): number => Math.round((ms * sampleRate) / 1000);
export const framesToMs = (frames: number, sampleRate: number): number => (frames * 1000) / sampleRate;

/** Duration of an interleaved PCM16 array. */
export const durationMs = (samples: Int16Array, sampleRate: number, channels = 1): number =>
  framesToMs(samples.length / channels, sampleRate);

/** Bytes per millisecond for a given encoding (PCM16 = 2 bytes/sample, mu-law = 1). */
export const bytesPerMs = (sampleRate: number, bytesPerSample = 2, channels = 1): number =>
  (sampleRate * bytesPerSample * channels) / 1000;

/** Round and clamp to the int16 range. */
export const clamp16 = (v: number): number => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v));

/** Byte size of one frame of `ms` audio (e.g. 50 ms PCM16 16 kHz = 1600 B; 100 ms mu-law 8 kHz = 800 B). */
export const frameBytesFor = (sampleRate: number, ms: number, bytesPerSample = 2, channels = 1): number =>
  msToFrames(ms, sampleRate) * bytesPerSample * channels;

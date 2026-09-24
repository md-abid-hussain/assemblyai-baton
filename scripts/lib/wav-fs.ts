/**
 * wav-fs.ts - filesystem WAV helpers for Node scripts (DESIGN §3.2: spikes/lib/wav.ts readWav/writeWav).
 * Decoding/encoding is the isomorphic src/core/audio/wav-decode.ts; this file only adds disk I/O.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { decodeWav, encodeWav, type WavData } from "../../src/core/audio/wav-decode";

export { decodeWav, encodeWav, type WavData };

/** Read and decode a WAV file (PCM16, mu-law and extensible formats, per decodeWav). */
export function readWav(path: string): WavData {
  return decodeWav(new Uint8Array(readFileSync(path)));
}

/** Write a PCM16 WAV (creates parent directories). `samples` must be interleaved if channels > 1. */
export function writeWav(path: string, samples: Int16Array, sampleRate: number, channels = 1): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodeWav(samples, sampleRate, channels));
}

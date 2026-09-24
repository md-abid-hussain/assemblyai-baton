/**
 * audio/pace.ts - real-time pacing of audio chunks (promoted from spikes/lib/audio.ts `pace`/`paceAudio`).
 *
 * DESIGN §3.2 moved these to a Node-only scripts/lib/pace.ts because the spike slept with a Node timers
 * import. This version sleeps with an isomorphic, abortable setTimeout wrapper, so it lives in src/core and
 * scripts/lib/pace.ts (WP0b) can simply re-export it. Browser realtime clocks still use worklet ticks (DESIGN §7.6);
 * this pacer is for Node scripts, tests and fixtures.
 */
import { chunkBytes, type ChunkOptions } from "./pcm";
import { bytesPerMs } from "./units";

/** Abortable sleep (rejects with `signal.reason` when aborted). */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PaceOptions {
  /** 1 = real time (default). 1.2 = 20% faster than real time. */
  speed?: number;
  /**
   * "end" (default): release a chunk once its audio would have been *recorded* (mic-like; never ahead of the
   * wall clock -> cannot trip Voice Agent `audio_rate_violation`). "start": release at the start of its slot
   * (one chunk ahead; first chunk immediately).
   */
  release?: "end" | "start";
  /** If the consumer falls behind by more than this, re-anchor the clock instead of bursting (default 250 ms). */
  resyncAfterLateMs?: number;
  signal?: AbortSignal;
  /** Clock source (default performance.now); injectable for tests. */
  now?: () => number;
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
  const clock = opts.now ?? (() => performance.now());
  const speed = opts.speed ?? 1;
  const release = opts.release ?? "end";
  const resync = opts.resyncAfterLateMs ?? 250;
  const start = clock();
  let t0 = start;
  let audioMs = 0; // audio time already scheduled relative to t0
  let offset = 0; // total audio position
  let index = 0;
  for await (const c of chunks) {
    opts.signal?.throwIfAborted();
    const d = typeof durationOf === "number" ? durationOf : durationOf(c);
    const due = t0 + (release === "end" ? audioMs + d : audioMs) / speed;
    const wait = due - clock();
    if (wait > 0.5) await sleepMs(wait, opts.signal);
    const now = clock();
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

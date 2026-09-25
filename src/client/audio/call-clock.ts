/**
 * call-clock.ts - maps the CallPlayer worklet's frame counter to the call clock and to the exact source-format bytes
 * "elapsed" since the last tick (DESIGN §5.1.4). Pure (no Web Audio), so it is unit-tested sample-exactly.
 *
 *   srcPos = floor(frame * srcRate / ctxRate)          samples of source audio elapsed since start(fromMs)
 *   bytes  = playing ? srcBytes[startSrc + lastPos … startSrc + srcPos] (padded with silence past the end)
 *                    : silence(srcPos − lastPos)
 *   callMs = srcPos / srcRate * 1000 + startOffsetMs
 *
 * Invariant: bytes handed out since start ⇔ (callMs − startOffsetMs) of audio, exactly. So a session's audio ms plus
 * its base offset IS the call clock (word times convert with callMs = word.start + sessionBaseMs).
 */
import "client-only";

import type { CallTick } from "@/core/contracts/services";

export interface CallFeedSource {
  srcRate: 8000 | 16000;
  /** 1 (µ-law) | 2 (PCM16 LE). */
  bytesPerSample: 1 | 2;
  /** 0xFF µ-law | 0x00 PCM16. */
  silenceByte: number;
  rep: Uint8Array;
  customer: Uint8Array;
}

export class CallFeedClock {
  private readonly src: CallFeedSource;
  private ctxRate: number;
  private startOffsetMs = 0;
  private startSrc = 0;
  private lastPos = 0;
  private _callMs = 0;
  private started = false;

  constructor(src: CallFeedSource, ctxRate: number) {
    this.src = src;
    this.ctxRate = ctxRate;
  }

  /** Total source samples of the longer channel. */
  get lengthSamples(): number {
    return Math.floor(Math.max(this.src.rep.byteLength, this.src.customer.byteLength) / this.src.bytesPerSample);
  }
  get durationMs(): number {
    return (this.lengthSamples / this.src.srcRate) * 1000;
  }
  get callMs(): number {
    return this._callMs;
  }
  get isStarted(): boolean {
    return this.started;
  }
  /** Source-sample index (absolute, into the channel arrays) the next tick's bytes start at. */
  get absPos(): number {
    return this.startSrc + this.lastPos;
  }

  /** Mirrors the worklet's `start {fromMs}`: frame 0 = source sample floor(fromMs · srcRate / 1000). */
  start(fromMs: number, ctxRate = this.ctxRate): void {
    this.ctxRate = ctxRate;
    this.startOffsetMs = Math.max(0, fromMs);
    this.startSrc = Math.floor((this.startOffsetMs * this.src.srcRate) / 1000);
    // callMs is defined by the sample actually used, so callMs(0) = startSrc / srcRate (never fractional drift).
    this.startOffsetMs = (this.startSrc / this.src.srcRate) * 1000;
    this.lastPos = 0;
    this._callMs = this.startOffsetMs;
    this.started = true;
  }

  get offsetMs(): number {
    return this.startOffsetMs;
  }

  /** One worklet tick → the CallTick (bytes elapsed since the previous tick, per channel). */
  tick(frame: number, playing: boolean): CallTick {
    const srcPos = Math.floor((frame * this.src.srcRate) / this.ctxRate);
    const from = this.lastPos;
    const to = Math.max(from, srcPos);
    const rep = this.slice(this.src.rep, from, to, playing);
    const customer = this.slice(this.src.customer, from, to, playing);
    this.lastPos = to;
    this._callMs = (to / this.src.srcRate) * 1000 + this.startOffsetMs;
    return { callMs: this._callMs, playing, rep, customer };
  }

  private slice(buf: Uint8Array, from: number, to: number, playing: boolean): Uint8Array {
    const bps = this.src.bytesPerSample;
    const n = (to - from) * bps;
    const out = new Uint8Array(n);
    if (!playing) {
      if (this.src.silenceByte !== 0) out.fill(this.src.silenceByte);
      return out;
    }
    const a = (this.startSrc + from) * bps;
    const b = Math.min(buf.byteLength, (this.startSrc + to) * bps);
    if (b > a) out.set(buf.subarray(a, b));
    const copied = Math.max(0, b - a);
    if (copied < n && this.src.silenceByte !== 0) out.fill(this.src.silenceByte, copied);
    return out;
  }
}

/** Decode source-format bytes to Float32 at the source rate (µ-law table / PCM16 ÷ 32768). */
export function decodeSourceToFloat32(bytes: Uint8Array, bytesPerSample: 1 | 2, mulawDecode: (b: Uint8Array) => Float32Array): Float32Array {
  if (bytesPerSample === 1) return mulawDecode(bytes);
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return out;
}

/** RMS level (dBFS, floored at −120 so it survives JSON) of a window of source-format audio. */
export function sourceWindowDb(bytes: Uint8Array, bytesPerSample: 1 | 2, fromSample: number, toSample: number, mulawSample: (b: number) => number): number {
  const a = Math.max(0, Math.floor(fromSample));
  const b = Math.min(Math.floor(bytes.byteLength / bytesPerSample), Math.floor(toSample));
  if (b <= a) return -120;
  let acc = 0;
  if (bytesPerSample === 1) {
    for (let i = a; i < b; i++) {
      const v = mulawSample(bytes[i]!);
      acc += v * v;
    }
  } else {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = a; i < b; i++) {
      const v = dv.getInt16(i * 2, true);
      acc += v * v;
    }
  }
  if (acc === 0) return -120;
  return Math.max(-120, 20 * Math.log10(Math.sqrt(acc / (b - a)) / 32768));
}

/**
 * va-output.ts - `VaOutputPlayer` (DESIGN §5.9.3) over the VA-output worklet (adaptive jitter ring buffer).
 *
 * `push(b64, replyId, audible)`: `audible` is the caller's `ReplyTracker` verdict for this chunk's reply
 * (`firstAudibleAtMs !== undefined` after observing it). While a reply is not yet audible its chunks are leading
 * silence (chunkLevelDb ≤ −50) and are DROPPED here [10a §15]; the first audible chunk of a reply carries the marker
 * that makes the worklet report `playedFirstAudible(replyId, ctxTime)` when its first sample is rendered.
 */
import "client-only";

import { base64ToPcm16, pcm16ToFloat32 } from "@/core/audio";
import type { VaOutputPlayer } from "@/core/contracts/services";
import type { PortLike } from "./call-player";

export interface VaOutputNode {
  readonly port: PortLike;
  disconnect(): void;
}

export interface VaOutputDeps {
  node: VaOutputNode;
  /** Volume gain after the worklet (null in tests). */
  gain: GainNode | null;
  /** For `setVolume` ramps. */
  now(): number;
}

export class VaOutput implements VaOutputPlayer {
  private readonly deps: VaOutputDeps;
  private readonly firstCbs = new Set<(replyId: string, ctxTimeMs: number) => void>();
  private readonly audibleReplies = new Set<string>();
  private _underruns = 0;
  /** Chunks dropped as leading silence (for the HUD / tests). */
  droppedLeading = 0;
  flushes = 0;
  startThresholdMs = 120;
  private disposed = false;

  constructor(deps: VaOutputDeps) {
    this.deps = deps;
    deps.node.port.onmessage = (ev) => this.onMessage(ev.data as { type: string; replyId?: string; ctxTime?: number; underruns?: number; startMs?: number });
  }

  get underruns(): number {
    return this._underruns;
  }

  private onMessage(m: { type: string; replyId?: string; ctxTime?: number; underruns?: number; startMs?: number }): void {
    if (m.type === "firstAudible" && m.replyId) {
      for (const cb of [...this.firstCbs]) cb(m.replyId, (m.ctxTime ?? 0) * 1000);
    } else if (m.type === "underrun") {
      this._underruns = m.underruns ?? this._underruns + 1;
      if (typeof m.startMs === "number") this.startThresholdMs = m.startMs;
    } else if (m.type === "flushed") {
      this.flushes++;
    }
  }

  push(b64Pcm24k: string, replyId: string, audible: boolean): void {
    if (this.disposed) return;
    if (!audible) {
      this.droppedLeading++;
      return;
    }
    const pcm = base64ToPcm16(b64Pcm24k);
    if (pcm.length === 0) return;
    const samples = pcm16ToFloat32(pcm);
    const firstAudible = !this.audibleReplies.has(replyId);
    if (firstAudible) this.audibleReplies.add(replyId);
    this.deps.node.port.postMessage({ type: "push", samples, replyId, firstAudible }, [samples.buffer]);
  }

  flush(): void {
    if (this.disposed) return;
    this.deps.node.port.postMessage({ type: "flush" });
  }

  holdUntil(ctxTimeMs: number): void {
    if (this.disposed) return;
    this.deps.node.port.postMessage({ type: "holdUntil", t: ctxTimeMs / 1000 });
  }

  onFirstAudiblePlayed(cb: (replyId: string, ctxTimeMs: number) => void): () => void {
    this.firstCbs.add(cb);
    return () => this.firstCbs.delete(cb);
  }

  setVolume(v: number): void {
    const g = this.deps.gain;
    if (!g) return;
    g.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.deps.now(), 0.02);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deps.node.port.postMessage({ type: "flush" });
    this.deps.node.port.onmessage = null;
    try {
      this.deps.node.disconnect();
      this.deps.gain?.disconnect();
    } catch {
      /* ignore */
    }
    this.firstCbs.clear();
  }
}

/**
 * "Slow network" signal (DESIGN §5.9.3): true when the Voice Agent socket's `bufferedAmount` holds more than ~1 s of
 * outgoing audio. 24 kHz PCM16 base64 ≈ 64 000 B/s of JSON; the threshold is configurable.
 */
export function slowUplink(bufferedAmount: number, bytesPerSecond = 64_000, thresholdS = 1): boolean {
  return bufferedAmount > bytesPerSecond * thresholdS;
}

/**
 * call-player.ts - `CallPlayback` over the CallPlayer worklet (DESIGN §5.1.2-§5.1.4, §5.1.1 handoff clip).
 *
 * The worklet renders the stereo mix and owns the clock; this side turns each 50 ms tick into a `CallTick` (exact
 * source-format bytes per channel, `CallFeedClock`) for the STT feed, and plays spans (evidence chips, the handoff
 * clip) as one-shot buffers at the context rate (never `createBuffer` at 8 kHz, §5.1.2 / §7.6).
 */
import "client-only";

import { mulawDecodeSample, mulawDecodeToFloat32, resampleLinearFloat32 } from "@/core/audio";
import type { Channel } from "@/core/contracts/case";
import type { CallManifestEntry } from "@/core/contracts/scenario";
import type { CallPlayback, CallTick } from "@/core/contracts/services";
import { CallFeedClock, decodeSourceToFloat32, sourceWindowDb } from "./call-clock";

/** The slice of a worklet node the player talks to (an AudioWorkletNode in the browser, a fake in tests). */
export interface PortLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
export interface CallPlayerNode {
  readonly port: PortLike;
  disconnect(): void;
}

/** The Web Audio surface the span player needs (an AudioContext in the browser). */
export interface SpanAudioContext {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly destination: AudioNode;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
}

export interface CallPlayerDeps {
  ctx: SpanAudioContext;
  node: CallPlayerNode;
  /** The duck gain between the worklet and the destination (null in tests). */
  duckGain: GainNode | null;
  format: CallManifestEntry["format"];
  srcBytes: { rep: Uint8Array; customer: Uint8Array };
}

/** Gap between the rep's handoff line and the customer's acceptance (DESIGN §5.1.1). */
export const HANDOFF_GAP_MS = 300;
/** Lead before a scheduled span starts, so the first samples are not clipped. */
const SPAN_LEAD_S = 0.03;

export class CallPlayer implements CallPlayback {
  private readonly deps: CallPlayerDeps;
  private readonly clock: CallFeedClock;
  private readonly srcRate: 8000 | 16000;
  private readonly bps: 1 | 2;
  private readonly decoded: { rep: Float32Array; customer: Float32Array };
  private readonly tickCbs = new Set<(t: CallTick) => void>();
  private readonly endedCbs = new Set<() => void>();
  private disposed = false;
  private hasEnded = false;
  /** Context time (s) of the last tick, and the frame it carried (for ctx ↔ call-clock mapping). */
  lastTickCtxTime = 0;
  lastTickFrame = 0;
  ticks = 0;

  constructor(deps: CallPlayerDeps) {
    this.deps = deps;
    this.srcRate = deps.format.sampleRate;
    this.bps = deps.format.encoding === "pcm_mulaw" ? 1 : 2;
    this.clock = new CallFeedClock(
      { srcRate: this.srcRate, bytesPerSample: this.bps, silenceByte: this.bps === 1 ? 0xff : 0, rep: deps.srcBytes.rep, customer: deps.srcBytes.customer },
      deps.ctx.sampleRate,
    );
    this.decoded = {
      rep: decodeSourceToFloat32(deps.srcBytes.rep, this.bps, mulawDecodeToFloat32),
      customer: decodeSourceToFloat32(deps.srcBytes.customer, this.bps, mulawDecodeToFloat32),
    };
    deps.node.port.onmessage = (ev) => this.onWorkletMessage(ev.data as { type: string; frame?: number; playing?: boolean; ctxTime?: number });
    // The worklet gets its own copies (the main thread keeps `decoded` for spans and energy).
    const rep = this.decoded.rep.slice();
    const customer = this.decoded.customer.slice();
    deps.node.port.postMessage({ type: "load", rep, customer, srcRate: this.srcRate }, [rep.buffer, customer.buffer]);
  }

  get durationMs(): number {
    return this.clock.durationMs;
  }
  get callMs(): number {
    return this.clock.callMs;
  }
  get startOffsetMs(): number {
    return this.clock.offsetMs;
  }
  get started(): boolean {
    return this.clock.isStarted;
  }

  private onWorkletMessage(m: { type: string; frame?: number; playing?: boolean; ctxTime?: number }): void {
    if (this.disposed) return;
    if (m.type === "tick" && typeof m.frame === "number") {
      if (!this.clock.isStarted) return;
      this.lastTickCtxTime = m.ctxTime ?? 0;
      this.lastTickFrame = m.frame;
      this.ticks++;
      const t = this.clock.tick(m.frame, m.playing === true);
      for (const cb of [...this.tickCbs]) cb(t);
    } else if (m.type === "ended") {
      if (this.hasEnded) return;
      this.hasEnded = true;
      for (const cb of [...this.endedCbs]) cb();
    }
  }

  start(fromMs: number): void {
    if (this.disposed) return;
    this.hasEnded = false;
    this.clock.start(fromMs, this.deps.ctx.sampleRate);
    // Send the SNAPPED offset so the worklet and the byte clock agree to the sample.
    this.deps.node.port.postMessage({ type: "start", fromMs: this.clock.offsetMs });
  }

  stop(fadeMs = 30): void {
    if (this.disposed) return;
    this.deps.node.port.postMessage({ type: "stop", fadeMs });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deps.node.port.postMessage({ type: "dispose" });
    this.deps.node.port.onmessage = null;
    try {
      this.deps.node.disconnect();
      this.deps.duckGain?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.tickCbs.clear();
    this.endedCbs.clear();
  }

  onTick(cb: (t: CallTick) => void): () => void {
    this.tickCbs.add(cb);
    return () => this.tickCbs.delete(cb);
  }
  onEnded(cb: () => void): () => void {
    this.endedCbs.add(cb);
    return () => this.endedCbs.delete(cb);
  }

  duck(level: number): void {
    const g = this.deps.duckGain;
    if (!g) return;
    const v = Math.max(0, Math.min(1, level));
    g.gain.setTargetAtTime(v, this.deps.ctx.currentTime, 0.05);
  }

  /** RMS of the channel over the last `windowMs` of the call clock (−120 when stopped or silent). */
  channelEnergyDb(ch: Channel, windowMs: number): number {
    if (!this.clock.isStarted) return -120;
    const bytes = ch === "rep" ? this.deps.srcBytes.rep : this.deps.srcBytes.customer;
    const end = (this.clock.callMs * this.srcRate) / 1000;
    const start = end - (windowMs * this.srcRate) / 1000;
    return sourceWindowDb(bytes, this.bps, start, end, mulawDecodeSample);
  }

  /** Build the context-rate buffer of a span (mono per channel; "both" = the stereo mix). */
  private spanBuffer(parts: { ch: Channel | "both"; fromMs: number; toMs: number }[], gapMs = 0): AudioBuffer | null {
    const ctx = this.deps.ctx;
    const rate = ctx.sampleRate;
    const pieces: { l: Float32Array; r: Float32Array }[] = [];
    for (const [i, p] of parts.entries()) {
      const a = Math.max(0, Math.floor((p.fromMs * this.srcRate) / 1000));
      const b = Math.max(a, Math.floor((p.toMs * this.srcRate) / 1000));
      const rep = resampleLinearFloat32(this.decoded.rep.subarray(a, Math.min(b, this.decoded.rep.length)), this.srcRate, rate);
      const cus = resampleLinearFloat32(this.decoded.customer.subarray(a, Math.min(b, this.decoded.customer.length)), this.srcRate, rate);
      const n = Math.max(p.ch === "customer" ? 0 : rep.length, p.ch === "rep" ? 0 : cus.length);
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const vr = p.ch === "customer" ? 0 : (rep[k] ?? 0);
        const vc = p.ch === "rep" ? 0 : (cus[k] ?? 0);
        l[k] = vr * 0.853 + vc * 0.522;
        r[k] = vr * 0.522 + vc * 0.853;
      }
      pieces.push({ l, r });
      if (gapMs > 0 && i < parts.length - 1) {
        const g = Math.round((gapMs * rate) / 1000);
        pieces.push({ l: new Float32Array(g), r: new Float32Array(g) });
      }
    }
    const total = pieces.reduce((s, p) => s + p.l.length, 0);
    if (total === 0) return null;
    const buf = ctx.createBuffer(2, total, rate);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    let off = 0;
    for (const p of pieces) {
      L.set(p.l, off);
      R.set(p.r, off);
      off += p.l.length;
    }
    return buf;
  }

  private schedule(buf: AudioBuffer): { startAt: number; endAt: number; done: Promise<void> } {
    const ctx = this.deps.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = ctx.currentTime + SPAN_LEAD_S;
    const endAt = startAt + buf.duration;
    const done = new Promise<void>((resolve) => {
      src.onended = () => {
        try {
          src.disconnect();
        } catch {
          /* ignore */
        }
        resolve();
      };
    });
    src.start(startAt);
    return { startAt, endAt, done };
  }

  async playSpan(ch: Channel | "both", fromMs: number, toMs: number): Promise<void> {
    const buf = this.spanBuffer([{ ch, fromMs, toMs }]);
    if (!buf) return;
    await this.schedule(buf).done;
  }

  /**
   * The early-pass handoff clip (DESIGN §5.1.1): the rep's line, 300 ms, then the customer's acceptance span.
   * Resolves as soon as it is SCHEDULED with `endCtxMs` = the context time (ms) the clip will end, so the caller can
   * `holdUntil` the Voice Agent's greeting behind it. Without an acceptance span only the rep line plays (the
   * labelled synthetic "Sure." is the caller's, via `AudioEngine.playPcm24k`).
   */
  async playHandoffClip(h: NonNullable<CallManifestEntry["handoff"]>): Promise<{ endCtxMs: number }> {
    const parts: { ch: Channel; fromMs: number; toMs: number }[] = [{ ch: "rep", fromMs: h.lineStartMs, toMs: h.lineEndMs }];
    if (h.acceptStartMs !== null && h.acceptEndMs !== null && h.acceptEndMs > h.acceptStartMs) {
      parts.push({ ch: "customer", fromMs: h.acceptStartMs, toMs: h.acceptEndMs });
    }
    const buf = this.spanBuffer(parts, HANDOFF_GAP_MS);
    if (!buf) return { endCtxMs: this.deps.ctx.currentTime * 1000 };
    const { endAt } = this.schedule(buf);
    return { endCtxMs: endAt * 1000 };
  }
}

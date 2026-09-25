/**
 * paced-feeder.ts - the Voice Agent input feeder (DESIGN §5.9.2): 24 kHz PCM16, 50 ms = 1200 samples = 2400 B
 * frames, paced by a worklet clock (never timers, §7.6). Sources in priority order: mic frames (mic mode), queued
 * clips (chips / typed / autopilot), silence. Nothing is sent before `start()` (the caller starts it on
 * `session.ready`).
 *
 * A frame is released when its audio has "elapsed" on the context clock (mic-like pacing), so `enqueueClip` resolves
 * with `endCtxMs` = the context time the clip's last real sample was due (the HUD's end-of-speech for a clip).
 */
import "client-only";

import { pcm16ToBytes } from "@/core/audio";
import type { MicSource, PacedFeeder } from "@/core/contracts/services";

export const FEED_RATE = 24_000;
export const FEED_FRAME_MS = 50;
export const FEED_FRAME_SAMPLES = (FEED_RATE * FEED_FRAME_MS) / 1000; // 1200
/** Cap the mic backlog so a stalled main thread never turns into seconds of latency. */
const MIC_MAX_BACKLOG_FRAMES = 4;

interface QueuedClip {
  pcm: Int16Array;
  off: number;
  resolve: (r: { endCtxMs: number }) => void;
}

/** Pure frame scheduler (unit-tested); the worklet clock calls `onClock`. */
export class FeederCore {
  private readonly clips: QueuedClip[] = [];
  private mic: Int16Array[] = [];
  private micSamples = 0;
  private micOn = false;
  private sent = 0;
  /** Frame of the clock node that is t = 0 of the feed (a fresh clock node per start → 0). */
  private originFrame = 0;
  framesSent = 0;
  micFrames = 0;
  clipFrames = 0;
  silenceFrames = 0;

  setMicActive(on: boolean): void {
    this.micOn = on;
    if (!on) {
      this.mic = [];
      this.micSamples = 0;
    }
  }

  pushMic(pcm: Int16Array): void {
    if (!this.micOn || pcm.length === 0) return;
    this.mic.push(pcm);
    this.micSamples += pcm.length;
    while (this.micSamples > FEED_FRAME_SAMPLES * MIC_MAX_BACKLOG_FRAMES && this.mic.length > 1) {
      this.micSamples -= this.mic.shift()!.length;
    }
  }

  enqueueClip(pcm: Int16Array): Promise<{ endCtxMs: number }> {
    return new Promise((resolve) => this.clips.push({ pcm, off: 0, resolve }));
  }

  /** Drop queued clips (each resolves with `endCtxMs = nowCtxMs`) and the mic backlog. */
  clear(nowCtxMs: number): void {
    for (const c of this.clips.splice(0)) c.resolve({ endCtxMs: nowCtxMs });
    this.mic = [];
    this.micSamples = 0;
  }

  /** Reset the pacing origin: `originFrame` of the clock is t = 0 of a new session (0 for a fresh clock node). */
  resetOrigin(originFrame = 0): void {
    this.originFrame = originFrame;
    this.sent = 0;
  }

  /**
   * Clock tick: returns the frames now due. `frame` = rendered frames of the clock node, `ctxRate` its sample rate,
   * `ctxTimeMs` the context time of the tick.
   */
  onClock(frame: number, ctxRate: number, ctxTimeMs: number): Uint8Array[] {
    const elapsedMs = ((frame - this.originFrame) / ctxRate) * 1000;
    const due = Math.floor(elapsedMs / FEED_FRAME_MS);
    const out: Uint8Array[] = [];
    while (this.sent < due) {
      this.sent++;
      // The frame being released covers audio ending at `frameEndMs` (ctx clock).
      const frameEndMs = ctxTimeMs - (due - this.sent) * FEED_FRAME_MS;
      out.push(pcm16ToBytes(this.nextFrame(frameEndMs)));
    }
    return out;
  }

  private nextFrame(frameEndMs: number): Int16Array {
    this.framesSent++;
    if (this.micOn && this.micSamples >= FEED_FRAME_SAMPLES) {
      this.micFrames++;
      return this.takeMic();
    }
    const clip = this.clips[0];
    if (clip) {
      const frame = new Int16Array(FEED_FRAME_SAMPLES);
      const n = Math.min(FEED_FRAME_SAMPLES, clip.pcm.length - clip.off);
      frame.set(clip.pcm.subarray(clip.off, clip.off + n));
      clip.off += n;
      this.clipFrames++;
      if (clip.off >= clip.pcm.length) {
        this.clips.shift();
        const padMs = ((FEED_FRAME_SAMPLES - n) / FEED_RATE) * 1000;
        clip.resolve({ endCtxMs: frameEndMs - padMs });
      }
      return frame;
    }
    this.silenceFrames++;
    return new Int16Array(FEED_FRAME_SAMPLES);
  }

  private takeMic(): Int16Array {
    const frame = new Int16Array(FEED_FRAME_SAMPLES);
    let filled = 0;
    while (filled < FEED_FRAME_SAMPLES && this.mic.length) {
      const head = this.mic[0]!;
      const k = Math.min(head.length, FEED_FRAME_SAMPLES - filled);
      frame.set(head.subarray(0, k), filled);
      filled += k;
      if (k === head.length) this.mic.shift();
      else this.mic[0] = head.subarray(k);
    }
    this.micSamples -= filled;
    return frame;
  }
}

export interface ClockNode {
  readonly port: { postMessage(m: unknown): void; onmessage: ((ev: { data: unknown }) => void) | null };
  disconnect(): void;
}

export interface PacedFeederDeps {
  /** Creates (and connects) a fresh clock worklet node; called by `start`. */
  createClock(): ClockNode;
  ctxRate: number;
}

export class WorkletPacedFeeder implements PacedFeeder {
  private readonly deps: PacedFeederDeps;
  readonly core = new FeederCore();
  private clock: ClockNode | null = null;
  private send: ((frame24k: Uint8Array) => void) | null = null;
  private unsubMic: (() => void) | null = null;
  private lastCtxMs = 0;

  constructor(deps: PacedFeederDeps) {
    this.deps = deps;
  }

  start(send: (frame24k: Uint8Array) => void): void {
    this.stop();
    this.send = send;
    this.core.resetOrigin();
    const clock = this.deps.createClock();
    clock.port.onmessage = (ev) => {
      const m = ev.data as { type: string; frame: number; ctxTime: number };
      if (m.type !== "tick" || !this.send) return;
      this.lastCtxMs = m.ctxTime * 1000;
      for (const f of this.core.onClock(m.frame, this.deps.ctxRate, this.lastCtxMs)) this.send(f);
    };
    this.clock = clock;
  }

  stop(): void {
    if (!this.clock) return;
    this.clock.port.postMessage({ type: "stop" });
    this.clock.port.onmessage = null;
    try {
      this.clock.disconnect();
    } catch {
      /* ignore */
    }
    this.clock = null;
    this.send = null;
  }

  enqueueClip(pcm24k: Int16Array): Promise<{ endCtxMs: number }> {
    return this.core.enqueueClip(pcm24k);
  }

  setMicSource(src: MicSource | null): void {
    this.unsubMic?.();
    this.unsubMic = null;
    this.core.setMicActive(src !== null);
    if (src) this.unsubMic = src.onFrame((pcm) => this.core.pushMic(pcm));
  }

  clear(): void {
    this.core.clear(this.lastCtxMs);
  }
}

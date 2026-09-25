/**
 * mic-capture.ts - `MicSource` (DESIGN §7.6 Firefox/getUserMedia rules; research 10b §browser capture):
 * `getUserMedia({audio:{echoCancellation:true, noiseSuppression:false, autoGainControl:true, channelCount:1}})`, the
 * context at the DEVICE rate (never a `sampleRate` option), the capture worklet posts ~20 ms Float32 batches, and a
 * stateful resampler turns them into 16/24 kHz PCM16 frames. Never feed one mic to two sockets (10 §3.4).
 */
import "client-only";

import type { MicSource } from "@/core/contracts/services";
import { float32Db, StreamingResampler } from "./resampler";

export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: true,
  channelCount: 1,
};

export interface MicCaptureDeps {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: { port: { postMessage(m: unknown): void; onmessage: ((ev: { data: unknown }) => void) | null }; disconnect(): void };
  sink: AudioNode | null;
  ctxRate: number;
  targetRate: 16000 | 24000;
  /** Called after stop (e.g. to switch the iOS audio session back to "playback"). */
  onStopped?: () => void;
}

export class MicCapture implements MicSource {
  private readonly deps: MicCaptureDeps;
  private readonly resampler: StreamingResampler;
  private readonly cbs = new Set<(pcm: Int16Array) => void>();
  private levelDb = -120;
  private stopped = false;
  framesIn = 0;
  samplesOut = 0;

  constructor(deps: MicCaptureDeps) {
    this.deps = deps;
    this.resampler = new StreamingResampler(deps.ctxRate, deps.targetRate);
    deps.node.port.onmessage = (ev) => {
      const m = ev.data as { type: string; samples?: Float32Array };
      if (m.type !== "pcm" || !m.samples || this.stopped) return;
      this.framesIn++;
      this.levelDb = float32Db(m.samples);
      const pcm = this.resampler.push(m.samples);
      if (pcm.length === 0) return;
      this.samplesOut += pcm.length;
      for (const cb of [...this.cbs]) cb(pcm);
    };
  }

  onFrame(cb: (pcm: Int16Array) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  energyDb(): number {
    return this.stopped ? -120 : this.levelDb;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.deps.node.port.postMessage({ type: "stop" });
    this.deps.node.port.onmessage = null;
    try {
      this.deps.source.disconnect();
      this.deps.node.disconnect();
      this.deps.sink?.disconnect();
    } catch {
      /* ignore */
    }
    for (const t of this.deps.stream.getTracks()) t.stop();
    this.cbs.clear();
    this.deps.onStopped?.();
  }
}

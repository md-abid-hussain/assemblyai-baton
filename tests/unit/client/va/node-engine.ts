/**
 * A Node stand-in for the browser AudioEngine pieces the Voice Agent controller uses (live integration tests):
 * - NodePacedFeeder: 50 ms / 2400 B frames at wall-clock pace (release-at-end, never faster than real time),
 *   silence when nothing is queued, `enqueueClip` resolves at the clip's last frame;
 * - NodePlayer: no sound; simulates the output worklet's timing (start once ≥120 ms is buffered or 200 ms after the
 *   first kept chunk, never before `holdUntil`) and reports first-audible-played per reply.
 * Clock = performance.now().
 */
import type { MicSource, PacedFeeder, VaOutputPlayer } from "../../../../src/core/contracts/services";

const now = () => performance.now();

export class NodePlayer implements VaOutputPlayer {
  underruns = 0;
  volume = 1;
  flushes = 0;
  private hold = 0;
  private cbs = new Set<(replyId: string, ctxTimeMs: number) => void>();
  private pending = new Map<string, { bufferedMs: number; firstAt: number; timer: ReturnType<typeof setTimeout> | null; fired: boolean }>();

  push(b64Pcm24k: string, replyId: string, audible: boolean): void {
    const ms = Math.floor((b64Pcm24k.length * 3) / 4) / 48;
    let p = this.pending.get(replyId);
    if (!p) {
      p = { bufferedMs: 0, firstAt: now(), timer: null, fired: false };
      this.pending.set(replyId, p);
    }
    p.bufferedMs += ms;
    if (p.fired || !audible) return;
    const startAt = Math.max(this.hold, p.bufferedMs >= 120 ? now() : p.firstAt + 200);
    if (p.timer) clearTimeout(p.timer);
    const pp = p;
    p.timer = setTimeout(() => {
      pp.fired = true;
      for (const cb of this.cbs) cb(replyId, now());
    }, Math.max(0, startAt - now()));
  }
  flush(): void {
    this.flushes++;
    for (const p of this.pending.values()) if (p.timer && !p.fired) clearTimeout(p.timer);
  }
  holdUntil(ctxTimeMs: number): void {
    this.hold = ctxTimeMs;
  }
  onFirstAudiblePlayed(cb: (replyId: string, ctxTimeMs: number) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  setVolume(v: number): void {
    this.volume = v;
  }
}

export class NodePacedFeeder implements PacedFeeder {
  private queue: { bytes: Uint8Array; off: number; resolve: (r: { endCtxMs: number }) => void }[] = [];
  private running = false;
  private send: ((f: Uint8Array) => void) | null = null;
  framesSent = 0;

  start(send: (frame24k: Uint8Array) => void): void {
    if (this.running) return;
    this.running = true;
    this.send = send;
    const t0 = now();
    let n = 0;
    const step = () => {
      if (!this.running) return;
      const head = this.queue[0];
      let frame = new Uint8Array(2400);
      if (head) {
        const end = Math.min(head.off + 2400, head.bytes.length);
        frame.set(head.bytes.subarray(head.off, end));
        head.off = end;
        if (head.off >= head.bytes.length) {
          this.queue.shift();
          head.resolve({ endCtxMs: now() });
        }
      } else frame = new Uint8Array(2400);
      this.send?.(frame);
      this.framesSent++;
      n++;
      const due = t0 + (n + 1) * 50;
      setTimeout(step, Math.max(0, due - now()));
    };
    setTimeout(step, 50);
  }
  stop(): void {
    this.running = false;
    for (const q of this.queue) q.resolve({ endCtxMs: now() });
    this.queue = [];
  }
  enqueueClip(pcm24k: Int16Array): Promise<{ endCtxMs: number }> {
    const bytes = new Uint8Array(pcm24k.buffer, pcm24k.byteOffset, pcm24k.byteLength);
    return new Promise((resolve) => this.queue.push({ bytes, off: 0, resolve }));
  }
  setMicSource(_src: MicSource | null): void {}
  clear(): void {
    this.queue = [];
  }
}

export class NodeEngine {
  players: NodePlayer[] = [];
  feeders: NodePacedFeeder[] = [];
  nowMs = (): number => now();
  createVaOutput = (): VaOutputPlayer => {
    const p = new NodePlayer();
    this.players.push(p);
    return p;
  };
  createFeeder = (): PacedFeeder => {
    const f = new NodePacedFeeder();
    this.feeders.push(f);
    return f;
  };
}

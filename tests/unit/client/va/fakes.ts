/**
 * In-memory fakes for the WP5b Voice Agent controller tests (unit) and the live Node tests (integration):
 * a WHATWG-style fake socket, a fake audio engine (clock, output player, paced feeder) and a recording sink.
 * No network, no credentials.
 */
import { bytesToBase64 } from "../../../../src/core/audio/base64";
import type { WebSocketLike } from "../../../../src/core/aai/voice-agent";
import type { BatonEvent } from "../../../../src/core/contracts/events";
import type { MicSource, PacedFeeder, VaOutputPlayer } from "../../../../src/core/contracts/services";

type Listener = (ev: never) => void;

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];
  readonly url: string;
  private listeners = new Map<string, Set<Listener>>();
  closeCalls: { code?: number; reason?: string }[] = [];
  /** Auto-answer session.end with session.ended (+ close), like the live server. */
  autoEnd = true;

  constructor(url = "wss://fake") {
    this.url = url;
  }

  addEventListener(type: string, fn: Listener): void {
    let s = this.listeners.get(type);
    if (!s) this.listeners.set(type, (s = new Set()));
    s.add(fn);
  }

  private fire(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) (fn as (e: unknown) => void)(ev);
  }

  open(): void {
    this.readyState = 1;
    this.fire("open", {});
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("fake socket not open");
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    if (msg.type === "session.end" && this.autoEnd) {
      queueMicrotask(() => {
        this.server({ type: "session.ended", session_duration_seconds: 12.5 });
      });
    }
  }

  close(code = 1000, reason = ""): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.fire("close", { code, reason }));
  }

  /** Server → client event. */
  server(ev: Record<string, unknown>): void {
    this.fire("message", { data: JSON.stringify(ev) });
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.fire("close", { code, reason });
  }

  /** Sent client events other than input.audio. */
  get control(): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type !== "input.audio");
  }

  types(): string[] {
    return this.control.map((m) => String(m.type));
  }
}

export class Clock {
  t = 0;
  now = (): number => this.t;
}

export class FakePlayer implements VaOutputPlayer {
  pushes: { replyId: string; audible: boolean; bytes: number }[] = [];
  flushes = 0;
  holdUntilMs = 0;
  volume = 1;
  underruns = 0;
  private cbs = new Set<(replyId: string, ctxTimeMs: number) => void>();
  private firedFor = new Set<string>();
  /** When true, the first audible push of a reply "plays" at max(now, holdUntil) synchronously. */
  autoPlay = true;
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  push(b64Pcm24k: string, replyId: string, audible: boolean): void {
    this.pushes.push({ replyId, audible, bytes: Math.floor((b64Pcm24k.length * 3) / 4) });
    if (this.autoPlay && audible && !this.firedFor.has(replyId)) this.playFirstAudible(replyId, Math.max(this.clock.t, this.holdUntilMs));
  }
  playFirstAudible(replyId: string, ctxMs: number): void {
    this.firedFor.add(replyId);
    for (const cb of this.cbs) cb(replyId, ctxMs);
  }
  flush(): void {
    this.flushes++;
  }
  holdUntil(ctxTimeMs: number): void {
    this.holdUntilMs = ctxTimeMs;
  }
  onFirstAudiblePlayed(cb: (replyId: string, ctxTimeMs: number) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  setVolume(v: number): void {
    this.volume = v;
  }
}

export class FakeFeeder implements PacedFeeder {
  send: ((frame24k: Uint8Array) => void) | null = null;
  started = 0;
  stopped = 0;
  clips: number[] = [];
  mic: MicSource | null = null;
  private readonly clock: Clock;
  constructor(clock: Clock) {
    this.clock = clock;
  }
  start(send: (frame24k: Uint8Array) => void): void {
    this.send = send;
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
  async enqueueClip(pcm24k: Int16Array): Promise<{ endCtxMs: number }> {
    this.clips.push(pcm24k.length);
    return { endCtxMs: this.clock.t + pcm24k.length / 24 };
  }
  setMicSource(src: MicSource | null): void {
    this.mic = src;
  }
  clear(): void {}
  /** Push one 50 ms silent frame through the controller's send. */
  tick(): void {
    this.send?.(new Uint8Array(2400));
  }
}

export class FakeEngine {
  readonly clock = new Clock();
  players: FakePlayer[] = [];
  feeders: FakeFeeder[] = [];
  nowMs = (): number => this.clock.t;
  createVaOutput = (): VaOutputPlayer => {
    const p = new FakePlayer(this.clock);
    this.players.push(p);
    return p;
  };
  createFeeder = (): PacedFeeder => {
    const f = new FakeFeeder(this.clock);
    this.feeders.push(f);
    return f;
  };
  get player(): FakePlayer {
    return this.players[this.players.length - 1]!;
  }
  get feeder(): FakeFeeder {
    return this.feeders[this.feeders.length - 1]!;
  }
}

export class RecordingSink {
  events: BatonEvent[] = [];
  emit(ev: BatonEvent): void {
    this.events.push(ev);
  }
  of<K extends BatonEvent["type"]>(type: K): Extract<BatonEvent, { type: K }>[] {
    return this.events.filter((e) => e.type === type) as Extract<BatonEvent, { type: K }>[];
  }
}

/** base64 PCM16 chunk (10 ms = 480 B) at a constant amplitude (0 = digital silence). */
export function pcmChunkB64(amplitude: number, ms = 10): string {
  const n = (24000 * ms) / 1000;
  const bytes = new Uint8Array(n * 2);
  const v = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, i % 2 === 0 ? amplitude : -amplitude, true);
  return bytesToBase64(bytes);
}

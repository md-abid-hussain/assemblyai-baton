/**
 * engine.ts - the one `AudioEngine` of the page (TASKS §2, DESIGN §5.1, §5.9.2-§5.9.3, §7.6).
 *
 * Rules it enforces:
 * - ONE AudioContext, created inside the first click handler (`getAudioEngine()` + `unlockSync()` in the handler),
 *   never with a `sampleRate` option (breaks Firefox AEC, garbles Safari). Resampling happens in JS / worklets.
 * - `unlockSync()` calls `ctx.resume()` and sets the iOS audio session to "playback" SYNCHRONOUSLY, before any await.
 *   Without `navigator.audioSession` (older iOS), a looping silent `<audio>` starts in the same gesture.
 * - Worklets load from ONE Blob URL (CSP `script-src blob:`, verified by /dev/csp), right at unlock, so the
 *   synchronous factories (`createVaOutput`, `createFeeder`) can hand out players whose nodes attach when ready.
 * - Every realtime clock (STT feed, VA feed) runs on worklet ticks, never timers.
 */
import "client-only";

import { resampleLinearFloat32, pcm16ToFloat32 } from "@/core/audio";
import type { CreateCaseResponse } from "@/core/contracts/api";
import type { CallManifestEntry } from "@/core/contracts/scenario";
import type { AudioEngine, CallPlayback, MicSource, PacedFeeder, VaOutputPlayer } from "@/core/contracts/services";
import { hasNavigatorAudioSession, setNavigatorAudioSession, startSilentAudioLoop, type AudioSessionKind } from "../platform/audio-session";
import { detectIOS } from "../platform/ios";
import { CallPlayer, type PortLike } from "./call-player";
import { MIC_CONSTRAINTS, MicCapture } from "./mic-capture";
import { WorkletPacedFeeder } from "./paced-feeder";
import { VaOutput } from "./va-output";
import { ALL_WORKLETS_SOURCE, CALL_PLAYER_PROCESSOR, CLOCK_PROCESSOR, MIC_CAPTURE_PROCESSOR, VA_OUTPUT_PROCESSOR } from "./worklets";

export interface AudioEngineOptions {
  /** Test seam / Safari prefix. */
  AudioContextCtor?: typeof AudioContext;
  fetchImpl?: typeof fetch;
  isIOS?: boolean;
}

/**
 * A node whose port buffers messages until the real AudioWorkletNode exists (worklet modules load asynchronously,
 * the factories of the AudioEngine contract are synchronous).
 */
export class LazyWorkletNode {
  private real: AudioWorkletNode | null = null;
  private readonly queue: { msg: unknown; transfer?: Transferable[] }[] = [];
  private handler: ((ev: { data: unknown }) => void) | null = null;
  private dead = false;
  private readonly extra: AudioNode[] = [];
  readonly port: PortLike;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.port = {
      postMessage(msg: unknown, transfer?: Transferable[]) {
        if (self.dead) return;
        if (self.real) self.real.port.postMessage(msg, transfer ?? []);
        else self.queue.push(transfer ? { msg, transfer } : { msg });
      },
      get onmessage() {
        return self.handler;
      },
      set onmessage(h: ((ev: { data: unknown }) => void) | null) {
        self.handler = h;
        if (self.real) self.real.port.onmessage = h ? (ev) => h(ev) : null;
      },
    };
  }

  attach(node: AudioWorkletNode, ...extra: AudioNode[]): void {
    if (this.dead) {
      node.disconnect();
      for (const n of extra) n.disconnect();
      return;
    }
    this.real = node;
    this.extra.push(...extra);
    const h = this.handler;
    node.port.onmessage = h ? (ev) => h(ev) : null;
    for (const q of this.queue.splice(0)) node.port.postMessage(q.msg, q.transfer ?? []);
  }

  get attached(): boolean {
    return this.real !== null;
  }

  disconnect(): void {
    this.dead = true;
    try {
      this.real?.disconnect();
      for (const n of this.extra) n.disconnect();
    } catch {
      /* ignore */
    }
  }
}

async function fetchBytes(url: string, fetchImpl: typeof fetch, onProgress?: (loaded: number) => void): Promise<Uint8Array> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`asset ${url}: HTTP ${res.status}`);
  if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
    onProgress(total);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export class BrowserAudioEngine implements AudioEngine {
  readonly ctx: AudioContext;
  readonly isIOS: boolean;
  private readonly fetchImpl: typeof fetch;
  private workletsReady: Promise<void> | null = null;
  private workletUrl: string | null = null;
  private sessionKind: AudioSessionKind = "playback";
  /** Diagnostics for /dev/audio and the notes. */
  readonly diag: { unlockCalls: number; audioSessionApi: boolean; silentLoop: boolean; workletError: string | null } = {
    unlockCalls: 0,
    audioSessionApi: false,
    silentLoop: false,
    workletError: null,
  };

  constructor(opts: AudioEngineOptions = {}) {
    const Ctor = opts.AudioContextCtor ?? (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("Web Audio is not available in this browser");
    // Never pass a sampleRate (DESIGN §7.6).
    this.ctx = new Ctor({ latencyHint: "interactive" });
    this.isIOS = opts.isIOS ?? detectIOS();
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  /** MUST run synchronously inside the click handler: resume + iOS "playback" session (+ worklet preload). */
  unlockSync(): void {
    this.diag.unlockCalls++;
    this.setAudioSession("playback");
    if (!this.diag.audioSessionApi && this.isIOS) this.diag.silentLoop = startSilentAudioLoop() !== null;
    if (this.ctx.state !== "running") void this.ctx.resume().catch(() => undefined);
    void this.ensureWorklets().catch(() => undefined);
  }

  /** Resolves true once the context runs; false after `timeoutMs` (→ the "Tap to enable sound" overlay). */
  async whenRunning(timeoutMs = 300): Promise<boolean> {
    if (this.ctx.state === "running") return true;
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(timer);
        this.ctx.removeEventListener("statechange", on);
        resolve(v);
      };
      const on = () => {
        if (this.ctx.state === "running") done(true);
      };
      const timer = setTimeout(() => done(this.ctx.state === "running"), timeoutMs);
      this.ctx.addEventListener("statechange", on);
    });
  }

  nowMs(): number {
    return this.ctx.currentTime * 1000;
  }

  setAudioSession(kind: AudioSessionKind): void {
    this.sessionKind = kind;
    this.diag.audioSessionApi = setNavigatorAudioSession(kind) || hasNavigatorAudioSession();
  }

  get audioSession(): AudioSessionKind {
    return this.sessionKind;
  }

  /** Loads every Baton processor once (one Blob URL). */
  ensureWorklets(): Promise<void> {
    if (!this.workletsReady) {
      if (!this.ctx.audioWorklet) {
        // AudioWorklet exists only in secure contexts (https or localhost): a LAN http URL on a phone has none.
        this.diag.workletError = "AudioWorklet unavailable (needs a secure context: https or localhost)";
        return Promise.reject(new Error(this.diag.workletError));
      }
      this.workletUrl = URL.createObjectURL(new Blob([ALL_WORKLETS_SOURCE], { type: "application/javascript" }));
      this.workletsReady = this.ctx.audioWorklet.addModule(this.workletUrl).catch((e: unknown) => {
        this.diag.workletError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        this.workletsReady = null;
        throw e;
      });
    }
    return this.workletsReady;
  }

  async loadCall(entry: CallManifestEntry, assets: CreateCaseResponse["assets"], onProgress?: (p: number) => void): Promise<CallPlayback> {
    const loaded = { rep: 0, customer: 0 };
    // Expected sizes from the duration (for progress only).
    const bps = entry.format.encoding === "pcm_mulaw" ? 1 : 2;
    const expected = Math.max(1, (entry.durationMs / 1000) * entry.format.sampleRate * bps * 2);
    const report = () => onProgress?.(Math.min(1, (loaded.rep + loaded.customer) / expected));
    const [rep, customer] = await Promise.all([
      fetchBytes(assets.rep, this.fetchImpl, onProgress ? (n) => ((loaded.rep = n), report()) : undefined),
      fetchBytes(assets.customer, this.fetchImpl, onProgress ? (n) => ((loaded.customer = n), report()) : undefined),
      this.ensureWorklets(),
    ]);
    onProgress?.(1);
    const real = new AudioWorkletNode(this.ctx, CALL_PLAYER_PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const duck = this.ctx.createGain();
    real.connect(duck).connect(this.ctx.destination);
    const node = new LazyWorkletNode();
    node.attach(real);
    return new CallPlayer({ ctx: this.ctx, node, duckGain: duck, format: entry.format, srcBytes: { rep, customer } });
  }

  createVaOutput(): VaOutputPlayer {
    const lazy = new LazyWorkletNode();
    const gain = this.ctx.createGain();
    gain.connect(this.ctx.destination);
    void this.ensureWorklets().then(() => {
      const node = new AudioWorkletNode(this.ctx, VA_OUTPUT_PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      node.connect(gain);
      lazy.attach(node);
    });
    return new VaOutput({ node: lazy, gain, now: () => this.ctx.currentTime });
  }

  /** A silent clock node (connected through a zero gain so the graph pulls it). */
  private createClockNode(): LazyWorkletNode {
    const lazy = new LazyWorkletNode();
    void this.ensureWorklets().then(() => {
      const node = new AudioWorkletNode(this.ctx, CLOCK_PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { tickMs: 50 } });
      const zero = this.ctx.createGain();
      zero.gain.value = 0;
      node.connect(zero).connect(this.ctx.destination);
      lazy.attach(node, zero);
    });
    return lazy;
  }

  createFeeder(): PacedFeeder {
    return new WorkletPacedFeeder({ createClock: () => this.createClockNode(), ctxRate: this.ctx.sampleRate });
  }

  async openMic(targetRate: 16000 | 24000): Promise<MicSource> {
    await this.ensureWorklets();
    this.setAudioSession("play-and-record");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
    } catch (e) {
      this.setAudioSession("playback");
      throw e;
    }
    const source = this.ctx.createMediaStreamSource(stream);
    const real = new AudioWorkletNode(this.ctx, MIC_CAPTURE_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const zero = this.ctx.createGain();
    zero.gain.value = 0;
    source.connect(real).connect(zero).connect(this.ctx.destination);
    const node = new LazyWorkletNode();
    node.attach(real);
    return new MicCapture({ stream, source, node, sink: zero, ctxRate: this.ctx.sampleRate, targetRate, onStopped: () => this.setAudioSession("playback") });
  }

  /** One-shot 24 kHz PCM16 clip (TTS chips, the synthetic "Sure."), resampled to the context rate. */
  playPcm24k(pcm: Int16Array, opts: { volume?: number } = {}): Promise<void> {
    if (pcm.length === 0) return Promise.resolve();
    const f = resampleLinearFloat32(pcm16ToFloat32(pcm), 24_000, this.ctx.sampleRate);
    const buf = this.ctx.createBuffer(1, f.length, this.ctx.sampleRate);
    buf.getChannelData(0).set(f);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = opts.volume ?? 1;
    src.connect(g).connect(this.ctx.destination);
    return new Promise((resolve) => {
      src.onended = () => {
        try {
          src.disconnect();
          g.disconnect();
        } catch {
          /* ignore */
        }
        resolve();
      };
      src.start();
    });
  }

  async close(): Promise<void> {
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
    await this.ctx.close().catch(() => undefined);
  }
}

let singleton: BrowserAudioEngine | null = null;

/**
 * The page's one engine. Call it (and `unlockSync()`) inside the first click handler; later calls return the same
 * instance. Never create an AudioContext anywhere else.
 */
export function getAudioEngine(opts: AudioEngineOptions = {}): BrowserAudioEngine {
  if (!singleton || singleton.ctx.state === "closed") singleton = new BrowserAudioEngine(opts);
  return singleton;
}

/** For tests and the dev page only. */
export function resetAudioEngineForTests(): void {
  singleton = null;
}

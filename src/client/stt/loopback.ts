/**
 * loopback.ts - a $0 stand-in for the two Streaming sessions, used by /dev/audio's "loopback" mode and browser
 * checks: it accepts exactly what a real session would (binary frames of 50..1000 ms, else the 3007 the server
 * would send), counts audio, and optionally emits the call's cached Turn messages as if they arrived live (so the
 * whole manager → CaseSync path runs without a token). Never used in production paths.
 */
import "client-only";

import type { BeginMessage, ErrorMessage, StreamingParams, TerminationMessage, TurnMessage, UpdateConfigurationPatch } from "@/core/aai/streaming";
import type { SessionReport, SttTokenRequest, SttTokenResponse } from "@/core/contracts/api";
import type { Channel } from "@/core/contracts/case";
import type { CachedTurnsFile } from "@/core/contracts/eval";
import type { SttApi } from "./api";
import type { SttConnect, SttSessionLike } from "./channel-manager";

type Fn = (ev: never) => void;

export class LoopbackSession implements SttSessionLike {
  readonly begin: BeginMessage;
  lastError: ErrorMessage | null = null;
  termination: TerminationMessage | null = null;
  isOpen = true;
  frames = 0;
  bytes = 0;
  rejected = 0;
  readonly updates: UpdateConfigurationPatch[] = [];
  private readonly ls = new Map<string, Set<Fn>>();
  private readonly bytesPerMs: number;
  private readonly script: { recvMs: number; message: Record<string, unknown> }[];
  private next = 0;
  private readonly base: number;

  constructor(params: StreamingParams, id: string, script: { recvMs: number; message: Record<string, unknown> }[] = [], baseCallMs = 0) {
    this.begin = { type: "Begin", id, expires_at: 0, configuration: { model: params.speech_model, mode: params.mode, loopback: true } };
    this.bytesPerMs = ((params.sample_rate ?? 16000) * (params.encoding === "pcm_mulaw" ? 1 : 2)) / 1000;
    this.script = script;
    this.base = baseCallMs;
  }
  get sessionId(): string {
    return this.begin.id;
  }
  get audioMs(): number {
    return this.bytes / this.bytesPerMs;
  }
  on(type: string, fn: Fn): () => void {
    let s = this.ls.get(type);
    if (!s) this.ls.set(type, (s = new Set()));
    s.add(fn);
    return () => s.delete(fn);
  }
  private fire(type: string, ev: unknown): void {
    for (const fn of [...(this.ls.get(type) ?? [])]) (fn as (e: unknown) => void)(ev);
  }
  sendAudio(chunk: Uint8Array): boolean {
    if (!this.isOpen) return false;
    const ms = chunk.byteLength / this.bytesPerMs;
    if (ms < 50 || ms > 1000) {
      this.rejected++;
      this.lastError = { error_code: 3007, error: `loopback: frame of ${ms.toFixed(1)} ms (server would close 3007)` };
      this.isOpen = false;
      this.fire("close", { code: 3007, reason: "See Error message for details" });
      return false;
    }
    this.frames++;
    this.bytes += chunk.byteLength;
    // Replay cached turns whose arrival (session clock) has been reached, shifted to this session's clock.
    const nowCall = this.base + this.audioMs;
    while (this.next < this.script.length && this.script[this.next]!.recvMs <= nowCall) {
      const m = this.script[this.next++]!.message as unknown as TurnMessage;
      this.fire("turn", { ...m, words: (m.words ?? []).map((w) => ({ ...w, start: w.start - this.base, end: w.end - this.base })) });
    }
    return true;
  }
  updateConfiguration(patch: UpdateConfigurationPatch): boolean {
    this.updates.push(patch);
    return this.isOpen;
  }
  forceEndpoint(): boolean {
    return this.isOpen;
  }
  async terminate(): Promise<TerminationMessage | null> {
    if (!this.isOpen) return this.termination;
    this.isOpen = false;
    this.termination = { type: "Termination", audio_duration_seconds: this.audioMs / 1000, session_duration_seconds: Math.ceil(this.audioMs / 1000) };
    this.fire("close", { code: 1000, reason: "" });
    return this.termination;
  }
  abort(): void {
    this.isOpen = false;
  }
}

/** A connect + API pair that never leaves the page. `cached` (optional) plays the call's cached turns "live". */
export function loopbackStt(params: Record<Channel, StreamingParams>, cached: CachedTurnsFile | null = null, startOffsetMs = 0): {
  api: SttApi;
  connect: SttConnect;
  sessions: LoopbackSession[];
  reports: SessionReport[];
} {
  const sessions: LoopbackSession[] = [];
  const reports: SessionReport[] = [];
  let n = 0;
  const api: SttApi = {
    token: async (req: SttTokenRequest): Promise<SttTokenResponse> => ({
      status: "granted",
      token: "loopback",
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
      params: params as never,
      sessionIds: req.n === 2 ? { rep: `lb-rep-${++n}`, customer: `lb-customer-${n}` } : { [req.channel ?? "rep"]: `lb-${req.channel}-${++n}` },
    }),
    cancel: async () => undefined,
    report: async (r) => {
      reports.push(r);
    },
  };
  const connect: SttConnect = async ({ channel, params: p }) => {
    const s = new LoopbackSession(p, `loopback-${channel}-${sessions.length + 1}`, (cached?.channels[channel] ?? []).filter((r) => r.recvMs >= startOffsetMs), startOffsetMs);
    sessions.push(s);
    return s;
  };
  return { api, connect, sessions, reports };
}

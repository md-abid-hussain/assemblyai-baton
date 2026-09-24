/**
 * channel-manager.ts - `SttChannelManager` (DESIGN §5.1.4-§5.1.9, §5.2, §7.6): two live Universal-3.5 Pro sessions,
 * one per call channel, fed from CallPlayer ticks; finals become TurnInputs for CaseSync.
 *
 * Clocks. Each session's audio is exactly the source bytes handed out by the call clock since its first frame, so
 * `callMs = word.start + base[ch]`, where `base[ch]` = the call ms of that session's first byte (the run's
 * `startOffsetMs` for the first session; the reconnect call ms for later ones = DESIGN's startOffsetMs +
 * reconnectOffsetMs). The feed offset (call ms elapsed − audio ms sent − ms pending in the batcher) is measured
 * on every tick and should stay 0.
 *
 * Lifecycle per channel: idle → queued → open → closed | cached | paused.
 * - Token: one n=2 grant opens both sessions; both connects start right after the grant (10 s window).
 * - `Begin.configuration` check: dev/CI → E_STT_INPUT + cached fallback; production → warn and continue.
 * - Retryable close (1006/1011/3005): ONE reconnect per channel (n=1, `reconnect:true`), generation g → turn ids
 *   `${ch}-${order}-r${g}`, customer re-seeded with the last rep final. Denied/failed → that channel goes cached.
 * - 3006 "inactivity" (a suspended iOS context) → "paused"; `resume()` reconnects through the offset path.
 * - 1008/3009 rate, 1008 auth, 3006/3007 input, balance → cached for that channel (with the error event).
 * - `agent_context` carry (§5.2): every rep final → customer `UpdateConfiguration{agent_context}` (clipped to the
 *   last 1750 chars by the client). Never to the Voice Agent.
 */
import "client-only";

import {
  FrameBatcher, isRetryableClose, sttCloseToErrorCode, StreamingSession, TurnTracker, type BeginMessage, type ErrorMessage,
  type StreamingParams, type TerminationMessage, type TurnMessage, type UpdateConfigurationPatch,
} from "@/core/aai/streaming";
import { bytesPerSampleOf, checkBeginConfiguration, sttFrameMs } from "@/core/aai/stt-params";
import type { SttTokenResponse } from "@/core/contracts/api";
import type { Channel, PolicyRecord } from "@/core/contracts/case";
import type { ErrorCode } from "@/core/contracts/errors";
import type { CallManifestEntry } from "@/core/contracts/scenario";
import type { CallTick, CaseSync, EventSink, SttChannelManager } from "@/core/contracts/services";
import { turnIdOf, type TurnInput } from "@/core/contracts/turns";
import type { CachedReplay } from "../replay/cached-replay";
import type { SttApi } from "./api";

export const CHANNELS: readonly Channel[] = ["rep", "customer"];
type ChannelStatus = SttChannelManager["status"][Channel];

/** The slice of `StreamingSession` the manager uses (a fake socket-backed session in tests). */
export interface SttSessionLike {
  readonly begin: BeginMessage;
  readonly sessionId: string | undefined;
  readonly isOpen: boolean;
  readonly lastError: ErrorMessage | null;
  readonly termination: TerminationMessage | null;
  on(type: "turn", fn: (m: TurnMessage) => void): () => void;
  on(type: "close", fn: (c: { code: number; reason: string }) => void): () => void;
  on(type: "error", fn: (e: ErrorMessage) => void): () => void;
  sendAudio(chunk: Uint8Array): boolean;
  updateConfiguration(patch: UpdateConfigurationPatch): boolean;
  forceEndpoint(): boolean;
  terminate(opts?: { timeoutMs?: number }): Promise<TerminationMessage | null>;
  abort(code?: number, reason?: string): void;
}

export type SttConnect = (o: { channel: Channel; token: string; params: StreamingParams; timeoutMs: number }) => Promise<SttSessionLike>;

/** The browser path: a temporary token, the global WebSocket, 8 s to Begin (DESIGN §5.1.6). */
export const browserConnect: SttConnect = async ({ token, params, timeoutMs }) =>
  (await StreamingSession.connect({ auth: { token }, params, connectTimeoutMs: timeoutMs })) as unknown as SttSessionLike;

export interface SttManagerOptions {
  api: SttApi;
  sink: EventSink;
  caseSync: Pick<CaseSync, "enqueue">;
  /** Event clock (ms since page session start). */
  now(): number;
  connect?: SttConnect;
  /** Labelled fallback (§5.1.10); without it a failed channel just closes. */
  cached?: CachedReplay | null;
  /** The takeover's view of the arm (late-turn flag, §5.1.7). */
  takeover?: () => { armed: boolean; tArmMs: number | null };
  /** true in dev/CI: a Begin mismatch is fatal (E_STT_INPUT); false in production: warn and continue. */
  strictBegin?: boolean;
  /** Wall clock for billed-seconds estimates (inactivity close has no Termination). */
  wallMs?: () => number;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
  connectTimeoutMs?: number;
  terminateTimeoutMs?: number;
  /** Queue polling fallback when the route does not say (ms). */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ChannelState {
  ch: Channel;
  status: ChannelStatus;
  session: SttSessionLike | null;
  /** Our live_sessions id (route #7). */
  liveId: string | null;
  tracker: TurnTracker;
  batcher: FrameBatcher;
  generation: number;
  /** Call ms of this session's first byte (null until the first tick after open). */
  base: number | null;
  sentBytes: number;
  reconnectsLeft: number;
  openedWallMs: number;
  offs: (() => void)[];
  closingByUs: boolean;
}

export interface SttMetrics {
  /** Max |call ms elapsed − (audio ms sent + ms pending in the batcher)| per channel since open. */
  maxFeedOffsetMs: Record<Channel, number>;
  framesSent: Record<Channel, number>;
  /** Final latency on the call clock: recvMs − endMs (last word end). */
  finalLatencyMs: Record<Channel, number[]>;
  finals: Record<Channel, number>;
  partials: Record<Channel, number>;
  beginChecks: { channel: Channel; ok: boolean; mismatches: string[] }[];
  closes: { channel: Channel; code: number; errorCode: ErrorCode | null; text: string | null; atCallMs: number }[];
  reconnects: { channel: Channel; atCallMs: number; ok: boolean }[];
  ctxUpdates: number;
  sessionIds: Partial<Record<Channel, string[]>>;
  billedSeconds: Partial<Record<Channel, number[]>>;
}

const emptyPair = <T>(f: () => T): Record<Channel, T> => ({ rep: f(), customer: f() });

export class LiveSttChannelManager implements SttChannelManager {
  private readonly o: SttManagerOptions;
  private readonly connectFn: SttConnect;
  private readonly chs: Record<Channel, ChannelState>;
  private call: CallManifestEntry | null = null;
  private runId = "";
  private caseId = "";
  private ctxCarry: "none" | "last_rep_turn" = "last_rep_turn";
  private params: Record<Channel, StreamingParams> | null = null;
  private lastRepFinal: string | null = null;
  private lastCallMs = 0;
  private ticket: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private finishWaiters: { atMs: number; resolve: () => void }[] = [];
  private disposed = false;
  readonly metrics: SttMetrics = {
    maxFeedOffsetMs: emptyPair(() => 0),
    framesSent: emptyPair(() => 0),
    finalLatencyMs: emptyPair(() => [] as number[]),
    finals: emptyPair(() => 0),
    partials: emptyPair(() => 0),
    beginChecks: [],
    closes: [],
    reconnects: [],
    ctxUpdates: 0,
    sessionIds: {},
    billedSeconds: {},
  };

  constructor(o: SttManagerOptions) {
    this.o = o;
    this.connectFn = o.connect ?? browserConnect;
    this.chs = {
      rep: this.freshChannel("rep"),
      customer: this.freshChannel("customer"),
    };
  }

  private freshChannel(ch: Channel): ChannelState {
    return {
      ch,
      status: "idle",
      session: null,
      liveId: null,
      tracker: new TurnTracker(),
      batcher: new FrameBatcher({ sampleRate: 16000, bytesPerSample: 2, targetMs: 50 }),
      generation: 0,
      base: null,
      sentBytes: 0,
      reconnectsLeft: 1,
      openedWallMs: 0,
      offs: [],
      closingByUs: false,
    };
  }

  get status(): Record<Channel, ChannelStatus> {
    return { rep: this.chs.rep.status, customer: this.chs.customer.status };
  }
  get callMs(): number {
    return this.lastCallMs;
  }
  /** Provider session ids (Begin.id) for the HUD's liveness proof. */
  get providerSessionIds(): Partial<Record<Channel, string>> {
    const out: Partial<Record<Channel, string>> = {};
    for (const ch of CHANNELS) {
      const id = this.chs[ch].session?.sessionId;
      if (id) out[ch] = id;
    }
    return out;
  }

  private log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
    this.o.log?.(level, msg, data);
  }
  private t(): number {
    return this.o.now();
  }
  private wall(): number {
    return this.o.wallMs ? this.o.wallMs() : Date.now();
  }
  private setStatus(ch: Channel, status: ChannelStatus, ev?: "queued" | "connecting" | "open" | "reconnecting" | "terminated" | "error", detail?: string): void {
    this.chs[ch].status = status;
    if (ev) this.o.sink.emit({ t: this.t(), type: "stt.status", channel: ch, status: ev, ...(detail ? { detail } : {}) });
  }

  // ------------------------------------------------------------------------------------------------ open

  async open(p: {
    caseId: string; caseToken: string; runId: string; call: CallManifestEntry; policy: PolicyRecord; startOffsetMs: number;
    ctxCarry: "none" | "last_rep_turn"; seedAgentContext?: string;
  }): Promise<"live" | "queued" | "denied"> {
    this.call = p.call;
    this.runId = p.runId;
    this.caseId = p.caseId;
    this.ctxCarry = p.ctxCarry;
    this.lastCallMs = p.startOffsetMs;
    if (p.seedAgentContext) this.lastRepFinal = p.seedAgentContext;
    for (const ch of CHANNELS) {
      const c = this.chs[ch];
      c.batcher = this.newBatcher();
      this.setStatus(ch, "queued", "connecting");
    }
    const resp = await this.o.api.token({ caseId: p.caseId, runId: p.runId, n: 2 });
    return this.onTokenResponse(resp, CHANNELS, false);
  }

  private newBatcher(): FrameBatcher {
    const f = this.call!.format;
    return new FrameBatcher({ sampleRate: f.sampleRate, bytesPerSample: bytesPerSampleOf(f), targetMs: sttFrameMs(f) });
  }

  private async onTokenResponse(resp: SttTokenResponse, chans: readonly Channel[], reconnect: boolean): Promise<"live" | "queued" | "denied"> {
    if (this.disposed) return "denied";
    if (resp.status === "granted") {
      this.ticket = null;
      this.params = { rep: resp.params.rep as StreamingParams, customer: resp.params.customer as StreamingParams };
      const results = await Promise.all(chans.map((ch) => this.connectChannel(ch, resp.token, resp.sessionIds[ch] ?? null, reconnect)));
      if (results.every((r) => r)) return "live";
      // strict Begin failure or a failed connect: every channel that is not live is cached now
      return results.some((r) => r) ? "live" : "denied";
    }
    if (resp.status === "queued") {
      this.ticket = resp.ticket;
      for (const ch of chans) this.setStatus(ch, "queued", "queued", `position ${resp.position}, ~${Math.round(resp.etaMs / 1000)} s`);
      this.schedulePoll(resp.pollMs, chans, reconnect);
      return "queued";
    }
    this.log("warn", "stt token denied", { code: resp.code });
    await this.toCached(chans, resp.code, resp.message);
    return "denied";
  }

  private schedulePoll(pollMs: number, chans: readonly Channel[], reconnect: boolean): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (this.disposed || !this.ticket) return;
      void this.o.api
        .token({ caseId: this.caseId, runId: this.runId, ...(chans.length === 1 ? { n: 1, channel: chans[0]! } : { n: 2 }), ticket: this.ticket, ...(reconnect ? { reconnect: true } : {}) })
        .then((r) => this.onTokenResponse(r, chans, reconnect));
    }, Math.max(250, pollMs || this.o.pollMs || 1000));
  }

  private async connectChannel(ch: Channel, token: string, liveId: string | null, reconnect: boolean): Promise<boolean> {
    const c = this.chs[ch];
    const base = this.params![ch];
    const seed = ch === "customer" && this.ctxCarry === "last_rep_turn" && this.lastRepFinal ? { agent_context: this.lastRepFinal } : {};
    const params: StreamingParams = { ...base, ...seed };
    c.liveId = liveId;
    let s: SttSessionLike;
    try {
      s = await this.connectFn({ channel: ch, token, params, timeoutMs: this.o.connectTimeoutMs ?? 8000 });
    } catch (e) {
      const code = (e as { errorCode?: ErrorCode }).errorCode ?? "E_STT_TRANSIENT";
      this.log("error", "stt connect failed", { channel: ch, code, message: e instanceof Error ? e.message : String(e) });
      if (liveId) void this.o.api.report({ sessionId: liveId, kind: "stt", event: "closed", billedSeconds: 0 });
      if (reconnect) this.metrics.reconnects.push({ channel: ch, atCallMs: this.lastCallMs, ok: false });
      await this.toCached([ch], code, `connect failed (${code})`);
      return false;
    }
    if (this.disposed) {
      void s.terminate({ timeoutMs: 3000 });
      return false;
    }
    const check = checkBeginConfiguration(s.begin);
    this.metrics.beginChecks.push({ channel: ch, ok: check.ok, mismatches: check.mismatches });
    if (!check.ok) {
      if (this.o.strictBegin) {
        this.log("error", "Begin check failed (strict)", { channel: ch, mismatches: check.mismatches });
        c.session = s;
        c.closingByUs = true;
        const term = await s.terminate({ timeoutMs: 3000 }).catch(() => null);
        if (liveId) void this.o.api.report({ sessionId: liveId, kind: "stt", event: "closed", ...(term ? { billedSeconds: term.session_duration_seconds } : {}) });
        c.session = null;
        this.o.sink.emit({ t: this.t(), type: "error", code: "E_STT_INPUT", message: `Begin check: ${check.mismatches.join("; ")}` });
        await this.toCached([ch], "E_STT_INPUT", "Begin check failed");
        return false;
      }
      this.log("warn", "Begin check mismatch (production: continuing)", { channel: ch, mismatches: check.mismatches });
    }
    // wire the session
    for (const off of c.offs.splice(0)) off();
    c.session = s;
    c.closingByUs = false;
    c.tracker = new TurnTracker();
    c.batcher = this.newBatcher();
    c.base = null;
    c.sentBytes = 0;
    c.openedWallMs = this.wall();
    if (reconnect) c.generation++;
    c.offs.push(s.on("turn", (m) => this.onTurn(ch, m)));
    c.offs.push(s.on("close", (e) => void this.onClose(ch, s, e.code)));
    (this.metrics.sessionIds[ch] ??= []).push(s.sessionId ?? "?");
    if (liveId) void this.o.api.report({ sessionId: liveId, kind: "stt", event: "opened", ...(s.sessionId ? { providerSessionId: s.sessionId } : {}) });
    if (reconnect) this.metrics.reconnects.push({ channel: ch, atCallMs: this.lastCallMs, ok: true });
    this.setStatus(ch, "open", "open", reconnect ? `reconnected at ${fmtClock(this.lastCallMs)}` : s.sessionId);
    return true;
  }

  // ------------------------------------------------------------------------------------------------ feed

  feed(t: CallTick): void {
    this.lastCallMs = t.callMs;
    this.o.cached?.onTick(t.callMs);
    if (!this.call) return;
    const bytesPerMs = (this.call.format.sampleRate * bytesPerSampleOf(this.call.format)) / 1000;
    for (const ch of CHANNELS) {
      const c = this.chs[ch];
      if (c.status !== "open" || !c.session) continue;
      const bytes = ch === "rep" ? t.rep : t.customer;
      if (c.base === null) c.base = t.callMs - bytes.byteLength / bytesPerMs;
      for (const frame of c.batcher.push(bytes)) {
        try {
          if (c.session.sendAudio(frame)) {
            c.sentBytes += frame.byteLength;
            this.metrics.framesSent[ch]++;
          }
        } catch (e) {
          // RangeError = a frame outside 50..1000 ms (would be 3007): a bug; never reaches the server.
          this.log("error", "sendAudio refused a frame", { channel: ch, message: e instanceof Error ? e.message : String(e) });
        }
      }
      const offset = Math.abs(t.callMs - c.base - (c.sentBytes + c.batcher.pendingBytes) / bytesPerMs);
      if (offset > this.metrics.maxFeedOffsetMs[ch]) this.metrics.maxFeedOffsetMs[ch] = offset;
    }
    if (this.finishWaiters.length) {
      const due = this.finishWaiters.filter((w) => t.callMs >= w.atMs);
      this.finishWaiters = this.finishWaiters.filter((w) => t.callMs < w.atMs);
      for (const w of due) w.resolve();
    }
  }

  // ------------------------------------------------------------------------------------------------ turns

  private onTurn(ch: Channel, m: TurnMessage): void {
    const c = this.chs[ch];
    if (c.status !== "open" && c.status !== "closed") return;
    const r = c.tracker.apply(m);
    if (r === "partial") {
      this.metrics.partials[ch]++;
      this.o.sink.emit({ t: this.t(), type: "stt.partial", channel: ch, turnOrder: m.turn_order, text: m.transcript });
      return;
    }
    if (r !== "final") return;
    const base = c.base ?? this.lastCallMs;
    const words = (m.words ?? []).map((w) => ({ text: w.text, startMs: w.start + base, endMs: w.end + base, confidence: w.confidence }));
    const recvMs = this.lastCallMs;
    const endMs = words.at(-1)?.endMs ?? recvMs;
    const tk = this.o.takeover?.();
    const turn: TurnInput = {
      caseId: this.caseId,
      turnId: turnIdOf(ch, m.turn_order, c.generation),
      channel: ch,
      text: m.transcript,
      startMs: words[0]?.startMs ?? recvMs,
      endMs,
      words,
      source: "stt_live",
      recvMs,
      cut: false,
      late: !!tk?.armed && tk.tArmMs !== null && endMs > tk.tArmMs,
    };
    this.metrics.finals[ch]++;
    this.metrics.finalLatencyMs[ch].push(recvMs - endMs);
    this.o.caseSync.enqueue(turn);
    this.o.sink.emit({ t: this.t(), type: "stt.final", turn });
    if (ch === "rep") {
      this.lastRepFinal = m.transcript;
      if (this.ctxCarry === "last_rep_turn") {
        const cus = this.chs.customer;
        if (cus.status === "open" && cus.session?.updateConfiguration({ agent_context: m.transcript })) this.metrics.ctxUpdates++;
      }
    }
  }

  hasOpenPartial(ch: Channel): boolean {
    const c = this.chs[ch];
    if (c.status === "cached") return this.o.cached?.hasOpenPartial(ch) ?? false;
    return c.status === "open" && c.tracker.hasOpenPartial();
  }

  /** Only ever while the channel is being fed silence (never mid-speech: WER +13.8%, 10b ST-8). */
  forceEndpoint(ch: Channel): void {
    const c = this.chs[ch];
    if (c.status === "open") c.session?.forceEndpoint();
  }

  // ------------------------------------------------------------------------------------------------ errors

  private async onClose(ch: Channel, s: SttSessionLike, code: number): Promise<void> {
    const c = this.chs[ch];
    if (c.session !== s) return; // a superseded session
    const text = s.lastError?.error ?? null;
    const errorCode = code === 1000 ? null : sttCloseToErrorCode(code, text);
    this.metrics.closes.push({ channel: ch, code, errorCode, text, atCallMs: this.lastCallMs });
    if (c.closingByUs) return;
    for (const off of c.offs.splice(0)) off();
    c.session = null;
    const billed = s.termination?.session_duration_seconds ?? (errorCode === "E_STT_INACTIVITY" ? (this.wall() - c.openedWallMs) / 1000 : undefined);
    if (billed !== undefined) (this.metrics.billedSeconds[ch] ??= []).push(billed);
    if (c.liveId) void this.o.api.report({ sessionId: c.liveId, kind: "stt", event: "closed", closeCode: code, ...(billed !== undefined ? { billedSeconds: billed } : {}), ...(s.sessionId ? { providerSessionId: s.sessionId } : {}) });
    this.log("warn", "stt session closed", { channel: ch, code, errorCode, text });
    if (errorCode === null) {
      this.setStatus(ch, "closed", "terminated");
      return;
    }
    if (errorCode === "E_STT_TRANSIENT" && isRetryableClose(code) && c.reconnectsLeft > 0) {
      c.reconnectsLeft--;
      this.setStatus(ch, "queued", "reconnecting", `close ${code}`);
      const resp = await this.o.api.token({ caseId: this.caseId, runId: this.runId, n: 1, channel: ch, reconnect: true });
      await this.onTokenResponse(resp, [ch], true);
      return;
    }
    if (errorCode === "E_STT_INACTIVITY") {
      this.setStatus(ch, "paused", "error", "paused (inactivity)");
      this.o.sink.emit({ t: this.t(), type: "paused", reason: "audio_interrupted", resumed: false });
      return;
    }
    this.o.sink.emit({ t: this.t(), type: "error", code: errorCode, message: `stt ${ch} closed ${code}${text ? `: ${text}` : ""}` });
    await this.toCached([ch], errorCode, `live transcription stopped (${errorCode})`);
  }

  private async toCached(chans: readonly Channel[], code: string, reason: string): Promise<void> {
    const cached = this.o.cached;
    for (const ch of chans) this.setStatus(ch, cached ? "cached" : "closed", "error", `${code}: ${reason}`);
    if (!cached) return;
    try {
      if (!cached.loaded) await cached.ensureLoaded();
      const partial = CHANNELS.some((c) => !chans.includes(c) && (this.chs[c].status === "open" || this.chs[c].status === "queued"));
      cached.activate(chans.length === 2 ? "both" : chans[0]!, this.lastCallMs, partial ? `partially cached (${reason})` : reason);
    } catch (e) {
      this.log("error", "cached replay unavailable", { message: e instanceof Error ? e.message : String(e) });
    }
  }

  // ------------------------------------------------------------------------------------------------ pause/resume/end

  /** iOS background (§7.6): stop feeding and terminate both sessions cleanly; `resume()` reconnects. */
  async pause(): Promise<void> {
    await Promise.all(
      CHANNELS.map(async (ch) => {
        const c = this.chs[ch];
        if (c.status !== "open" || !c.session) return;
        await this.closeSession(ch);
        this.setStatus(ch, "paused", "terminated", "paused");
      }),
    );
  }

  /** Reconnect every paused channel through the offset path (new generation, base = the current call ms). */
  async resume(): Promise<void> {
    const paused = CHANNELS.filter((ch) => this.chs[ch].status === "paused");
    if (paused.length === 0 || !this.call) return;
    for (const ch of paused) this.setStatus(ch, "queued", "reconnecting", "resume");
    const req = paused.length === 2 ? { n: 2 as const } : { n: 1 as const, channel: paused[0]! };
    const resp = await this.o.api.token({ caseId: this.caseId, runId: this.runId, ...req, reconnect: true });
    await this.onTokenResponse(resp, paused, true);
  }

  private async closeSession(ch: Channel): Promise<number | null> {
    const c = this.chs[ch];
    const s = c.session;
    if (!s) return null;
    c.closingByUs = true;
    // Flush the batcher remainder (padded to ≥ 50 ms with silence; a shorter frame would be 3007).
    const rest = c.batcher.flush(true);
    if (rest && s.isOpen) {
      try {
        s.sendAudio(rest);
      } catch {
        /* ignore */
      }
    }
    const term = await s.terminate({ timeoutMs: this.o.terminateTimeoutMs ?? 3000 }).catch(() => null);
    for (const off of c.offs.splice(0)) off();
    c.session = null;
    const billed = term?.session_duration_seconds ?? null;
    if (billed !== null) (this.metrics.billedSeconds[ch] ??= []).push(billed);
    if (c.liveId) void this.o.api.report({ sessionId: c.liveId, kind: "stt", event: "closed", ...(billed !== null ? { billedSeconds: billed } : {}), ...(s.sessionId ? { providerSessionId: s.sessionId } : {}) });
    return billed;
  }

  /**
   * End of recording (§5.1.8): keep feeding (the CallPlayer ticks silence after `ended`) until `silenceMs` more call
   * time has passed, so the last turn finalizes (~0.3 s after its last word, 10b ST-14); then terminate both.
   */
  finishAfterSilence(silenceMs = 1500): Promise<{ channel: Channel; billedSeconds: number | null }[]> {
    const atMs = this.lastCallMs + silenceMs;
    return new Promise<void>((resolve) => this.finishWaiters.push({ atMs, resolve })).then(() => this.terminateAll());
  }

  async terminateAll(): Promise<{ channel: Channel; billedSeconds: number | null }[]> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ticket) {
      const t = this.ticket;
      this.ticket = null;
      await this.o.api.cancel(t);
    }
    const out = await Promise.all(
      CHANNELS.map(async (ch) => {
        const c = this.chs[ch];
        const billed = await this.closeSession(ch);
        if (c.status === "open" || c.status === "queued" || c.status === "paused") this.setStatus(ch, "closed", "terminated");
        return { channel: ch, billedSeconds: billed };
      }),
    );
    this.o.cached?.deactivate("both");
    return out;
  }

  /** pagehide: best effort, synchronous start (keepalive reports are the caller's; sessions get Terminate). */
  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const ch of CHANNELS) {
      const c = this.chs[ch];
      if (c.session) {
        c.closingByUs = true;
        void c.session.terminate({ timeoutMs: 1000 }).catch(() => null);
      }
    }
  }
}

const fmtClock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** p50 helper for metrics. */
export function p50(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

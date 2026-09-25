/**
 * client/va/controller.ts - the Voice Agent half of a takeover (DESIGN §5.9, §5.8 pay protocol, §5.10 captions,
 * barge-in and HUD marks). Implements `VoiceAgentController` (services.ts) + `VoiceAgentControllerExt`
 * (contracts/ext/wp5b-va.ts). WP5's TakeoverController owns the phase machine and the retry decision; this class
 * owns one Voice Agent socket at a time and reports what happened through `onEvent`.
 *
 * Wire order (DESIGN §5.5.3): connect(token) at ARMED (WS pre-open, T-D1-3 part A) → start(compiled,
 * {holdAudioUntilCtxMs: repLineEnd}) at tSend → session.ready → the customer feeder starts, the output player holds
 * until the end of the rep's line → first audible PLAYED → HUD click_to_first_audible / dead_air_after_rep.
 *
 * Day-1 results baked in (docs/notes/wp5b.md §1):
 *  - PAY_TOOL_MODE defaults to "push": a reply.create while a `hold` tool is in flight is SILENT (T-D1-1).
 *  - Stage change: session.update{system_prompt, tools[, input]} then tool.result, no wait (T-D1-2 PASS).
 *  - transcription_mode and keyterms are mutable mid-session; a partial `input` merges (T-D1-4 PASS).
 *  - Inline HTTP tools are rejected (T-D1-5): function tools only.
 */
import "client-only";

import {
  NON_FATAL_CONFIG_ERROR_CODES, SessionError, TimeoutError, VoiceAgentSession, base64ToBytes, chunkLevelDb, errorCode, tokenUrl,
  vaErrorToErrorCode, type InlineSessionConfig, type ReplyInfo, type ServerEvent, type SessionErrorEvent, type ToolCallEvent, type WebSocketLike,
} from "@/core/aai/voice-agent";
import type { ToolResponse } from "@/core/contracts/api";
import type { Stage } from "@/core/contracts/case";
import { BatonError, type ErrorCode } from "@/core/contracts/errors";
import type { BatonEvent, ReplyKind } from "@/core/contracts/events";
import type {
  LatencyHudExt, PayToolMode, VaControllerEvent, VaControllerPhase, VaEventsPoster, VaPaymentPoller, VaStageSource, VaToolCaller,
  VoiceAgentControllerExt,
} from "@/core/contracts/ext/wp5b-va";
import type {
  AudioEngine, EventSink, MicSource, PacedFeeder, PageLifecycle, PhoneState, ToolOutcome, ValidateFirstUpdate, VaOutputPlayer,
} from "@/core/contracts/services";
import { TAKEOVER_TIMING, type CompiledTakeover, type TranscriptionMode } from "@/core/contracts/takeover";
import { TOOL_NAMES, type ToolName } from "@/core/contracts/tools";

import { SessionCap, wrapUpInstructions } from "./cap";
import { CaptionScheduler } from "./captions";
import { basicFirstUpdateGuard, buildFirstUpdate } from "./first-update";
import { PAY_LINES, PAY_TIMEOUT_RESULT, PaymentWatch, type PaymentOutcome } from "./payment-watch";

/** Chunks at or below this level are "silent" (leading-silence trim, §5.9.3; 10a §4.2). */
export const AUDIBLE_DB = -50;
/** 24 kHz PCM16 mono. */
const BYTES_PER_MS = 48;

export interface VaControllerConfig {
  /** T-D1-1 → "push". */
  payToolMode: PayToolMode;
  /** VA_KEYTERMS (T-D1-0 PASS with keyterms). */
  vaKeyterms: boolean;
  /** T-D1-2 fallback: wait ≤400 ms for session.updated before sending the stage-changing tool.result. */
  waitSessionUpdated: boolean;
  /** T-D1-4 → true. When false, transcription_mode is never changed after the first update. */
  inputModeMutable: boolean;
  /** VA_SESSION_CAP_MAX_MS (the absolute ceiling adds HOLD_MAX_MS). */
  vaSessionCapMaxMs: number;
  /** iOS: the page is hidden → session.end after this long (§5.9 / WP5b goal). */
  iosHiddenEndMs: number;
  /** WS bufferedAmount above this = "slow network" (≈1 s of base64 24 kHz audio). */
  slowNetworkBytes: number;
  /** Quiet after a non-question closing reply (after send_confirmation) before `close_ready`. */
  closeQuietMs: number;
  /** Quiet after a question reply (after send_confirmation) before `close_ready` (the customer did not answer). */
  closeQuestionQuietMs: number;
  /** Mic mode: local VAD onset level and ducking (§5.10 barge-in). */
  micOnsetDb: number;
  micEndDb: number;
  duckLevel: number;
  duckRestoreMs: number;
}

export const DEFAULT_VA_CONTROLLER_CONFIG: VaControllerConfig = {
  payToolMode: "push",
  vaKeyterms: true,
  waitSessionUpdated: false,
  inputModeMutable: true,
  vaSessionCapMaxMs: 420_000,
  iosHiddenEndMs: 10_000,
  slowNetworkBytes: 64_000,
  closeQuietMs: TAKEOVER_TIMING.CLOSE_GRACE_MS,
  closeQuestionQuietMs: 12_000,
  micOnsetDb: -40,
  micEndDb: -45,
  duckLevel: 0.3,
  duckRestoreMs: 2500,
};

export interface ControllerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

const defaultTimers: ControllerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface VoiceAgentControllerDeps {
  takeoverId: string;
  /** PolicyRecord.repFirstName, for the wrap-up line. */
  repFirst: string;
  engine: Pick<AudioEngine, "nowMs" | "createVaOutput" | "createFeeder">;
  sink: EventSink;
  callTool: VaToolCaller;
  hud?: LatencyHudExt;
  pollPayment?: VaPaymentPoller;
  stageSource?: VaStageSource;
  postEvents?: VaEventsPoster;
  /** WP1's validator (authoritative). Without it, `basicFirstUpdateGuard` runs. */
  validateFirstUpdate?: ValidateFirstUpdate;
  lifecycle?: Pick<PageLifecycle, "onPause" | "onResume">;
  /** Browser default: `new WebSocket(url)`. */
  openSocket?: (url: string) => WebSocketLike;
  /** `t` of emitted BatonEvents (ms since page session start). Default: the engine clock. */
  eventTime?: () => number;
  timers?: ControllerTimers;
  /** Raw protocol hook (debug / Explorer). Audio events are included; do not log payloads. */
  onRawEvent?: (ev: ServerEvent) => void;
  config?: Partial<VaControllerConfig>;
}

interface ReplyState {
  audibleSeen: boolean;
  leadingSilenceMs: number;
  pushedMs: number;
  playStartCtx: number | null;
  interrupted: boolean;
  done: boolean;
  startedAt: number;
  kind?: ReplyKind;
}

const isToolName = (n: string): n is ToolName => (TOOL_NAMES as readonly string[]).includes(n);

export class VoiceAgentControllerImpl implements VoiceAgentControllerExt {
  readonly cfg: VaControllerConfig;
  private readonly d: VoiceAgentControllerDeps;
  private readonly timers: ControllerTimers;
  private readonly captions: CaptionScheduler;
  private listeners = new Set<(e: VaControllerEvent) => void>();

  private session: VoiceAgentSession | null = null;
  private _phase: VaControllerPhase = "idle";
  private _stage: Stage | null = null;
  private mode: TranscriptionMode | null = null;
  private compiled: CompiledTakeover | null = null;
  private player: VaOutputPlayer | null = null;
  private feeder: PacedFeeder | null = null;
  private mic: MicSource | null = null;
  private cap: SessionCap | null = null;
  private watch: PaymentWatch | null = null;
  private phoneState: PhoneState = "idle";
  private holdResolve: ((r: unknown) => void) | null = null;

  private replies = new Map<string, ReplyState>();
  private currentReplyId: string | null = null;
  private greetingPlayed = false;
  private silentCount = 0;
  private userSpeaking = false;
  private lastClipEos: number | null = null;
  private handBack: { reason: string; summary: string; resultAt: number; fired: boolean; timer: unknown } | null = null;
  private confirmationSent = false;
  private closeTimer: unknown = null;
  private closeReadyEmitted = false;
  private slowNetwork = false;

  private intervals: unknown[] = [];
  private iosTimer: unknown = null;
  private duckTimer: unknown = null;
  private ducked = false;
  private micPoll: unknown = null;
  private micSpeaking = false;
  private micQuietSince: number | null = null;
  private micOnsetHits = 0;
  private unsubs: (() => void)[] = [];
  private firstUpdateSent = false;
  private ready = false;
  private endedByUs = false;
  private endedEmitted = false;
  private ending: Promise<void> | null = null;
  private lastError: SessionErrorEvent | null = null;
  /** Errors/closes that raced in between session.ready and start() resuming. */
  private deferred: (() => void)[] = [];

  constructor(deps: VoiceAgentControllerDeps) {
    this.d = deps;
    this.cfg = { ...DEFAULT_VA_CONTROLLER_CONFIG, ...(deps.config ?? {}) };
    this.timers = deps.timers ?? defaultTimers;
    this.captions = new CaptionScheduler({ sink: deps.sink, nowCtxMs: () => this.now(), eventTime: () => this.t() });
  }

  // ------------------------------------------------------------------------------------------------ public surface

  get phase(): VaControllerPhase {
    return this._phase;
  }
  get stage(): Stage | null {
    return this._stage;
  }
  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }
  /** The underlying session (tests, the Explorer's raw view). */
  get rawSession(): VoiceAgentSession | null {
    return this.session;
  }

  onEvent(cb: (e: VaControllerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Open the socket with a takeover-keyed temp token (browser). Resolves when the socket is OPEN. */
  async connect(token: string): Promise<void> {
    this.assertFresh();
    this.setPhase("connecting");
    this.emitSink({ t: this.t(), type: "va.status", status: "connecting" });
    const open = this.d.openSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    const ws = open(tokenUrl(token));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        fn();
      };
      const timer = this.timers.setTimeout(
        () => settle(() => reject(new BatonError("E_VA_TRANSIENT", `Voice Agent socket not open after ${TAKEOVER_TIMING.VA_WS_OPEN_TIMEOUT_MS} ms`))),
        TAKEOVER_TIMING.VA_WS_OPEN_TIMEOUT_MS,
      );
      ws.addEventListener("open", () => settle(resolve));
      ws.addEventListener("error", () => settle(() => reject(new BatonError("E_VA_TRANSIENT", "Voice Agent socket error before open"))));
      ws.addEventListener("close", (c) => settle(() => reject(new BatonError("E_VA_TRANSIENT", `Voice Agent socket closed before open (${c.code})`))));
      if (ws.readyState === 1) settle(resolve);
    }).catch((e) => {
      this.setPhase("failed");
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      throw e;
    });
    this.attach(new VoiceAgentSession(ws));
  }

  /**
   * Adopt an already-open session (Node: `openVoiceAgentNode(...).session` in live tests; the browser uses
   * `connect`). Must be called before `start`.
   */
  attach(session: VoiceAgentSession): void {
    if (this.session && this.session !== session) throw new Error("VoiceAgentController: already attached (use a new controller per attempt)");
    this.session = session;
    this.setPhase("open");
    this.wireSession(session);
  }

  async start(c: CompiledTakeover, opts: { holdAudioUntilCtxMs: number }): Promise<{ sessionId: string }> {
    const s = this.session;
    if (!s) throw new BatonError("E_VA_TRANSIENT", "start() before connect()");
    if (this.firstUpdateSent) throw new Error("VoiceAgentController.start() called twice");
    const msg = buildFirstUpdate(c, { keytermsEnabled: this.cfg.vaKeyterms });
    try {
      (this.d.validateFirstUpdate ?? basicFirstUpdateGuard)(msg as unknown as { type: "session.update"; session: Record<string, unknown> }, { keytermsEnabled: this.cfg.vaKeyterms });
    } catch (e) {
      // §5.9.6: a bad first update is a bug; nothing was sent. No retry with the same config.
      const message = e instanceof Error ? e.message : String(e);
      this.emitSink({ t: this.t(), type: "error", code: "E_VA_CONFIG", message });
      this.emit({ type: "error", code: "E_VA_CONFIG", retryable: false, message, afterFirstUpdate: false });
      throw e instanceof BatonError ? e : new BatonError("E_VA_CONFIG", message, { cause: e });
    }
    this.compiled = c;
    this._stage = c.stage;
    this.mode = c.transcriptionMode;
    const player = this.d.engine.createVaOutput();
    this.player = player;
    player.holdUntil(opts.holdAudioUntilCtxMs);
    this.unsubs.push(player.onFirstAudiblePlayed((replyId, ctxMs) => this.onFirstAudiblePlayed(replyId, ctxMs)));
    this.d.hud?.mark("updateSent", this.now());
    this.firstUpdateSent = true;
    let readyEv;
    try {
      readyEv = await s.start(msg.session as InlineSessionConfig, TAKEOVER_TIMING.SESSION_READY_TIMEOUT_MS);
    } catch (e) {
      const { code, message } = this.classifyStartError(e);
      const retryable = code !== "E_VA_CONFIG";
      this.setPhase("failed");
      this.emitSink({ t: this.t(), type: "va.status", status: "error", code });
      this.emit({ type: "error", code, retryable, message, afterFirstUpdate: true });
      this.cleanup();
      throw new BatonError(code, message, { cause: e });
    }
    this.ready = true;
    const sessionId = readyEv.session_id;
    const now = this.now();
    this.d.hud?.mark("sessionReady", now);
    this.d.hud?.setSessionIds({ va: sessionId });
    this.emitSink({ t: this.t(), type: "va.status", status: "ready", sessionId });
    void this.post({ vaSessionId: sessionId });

    // audio in (§5.9.2): starts on session.ready, nothing before
    const feeder = this.d.engine.createFeeder();
    this.feeder = feeder;
    if (this.mic) feeder.setMicSource(this.mic);
    feeder.start((frame) => this.sendFrame(frame));

    this.cap = new SessionCap({ capMs: c.vaSessionCapMs, vaSessionCapMaxMs: this.cfg.vaSessionCapMaxMs });
    this.cap.start(now);
    this.intervals.push(this.timers.setInterval(() => void this.post({ heartbeat: true, vaSessionId: sessionId }), TAKEOVER_TIMING.VA_HEARTBEAT_MS));
    this.intervals.push(this.timers.setInterval(() => this.onCapTick(), 1000));
    this.intervals.push(this.timers.setInterval(() => this.d.hud?.setAudioHealth({ underruns: this.player?.underruns ?? 0 }), 1000));
    this.wireLifecycle();
    this.setPhase("ready");
    this.emit({ type: "ready", sessionId, ctxMs: now });
    for (const fn of this.deferred.splice(0)) fn();
    return { sessionId };
  }

  applyStage(r: Pick<ToolOutcome, "systemPrompt" | "tools" | "stage" | "transcriptionMode">): void {
    void this.applyStageAsync(r);
  }

  /** reply.create{instructions} (one turn of context; never conversation.message, §5.9.5). */
  say(instructions: string): void {
    if (!this.session?.isOpen) return;
    try {
      this.session.replyNow(instructions);
    } catch {
      /* socket raced closed */
    }
  }

  setPayingState(phone: PhoneState): void {
    this.phoneState = phone;
    this.watch?.setPhoneState(phone);
  }

  async playCustomerClip(pcm24k: Int16Array): Promise<{ endCtxMs: number }> {
    if (!this.feeder) throw new BatonError("E_VA_TRANSIENT", "customer audio before session.ready");
    const r = await this.feeder.enqueueClip(pcm24k);
    this.lastClipEos = r.endCtxMs;
    this.d.hud?.mark("eos", r.endCtxMs);
    return r;
  }

  setMicSource(src: MicSource | null): void {
    this.mic = src;
    this.feeder?.setMicSource(src);
    if (this.micPoll !== null) this.timers.clearInterval(this.micPoll);
    this.micPoll = null;
    if (src) this.micPoll = this.timers.setInterval(() => this.onMicEnergy(src.energyDb()), 20);
  }

  async end(reason: string): Promise<void> {
    if (this.ending) return this.ending;
    this.ending = (async () => {
      this.endedByUs = true;
      this.setPhase("closing");
      this.cap?.setClosing(true);
      this.stopTimers();
      this.watch?.stop();
      this.resolveHold(PAY_TIMEOUT_RESULT);
      this.feeder?.stop();
      const s = this.session;
      if (s) await s.end(TAKEOVER_TIMING.SESSION_ENDED_WAIT_MS).catch(() => undefined);
      this.player?.flush();
      this.finishEnded(reason);
    })();
    return this.ending;
  }

  endNow(reason: string): void {
    this.endedByUs = true;
    this.stopTimers();
    this.watch?.stop();
    this.feeder?.stop();
    this.session?.endNow();
    this.player?.flush();
    this.finishEnded(reason);
  }

  // ------------------------------------------------------------------------------------------------ session wiring

  private wireSession(s: VoiceAgentSession): void {
    s.tools.policy = "immediate"; // §5.9.4 (10a §7: ≈1 s faster)
    for (const name of TOOL_NAMES) s.tools.register(name, (args, call) => this.onTool(name, args, call));
    if (this.d.onRawEvent) this.unsubs.push(s.on("*", this.d.onRawEvent));
    this.unsubs.push(
      s.on("reply.started", (e) => {
        this.currentReplyId = e.reply_id;
        this.replies.set(e.reply_id, { audibleSeen: false, leadingSilenceMs: 0, pushedMs: 0, playStartCtx: null, interrupted: false, done: false, startedAt: this.now() });
        this.d.hud?.mark("replyStarted", this.now(), e.reply_id);
        this.emitSink({ t: this.t(), type: "va.reply", replyId: e.reply_id, phase: "started" });
        this.cancelCloseTimer();
      }),
      s.on("reply.audio", (e) => this.onReplyAudio(e.reply_id ?? this.currentReplyId, e.data)),
      s.on("transcript.agent.delta", (e) => {
        const id = e.reply_id ?? this.currentReplyId;
        if (id) this.captions.onAgentDelta(id, e.delta, e.start_ms);
      }),
      s.on("transcript.agent", (e) => {
        if (e.interrupted) this.bargeIn(e.reply_id ?? null);
      }),
      s.on("transcript.user.delta", (e) => this.captions.onUserDelta(e.item_id, e.text)),
      s.on("transcript.user", (e) => this.captions.onUserFinal(e.item_id, e.text)),
      s.on("input.speech.started", () => {
        this.userSpeaking = true;
        this.cancelCloseTimer();
        this.bargeIn(null);
      }),
      s.on("input.speech.stopped", () => {
        this.userSpeaking = false;
        const now = this.now();
        // chips/typed/autopilot already marked the exact clip end; mic mode marks the local VAD end
        const clipRecent = this.lastClipEos !== null && now - this.lastClipEos < 4000;
        if (!clipRecent && !this.mic) this.d.hud?.mark("eos", now);
      }),
      s.on("reply.done", (e) => this.onReplyDone(e.reply_id ?? this.currentReplyId, e.status)),
      s.on("tool.call", (e) => {
        if (!isToolName(e.name) && !s.tools.isServerSide(e.name)) {
          this.emitSink({ t: this.t(), type: "error", code: "E_VA_CONFIG", message: `unknown tool ${e.name}` });
        }
      }),
      s.on("session.error", (e) => this.onSessionError(e)),
      s.on("__close", (c) => this.onClose(c.code, c.reason)),
    );
  }

  // ------------------------------------------------------------------------------------------------ audio out

  private replyState(id: string): ReplyState {
    let st = this.replies.get(id);
    if (!st) {
      st = { audibleSeen: false, leadingSilenceMs: 0, pushedMs: 0, playStartCtx: null, interrupted: false, done: false, startedAt: this.now() };
      this.replies.set(id, st);
    }
    return st;
  }

  private onReplyAudio(id: string | null, b64: string): void {
    if (!id || !b64 || !this.player) return;
    const st = this.replyState(id);
    if (st.interrupted) return;
    const bytes = base64ToBytes(b64);
    const level = chunkLevelDb(bytes); // -Infinity for digital silence (G0 note): compared, never serialized
    const audible = Number.isFinite(level) && level > AUDIBLE_DB;
    if (!st.audibleSeen) {
      if (!audible) {
        st.leadingSilenceMs += bytes.length / BYTES_PER_MS; // leading-silence trim (§5.9.3)
        return;
      }
      st.audibleSeen = true;
    }
    st.pushedMs += bytes.length / BYTES_PER_MS;
    this.player.push(b64, id, audible);
  }

  private onFirstAudiblePlayed(replyId: string, ctxMs: number): void {
    const st = this.replyState(replyId);
    if (st.playStartCtx !== null) return;
    st.playStartCtx = ctxMs;
    this.d.hud?.mark("firstAudiblePlayed", ctxMs, replyId);
    this.captions.onFirstAudiblePlayed(replyId, ctxMs, st.leadingSilenceMs);
    this.emitSink({ t: this.t(), type: "va.reply", replyId, phase: "first_audible" });
    const greeting = !this.greetingPlayed;
    this.greetingPlayed = true;
    if (greeting && (this._phase === "ready" || this._phase === "open")) this.setPhase("active");
    this.emit({ type: "first_audible", replyId, ctxMs, greeting });
  }

  /** The reply whose audio is playing or buffered right now (for barge-in), or null. */
  private activeAgentReply(now: number): string | null {
    for (const [id, st] of [...this.replies].reverse()) {
      if (st.interrupted || !st.audibleSeen) continue;
      if (st.playStartCtx === null) return id; // buffered, not started yet (e.g. held until the rep line ends)
      if (now < st.playStartCtx + st.pushedMs + 150) return id;
    }
    return null;
  }

  /** Estimated end of playback of a reply (ctx ms), or now. */
  private playbackEnd(id: string | null): number {
    const now = this.now();
    if (!id) return now;
    const st = this.replies.get(id);
    if (!st || st.playStartCtx === null) return now;
    return Math.max(now, st.playStartCtx + st.pushedMs);
  }

  /** §5.10 barge-in: on the FIRST of speech.started / reply.done{interrupted} / transcript.agent{interrupted}. */
  private bargeIn(replyId: string | null): void {
    const now = this.now();
    const id = replyId ?? this.activeAgentReply(now);
    if (!id) return;
    const st = this.replyState(id);
    if (st.interrupted) return;
    // speech.started right after a reply finished streaming: let the last few hundred ms of buffered audio play
    if (replyId === null && st.done && this.playbackEnd(id) - now < 400) return;
    const wasAudible = st.audibleSeen;
    st.interrupted = true;
    this.player?.flush();
    this.restoreVolume();
    if (!wasAudible) return; // a silent reply (pre-amble) cannot be "heard" as interrupted
    this.captions.interrupt(id, now);
    this.emitSink({ t: this.t(), type: "va.reply", replyId: id, phase: "done", interrupted: true });
  }

  private onReplyDone(id: string | null, status: string | undefined): void {
    if (!id) return;
    const st = this.replyState(id);
    st.done = true;
    const info = this.trackerReply(id);
    const kind: ReplyKind = info?.kind ?? (st.audibleSeen ? "speech" : "silent_no_output");
    st.kind = kind;
    this.d.hud?.noteReplyKind(id, kind);
    if (status === "interrupted") this.bargeIn(id);
    if (!st.interrupted) this.emitSink({ t: this.t(), type: "va.reply", replyId: id, phase: "done", kind, interrupted: false });

    if (kind === "silent_no_output") {
      // T-D1-1: while a `hold` tool is in flight every reply.create is silent; that is not E_VA_SILENT.
      const inHold = this.holdResolve !== null;
      if (!inHold) this.onSilentReply();
    } else if (kind === "speech") {
      this.silentCount = 0;
    }
    if (kind === "speech" && !st.interrupted) {
      this.maybeFireHandBack(id);
      this.maybeScheduleClose(id, info?.text ?? "");
    }
  }

  private trackerReply(id: string): ReplyInfo | undefined {
    const r = this.session?.replies;
    if (!r) return undefined;
    if (r.current?.replyId === id) return r.current;
    return r.replies.find((x) => x.replyId === id);
  }

  private onSilentReply(): void {
    this.silentCount++;
    if (this.silentCount === 1) {
      this.say("Please continue.");
      return;
    }
    this.emit({ type: "error", code: "E_VA_SILENT", retryable: true, message: "two silent replies in a row", afterFirstUpdate: false });
  }

  // ------------------------------------------------------------------------------------------------ audio in

  private sendFrame(frame: Uint8Array): void {
    const s = this.session;
    if (!s?.isOpen) return;
    s.sendAudio(frame);
    const buffered = s.ws.bufferedAmount ?? 0;
    const slow = buffered > this.cfg.slowNetworkBytes;
    if (slow !== this.slowNetwork && (slow || buffered < this.cfg.slowNetworkBytes / 2)) {
      this.slowNetwork = slow;
      this.d.hud?.setAudioHealth({ slowNetwork: slow });
    }
  }

  private onMicEnergy(db: number): void {
    const now = this.now();
    if (db > this.cfg.micOnsetDb) {
      this.micQuietSince = null;
      this.micOnsetHits++;
      if (!this.micSpeaking && this.micOnsetHits >= 2) {
        this.micSpeaking = true;
        // perceived-responsiveness aid: duck agent playback while the server decides on barge-in
        if (this.activeAgentReply(now) && !this.ducked) {
          this.ducked = true;
          this.player?.setVolume(this.cfg.duckLevel);
          this.duckTimer = this.timers.setTimeout(() => this.restoreVolume(), this.cfg.duckRestoreMs);
        }
      }
      return;
    }
    this.micOnsetHits = 0;
    if (this.micSpeaking && db < this.cfg.micEndDb) {
      this.micQuietSince ??= now;
      if (now - this.micQuietSince >= 300) {
        this.micSpeaking = false;
        this.d.hud?.mark("eos", this.micQuietSince); // local VAD end of speech
        this.micQuietSince = null;
      }
    }
  }

  private restoreVolume(): void {
    if (this.duckTimer !== null) this.timers.clearTimeout(this.duckTimer);
    this.duckTimer = null;
    if (this.ducked) {
      this.ducked = false;
      this.player?.setVolume(1);
    }
  }

  // ------------------------------------------------------------------------------------------------ tools

  private async onTool(name: ToolName, args: Record<string, unknown>, call: ToolCallEvent): Promise<unknown> {
    this.emitSink({ t: this.t(), type: "va.tool", callId: call.call_id, name, phase: "call", args });
    if (name === "send_esign_and_pay_link") return this.onPayTool(args, call);
    const resp = await this.d.callTool(name, args, { takeoverId: this.d.takeoverId, callId: call.call_id });
    this.applyUi(resp);
    await this.applyStageAsync(resp); // §5.9.4: session.update first; the dispatcher sends tool.result after we return
    this.emitSink({ t: this.t(), type: "va.tool", callId: call.call_id, name, phase: "result", result: resp.result });
    if (name === "hand_back_to_rep") this.armHandBack(args);
    if (name === "send_confirmation" && resp.result.ok === true) this.confirmationSent = true;
    return resp.result;
  }

  private applyUi(resp: ToolResponse): void {
    if (resp.ui?.sms) this.emitSink({ t: this.t(), type: "phone.sms", text: resp.ui.sms, ...(resp.ui.link ? { link: resp.ui.link } : {}) });
  }

  private async applyStageAsync(r: Pick<ToolOutcome, "systemPrompt" | "tools" | "stage" | "transcriptionMode">): Promise<void> {
    const s = this.session;
    const upd: InlineSessionConfig = {};
    if (r.systemPrompt) upd.system_prompt = r.systemPrompt;
    if (r.tools) upd.tools = r.tools.map((t) => ({ ...t }));
    if (r.transcriptionMode && r.transcriptionMode !== this.mode && this.cfg.inputModeMutable) upd.input = { transcription_mode: r.transcriptionMode };
    if (s?.isOpen && Object.keys(upd).length > 0) {
      const updated = this.cfg.waitSessionUpdated
        ? s.waitFor("session.updated", { timeoutMs: 400, alsoResolveOn: ["session.error"] }).catch(() => undefined)
        : null;
      try {
        s.sendUpdate(upd);
        if (upd.input?.transcription_mode) this.mode = upd.input.transcription_mode;
      } catch {
        /* socket raced closed */
      }
      if (updated) await updated;
    }
    if (r.stage && r.stage !== this._stage) {
      this._stage = r.stage;
      this.emitSink({ t: this.t(), type: "stage", stage: r.stage });
      this.emit({ type: "stage", stage: r.stage });
    }
  }

  private async enterStageFromSource(stage: Stage): Promise<boolean> {
    if (!this.d.stageSource) {
      this.emitSink({ t: this.t(), type: "error", code: "E_CASE_STATE", message: `no stage source for ${stage}` });
      return false;
    }
    try {
      const p = await this.d.stageSource(stage);
      await this.applyStageAsync({ stage, systemPrompt: p.systemPrompt, tools: p.tools, ...(p.transcriptionMode ? { transcriptionMode: p.transcriptionMode } : {}) });
      return true;
    } catch (e) {
      this.emitSink({ t: this.t(), type: "error", code: "E_CASE_STATE", message: `stage ${stage}: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
  }

  // ------------------------------------------------------------------------------------------------ pay (§5.8)

  private async onPayTool(args: Record<string, unknown>, call: ToolCallEvent): Promise<unknown> {
    const resp = await this.d.callTool("send_esign_and_pay_link", args, { takeoverId: this.d.takeoverId, callId: call.call_id });
    this.applyUi(resp);
    const paymentId = resp.ui?.paymentId;
    const status = resp.result.status;
    if (!paymentId || (status !== "link_sent" && status !== undefined && status !== "paid")) {
      // not_sent (consent required, invalid args) or an immediate terminal answer: plain interactive result
      this.emitSink({ t: this.t(), type: "va.tool", callId: call.call_id, name: "send_esign_and_pay_link", phase: "result", result: resp.result });
      return resp.result;
    }
    await this.applyStageAsync(resp);
    this.beginPaying(paymentId);
    if (this.cfg.payToolMode === "push") {
      const result = status === "link_sent" ? resp.result : { status: "link_sent" };
      this.emitSink({ t: this.t(), type: "va.tool", callId: call.call_id, name: "send_esign_and_pay_link", phase: "result", result });
      return result;
    }
    // hold: keep the tool.result until the payment resolves. The status line is sent per §5.8 step 2, although
    // T-D1-1 showed that replies during a hold are silent (hence push is the default).
    this.say(PAY_LINES.status);
    return new Promise((resolve) => {
      this.holdResolve = (r) => {
        this.emitSink({ t: this.t(), type: "va.tool", callId: call.call_id, name: "send_esign_and_pay_link", phase: "result", result: r });
        resolve(r);
      };
    });
  }

  private beginPaying(paymentId: string): void {
    this.cap?.setPaying(true, this.now());
    this.setPhase("paying");
    this.emit({ type: "paying", on: true });
    if (!this.d.pollPayment) {
      this.emitSink({ t: this.t(), type: "error", code: "E_INTERNAL", message: "no payment poller injected" });
      return;
    }
    this.watch?.stop();
    this.watch = new PaymentWatch({
      paymentId,
      poll: this.d.pollPayment,
      now: () => this.now(),
      timers: { setTimeout: (fn, ms) => this.timers.setTimeout(fn, ms), clearTimeout: (h) => this.timers.clearTimeout(h) },
      onReassure: () => this.sayWhenIdle(PAY_LINES.reassure),
      onOutcome: (o) => void this.onPaymentOutcome(o),
    });
    this.watch.setPhoneState(this.phoneState);
    this.watch.start(this.now());
  }

  private endPaying(): void {
    if (!this.cap?.paying && this._phase !== "paying") return;
    this.cap?.setPaying(false, this.now());
    if (this._phase === "paying") this.setPhase("active");
    this.emit({ type: "paying", on: false });
  }

  private resolveHold(r: unknown): boolean {
    const h = this.holdResolve;
    if (!h) return false;
    this.holdResolve = null;
    h(r);
    return true;
  }

  private async onPaymentOutcome(o: PaymentOutcome): Promise<void> {
    if (o.kind === "timeout") {
      this.emitSink({ t: this.t(), type: "payment", status: "timeout" });
      if (!this.resolveHold(PAY_TIMEOUT_RESULT)) this.sayWhenIdle(PAY_LINES.timeout);
      this.endPaying(); // the watch keeps polling for a late success (step 8)
      return;
    }
    const v = o.view;
    this.emitSink({ t: this.t(), type: "payment", status: v.status, ...(v.statusSource ? { source: v.statusSource } : {}) });
    this.watch?.stop();
    if (v.status === "succeeded") {
      await this.enterStageFromSource("close"); // session.update{close} first (§5.8 step 3)
      const result = v.toolResult ?? { status: "paid", amount: "", receipt: v.id, verified_by: v.simulated ? "simulated" : "polar_webhook" };
      if (!this.resolveHold(result)) this.sayWhenIdle(o.late ? PAY_LINES.latePaid : PAY_LINES.paid);
    } else {
      const result = v.toolResult ?? { status: v.status === "expired" ? "expired" : "failed", instruction: PAY_TIMEOUT_RESULT.instruction };
      if (!this.resolveHold(result)) {
        const instr = "instruction" in result && typeof result.instruction === "string" ? result.instruction : PAY_TIMEOUT_RESULT.instruction;
        this.sayWhenIdle(`The payment ${v.status === "expired" ? "link expired" : "did not go through"}. ${instr}`);
      }
    }
    this.endPaying();
  }

  /** reply.create only when neither side is talking (retries for up to 10 s). */
  private sayWhenIdle(instructions: string, triesLeft = 10): void {
    const busy = this.userSpeaking || (this.currentReplyId !== null && !this.replyState(this.currentReplyId).done) || this.activeAgentReply(this.now()) !== null;
    if (busy && triesLeft > 0) {
      this.timers.setTimeout(() => this.sayWhenIdle(instructions, triesLeft - 1), 1000);
      return;
    }
    this.say(instructions);
  }

  // ------------------------------------------------------------------------------------------------ hand-back, close, cap

  private armHandBack(args: Record<string, unknown>): void {
    const reason = typeof args.reason === "string" ? args.reason : "other";
    const summary = typeof args.summary === "string" ? args.summary : "";
    const timer = this.timers.setTimeout(() => this.fireHandBack(), 10_000); // the agent never spoke its sentence
    this.handBack = { reason, summary, resultAt: this.now(), fired: false, timer };
  }

  private maybeFireHandBack(replyId: string): void {
    const hb = this.handBack;
    if (!hb || hb.fired) return;
    const st = this.replies.get(replyId);
    if (!st || st.startedAt < hb.resultAt) return;
    const wait = Math.min(TAKEOVER_TIMING.HAND_BACK_REPLY_GRACE_MS, Math.max(0, this.playbackEnd(replyId) - this.now()));
    this.timers.clearTimeout(hb.timer);
    hb.timer = this.timers.setTimeout(() => this.fireHandBack(), wait);
  }

  private fireHandBack(): void {
    const hb = this.handBack;
    if (!hb || hb.fired) return;
    hb.fired = true;
    this.timers.clearTimeout(hb.timer);
    this.emit({ type: "hand_back", reason: hb.reason, summary: hb.summary });
  }

  private maybeScheduleClose(replyId: string, text: string): void {
    if (!this.confirmationSent || this.closeReadyEmitted) return;
    this.cancelCloseTimer();
    const question = /\?\s*$/.test(text.trim());
    const wait = Math.max(0, this.playbackEnd(replyId) - this.now()) + (question ? this.cfg.closeQuestionQuietMs : this.cfg.closeQuietMs);
    this.closeTimer = this.timers.setTimeout(() => {
      this.closeTimer = null;
      if (this.userSpeaking || this.closeReadyEmitted) return;
      this.closeReadyEmitted = true;
      this.cap?.setClosing(true);
      this.emit({ type: "close_ready" });
    }, wait);
  }

  private cancelCloseTimer(): void {
    if (this.closeTimer !== null) this.timers.clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  private onCapTick(): void {
    const sig = this.cap?.tick(this.now()) ?? "none";
    if (sig === "wrap_up") {
      this.sayWhenIdle(wrapUpInstructions(this.d.repFirst));
      this.emit({ type: "wrap_up", atMs: this.now() });
    } else if (sig === "cap" || sig === "ceiling") {
      void this.end(sig === "cap" ? "cap" : "ceiling");
    }
  }

  private wireLifecycle(): void {
    const lc = this.d.lifecycle;
    if (!lc) return;
    this.unsubs.push(
      lc.onPause((reason) => {
        if (reason !== "ios_background" || this.iosTimer !== null) return;
        this.iosTimer = this.timers.setTimeout(() => {
          this.iosTimer = null;
          void this.end("ios_background");
        }, this.cfg.iosHiddenEndMs);
      }),
      lc.onResume(() => {
        if (this.iosTimer !== null) this.timers.clearTimeout(this.iosTimer);
        this.iosTimer = null;
      }),
    );
  }

  // ------------------------------------------------------------------------------------------------ errors and close

  private classifyStartError(e: unknown): { code: ErrorCode; message: string } {
    if (e instanceof SessionError) return { code: vaErrorToErrorCode(e.event, { afterFirstUpdate: true }), message: e.message };
    if (e instanceof TimeoutError) return { code: "E_VA_TIMEOUT", message: e.message };
    const closed = this.session?.closed;
    if (closed?.code === 1008) {
      const code = this.lastError ? vaErrorToErrorCode(this.lastError, { afterFirstUpdate: true }) : "E_VA_CONFIG";
      return { code, message: `closed 1008 after the first update${this.lastError ? `: ${errorCode(this.lastError)}` : ""}` };
    }
    return { code: "E_VA_TRANSIENT", message: e instanceof Error ? e.message : String(e) };
  }

  private onSessionError(e: SessionErrorEvent): void {
    this.lastError = e;
    if (!this.ready) {
      // session.ready already arrived but start() has not resumed yet (same tick): handle it right after "ready"
      if (this.session?.ready) this.deferred.push(() => this.onSessionError(e));
      return; // otherwise start() reports first-update failures
    }
    const code = errorCode(e);
    if (NON_FATAL_CONFIG_ERROR_CODES.has(code)) {
      // §5.9.6: log E_VA_CONFIG, keep the session, continue without that update
      this.emitSink({ t: this.t(), type: "error", code: "E_VA_CONFIG", message: `${code}: ${e.message ?? ""}${e.param ? ` (${e.param})` : ""}` });
      return;
    }
    const mapped = vaErrorToErrorCode(e);
    this.emitSink({ t: this.t(), type: "error", code: mapped, message: `${code}: ${e.message ?? ""}` });
    this.emit({ type: "error", code: mapped, retryable: mapped !== "E_VA_CONFIG" && mapped !== "E_AAI_BALANCE", message: e.message ?? code, afterFirstUpdate: false });
  }

  private onClose(code: number, reason: string): void {
    if (this.endedByUs) return; // our end()
    if (!this.ready) {
      if (this.session?.ready) this.deferred.push(() => this.onClose(code, reason));
      return; // start() handles pre-ready failures
    }
    const mapped: ErrorCode = this.lastError ? vaErrorToErrorCode(this.lastError) : "E_VA_TRANSIENT";
    this.emitSink({ t: this.t(), type: "va.status", status: "error", code: String(code) });
    this.emit({ type: "error", code: mapped, retryable: mapped !== "E_AAI_BALANCE", message: `socket closed ${code} ${reason}`, afterFirstUpdate: false });
    this.stopTimers();
    this.watch?.stop();
    this.feeder?.stop();
    this.player?.flush();
    this.setPhase("failed");
    this.finishEnded(`closed_${code}`);
  }

  private finishEnded(reason: string): void {
    if (this.endedEmitted) return;
    this.endedEmitted = true;
    if (this._phase !== "failed") this.setPhase("ended");
    const sessionSeconds = this.session?.ended?.session_duration_seconds ?? null;
    this.emitSink({ t: this.t(), type: "va.status", status: "ended", ...(this.sessionId ? { sessionId: this.sessionId } : {}) });
    this.emit({ type: "ended", reason, sessionSeconds, sessionId: this.sessionId });
    this.cleanup();
  }

  private stopTimers(): void {
    for (const h of this.intervals) this.timers.clearInterval(h);
    this.intervals = [];
    if (this.micPoll !== null) this.timers.clearInterval(this.micPoll);
    this.micPoll = null;
    if (this.iosTimer !== null) this.timers.clearTimeout(this.iosTimer);
    this.iosTimer = null;
    this.cancelCloseTimer();
    if (this.handBack) this.timers.clearTimeout(this.handBack.timer);
    this.restoreVolume();
  }

  private cleanup(): void {
    this.stopTimers();
    for (const u of this.unsubs.splice(0)) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.captions.prune(0);
  }

  // ------------------------------------------------------------------------------------------------ helpers

  private assertFresh(): void {
    if (this.session) throw new Error("VoiceAgentController: one controller per Voice Agent session attempt");
  }

  private now(): number {
    return this.d.engine.nowMs();
  }

  private t(): number {
    return this.d.eventTime ? this.d.eventTime() : this.now();
  }

  private setPhase(p: VaControllerPhase): void {
    this._phase = p;
  }

  private emit(e: VaControllerEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* a listener must not break the session */
      }
    }
  }

  private emitSink(ev: BatonEvent): void {
    try {
      this.d.sink.emit(ev);
    } catch {
      /* the UI must not break the session */
    }
  }

  private async post(body: Parameters<VaEventsPoster>[0]): Promise<void> {
    if (!this.d.postEvents) return;
    try {
      await this.d.postEvents(body);
    } catch {
      /* heartbeats and HUD posts are best effort */
    }
  }

}

export function createVoiceAgentController(deps: VoiceAgentControllerDeps): VoiceAgentControllerImpl {
  return new VoiceAgentControllerImpl(deps);
}

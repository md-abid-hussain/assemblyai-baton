import "client-only";

import type { Channel } from "@/core/contracts/case";
import { isBatonError, type ErrorCode } from "@/core/contracts/errors";
import type { TakeoverClientView, TakeoverControllerExt } from "@/core/contracts/ext/wp5-takeover";
import type { BatonEvent, TakeoverPhase } from "@/core/contracts/events";
import type { CallTick } from "@/core/contracts/services";
import { TAKEOVER_TIMING, type DrainReport } from "@/core/contracts/takeover";
import {
  armView,
  defaultMachineConfig,
  initialMachineState,
  isRetryableVaCode,
  manualPassAllowed,
  nextDeadline,
  reduce,
  type AudioSample,
  type TakeoverEffect,
  type TakeoverInput,
  type TakeoverMachineState,
} from "@/core/protocol/takeover-machine";

import { TakeoverApiError, type TakeoverControllerDeps, type Timers, type VaSession, type VaSessionEvent } from "./ports";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<BatonEvent, "t">;

/**
 * TakeoverController (DESIGN §5.5, TASKS WP5): executes the effects of the pure protocol machine
 * (`src/core/protocol/takeover-machine.ts`) against the page's collaborators and feeds their results back as inputs.
 *
 *  - Clock: the AudioContext (`engine.nowMs()`); one timer, re-armed at `nextDeadline(state)`.
 *  - Audio samples: on every CallPlayback tick while the pass can still need them (idle for the auto-baton and the
 *    recorded half, armed and sealing for quiet/cap/partials): speaking = RMS(200 ms) ≥ −45 dBFS per channel,
 *    quiet = both channels < −45 dBFS over 400 ms, openPartial = SttChannelManager.hasOpenPartial (§5.5.3, rule 3).
 *  - Ordering that matters on the wire: `POST /events {failure}` completes before `POST /api/va/token {attempt:1}`
 *    (route #10 needs last_failure_at); `POST /sessions/report {closed}` completes before `POST /end` (the slot is
 *    settled with the billed seconds, not by the /end safety net).
 *  - Voice Agent events are tagged with their attempt, and an aborted attempt is unsubscribed, so a late event of
 *    the old socket can never move the new attempt.
 *
 * `arm()` must be called from the click handler AFTER `AudioEngine.unlockSync()` (WP4, iOS), which is the caller's.
 */
export class TakeoverControllerImpl implements TakeoverControllerExt {
  private s: TakeoverMachineState;
  private readonly timers: Timers;
  private timer: unknown = null;
  private timerAt: number | null = null;
  private dispatching = false;
  private readonly queue: TakeoverInput[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly offs: (() => void)[] = [];
  private takeoverToken: string | null = null;
  private vaTokens: Partial<Record<0 | 1, { token: string; liveSessionId: string }>> = {};
  private vas: Partial<Record<0 | 1, { session: VaSession; off: () => void }>> = {};
  private failureReport: Promise<void> = Promise.resolve();
  private vaReport: Promise<void> = Promise.resolve();
  private sttTerminated = false;
  private notice: TakeoverClientView["notice"] = null;
  private verificationJobId: string | null = null;
  private disposed = false;
  /** The latest CallPlayback tick (the click's sample uses its callMs and playing flag). */
  private lastTick: CallTick | null = null;

  constructor(private readonly d: TakeoverControllerDeps) {
    this.timers = d.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.s = initialMachineState(
      defaultMachineConfig({
        aiHalf: d.aiHalf,
        handoff: d.call.handoff,
        hasRecordedBundle: d.call.recordedAiBundle !== null && d.recorded !== null,
        autoBaton: d.autoBaton,
      }),
    );
    this.offs.push(d.playback.onTick((t) => this.onTick(t)));
    this.offs.push(d.playback.onEnded(() => this.dispatch({ type: "recording_ended", now: this.now() })));
    const onPageHide = d.onPageHide ?? defaultPageHide;
    this.offs.push(onPageHide(() => this.pagehide()));
  }

  // ------------------------------------------------------------------------------------------ TakeoverController

  get phase(): TakeoverPhase {
    return this.s.phase;
  }

  get manualPassAllowed(): boolean {
    return manualPassAllowed(this.s);
  }

  async arm(source: "manual" | "auto_handoff"): Promise<void> {
    // A fresh sample so midUtterance/quiet reflect the moment of the click, not the last tick.
    this.dispatch({ type: "sample", ...this.sample(null) });
    this.dispatch({ type: "arm", now: this.now(), source });
  }

  abort(reason: string): void {
    this.endCall(reason);
  }

  endCall(reason: string): void {
    this.dispatch({ type: "end_call", now: this.now(), reason });
  }

  noteFinal(turn: { turnId: string; channel: Channel; startMs: number; endMs: number }): void {
    this.dispatch({ type: "final", now: this.now(), ...turn });
  }

  armInfo(): { armed: boolean; tArmMs: number | null } {
    return armView(this.s);
  }

  view(): TakeoverClientView {
    const p = this.s.pass;
    return {
      phase: this.s.phase,
      manualPassAllowed: manualPassAllowed(this.s),
      passes: this.s.passes,
      lastOutcome: this.s.lastOutcome,
      pass: p
        ? {
            source: p.source, takeoverId: p.arm.takeoverId, tArmMs: p.tArmMs, tCutMs: p.tCutMs, midUtterance: p.midUtterance, capHit: p.capHit,
            speakingCh: p.speakingCh, attempt: p.va.attempt, compiledBy: p.compile.by, leadMs: p.arm.leadMs, vaSessionId: p.va.sessionId,
            timings: { ...p.timings },
          }
        : null,
      notice: this.notice,
      verificationJobId: this.verificationJobId,
    };
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The machine state (tests, the Explorer's debug panel). */
  get state(): TakeoverMachineState {
    return this.s;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    for (const off of this.offs.splice(0)) off();
    for (const a of [0, 1] as const) this.vas[a]?.off();
    this.listeners.clear();
  }

  // ------------------------------------------------------------------------------------------ inputs

  private now(): number {
    return this.d.engine.nowMs();
  }

  private sample(tick: CallTick | null): AudioSample {
    const now = this.now();
    const pb = this.d.playback;
    const t = tick ?? this.lastTick;
    const playing = t ? t.playing : false;
    const db = (ch: Channel, ms: number) => {
      const v = pb.channelEnergyDb(ch, ms);
      return Number.isFinite(v) ? v : -120;
    };
    const Q = TAKEOVER_TIMING.QUIET_DBFS;
    const speaking = playing ? { rep: db("rep", 200) >= Q, customer: db("customer", 200) >= Q } : { rep: false, customer: false };
    const quiet = !playing || (db("rep", TAKEOVER_TIMING.QUIET_REQUIRED_MS) < Q && db("customer", TAKEOVER_TIMING.QUIET_REQUIRED_MS) < Q);
    const openPartial = { rep: this.d.stt.hasOpenPartial("rep"), customer: this.d.stt.hasOpenPartial("customer") };
    return { now, callMs: t ? t.callMs : (this.s.sample?.callMs ?? 0), playing, speaking, quiet, openPartial };
  }

  private onTick(t: CallTick): void {
    this.lastTick = t;
    const ph = this.s.phase;
    // After sealing nothing reads audio samples; idle needs them for the auto-baton and the recorded half.
    if (ph !== "idle" && ph !== "armed" && ph !== "sealing") return;
    this.dispatch({ type: "sample", ...this.sample(t) });
  }

  private pagehide(): void {
    this.dispatch({ type: "pagehide", now: this.now() });
  }

  private dispatch(input: TakeoverInput): void {
    if (this.disposed && input.type !== "pagehide") return;
    this.queue.push(input);
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        const prev = this.s;
        const r = reduce(prev, next);
        this.s = r.state;
        if (r.state.phase !== prev.phase) this.emitPhase(r.state.phase);
        for (const e of r.effects) this.run(e);
      }
    } finally {
      this.dispatching = false;
    }
    this.schedule();
    for (const cb of [...this.listeners]) cb();
  }

  private schedule(): void {
    const at = this.disposed ? null : nextDeadline(this.s);
    if (at === this.timerAt) return;
    this.clearTimer();
    if (at === null) return;
    this.timerAt = at;
    // The AudioContext clock and the timer clock differ slightly; an early tick is harmless (the machine re-checks).
    const delay = Math.max(20, at - this.now());
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.timerAt = null;
      this.dispatch({ type: "tick", now: this.now() });
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = null;
  }

  private emitPhase(phase: TakeoverPhase): void {
    const p = this.s.pass;
    const detail: Record<string, number | string> = {};
    if (p) {
      detail.source = p.source;
      detail.tArmMs = p.tArmMs;
      detail.attempt = p.va.attempt;
      if (p.tCutMs !== null) detail.tCutMs = p.tCutMs;
      if (p.capHit) detail.capHit = 1;
      if (p.compile.by) detail.compiledBy = p.compile.by;
    }
    this.emit({ type: "takeover.phase", phase, atMs: this.now(), ...(p ? { detail } : {}) });
  }

  private emit(ev: EventBody): void {
    const t = this.d.eventTime ? this.d.eventTime() : this.now();
    this.d.sink.emit({ t, ...ev } as BatonEvent);
  }

  private log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
    this.d.log?.(level, msg, data);
  }

  // ------------------------------------------------------------------------------------------ effects

  private run(e: TakeoverEffect): void {
    try {
      this.runUnsafe(e);
    } catch (err) {
      this.log("error", "takeover effect failed", { effect: e.type, err: String(err) });
    }
  }

  private runUnsafe(e: TakeoverEffect): void {
    const d = this.d;
    switch (e.type) {
      case "hud_mark":
        d.hud?.mark(e.name, e.ctxMs);
        return;
      case "post_arm":
        d.api
          .arm({ caseId: d.ids.caseId, runId: d.ids.runId, tArmMs: e.tArmMs, midUtterance: e.midUtterance, source: e.source }, d.ids.caseToken)
          .then((r) => {
            this.takeoverToken = r.takeoverToken;
            this.dispatch({ type: "arm_ok", now: this.now(), takeoverId: r.takeoverId, leadMs: r.leadMs });
          })
          .catch((err: unknown) => this.dispatch({ type: "arm_failed", now: this.now(), code: codeOf(err, "E_INTERNAL"), message: messageOf(err) }));
        return;
      case "mint_va": {
        const token = this.takeoverToken;
        if (!token) return this.dispatch({ type: "va_token_failed", now: this.now(), attempt: e.attempt, code: "E_CASE_TOKEN", message: "no takeover token" });
        const before = e.attempt === 1 ? this.failureReport : Promise.resolve();
        void before
          .then(() => d.api.vaToken({ takeoverId: e.takeoverId, attempt: e.attempt }, token))
          .then((r) => {
            this.vaTokens[e.attempt] = { token: r.token, liveSessionId: r.liveSessionId };
            this.dispatch({ type: "va_token", now: this.now(), attempt: e.attempt, liveSessionId: r.liveSessionId });
          })
          .catch((err: unknown) => this.dispatch({ type: "va_token_failed", now: this.now(), attempt: e.attempt, code: codeOf(err, "E_VA_TRANSIENT"), message: messageOf(err) }));
        return;
      }
      case "open_va": {
        const tok = this.vaTokens[e.attempt];
        if (!tok) return;
        const session = d.createVa(e.attempt);
        const off = session.onEvent((ev) => this.onVaEvent(e.attempt, ev));
        this.vas[e.attempt] = { session, off };
        session
          .connect(tok.token)
          .then(() => this.dispatch({ type: "va_open", now: this.now(), attempt: e.attempt }))
          .catch((err: unknown) => {
            const code = codeOf(err, "E_VA_TRANSIENT");
            this.dispatch({ type: "va_error", now: this.now(), attempt: e.attempt, code, retryable: isRetryableVaCode(code), message: messageOf(err) });
          });
        return;
      }
      case "stop_playback":
        d.playback.stop(e.fadeMs);
        return;
      case "play_handoff_clip": {
        const h = d.call.handoff;
        if (!h) return this.dispatch({ type: "clip_scheduled", now: this.now(), endCtxMs: this.now() });
        d.playback
          .playHandoffClip(h)
          .then((r) => this.dispatch({ type: "clip_scheduled", now: this.now(), endCtxMs: r.endCtxMs }))
          .catch((err: unknown) => {
            this.log("warn", "handoff clip failed", { err: String(err) });
            this.dispatch({ type: "clip_scheduled", now: this.now(), endCtxMs: this.now() });
          });
        return;
      }
      case "force_endpoint":
        d.stt.forceEndpoint(e.channel);
        return;
      case "drain": {
        const started = this.now();
        d.caseSync
          .drain(e.timeoutMs)
          .then((r) => this.dispatch({ type: "drained", now: this.now(), completedTurnIds: r.completedTurnIds, pendingTurnIds: r.pendingTurnIds, waitedMs: r.waitedMs }))
          .catch(() => this.dispatch({ type: "drained", now: this.now(), completedTurnIds: [], pendingTurnIds: [], waitedMs: this.now() - started }));
        return;
      }
      case "terminate_stt":
        if (this.sttTerminated) return;
        this.sttTerminated = true;
        d.stt.terminateAll().catch((err: unknown) => this.log("warn", "stt terminate failed", { err: String(err) }));
        return;
      case "post_compile": {
        const token = this.takeoverToken;
        if (!token) return this.dispatch({ type: "compile_failed", now: this.now(), by: "server", code: "E_CASE_TOKEN", message: "no takeover token" });
        d.api
          .compile(e.takeoverId, e.drain, token)
          .then((c) => this.dispatch({ type: "compiled", now: this.now(), compiled: c, by: "server" }))
          .catch((err: unknown) => this.dispatch({ type: "compile_failed", now: this.now(), by: "server", code: codeOf(err, "E_INTERNAL"), message: messageOf(err) }));
        return;
      }
      case "compile_local":
        this.compileLocal(e.drain);
        return;
      case "start_va": {
        const va = this.vas[e.attempt];
        if (!va) return this.dispatch({ type: "va_error", now: this.now(), attempt: e.attempt, code: "E_VA_TRANSIENT", retryable: true, message: "no session" });
        va.session.start(e.compiled, { holdAudioUntilCtxMs: e.holdAudioUntilCtxMs }).catch((err: unknown) => {
          const code = codeOf(err, "E_VA_TRANSIENT");
          this.dispatch({ type: "va_error", now: this.now(), attempt: e.attempt, code, retryable: isRetryableVaCode(code), message: messageOf(err) });
        });
        return;
      }
      case "abort_va": {
        const va = this.vas[e.attempt];
        if (!va) return;
        va.off();
        try {
          va.session.endNow(e.reason);
        } catch (err) {
          this.log("warn", "va abort failed", { err: String(err) });
        }
        return;
      }
      case "report_failure": {
        const token = this.takeoverToken;
        if (!token) return;
        this.failureReport = d.api.events(e.takeoverId, { failure: { code: e.code } }, token).catch((err: unknown) => this.log("warn", "failure report failed", { err: String(err) }));
        return;
      }
      case "end_va": {
        const attempt = this.s.pass?.va.attempt ?? 0;
        const va = this.vas[attempt];
        if (!va) return this.dispatch({ type: "va_ended", now: this.now(), attempt, reason: e.reason, sessionSeconds: null });
        va.session.end(e.reason).catch((err: unknown) => {
          this.log("warn", "va end failed", { err: String(err) });
          this.dispatch({ type: "va_ended", now: this.now(), attempt, reason: e.reason, sessionSeconds: null });
        });
        return;
      }
      case "end_va_now": {
        const attempt = this.s.pass?.va.attempt ?? 0;
        const va = this.vas[attempt];
        if (!va) return;
        va.off();
        va.session.endNow(e.reason);
        return;
      }
      case "play_rep_back": {
        const play = d.playRepBack ?? (() => Promise.resolve());
        play()
          .catch((err: unknown) => this.log("warn", "rep line failed", { err: String(err) }))
          .finally(() => this.dispatch({ type: "rep_back_done", now: this.now() }));
        return;
      }
      case "post_events": {
        const token = this.takeoverToken;
        if (!token) return;
        d.api
          .events(e.takeoverId, { ...(e.phase ? { phase: e.phase } : {}), ...(e.timings ? { timings: e.timings } : {}), ...(e.vaSessionId ? { vaSessionId: e.vaSessionId } : {}) }, token)
          .catch((err: unknown) => this.log("warn", "events post failed", { err: String(err) }));
        return;
      }
      case "report_va": {
        const token = this.takeoverToken ?? d.ids.caseToken;
        this.vaReport = d.api
          .reportSession(
            { sessionId: e.liveSessionId, kind: "va", event: e.event, ...(e.providerSessionId ? { providerSessionId: e.providerSessionId } : {}), ...(e.billedSeconds !== undefined ? { billedSeconds: e.billedSeconds } : {}) },
            token,
          )
          .catch((err: unknown) => this.log("warn", "session report failed", { err: String(err) }));
        return;
      }
      case "post_end": {
        const token = this.takeoverToken;
        if (!token) return;
        const body = { outcome: e.outcome, vaSessionId: e.vaSessionId, reason: e.reason };
        if (e.keepalive) {
          d.api.end(e.takeoverId, body, token, { keepalive: true }).catch(() => undefined);
          return;
        }
        void this.vaReport
          .then(() => d.api.end(e.takeoverId, body, token))
          .then((r) => {
            this.verificationJobId = r.verificationJobId;
            for (const cb of [...this.listeners]) cb();
          })
          .catch((err: unknown) => this.log("warn", "end post failed", { err: String(err) }));
        return;
      }
      case "release_run":
        d.api.releaseRun(d.ids.runId, d.ids.caseToken, { keepalive: e.keepalive }).catch((err: unknown) => this.log("warn", "run release failed", { err: String(err) }));
        return;
      case "play_recorded": {
        this.emit({ type: "mode", mode: "recorded_ai", ...(this.s.pass ? { reason: "live_ai_failed" } : { reason: "run_plan" }) });
        this.emit({ type: "fallback", kind: "recorded_ai_session", label: "Recorded AI session (live AI unavailable)" });
        const rec = d.recorded;
        if (!rec) return this.dispatch({ type: "recorded_done", now: this.now() });
        rec
          .play()
          .catch((err: unknown) => this.log("warn", "recorded session failed", { err: String(err) }))
          .finally(() => this.dispatch({ type: "recorded_done", now: this.now() }));
        return;
      }
      case "stop_recorded":
        d.recorded?.stop();
        return;
      case "notice":
        this.notice = { level: e.level, code: e.code, message: e.message };
        if (e.level === "error" && e.code) this.emit({ type: "error", code: e.code, message: e.message });
        return;
    }
  }

  private compileLocal(drain: DrainReport): void {
    // Deferred: the local compile is CPU work and must not run inside the reducer's effect loop.
    queueMicrotask(() => {
      try {
        const c = this.d.localCompile(drain);
        this.dispatch({ type: "compiled", now: this.now(), compiled: c, by: "client" });
      } catch (err) {
        this.dispatch({ type: "compile_failed", now: this.now(), by: "client", code: codeOf(err, "E_VA_CONFIG"), message: messageOf(err) });
      }
    });
  }

  private onVaEvent(attempt: 0 | 1, ev: VaSessionEvent): void {
    const now = this.now();
    switch (ev.type) {
      case "ready":
        return this.dispatch({ type: "va_ready", now, attempt, sessionId: ev.sessionId });
      case "first_audible":
        if (ev.greeting) this.dispatch({ type: "va_first_audible", now, attempt, ctxMs: ev.ctxMs });
        return;
      case "paying":
        return this.dispatch({ type: "va_paying", now, on: ev.on });
      case "hand_back":
        return this.dispatch({ type: "va_hand_back", now, reason: ev.reason });
      case "close_ready":
        return this.dispatch({ type: "va_close_ready", now });
      case "error":
        return this.dispatch({ type: "va_error", now, attempt, code: ev.code, retryable: ev.retryable, message: ev.message });
      case "ended":
        return this.dispatch({ type: "va_ended", now, attempt, reason: ev.reason, sessionSeconds: ev.sessionSeconds });
      default:
        return;
    }
  }
}

function codeOf(err: unknown, fallback: ErrorCode): ErrorCode {
  if (err instanceof TakeoverApiError) return err.code;
  if (isBatonError(err)) return err.code;
  return fallback;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultPageHide(cb: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const h = () => cb();
  window.addEventListener("pagehide", h);
  return () => window.removeEventListener("pagehide", h);
}

export function createTakeoverController(deps: TakeoverControllerDeps): TakeoverControllerImpl {
  return new TakeoverControllerImpl(deps);
}

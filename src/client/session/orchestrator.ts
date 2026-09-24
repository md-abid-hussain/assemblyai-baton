/**
 * client/session/orchestrator.ts - the /call page orchestrator (TASKS WP7 "Provides"):
 *   prepare: /api/status → /api/cases → /api/runs (pre-flight copy from the run plan, D14)
 *   start (click): unlockSync() SYNCHRONOUSLY → load call → STT (live, queued, or labelled cached replay) → play
 *   pass: TakeoverController.arm("manual") (auto-baton and the AI half belong to WP5 / WP5b / WP11)
 *   end: verification polling → QA card; pagehide: release the run hold with a keepalive fetch.
 *
 * The WP4 / WP5 / WP5b / WP11 controllers are injected through `SessionControllers` (wired by the integrator at G2,
 * src/client/session/controllers.ts). Every state change reaches the UI as a BatonEvent or UiAction on the store.
 */
import "client-only";

import type { CreateCaseResponse } from "@/core/contracts/api";
import type { Channel, Evidence } from "@/core/contracts/case";
import { BatonError, isBatonError, type ErrorCode } from "@/core/contracts/errors";
import type { TranscriptLine, UiCallContext } from "@/core/contracts/ext/wp7-ui";
import type { RunPlan } from "@/core/contracts/run";
import { PeaksSchema, type CallManifestEntry } from "@/core/contracts/scenario";
import type {
  AudioEngine, CallPlayback, CaseSync, CustomerInput, EventSink, PageLifecycle, SttChannelManager, Suggestion, TakeoverController,
} from "@/core/contracts/services";
import type { TurnInput } from "@/core/contracts/turns";

import type { ConsoleStore } from "../store/store";
import type { ConsoleActions } from "./actions";
import type { SessionApi } from "./api";
import { createEvidencePlayer } from "./evidence";

/** DESIGN §5.1.6: Express starts 25 s before the decision point (WP4's express.ts snaps it to a turn start/gap). */
export const EXPRESS_LEAD_MS = 25_000;
export const defaultExpressOffset = (call: Pick<CallManifestEntry, "decisionPointMs">): number | null =>
  call.decisionPointMs === null ? null : Math.max(0, call.decisionPointMs - EXPRESS_LEAD_MS);

// ------------------------------------------------------------------------------------------------ injected controllers

export interface SessionContext {
  sink: EventSink;
  create: CreateCaseResponse;
  plan: RunPlan;
  call: CallManifestEntry;
  startOffsetMs: number;
  now: () => number;
  /** For CaseSync / STT: finals after the arm carry late:true. */
  takeoverState: () => { armed: boolean; tArmMs: number | null };
}

export interface CachedReplayLike {
  ensureLoaded(): Promise<void>;
  activate(channels: "both" | Channel, fromMs: number, reason: string): void;
}

export type SttManagerLike = SttChannelManager & { finishAfterSilence?(ms: number): Promise<void>; dispose?(): void };

export type AudioEngineLike = AudioEngine & { whenRunning?(timeoutMs: number): Promise<boolean> };

export interface TakeoverControllerLike extends TakeoverController {
  /** Fired once per takeover when it reaches DONE / FAILED (for the QA verification poll). */
  onEnded?(cb: (e: { takeoverId: string; takeoverToken: string; outcome: string }) => void): () => void;
  dispose?(): void;
}

export interface SessionControllers {
  engine(): AudioEngineLike;
  lifecycle(): PageLifecycle & { attachContext?(ctx: AudioContext): void };
  createCaseSync(c: SessionContext): CaseSync;
  createCachedReplay(c: SessionContext & { caseSync: CaseSync }): CachedReplayLike;
  createStt(c: SessionContext & { caseSync: CaseSync; cached: CachedReplayLike }): SttManagerLike;
  createTakeover(c: SessionContext & { playback: CallPlayback; stt: SttManagerLike; caseSync: CaseSync }): TakeoverControllerLike;
  createCustomerInput?(c: SessionContext): CustomerInput;
  /** "Ask for Daniel": reply.create instructions forcing hand_back_to_rep (WP5b controller). */
  askForRep?(): void;
  /** The user's "End call" in the AI half. */
  endCall?(): void;
  /** AI-half evidence clips (WP8 audio route). */
  playAiClip?(ev: Evidence, w: { fromMs: number; toMs: number }): Promise<void>;
}

// ------------------------------------------------------------------------------------------------ session

export interface CallSessionOptions {
  callId: string;
  api: SessionApi;
  store: ConsoleStore;
  controllers: SessionControllers | null;
  /** The page clock (BatonEvent.t). */
  now?: () => number;
  /** The manifest entry when the page already has it (lets prepare() create the Express case up front). */
  call?: CallManifestEntry | null;
  expressOffset?: (call: CallManifestEntry) => number | null;
  /** Poll GET /api/verifications/[id] every … ms (DESIGN S3: verified ≈15–25 s after the end). */
  verifyPollMs?: number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
}

export class CallSession implements ConsoleActions {
  private readonly now: () => number;
  private create: CreateCaseResponse | null = null;
  private plan: RunPlan | null = null;
  private prefillUntilMs = 0;
  private playback: CallPlayback | null = null;
  private stt: SttManagerLike | null = null;
  private caseSync: CaseSync | null = null;
  private cached: CachedReplayLike | null = null;
  private takeover: TakeoverControllerLike | null = null;
  private customer: CustomerInput | null = null;
  private engine: AudioEngineLike | null = null;
  private lifecycle: (PageLifecycle & { attachContext?(ctx: AudioContext): void }) | null = null;
  private unsubs: (() => void)[] = [];
  private startOffsetMs = 0;
  private armedCallMs: number | null = null;
  private released = false;
  private lastClockAt = -Infinity;
  private disposed = false;
  private playEv: ((ev: Evidence) => Promise<unknown>) | null = null;

  constructor(private readonly o: CallSessionOptions) {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    this.now = o.now ?? (() => (typeof performance !== "undefined" ? performance.now() - t0 : 0));
  }

  private get store(): ConsoleStore {
    return this.o.store;
  }
  private fail(code: ErrorCode, message: string): void {
    this.store.dispatch({ t: this.now(), type: "error", code, message });
  }
  private failFrom(e: unknown): void {
    if (isBatonError(e)) this.fail(e.code, e.message);
    else this.fail("E_INTERNAL", e instanceof Error ? e.message : "Unexpected error.");
  }

  // ---------------------------------------------------------------- pre-flight

  async prepare(): Promise<void> {
    const { api } = this.o;
    try {
      const status = await api.status();
      const call = this.o.call ?? null;
      const prefill = call ? ((this.o.expressOffset ?? defaultExpressOffset)(call) ?? 0) : 0;
      await this.createCaseAndRun(prefill, prefill > 0, status?.limits.sttOpensPerMin);
    } catch (e) {
      this.failFrom(e);
    }
  }

  private async createCaseAndRun(prefillUntilMs: number, express: boolean, sttOpensPerMin?: number): Promise<void> {
    const { api, callId } = this.o;
    const create = await api.createCase({ mode: "watch", callId, ...(prefillUntilMs > 0 ? { prefillUntilMs } : {}) });
    this.create = create;
    this.prefillUntilMs = prefillUntilMs;
    const call = create.call;
    if (!call) throw new BatonError("E_NOT_FOUND", "This call has no playable audio.");
    let peaks: UiCallContext["peaks"] = null;
    try {
      peaks = PeaksSchema.parse(await api.peaks(create.assets.peaks));
    } catch {
      peaks = null; // the timeline renders without a waveform
    }
    const context: UiCallContext = {
      callId: call.callId,
      title: call.title,
      callDate: create.policy.callDate,
      durationMs: call.durationMs,
      source: call.source,
      language: call.language,
      decisionPointMs: call.decisionPointMs,
      handoff: call.handoff,
      hasRecordedAiBundle: !!call.recordedAiBundle,
      policy: create.policy,
      peaks,
      ...(sttOpensPerMin !== undefined ? { sttOpensPerMin } : {}),
    };
    const t = this.now();
    this.store.act({ t, type: "ui.context", context });
    this.store.dispatch({ t, type: "call.loaded", callId: call.callId, durationMs: call.durationMs });
    this.store.dispatch({ t, type: "case.state", state: create.state });
    this.plan = await api.startRun({ caseId: create.caseId, callId: call.callId, express }, create.caseToken);
    this.released = false;
    this.store.dispatch({ t: this.now(), type: "run.plan", plan: this.plan });
  }

  // ---------------------------------------------------------------- start (click)

  /** MUST be called synchronously from the click handler: the audio unlock happens before any await (§7.6). */
  start(kind: "express" | "full"): void {
    const c = this.o.controllers;
    if (!c) {
      this.fail("E_INTERNAL", "Live playback is not wired into this build yet. Open a fixture from /dev/ui instead.");
      return;
    }
    this.engine = c.engine();
    this.engine.unlockSync();
    this.lifecycle = c.lifecycle();
    this.lifecycle.attachContext?.(this.engine.ctx);
    void this.startAsync(kind);
  }

  private async startAsync(kind: "express" | "full"): Promise<void> {
    const c = this.o.controllers as SessionControllers;
    const engine = this.engine as AudioEngineLike;
    try {
      if (engine.whenRunning && !(await engine.whenRunning(300))) this.store.act({ t: this.now(), type: "ui.audio-locked", locked: true });
      if (!this.create || !this.plan) throw new Error("The call is not ready yet.");
      const call0 = this.create.call as CallManifestEntry;
      const expressAt = (this.o.expressOffset ?? defaultExpressOffset)(call0);
      const wantPrefill = kind === "express" && expressAt !== null ? expressAt : 0;
      if (wantPrefill !== this.prefillUntilMs) {
        // Express needs a case created with prefillUntilMs; the full call needs one without (§5.1.6).
        const old = this.plan;
        await this.o.api.releaseRun(old.runId, this.create.caseToken);
        await this.createCaseAndRun(wantPrefill, kind === "express");
      }
      const create = this.create;
      const plan = this.plan;
      const call = create.call as CallManifestEntry;
      this.startOffsetMs = kind === "express" ? this.prefillUntilMs : 0;
      this.store.act({ t: this.now(), type: "ui.start", kind, startOffsetMs: this.startOffsetMs });

      const ctx: SessionContext = {
        sink: this.store,
        create,
        plan,
        call,
        startOffsetMs: this.startOffsetMs,
        now: this.now,
        takeoverState: () => ({ armed: this.armedCallMs !== null, tArmMs: this.armedCallMs }),
      };
      const playback = await engine.loadCall(call, create.assets, undefined);
      this.playback = playback;
      const caseSync = c.createCaseSync(ctx);
      const cached = c.createCachedReplay({ ...ctx, caseSync });
      void cached.ensureLoaded().catch(() => {});
      const stt = c.createStt({ ...ctx, caseSync, cached });
      this.caseSync = caseSync;
      this.cached = cached;
      this.stt = stt;
      this.playEv = createEvidencePlayer({
        playback,
        durationMs: call.durationMs,
        turnOf: (id) => this.turnOf(id),
        ...(c.playAiClip ? { playAiClip: c.playAiClip } : {}),
      });

      this.unsubs.push(
        playback.onTick((tick) => {
          stt.feed(tick);
          const t = this.now();
          if (t - this.lastClockAt >= 250) {
            this.lastClockAt = t;
            this.store.act({ t, type: "ui.clock", callMs: tick.callMs, playing: tick.playing });
          }
        }),
        playback.onEnded(() => void this.onRecordingEnded()),
      );
      const lc = this.lifecycle;
      if (lc) {
        this.unsubs.push(
          lc.onPause((reason) => {
            void stt.pause();
            this.store.dispatch({ t: this.now(), type: "paused", reason, resumed: false });
          }),
        );
      }

      if (plan.sttHalf === "cached") cached.activate("both", this.startOffsetMs, plan.reason ?? "live transcription is unavailable");
      else {
        const r = await stt.open({
          caseId: create.caseId,
          caseToken: create.caseToken,
          runId: plan.runId,
          call,
          policy: create.policy,
          startOffsetMs: this.startOffsetMs,
          ctxCarry: "last_rep_turn",
        });
        if (r === "denied") cached.activate("both", this.startOffsetMs, "live transcription was refused");
      }

      const takeover = c.createTakeover({ ...ctx, playback, stt, caseSync });
      this.takeover = takeover;
      if (takeover.onEnded) this.unsubs.push(takeover.onEnded((e) => void this.pollVerification(e.takeoverId, e.takeoverToken)));
      this.unsubs.push(
        this.store.subscribe(() => {
          const s = this.store.getState();
          if (s.takeover.tArmMs !== null && this.armedCallMs === null) this.armedCallMs = s.takeover.tArmMs;
        }),
      );
      if (c.createCustomerInput) {
        const ci = c.createCustomerInput(ctx);
        this.customer = ci;
        let lastIds = "";
        this.unsubs.push(
          this.store.subscribe(() => {
            const items: Suggestion[] = ci.suggestions();
            const ids = items.map((x) => x.id).join("|");
            if (ids !== lastIds) {
              lastIds = ids;
              this.store.act({ t: this.now(), type: "ui.suggestions", items });
            }
          }),
        );
      }
      playback.start(this.startOffsetMs);
    } catch (e) {
      this.failFrom(e);
    }
  }

  private turnOf(id: string): TurnInput | null {
    return this.store.getState().human.find((l) => l.turnId === id)?.turn ?? null;
  }

  private async onRecordingEnded(): Promise<void> {
    if (this.store.getState().takeover.armedT !== null) return;
    await this.stt?.finishAfterSilence?.(1500);
    this.store.act({ t: this.now(), type: "ui.call-ended" });
    await this.releaseHold(false);
  }

  private async releaseHold(keepalive: boolean): Promise<void> {
    if (this.released || !this.plan || !this.create) return;
    this.released = true;
    await this.o.api.releaseRun(this.plan.runId, this.create.caseToken, keepalive);
  }

  /** S3: poll #20 until verified / failed; "delayed" copy after 60 s is the QA card's job. */
  async pollVerification(takeoverId: string, token: string): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((r) => (this.o.setTimeout ?? setTimeout)(() => r(), ms));
    const every = this.o.verifyPollMs ?? 2500;
    this.store.act({ t: this.now(), type: "ui.qa-status", status: "waiting" });
    for (let i = 0; i < 60 && !this.disposed; i++) {
      try {
        const v = await this.o.api.verification(takeoverId, token);
        if (v.status === "completed" && v.qa) {
          this.store.dispatch({ t: this.now(), type: "qa", qa: v.qa });
          return;
        }
        if (v.status === "failed") {
          this.store.act({ t: this.now(), type: "ui.qa-status", status: "failed", ...(v.reason ? { reason: v.reason } : {}) });
          return;
        }
      } catch {
        /* transient: keep polling */
      }
      await sleep(every);
    }
    this.store.act({ t: this.now(), type: "ui.qa-status", status: "failed", reason: "verification took too long" });
  }

  // ---------------------------------------------------------------- actions

  pass(): void {
    const tk = this.takeover;
    if (!tk || !tk.manualPassAllowed) return;
    void tk.arm("manual").catch((e: unknown) => this.failFrom(e));
  }

  stopPlayback(): void {
    this.playback?.stop(30);
    this.store.act({ t: this.now(), type: "ui.clock", callMs: this.playback?.callMs ?? 0, playing: false });
  }

  resume(): void {
    this.engine?.unlockSync();
    void this.stt?.resume();
    this.store.dispatch({ t: this.now(), type: "paused", reason: "ios_background", resumed: true });
  }

  watchCachedNow(): void {
    const s = this.store.getState();
    void this.stt?.terminateAll();
    this.cached?.activate("both", Math.max(this.startOffsetMs, s.clock.callMs), "you chose the cached replay instead of waiting");
  }

  retry(): void {
    if (typeof window !== "undefined") window.location.reload();
  }

  watchReplay(): void {
    const bundle = this.create?.call?.recordedAiBundle;
    if (bundle && typeof window !== "undefined") window.location.assign(`${window.location.pathname}?replay=${encodeURIComponent(bundle)}`);
  }

  async playEvidence(ev: Evidence): Promise<void> {
    await this.playEv?.(ev);
  }

  async playTurn(line: TranscriptLine): Promise<void> {
    if (line.startMs === null || line.endMs === null || (line.lane !== "rep" && line.lane !== "customer")) return;
    const p = this.playback;
    if (!p) return;
    p.duck(0.2);
    try {
      await p.playSpan(line.lane, line.startMs, line.endMs);
    } finally {
      p.duck(1);
    }
  }

  setAutopilot(on: boolean): void {
    this.customer?.setAutopilot(on);
    this.store.act({ t: this.now(), type: "ui.autopilot", on });
  }

  async playSuggestion(s: Suggestion): Promise<void> {
    this.setAutopilot(false);
    await this.customer?.play(s);
  }

  async sendTyped(text: string): Promise<void> {
    this.setAutopilot(false);
    await this.customer?.sendTyped(text);
  }

  async toggleMic(on: boolean): Promise<boolean> {
    if (!on || !this.customer) return false;
    this.setAutopilot(false);
    const ok = await this.customer.enableMic();
    if (!ok) this.fail("E_MIC_DENIED", "The microphone is blocked: autopilot, the reply chips and typing still work.");
    return ok;
  }

  askForDaniel(): void {
    this.o.controllers?.askForRep?.();
  }

  endCall(): void {
    this.o.controllers?.endCall?.();
  }

  unlockAudio(): void {
    this.engine?.unlockSync();
    this.store.act({ t: this.now(), type: "ui.audio-locked", locked: false });
  }

  /** pagehide: release the VA hold (keepalive fetch) unless a takeover owns it; stop STT. The takeover controller handles its own pagehide. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.store.getState().takeover.armedT === null) void this.releaseHold(true);
    this.stt?.dispose?.();
    for (const u of this.unsubs.splice(0)) u();
    this.playback?.dispose();
  }
}

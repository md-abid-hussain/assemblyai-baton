/**
 * client/session/orchestrator.ts - the /call page orchestrator (TASKS WP7 "Provides", TASKS-v2 WP7 "By G2"):
 *   prepare: /api/status → Express start (WP4 `expressStart`: decision point − 25 s snapped to a clean cut, over the
 *            cached turns + peaks) → /api/cases {prefillUntilMs = the cut} → /api/runs {express} (pre-flight, D14)
 *   start (click): unlockSync() SYNCHRONOUSLY → load call → CaseSync + cached replay + STT (live, queued, or labelled
 *            cached replay) → TakeoverController (WP5; auto-baton in Watch mode) → play from the cut
 *   pass:  unlockSync() + TakeoverController.arm("manual") (WP5 → WP5b Voice Agent)
 *   end:   WP5 posts /end → verificationJobId → poll #20 with the takeover token → QA card ("✓ Verified from recording")
 *   pagehide: WP5's controller ends the VA, terminates STT and releases the run (keepalive); before a takeover
 *            controller exists the orchestrator releases the run hold itself.
 *
 * The WP4 / WP5 / WP5b (/ WP11) objects come from `SessionControllers` (src/client/session/wiring.ts builds the real
 * ones; tests inject fakes). Every state change reaches the UI as a BatonEvent or UiAction on the store.
 */
import "client-only";


import type { CaseState, Channel, Evidence } from "@/core/contracts/case";
import { CachedTurnsFileSchema, type CachedTurnsFile } from "@/core/contracts/eval";
import { BatonError, isBatonError, type ErrorCode } from "@/core/contracts/errors";
import type { BatonEvent } from "@/core/contracts/events";
import type { TakeoverControllerExt } from "@/core/contracts/ext/wp5-takeover";
import type { TranscriptLine, UiCallContext } from "@/core/contracts/ext/wp7-ui";
import type { RunPlan } from "@/core/contracts/run";
import { PeaksSchema, type CallManifestEntry, type Peaks } from "@/core/contracts/scenario";
import type {
  AudioEngine, CallPlayback, CaseSync, CustomerInput, EventSink, MicSource, PageLifecycle, PhoneState, SttChannelManager, Suggestion,
} from "@/core/contracts/services";
import type { TurnInput } from "@/core/contracts/turns";
import type { ProvenanceStrip } from "@/core/contracts/v2/api";

import { expressStart, EXPRESS_LEAD_MS, type ExpressStart } from "../stt/express";
import type { ConsoleStore } from "../store/store";
import type { ConsoleActions } from "./actions";
import type { CreatedCase, SessionApi } from "./api";
import { createEvidencePlayer } from "./evidence";
import { provisionalQa } from "./provisional-qa";

export { EXPRESS_LEAD_MS };

/** The unsnapped Express target (DESIGN §5.1.6); the real start is `expressStart()`'s snapped cut. */
export const defaultExpressOffset = (call: Pick<CallManifestEntry, "decisionPointMs">): number | null =>
  call.decisionPointMs === null ? null : Math.max(0, call.decisionPointMs - EXPRESS_LEAD_MS);

/** `public/data/cached-turns/<callId>.json` (WP9 writes it; the server's `cachedTurnsUrl` is the same path). */
export const cachedTurnsUrlFor = (callId: string): string => `/data/cached-turns/${encodeURIComponent(callId)}.json`;

const CHANNELS: readonly Channel[] = ["rep", "customer"];

// ------------------------------------------------------------------------------------------------ injected controllers

export interface SessionContext {
  /** The page sink: the store, plus `stt.final` → `TakeoverController.noteFinal` (WP5 §6.2). */
  sink: EventSink;
  create: CreatedCase;
  plan: RunPlan;
  call: CallManifestEntry;
  startOffsetMs: number;
  now: () => number;
  /** WP4's `takeover` option (STT/CachedReplay `late` flag) = the takeover controller's `armInfo()`, late-bound. */
  takeoverState: () => { armed: boolean; tArmMs: number | null };
  /** `/api/status` deployId (the local-compile fallback's marker); null when status was unavailable. */
  deployId: string | null;
  /** Watch mode: auto-baton on (WP5 rule 6). */
  mode: "watch" | "live";
  /** The latest case state on the page (the VA's stage source for paid → close). */
  caseState: () => CaseState | null;
}

export interface CachedReplayLike {
  ensureLoaded(): Promise<unknown>;
  activate(channels: "both" | Channel, fromMs: number, reason: string): void;
}

export type SttManagerLike = SttChannelManager & {
  finishAfterSilence?(ms: number): Promise<unknown>;
  dispose?(): void;
  readonly providerSessionIds?: Partial<Record<Channel, string>>;
};

export type AudioEngineLike = AudioEngine & { whenRunning?(timeoutMs: number): Promise<boolean> };

export type LifecycleLike = PageLifecycle & { onResume?(cb: () => void): () => void; attachContext?(ctx: AudioContext): void };

/** The human half's listening objects (WP4), built together so the STT manager gets the concrete cached replay. */
export interface HumanHalf {
  caseSync: CaseSync;
  cached: CachedReplayLike;
  stt: SttManagerLike;
}

/** One page's takeover (WP5 controller + what the orchestrator needs around it). */
export interface TakeoverHandle {
  ctl: TakeoverControllerExt;
  /** The current pass's takeover token (from POST /api/takeovers): #20 verification polls, #21 audio. */
  token(): string | null;
  /** "Ask for {rep}" during the AI half: reply.create forcing hand_back_to_rep (WP5b `say`). */
  askForRep(): void;
  /** WP4's provider session ids → the HUD (WP5b). */
  setSessionIds?(ids: { rep?: string; customer?: string; va?: string }): void;
  /** The current pass's pay link (route #14 `ui.paymentId`) for the MockPhone; null before the pay tool ran. */
  paymentId?(): string | null;
  /** MockPhone `onState` → `VoiceAgentController.setPayingState` (the progress-aware hold, DESIGN §5.8). */
  setPhoneState?(s: PhoneState): void;
  /** The judge's mic as the customer in the AI half (DESIGN §1.3 P1 step 5), when WP11's CustomerInput is absent. */
  setMicSource?(src: MicSource | null): void;
}

/** What the page's MockPhone needs besides the events (WP6 `MockPhoneProps`). */
export interface PhoneAuth {
  paymentId: string | null;
  takeoverToken: string;
  visitorToken: string | null;
}

export interface SessionControllers {
  engine(): AudioEngineLike;
  lifecycle(): LifecycleLike;
  createHumanHalf(c: SessionContext): HumanHalf;
  createTakeover(c: SessionContext & { engine: AudioEngineLike; playback: CallPlayback; lifecycle: LifecycleLike | null } & HumanHalf): TakeoverHandle;
  createCustomerInput?(c: SessionContext): CustomerInput;
  /** AI-half evidence clips (WP8 route #21 with the takeover token; src/client/session/ai-clip.ts). */
  playAiClip?(ev: Evidence, w: { fromMs: number; toMs: number }, auth: { takeoverToken: string | null; vaSessionId: string | null }): Promise<void>;
}

// ------------------------------------------------------------------------------------------------ session

export interface CallSessionOptions {
  callId: string;
  /**
   * The relay version this run pins (PLATFORM §7.6 `RelayConsole`): a gallery relay, a Try-an-edit preset or a
   * draft. Null (the flagship) creates the case exactly as before.
   */
  relayVersionId?: string | null;
  /**
   * The call manifest's own provenance (`src/generated/call-provenance.json`, read on the server by the page).
   * It overrides the server's human-half segment, so a generated take is never labelled a recording (WP9 contract
   * `ext/wp9-data.ts`; G2b open item §6.1).
   */
  callProvenance?: { humanHalf: "recorded" | "simulated"; detail: string } | null;
  api: SessionApi;
  store: ConsoleStore;
  controllers: SessionControllers | null;
  /** The page clock (BatonEvent.t). */
  now?: () => number;
  /** The manifest entry when the page already has it (lets prepare() create the Express case up front). */
  call?: CallManifestEntry | null;
  /** What prepare() gets ready for: Express (default, TASKS-v2 WP7) or the full call. */
  defaultStart?: "express" | "full";
  /** Poll GET /api/verifications/[id] every … ms (WP8: ~1.5 s; the route allows 1/s, a 429 is harmless). */
  verifyPollMs?: number;
  /** Give up on the verification after … ms (WP8: ~150 s). */
  verifyTimeoutMs?: number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

type StartKind = "express" | "full";

export class CallSession implements ConsoleActions {
  private readonly now: () => number;
  private create: CreatedCase | null = null;
  private plan: RunPlan | null = null;
  private deployId: string | null = null;
  private prefillUntilMs = 0;
  private express: ExpressStart | null = null;
  private expressComputed = false;
  private peaks: Peaks | null = null;
  private playback: CallPlayback | null = null;
  private human: HumanHalf | null = null;
  private handle: TakeoverHandle | null = null;
  private customer: CustomerInput | null = null;
  private engine: AudioEngineLike | null = null;
  private lifecycle: LifecycleLike | null = null;
  private unsubs: (() => void)[] = [];
  private startOffsetMs = 0;
  private started = false;
  private playing = false;
  private released = false;
  private lastClockAt = -Infinity;
  private disposed = false;
  private polling = false;
  private sttReady: (() => void) | null = null;
  private playEv: ((ev: Evidence) => Promise<unknown>) | null = null;
  private mic: MicSource | null = null;
  /** The case state the AI inherited, per pass (captured once the drain is over), for the provisional QA. */
  private passSnapshot: { pass: number; state: CaseState } | null = null;
  private provisionalFor = -1;
  /** The signed visitor token for cookie-less browsers (CreateCaseResponse.visitorToken). */
  visitorToken: string | undefined;

  constructor(private readonly o: CallSessionOptions) {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    this.now = o.now ?? (() => (typeof performance !== "undefined" ? performance.now() - t0 : 0));
  }

  private get store(): ConsoleStore {
    return this.o.store;
  }
  private log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
    this.o.log?.(level, msg, data);
  }
  private fail(code: ErrorCode, message: string): void {
    this.store.dispatch({ t: this.now(), type: "error", code, message });
  }
  private failFrom(e: unknown): void {
    if (isBatonError(e)) this.fail(e.code, e.message);
    else this.fail("E_INTERNAL", e instanceof Error ? e.message : "Unexpected error.");
  }

  /** The takeover controller (WP5) once the run started; null before. */
  get takeover(): TakeoverControllerExt | null {
    return this.handle?.ctl ?? null;
  }

  // ---------------------------------------------------------------- pre-flight

  async prepare(): Promise<void> {
    const { api } = this.o;
    try {
      const status = await api.status();
      this.deployId = status?.deployId ?? null;
      const call = this.o.call ?? null;
      let prefill = 0;
      if (call && (this.o.defaultStart ?? "express") === "express") prefill = (await this.expressFor(call))?.startOffsetMs ?? 0;
      await this.createCaseAndRun(prefill, status?.limits.sttOpensPerMin);
    } catch (e) {
      this.failFrom(e);
    }
  }

  /** WP4's Express cut for this call (cached turns + peaks; either may be missing → a less exact or unsnapped cut). */
  private async expressFor(call: CallManifestEntry): Promise<ExpressStart | null> {
    if (this.expressComputed) return this.express;
    this.expressComputed = true;
    if (call.decisionPointMs === null) return (this.express = null);
    const [cachedRaw, peaksRaw] = await Promise.all([
      this.o.api.getJson(this.create?.cachedTurnsUrl ?? cachedTurnsUrlFor(call.callId)),
      call.assets ? this.o.api.getJson(call.assets.peaks) : Promise.resolve(null),
    ]);
    const cached: CachedTurnsFile | null = cachedRaw ? (CachedTurnsFileSchema.safeParse(cachedRaw).data ?? null) : null;
    const peaks = peaksRaw ? (PeaksSchema.safeParse(peaksRaw).data ?? null) : null;
    if (peaks) this.peaks = peaks;
    const ex = expressStart(call, cached, peaks);
    this.log("info", "express start", { target: ex.targetMs, start: ex.startOffsetMs, snappedTo: ex.snappedTo, inFlight: ex.inFlight });
    this.express = ex.startOffsetMs > 0 ? ex : null;
    return this.express;
  }

  private async createCaseAndRun(prefillUntilMs: number, sttOpensPerMin?: number): Promise<void> {
    const { api, callId } = this.o;
    const relayVersionId = this.o.relayVersionId ?? null;
    const create = await api.createCase({
      mode: "watch",
      callId,
      ...(prefillUntilMs > 0 ? { prefillUntilMs } : {}),
      ...(relayVersionId ? { relayVersionId } : {}),
    });
    this.create = create;
    if (create.visitorToken) this.visitorToken = create.visitorToken;
    this.prefillUntilMs = prefillUntilMs;
    const call = create.call;
    if (!call) throw new BatonError("E_NOT_FOUND", "This call has no playable audio.");
    if (!this.peaks) {
      const raw = await api.getJson(create.assets.peaks);
      this.peaks = raw ? (PeaksSchema.safeParse(raw).data ?? null) : null; // the timeline renders without a waveform
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
      peaks: this.peaks,
      ...(sttOpensPerMin !== undefined ? { sttOpensPerMin } : {}),
    };
    const t = this.now();
    this.store.act({ t, type: "ui.context", context });
    this.store.act({
      t,
      type: "ui.relay",
      relay: create.relay ?? null,
      provenance: this.provenanceOf(create.provenance ?? null),
      account: create.account ?? null,
    });
    this.store.dispatch({ t, type: "call.loaded", callId: call.callId, durationMs: call.durationMs });
    this.store.dispatch({ t, type: "case.state", state: create.state });
    this.plan = await api.startRun({ caseId: create.caseId, callId: call.callId, express: prefillUntilMs > 0 }, create.caseToken);
    this.released = false;
    this.store.dispatch({ t: this.now(), type: "run.plan", plan: this.plan });
  }

  /**
   * The run's provenance strip: what the server stated, with the call manifest's own human half laid over it. The
   * manifest wins, because it is the only record of how the audio was made; a generated take must never be shown
   * as a recording (PLATFORM §7.6, WP9 `ext/wp9-data.ts`).
   */
  private provenanceOf(server: ProvenanceStrip | null): ProvenanceStrip | null {
    const local = this.o.callProvenance ?? null;
    if (!server && !local) return null;
    const base: ProvenanceStrip = server ?? {
      humanHalf: "recorded",
      transcription: { kind: "live", date: null },
      aiHalf: { kind: "live", date: null },
      customerInAiHalf: "recorded",
      detail: null,
    };
    if (local?.humanHalf !== "simulated" || base.humanHalf === "text_dry_run") return base;
    return {
      ...base,
      humanHalf: "simulated",
      // A simulated human half has no recorded customer to answer the AI: the stand-in voice does.
      customerInAiHalf: base.customerInAiHalf === "recorded" ? "synthetic" : base.customerInAiHalf,
      detail: local.detail,
    };
  }

  // ---------------------------------------------------------------- start (click)

  /** MUST be called synchronously from the click handler: the audio unlock happens before any await (§7.6). */
  start(kind: StartKind): void {
    const c = this.o.controllers;
    if (!c) {
      this.fail("E_INTERNAL", "Live playback is not available in this build. Open a fixture from /dev/ui instead.");
      return;
    }
    if (this.started) return;
    this.started = true;
    try {
      this.engine = c.engine();
      this.engine.unlockSync();
      this.lifecycle = c.lifecycle();
      this.lifecycle.attachContext?.(this.engine.ctx);
    } catch (e) {
      // No Web Audio / no AudioWorklet (insecure context): nothing can play.
      this.started = false;
      this.fail("E_INTERNAL", `This browser cannot play the call: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    void this.startAsync(kind);
  }

  private async startAsync(kind: StartKind): Promise<void> {
    const c = this.o.controllers as SessionControllers;
    const engine = this.engine as AudioEngineLike;
    try {
      if (engine.whenRunning && !(await engine.whenRunning(300))) this.store.act({ t: this.now(), type: "ui.audio-locked", locked: true });
      if (!this.create || !this.plan) throw new BatonError("E_INTERNAL", "The call is not ready yet. Reload the page and try again.");
      let want = 0;
      if (kind === "express") want = (await this.expressFor(this.create.call as CallManifestEntry))?.startOffsetMs ?? 0;
      if (want !== this.prefillUntilMs) {
        // Express needs a case created with prefillUntilMs = the cut; the full call needs one without (§5.1.6).
        await this.o.api.releaseRun(this.plan.runId, this.create.caseToken);
        await this.createCaseAndRun(want);
      }
      const create = this.create;
      const plan = this.plan;
      const call = create.call as CallManifestEntry;
      this.startOffsetMs = want;
      this.store.act({ t: this.now(), type: "ui.start", kind: want > 0 ? "express" : "full", startOffsetMs: this.startOffsetMs });

      const sink: EventSink = {
        emit: (ev: BatonEvent) => {
          this.store.dispatch(ev);
          if (ev.type === "stt.final") {
            const tk = this.handle?.ctl;
            tk?.noteFinal({ turnId: ev.turn.turnId, channel: ev.turn.channel, startMs: ev.turn.startMs, endMs: ev.turn.endMs });
          }
        },
      };
      const ctx: SessionContext = {
        sink,
        create,
        plan,
        call,
        startOffsetMs: this.startOffsetMs,
        now: this.now,
        takeoverState: () => this.handle?.ctl.armInfo() ?? { armed: false, tArmMs: null },
        deployId: this.deployId,
        mode: "watch",
        caseState: () => this.store.getState().caseState ?? this.human?.caseSync.state ?? null,
      };
      const playback = await engine.loadCall(call, create.assets, undefined);
      this.playback = playback;
      const human = c.createHumanHalf(ctx);
      this.human = human;
      void human.cached.ensureLoaded().catch(() => {}); // prefetch: any fallback needs it
      const handle = c.createTakeover({ ...ctx, ...human, engine, playback, lifecycle: this.lifecycle });
      this.handle = handle;
      this.playEv = createEvidencePlayer({
        playback,
        durationMs: call.durationMs,
        turnOf: (id) => this.turnOf(id),
        ...(c.playAiClip
          ? {
              playAiClip: (ev, w) =>
                (c.playAiClip as NonNullable<SessionControllers["playAiClip"]>)(ev, w, {
                  takeoverToken: handle.token(),
                  vaSessionId: handle.ctl.view().pass?.vaSessionId ?? this.store.getState().sessionIds.va ?? null,
                }),
            }
          : {}),
      });

      const { stt } = human;
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
        handle.ctl.subscribe(() => this.onTakeoverView()),
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
      if (c.createCustomerInput) this.mountCustomerInput(c.createCustomerInput(ctx));

      if (plan.sttHalf === "cached") human.cached.activate("both", this.startOffsetMs, plan.reason ?? "live transcription is unavailable");
      else {
        const r = await stt.open({
          caseId: create.caseId,
          caseToken: create.caseToken,
          runId: plan.runId,
          call,
          policy: create.policy,
          startOffsetMs: this.startOffsetMs,
          ctxCarry: "last_rep_turn",
          ...(this.express?.seedAgentContext && this.startOffsetMs > 0 ? { seedAgentContext: this.express.seedAgentContext } : {}),
          // A relay other than the flagship listens with its own prompt and keyterms; Baton keeps route #5's params.
          ...(create.listening && create.relay && !create.relay.relay.flagship ? { listening: create.listening } : {}),
        });
        // "denied": the manager already switched every channel to the labelled cached replay (WP4 toCached).
        if (r === "queued") await this.waitForStt(stt);
        this.publishSessionIds();
      }
      if (this.disposed) return;
      this.playing = true;
      playback.start(this.startOffsetMs);
    } catch (e) {
      this.failFrom(e);
    }
  }

  /** DESIGN §1.4 `queued`: playback waits until both channels are live (or fell back to cached, or the judge chose it). */
  private waitForStt(stt: SttManagerLike): Promise<void> {
    const ready = () => CHANNELS.every((ch) => stt.status[ch] !== "queued" && stt.status[ch] !== "idle");
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let off: () => void = () => {};
      const done = () => {
        off();
        this.sttReady = null;
        resolve();
      };
      this.sttReady = done;
      off = this.store.subscribe(() => {
        if (ready() || this.disposed) done();
      });
      this.unsubs.push(off);
    });
  }

  private publishSessionIds(): void {
    const ids = this.human?.stt.providerSessionIds;
    if (!ids || (!ids.rep && !ids.customer)) return;
    const v = { ...(ids.rep ? { rep: ids.rep } : {}), ...(ids.customer ? { customer: ids.customer } : {}) };
    this.store.act({ t: this.now(), type: "ui.session-ids", ids: v });
    this.handle?.setSessionIds?.(v);
  }

  private mountCustomerInput(ci: CustomerInput): void {
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

  private turnOf(id: string): TurnInput | null {
    return this.store.getState().human.find((l) => l.turnId === id)?.turn ?? null;
  }

  /** The takeover view changed: snapshot at compile, provisional QA at the end, then poll #20 once (WP8). */
  private onTakeoverView(): void {
    const h = this.handle;
    if (!h) return;
    const v = h.ctl.view();
    const st = this.store.getState();
    // WP5's info notices (e.g. "live AI unavailable, the recorded session plays") as the top bar's soft line; its
    // error notices already arrive as `error` events.
    const info = v.notice?.level === "info" ? v.notice.message : null;
    if (info && info !== st.notice) this.store.act({ t: this.now(), type: "ui.notice", message: info });
    if (["compiling", "connecting", "greeting", "active"].includes(v.phase) && this.passSnapshot?.pass !== v.passes && st.caseState) {
      this.passSnapshot = { pass: v.passes, state: st.caseState };
    }
    if (v.phase === "done" && this.provisionalFor !== v.passes && !st.qa.verified) {
      // DESIGN S3: provisional numbers right away, from the agent's own captions; WP8's verified result replaces them.
      this.provisionalFor = v.passes;
      const snap = this.passSnapshot?.pass === v.passes ? this.passSnapshot.state : null;
      try {
        const qa = provisionalQa(st, snap);
        if (qa) this.store.dispatch({ t: this.now(), type: "qa", qa });
      } catch (e) {
        this.log("warn", "provisional QA failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (this.polling) return;
    const id = v.pass?.takeoverId ?? null;
    const token = h.token();
    if (v.verificationJobId && id && token) {
      this.polling = true;
      void this.pollVerification(id, token);
    }
  }

  private async onRecordingEnded(): Promise<void> {
    this.playing = false;
    // The takeover controller saw the same end first: an armed pass seals; otherwise it released the VA hold (rule 8).
    if (this.handle?.ctl.armInfo().armed || this.store.getState().takeover.armedT !== null) return;
    await this.human?.stt.finishAfterSilence?.(1500);
    if (this.handle?.ctl.armInfo().armed) return;
    this.store.act({ t: this.now(), type: "ui.call-ended" });
    if (!this.handle) await this.releaseHold(false);
  }

  private async releaseHold(keepalive: boolean): Promise<void> {
    if (this.released || !this.plan || !this.create) return;
    this.released = true;
    await this.o.api.releaseRun(this.plan.runId, this.create.caseToken, keepalive);
  }

  /** S3: poll #20 until verified / failed (WP8: every ~1.5 s, stop after ~150 s; 404 = no verification). */
  async pollVerification(takeoverId: string, token: string): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((r) => (this.o.setTimeout ?? setTimeout)(() => r(), ms));
    const every = this.o.verifyPollMs ?? 1500;
    const deadline = this.now() + (this.o.verifyTimeoutMs ?? 150_000);
    this.store.act({ t: this.now(), type: "ui.qa-status", status: "waiting" });
    while (!this.disposed) {
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
      } catch (e) {
        if (isBatonError(e) && e.code === "E_NOT_FOUND") {
          this.store.act({ t: this.now(), type: "ui.qa-status", status: "failed", reason: "there is no recording to verify" });
          return;
        }
        /* 429 or transient: keep polling */
      }
      if (this.now() + every > deadline) break;
      await sleep(every);
    }
    if (!this.disposed) this.store.act({ t: this.now(), type: "ui.qa-status", status: "failed", reason: "verification took too long" });
  }

  // ---------------------------------------------------------------- actions

  pass(): void {
    const tk = this.handle?.ctl;
    if (!tk || !tk.manualPassAllowed) return;
    this.engine?.unlockSync(); // iOS: re-unlock inside the Pass click (WP5 → WP7)
    void tk.arm("manual").catch((e: unknown) => this.failFrom(e));
  }

  stopPlayback(): void {
    this.playback?.stop(30);
    this.playing = false;
    this.store.act({ t: this.now(), type: "ui.clock", callMs: this.playback?.callMs ?? 0, playing: false });
  }

  resume(): void {
    this.engine?.unlockSync();
    void this.human?.stt.resume();
    this.store.dispatch({ t: this.now(), type: "paused", reason: "ios_background", resumed: true });
  }

  watchCachedNow(): void {
    const h = this.human;
    if (!h) return;
    const s = this.store.getState();
    void h.stt.terminateAll();
    h.cached.activate("both", Math.max(this.startOffsetMs, s.clock.callMs), "you chose the cached replay instead of waiting");
    this.sttReady?.();
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
    if (this.customer) {
      if (!on) return false;
      this.setAutopilot(false);
      const ok = await this.customer.enableMic();
      if (!ok) this.fail("E_MIC_DENIED", "The microphone is blocked: autopilot, the reply chips and typing still work.");
      return ok;
    }
    // No WP11 customer input on the page: the judge's own mic answers the AI (WP4 openMic → WP5b setMicSource).
    if (!on) {
      const m = this.mic;
      this.mic = null;
      this.handle?.setMicSource?.(null);
      await m?.stop().catch(() => undefined);
      return false;
    }
    if (this.mic) return true;
    if (!this.engine || !this.handle?.setMicSource) return false;
    try {
      const m = await this.engine.openMic(24_000);
      if (this.disposed) {
        await m.stop().catch(() => undefined);
        return false;
      }
      this.mic = m;
      this.handle.setMicSource(m);
      return true;
    } catch {
      this.fail("E_MIC_DENIED", "The microphone is blocked. Allow it in the browser's site settings, or let the AI finish without you.");
      return false;
    }
  }

  /** The MockPhone's `paymentId` and tokens (read at render time; the takeover token changes per pass). */
  phoneAuth(): PhoneAuth {
    return { paymentId: this.handle?.paymentId?.() ?? null, takeoverToken: this.handle?.token() ?? "", visitorToken: this.visitorToken ?? null };
  }

  /** MockPhone `onState`: the store's phone state (narrator, floating pill) and the VA's progress-aware hold. */
  setPhoneState(s: PhoneState): void {
    this.store.dispatch({ t: this.now(), type: "phone.state", state: s });
    this.handle?.setPhoneState?.(s);
  }

  askForDaniel(): void {
    this.handle?.askForRep();
  }

  endCall(): void {
    this.handle?.ctl.endCall("user_end");
  }

  unlockAudio(): void {
    this.engine?.unlockSync();
    this.store.act({ t: this.now(), type: "ui.audio-locked", locked: false });
  }

  /**
   * Page teardown. `pagehide`: WP5's controller already ended the VA, terminated STT and released the run (keepalive)
   * from its own pagehide listener; before it exists the hold is released here. `unmount` (in-app navigation): the
   * unused hold is released (idempotent server-side; an `open` takeover slot is left alone).
   */
  dispose(reason: "pagehide" | "unmount" = "unmount"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sttReady?.();
    const armed = !!this.handle?.ctl.armInfo().armed || this.store.getState().takeover.armedT !== null;
    if (!this.handle || (reason === "unmount" && !armed)) void this.releaseHold(true);
    this.human?.stt.dispose?.();
    void this.mic?.stop().catch(() => undefined);
    this.mic = null;
    for (const u of this.unsubs.splice(0)) u();
    // On pagehide the controller's own pagehide listener may not have run yet (ours was registered first); disposing
    // it now would remove that listener mid-dispatch and skip its session.end / keepalive /end. The page is going away.
    if (reason === "unmount" && this.handle) {
      if (armed) this.handle.ctl.endCall("unmount");
      this.handle.ctl.dispose();
    }
    this.playback?.dispose();
  }

  /** Test/diagnostic view. */
  get debug(): { startOffsetMs: number; prefillUntilMs: number; playing: boolean; express: ExpressStart | null } {
    return { startOffsetMs: this.startOffsetMs, prefillUntilMs: this.prefillUntilMs, playing: this.playing, express: this.express };
  }
}

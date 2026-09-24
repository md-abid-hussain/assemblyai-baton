/**
 * core/protocol/takeover-machine.ts - the takeover protocol as a PURE reducer (DESIGN §5.5, TASKS WP5).
 *
 *   reduce(state, input) → { state, effects }
 *
 * `src/client/takeover/controller.ts` feeds it inputs (clicks, audio samples, STT finals, HTTP and Voice Agent
 * results, timer ticks) and executes the effects it returns. Nothing here reads a clock: every input carries `now`,
 * the AudioContext time in ms (`AudioEngine.nowMs()`), and every timeout is an absolute deadline on that clock
 * (`nextDeadline(state)` tells the controller when to send the next `tick`). So every transition and timeout is
 * unit-testable with a fake clock, and WP9b's sweep can reuse the same constants (`TAKEOVER_TIMING`).
 *
 * Timeline (§5.5.3; `t0` = the click, `tArm` = callMs at the click):
 *   IDLE --arm--> ARMED                       [HUD arm; POST /api/takeovers → VA token (attempt 0) → WS pre-open]
 *   ARMED --(both channels quiet ≥400 ms) | (t0+1500, capHit if still speaking)--> SEALING
 *                                             [tCut := callMs; playback.stop(30 ms); handoff clip; repLineEnd := clip end]
 *   SEALING (tCut+250): forceEndpoint(ch) for every channel with an open partial (rule 1: only in fed silence)
 *   SEALING --(no open partials) | (tCut+900)--> DRAINING   [CaseSync.drain(2000); terminate STT in the background]
 *   DRAINING --drained | +2000--> COMPILING   [POST /compile; +1500 → local compile]
 *   COMPILING --compiled--> CONNECTING --(ws open ∧ compiled) at tSend = max(now, repLineEnd − leadMs)--> GREETING
 *   GREETING: ready ≤3000 after the first update; first audible PLAYED ≤5000 after max(ready, repLineEnd) → ACTIVE
 *   ACTIVE ⇄ PAYING → CLOSING (close_ready | hand_back | cap | End call) → session.end → ended → POST /end → DONE
 *   RETRYING (once, attempt 1): abort old WS → POST /events {failure} → VA token {attempt:1} → new WS → same config
 *   RETRYING fails → FALLBACK (recorded AI bundle) | FAILED
 *   any state --pagehide--> session.end (sync) + STT terminate + keepalive /end + keepalive run release
 *
 * Rules 6–8 (§5.5.4): auto-baton at the recorded handoff line (tArm = lineStartMs, no clip, seal at the acceptance
 * end, repLineEnd := acceptEndMs); recorded AI half (no manual arm; at the acceptance end the recorded session
 * plays); the unused VA hold is released at the end of the recording without a pass and on pagehide.
 *
 * Decisions beyond DESIGN (docs/notes/wp5.md):
 *   - A Voice Agent failure before CONNECTING (pre-open token/WS) retries in the background at once; the phase shows
 *     `retrying` only from CONNECTING on. A dead VA is acted on at CONNECTING (FALLBACK/FAILED), after the snapshot
 *     froze, so the Explorer and QA still get the frozen case.
 *   - An arm that fails before SEALING returns to IDLE (the recording keeps playing, with a notice). After SEALING
 *     it ends in FALLBACK/FAILED.
 *   - A failure after the greeting was heard (ACTIVE/PAYING) is not retried (a second greeting mid-call would be
 *     worse): the session is ended and the pass ends FAILED (outcome `failed`).
 *   - The session cap / absolute ceiling (the VA controller ends the session itself) ends the pass with outcome
 *     `handed_back`, reason `cap`: the wrap-up line hands the rest to the rep (§5.9.5).
 */
import type { Channel } from "../contracts/case";
import type { ErrorCode } from "../contracts/errors";
import type { TakeoverPhase } from "../contracts/events";
import type { CallHandoff } from "../contracts/scenario";
import {
  TAKEOVER_TIMING,
  type CompiledTakeover,
  type DrainReport,
  type TakeoverOutcome,
  type TakeoverSource,
} from "../contracts/takeover";

export const T = TAKEOVER_TIMING;

/** Extra grace after DRAIN_MAX_MS before the machine stops waiting for `CaseSync.drain` (which has its own timeout). */
export const DRAIN_BACKSTOP_GRACE_MS = 500;
/** After `session.end`, wait SESSION_ENDED_WAIT_MS + this before closing without `session.ended`. */
export const CLOSE_BACKSTOP_MS = 1000;
/** hand_back: the rep's "I'm back" line must report done within this, or the session is ended anyway. */
export const REP_BACK_MAX_MS = 10_000;
/** Auto-baton: seal at most this long after the planned acceptance end even if playback stalls. */
export const AUTO_SEAL_BACKSTOP_MS = 1000;
/** Auto-baton without a labelled acceptance: seal at lineEndMs + this (§5.5.4 rule 6). */
export const AUTO_NO_ACCEPT_WAIT_MS = 1500;
/** Manual pass: if the handoff clip was not scheduled this long after the seal, stop waiting for it (repLineEnd = now). */
export const CLIP_SCHEDULE_MAX_MS = 3000;

/** Codes that never earn the one retry (the same config would fail again, or the platform refused a new slot). */
export const NON_RETRYABLE_VA_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "E_VA_CONFIG", "E_AAI_BALANCE", "E_BUDGET", "E_MODE_REPLAY_ONLY", "E_VA_CAPACITY", "E_RATE_LIMITED", "E_CASE_STATE",
  "E_FORBIDDEN", "E_NOT_FOUND", "E_BAD_REQUEST", "E_MAINTENANCE",
]);
export const isRetryableVaCode = (code: ErrorCode): boolean => !NON_RETRYABLE_VA_CODES.has(code);

// ================================================================================================ config and state

export interface MachineConfig {
  /** RunPlan.aiHalf (D14). "recorded" → no manual pass; the recorded AI session plays at the handoff (rule 7). */
  aiHalf: "live" | "recorded";
  /** CallManifestEntry.handoff (labels); null for calls without a labelled handoff. */
  handoff: CallHandoff | null;
  /** CallManifestEntry.recordedAiBundle !== null. */
  hasRecordedBundle: boolean;
  /** Watch mode: arm automatically at the recorded handoff line (rule 6). Never for declined handoffs. */
  autoBaton: boolean;
  /** TAKEOVER_TIMING.MAX_TAKEOVERS_PER_CASE. */
  maxPasses: number;
}

/** What the controller measured at the latest CallPlayback tick (DESIGN §5.5.3, §5.5.4 rule 3). */
export interface AudioSample {
  now: number;
  callMs: number;
  playing: boolean;
  /** RMS over the last 200 ms ≥ QUIET_DBFS, per channel (false while not playing). */
  speaking: Record<Channel, boolean>;
  /** Both channels < QUIET_DBFS over the last QUIET_REQUIRED_MS (true while not playing). */
  quiet: boolean;
  /** SttChannelManager.hasOpenPartial(ch). */
  openPartial: Record<Channel, boolean>;
}

export type VaStatus =
  | "idle" // no token requested yet (waiting for the arm response)
  | "minting" // POST /api/va/token in flight
  | "opening" // WebSocket connecting
  | "open" // WebSocket open, first update not sent
  | "starting" // first session.update sent, waiting for session.ready
  | "ready" // session.ready, waiting for the first audible greeting chunk to PLAY
  | "audible" // greeting heard
  | "ended" // session ended
  | "dead"; // failed with no retry left

export interface VaState {
  attempt: 0 | 1;
  status: VaStatus;
  /** When the current status began (the token/open/ready timeouts count from here). */
  since: number;
  liveSessionId: string | null;
  /** AssemblyAI session id (session.ready). */
  sessionId: string | null;
  readyAt: number | null;
  /** tSend, when it is in the future. */
  sendAt: number | null;
  lastCode: ErrorCode | null;
}

export type CompileStatus = "idle" | "waiting_arm" | "server" | "local" | "done";

export interface ClosingState {
  outcome: TakeoverOutcome;
  reason: string;
  /** The phase after the session ended. */
  finalPhase: "done" | "failed";
  startedAt: number;
  /** hand_back: the rep's "I'm back" line plays before `session.end`. */
  step: "rep_back" | "ending";
}

export interface PassState {
  source: TakeoverSource;
  /** ctx ms of the click (HUD `arm`). */
  t0: number;
  /** call ms of the pass point (manual: callMs at the click; auto: handoff.lineStartMs). */
  tArmMs: number;
  midUtterance: boolean;
  speakingCh: Channel | null;
  capHit: boolean;
  /** Auto-baton: seal when callMs reaches this (acceptEndMs ?? lineEndMs + 1500). */
  sealAtCallMs: number | null;
  /** Auto-baton: seal by this ctx time even if playback stalls. */
  sealBackstopAt: number | null;
  tCutMs: number | null;
  sealedAt: number | null;
  /** ctx ms when the rep line (manual: the handoff clip; auto: the recorded acceptance) ends. null = not known yet. */
  repLineEnd: number | null;
  forceEndpointDone: boolean;
  cutTurnIds: string[];
  drainStartedAt: number | null;
  drain: DrainReport | null;
  arm: { status: "pending" | "ok" | "failed"; takeoverId: string | null; leadMs: number; code: ErrorCode | null };
  compile: { status: CompileStatus; startedAt: number | null; compiled: CompiledTakeover | null; by: "server" | "client" | null };
  va: VaState;
  closing: ClosingState | null;
  /** POST /end was sent for this pass. */
  endPosted: boolean;
  /** ms since t0 (posted to #12 and read by the server's adaptive lead, §5.5.4 rule 5). */
  timings: Record<string, number>;
}

export interface TakeoverMachineState {
  cfg: MachineConfig;
  phase: TakeoverPhase;
  /** Passes armed on this page (arm responses that failed before sealing do not count). */
  passes: number;
  lastOutcome: TakeoverOutcome | null;
  pass: PassState | null;
  sample: AudioSample | null;
  /** The auto-baton fired (or was consumed by a failed arm); it never fires twice. */
  autoBatonUsed: boolean;
  /** Rule 7: the recorded AI session started (or the "live AI unavailable" end was shown). */
  recordedStarted: boolean;
  runReleased: boolean;
  /** pagehide ran: every later input is ignored. */
  disposed: boolean;
}

// ================================================================================================ inputs and effects

export type TakeoverInput =
  | { type: "arm"; now: number; source: TakeoverSource }
  | ({ type: "sample" } & AudioSample)
  | { type: "tick"; now: number }
  | { type: "clip_scheduled"; now: number; endCtxMs: number }
  | { type: "final"; now: number; turnId: string; channel: Channel; startMs: number; endMs: number }
  | { type: "drained"; now: number; completedTurnIds: string[]; pendingTurnIds: string[]; waitedMs: number }
  | { type: "arm_ok"; now: number; takeoverId: string; leadMs: number }
  | { type: "arm_failed"; now: number; code: ErrorCode; message: string }
  | { type: "compiled"; now: number; compiled: CompiledTakeover; by: "server" | "client" }
  | { type: "compile_failed"; now: number; by: "server" | "client"; code: ErrorCode; message: string }
  | { type: "va_token"; now: number; attempt: 0 | 1; liveSessionId: string }
  | { type: "va_token_failed"; now: number; attempt: 0 | 1; code: ErrorCode; message: string }
  | { type: "va_open"; now: number; attempt: 0 | 1 }
  | { type: "va_ready"; now: number; attempt: 0 | 1; sessionId: string }
  | { type: "va_first_audible"; now: number; attempt: 0 | 1; ctxMs: number }
  | { type: "va_paying"; now: number; on: boolean }
  | { type: "va_hand_back"; now: number; reason: string }
  | { type: "va_close_ready"; now: number }
  | { type: "va_error"; now: number; attempt: 0 | 1; code: ErrorCode; retryable: boolean; message: string }
  | { type: "va_ended"; now: number; attempt: 0 | 1; reason: string; sessionSeconds: number | null }
  | { type: "rep_back_done"; now: number }
  | { type: "end_call"; now: number; reason: string }
  | { type: "recording_ended"; now: number }
  | { type: "recorded_done"; now: number }
  | { type: "pagehide"; now: number };

export type HudMarkName = "arm" | "repLineStart" | "repLineEnd";

export type TakeoverEffect =
  | { type: "hud_mark"; name: HudMarkName; ctxMs: number }
  | { type: "post_arm"; tArmMs: number; midUtterance: boolean; source: TakeoverSource }
  | { type: "mint_va"; attempt: 0 | 1; takeoverId: string }
  | { type: "open_va"; attempt: 0 | 1 }
  | { type: "stop_playback"; fadeMs: number }
  | { type: "play_handoff_clip" }
  | { type: "force_endpoint"; channel: Channel }
  | { type: "drain"; timeoutMs: number }
  | { type: "terminate_stt" }
  | { type: "post_compile"; takeoverId: string; drain: DrainReport }
  | { type: "compile_local"; drain: DrainReport }
  | { type: "start_va"; attempt: 0 | 1; compiled: CompiledTakeover; holdAudioUntilCtxMs: number }
  | { type: "abort_va"; attempt: 0 | 1; reason: string }
  | { type: "report_failure"; takeoverId: string; code: ErrorCode }
  | { type: "end_va"; reason: string }
  | { type: "end_va_now"; reason: string }
  | { type: "play_rep_back" }
  | { type: "post_events"; takeoverId: string; phase?: TakeoverPhase; timings?: Record<string, number>; vaSessionId?: string }
  | { type: "report_va"; event: "opened" | "closed"; liveSessionId: string; providerSessionId?: string; billedSeconds?: number }
  | { type: "post_end"; takeoverId: string; outcome: TakeoverOutcome; vaSessionId: string | null; reason: string; keepalive: boolean }
  | { type: "release_run"; keepalive: boolean }
  | { type: "play_recorded" }
  | { type: "stop_recorded" }
  | { type: "notice"; level: "info" | "error"; code: ErrorCode | null; message: string };

export interface ReduceResult {
  state: TakeoverMachineState;
  effects: TakeoverEffect[];
}

// ================================================================================================ construction

export function defaultMachineConfig(partial: Partial<MachineConfig> = {}): MachineConfig {
  return { aiHalf: "live", handoff: null, hasRecordedBundle: false, autoBaton: true, maxPasses: T.MAX_TAKEOVERS_PER_CASE, ...partial };
}

export function initialMachineState(cfg: MachineConfig): TakeoverMachineState {
  return { cfg, phase: "idle", passes: 0, lastOutcome: null, pass: null, sample: null, autoBatonUsed: false, recordedStarted: false, runReleased: false, disposed: false };
}

/** Rule 6: the auto-baton applies to this call (a labelled, accepted handoff, live AI half, Watch auto-baton on). */
export function autoBatonEligible(cfg: MachineConfig): boolean {
  return cfg.autoBaton && cfg.aiHalf === "live" && cfg.handoff !== null && !cfg.handoff.declined;
}

/** Where the recorded acceptance ends (auto-baton seal point and recorded-AI start), on the call clock. */
export function acceptanceEndCallMs(h: CallHandoff): number {
  return h.acceptEndMs ?? h.lineEndMs + AUTO_NO_ACCEPT_WAIT_MS;
}

/** A manual pass is possible right now (TakeoverController.manualPassAllowed). */
export function manualPassAllowed(s: TakeoverMachineState): boolean {
  return canArm(s) && s.cfg.aiHalf === "live";
}

function canArm(s: TakeoverMachineState): boolean {
  if (s.disposed || s.passes >= s.cfg.maxPasses || s.recordedStarted) return false;
  if (s.phase === "idle") return true;
  // "Pass the baton again" after a hand-back (§1.3 P1 step 9).
  return s.phase === "done" && s.lastOutcome === "handed_back";
}

// ================================================================================================ deadlines

/** The earliest pending deadline (ctx ms), or null. The controller sends `{type:"tick", now}` at (or after) it. */
export function nextDeadline(s: TakeoverMachineState): number | null {
  const p = s.pass;
  if (!p || s.disposed) return null;
  const ds: number[] = [];
  switch (s.phase) {
    case "armed":
      if (p.source === "manual") ds.push(p.t0 + T.ARM_TURN_END_MAX_MS);
      else if (p.sealBackstopAt !== null) ds.push(p.sealBackstopAt);
      break;
    case "sealing":
      if (p.sealedAt !== null) {
        if (!p.forceEndpointDone) ds.push(p.sealedAt + T.SEAL_TAIL_MS);
        ds.push(p.sealedAt + T.FINALS_WAIT_MAX_MS);
      }
      break;
    case "draining":
      if (p.drainStartedAt !== null) ds.push(p.drainStartedAt + T.DRAIN_MAX_MS + DRAIN_BACKSTOP_GRACE_MS);
      break;
    case "compiling":
      if (p.compile.status === "server" && p.compile.startedAt !== null) ds.push(p.compile.startedAt + T.COMPILE_TIMEOUT_MS);
      break;
    case "connecting":
    case "retrying":
      if (p.repLineEnd === null && p.sealedAt !== null) ds.push(p.sealedAt + CLIP_SCHEDULE_MAX_MS);
      break;
    case "closing":
      if (p.closing) ds.push(p.closing.startedAt + (p.closing.step === "rep_back" ? REP_BACK_MAX_MS : T.SESSION_ENDED_WAIT_MS + CLOSE_BACKSTOP_MS));
      break;
    default:
      break;
  }
  const vd = vaDeadline(s);
  if (vd !== null) ds.push(vd);
  return ds.length ? Math.min(...ds) : null;
}

function vaDeadline(s: TakeoverMachineState): number | null {
  const p = s.pass;
  if (!p || p.closing || !vaPhase(s.phase)) return null;
  const va = p.va;
  switch (va.status) {
    case "minting":
      return va.since + T.VA_TOKEN_TIMEOUT_MS;
    case "opening":
      return va.since + T.VA_WS_OPEN_TIMEOUT_MS;
    case "open":
      return va.sendAt;
    case "starting":
      return va.since + T.SESSION_READY_TIMEOUT_MS;
    case "ready":
      return Math.max(va.readyAt ?? va.since, p.repLineEnd ?? va.since) + T.FIRST_AUDIBLE_TIMEOUT_MS;
    default:
      return null;
  }
}

/** A WebSocket exists for the current attempt (so there is something to abort or end). */
export function hasSocket(va: VaState): boolean {
  return va.status === "opening" || va.status === "open" || va.status === "starting" || va.status === "ready" || va.status === "audible";
}

/** Phases in which the pre-opened / greeting Voice Agent is being watched for timeouts. */
function vaPhase(ph: TakeoverPhase): boolean {
  return ph === "armed" || ph === "sealing" || ph === "draining" || ph === "compiling" || ph === "connecting" || ph === "retrying" || ph === "greeting";
}

// ================================================================================================ reducer

class Ctx {
  readonly effects: TakeoverEffect[] = [];
  constructor(public s: TakeoverMachineState) {}
  fx(e: TakeoverEffect): void {
    this.effects.push(e);
  }
  get p(): PassState {
    if (!this.s.pass) throw new Error("takeover-machine: no pass");
    return this.s.pass;
  }
}

function draft(s: TakeoverMachineState): TakeoverMachineState {
  const p = s.pass;
  return {
    ...s,
    pass: p
      ? {
          ...p,
          cutTurnIds: [...p.cutTurnIds],
          arm: { ...p.arm },
          compile: { ...p.compile },
          va: { ...p.va },
          closing: p.closing ? { ...p.closing } : null,
          timings: { ...p.timings },
        }
      : null,
  };
}

export function reduce(state: TakeoverMachineState, input: TakeoverInput): ReduceResult {
  if (state.disposed) return { state, effects: [] };
  const c = new Ctx(draft(state));
  step(c, input);
  return { state: c.s, effects: c.effects };
}

/** Apply several inputs in order (tests, replays). */
export function reduceAll(state: TakeoverMachineState, inputs: TakeoverInput[]): ReduceResult {
  let s = state;
  const effects: TakeoverEffect[] = [];
  for (const i of inputs) {
    const r = reduce(s, i);
    s = r.state;
    effects.push(...r.effects);
  }
  return { state: s, effects };
}

function step(c: Ctx, i: TakeoverInput): void {
  switch (i.type) {
    case "arm":
      return onArm(c, i.now, i.source);
    case "sample":
      return onSample(c, i);
    case "tick":
      return onTick(c, i.now);
    case "clip_scheduled":
      return onClip(c, i.now, i.endCtxMs);
    case "final":
      return onFinal(c, i);
    case "drained":
      return onDrained(c, i.now, i);
    case "arm_ok":
      return onArmOk(c, i.now, i.takeoverId, i.leadMs);
    case "arm_failed":
      return onArmFailed(c, i.now, i.code, i.message);
    case "compiled":
      return onCompiled(c, i.now, i.compiled, i.by);
    case "compile_failed":
      return onCompileFailed(c, i.now, i.by, i.code, i.message);
    case "va_token":
      return onVaToken(c, i.now, i.attempt, i.liveSessionId);
    case "va_token_failed":
      return onVaFailure(c, i.now, i.attempt, i.code, isRetryableVaCode(i.code), i.message);
    case "va_open":
      return onVaOpen(c, i.now, i.attempt);
    case "va_ready":
      return onVaReady(c, i.now, i.attempt, i.sessionId);
    case "va_first_audible":
      return onVaAudible(c, i.now, i.attempt, i.ctxMs);
    case "va_paying":
      return onPaying(c, i.now, i.on);
    case "va_hand_back":
      return onHandBack(c, i.now, i.reason);
    case "va_close_ready":
      return onCloseReady(c, i.now);
    case "va_error":
      return onVaFailure(c, i.now, i.attempt, i.code, i.retryable && isRetryableVaCode(i.code), i.message);
    case "va_ended":
      return onVaEnded(c, i.now, i.attempt, i.reason, i.sessionSeconds);
    case "rep_back_done":
      return onRepBackDone(c, i.now);
    case "end_call":
      return onEndCall(c, i.now, i.reason);
    case "recording_ended":
      return onRecordingEnded(c, i.now);
    case "recorded_done":
      if (c.s.phase === "fallback") c.s.phase = "done";
      return;
    case "pagehide":
      return onPageHide(c, i.now);
  }
}

// ------------------------------------------------------------------------------------------------ arm

function onArm(c: Ctx, now: number, source: TakeoverSource): void {
  const s = c.s;
  if (s.cfg.aiHalf === "recorded") {
    // Rule 7: recorded runs never arm (manual or auto).
    if (source === "manual" && !s.disposed) {
      c.fx({ type: "notice", level: "info", code: "E_CASE_STATE", message: "Live AI is unavailable right now: the recorded AI session starts at the rep's handoff line." });
    }
    return;
  }
  if (!canArm(s)) return;
  const sample = s.sample;
  const callMs = sample?.callMs ?? 0;
  if (source === "auto_handoff") {
    const h = s.cfg.handoff;
    if (!h || !autoBatonEligible(s.cfg) || s.autoBatonUsed || s.passes > 0) return;
    const sealAt = acceptanceEndCallMs(h);
    const toSeal = Math.max(0, sealAt - callMs);
    newPass(c, now, "auto_handoff", h.lineStartMs, false, null);
    const p = c.p;
    s.autoBatonUsed = true;
    p.sealAtCallMs = sealAt;
    p.sealBackstopAt = now + toSeal + AUTO_SEAL_BACKSTOP_MS;
    // The rep's real line and the customer's real acceptance keep playing from the recording.
    p.repLineEnd = now + Math.max(0, (h.acceptEndMs ?? h.lineEndMs) - callMs);
    c.fx({ type: "hud_mark", name: "repLineStart", ctxMs: now + Math.max(0, h.lineStartMs - callMs) });
    c.fx({ type: "hud_mark", name: "repLineEnd", ctxMs: p.repLineEnd });
    if (sample && sample.callMs >= sealAt) seal(c, now, sample.callMs);
    return;
  }
  const speakingCh: Channel | null = sample?.speaking.rep ? "rep" : sample?.speaking.customer ? "customer" : sample?.openPartial.rep ? "rep" : sample?.openPartial.customer ? "customer" : null;
  const mid = !!sample && (sample.speaking.rep || sample.speaking.customer || sample.openPartial.rep || sample.openPartial.customer);
  newPass(c, now, "manual", callMs, mid, speakingCh);
  // Already quiet on both channels at the click: seal at once (tCut = the click).
  if (!sample || sample.quiet || !sample.playing) seal(c, now, callMs);
}

function newPass(c: Ctx, now: number, source: TakeoverSource, tArmMs: number, mid: boolean, speakingCh: Channel | null): void {
  const s = c.s;
  s.passes += 1;
  s.phase = "armed";
  s.pass = {
    source, t0: now, tArmMs, midUtterance: mid, speakingCh, capHit: false, sealAtCallMs: null, sealBackstopAt: null,
    tCutMs: null, sealedAt: null, repLineEnd: null, forceEndpointDone: false, cutTurnIds: [], drainStartedAt: null, drain: null,
    arm: { status: "pending", takeoverId: null, leadMs: T.DEFAULT_LEAD_MS, code: null },
    compile: { status: "idle", startedAt: null, compiled: null, by: null },
    va: { attempt: 0, status: "idle", since: now, liveSessionId: null, sessionId: null, readyAt: null, sendAt: null, lastCode: null },
    closing: null, endPosted: false, timings: { armed: 0 },
  };
  c.fx({ type: "hud_mark", name: "arm", ctxMs: now });
  c.fx({ type: "post_arm", tArmMs, midUtterance: mid, source });
}

function onArmOk(c: Ctx, now: number, takeoverId: string, leadMs: number): void {
  const p = c.s.pass;
  if (!p || p.arm.status !== "pending") return;
  p.arm = { status: "ok", takeoverId, leadMs: clampLead(leadMs), code: null };
  p.timings.armOk = now - p.t0;
  // Fire & forget: the VA token and the WebSocket pre-open run in parallel with sealing (§5.5.3, T-D1-3 part A).
  if (p.va.status === "idle") {
    p.va = { ...p.va, status: "minting", since: now };
    c.fx({ type: "mint_va", attempt: 0, takeoverId });
  }
  if (p.compile.status === "waiting_arm" && p.drain) startServerCompile(c, now, takeoverId, p.drain);
}

export function clampLead(ms: number): number {
  if (!Number.isFinite(ms)) return T.DEFAULT_LEAD_MS;
  return Math.min(T.LEAD_MS_MAX, Math.max(T.LEAD_MS_MIN, ms));
}

function onArmFailed(c: Ctx, now: number, code: ErrorCode, message: string): void {
  const s = c.s;
  const p = s.pass;
  if (!p || p.arm.status !== "pending") return;
  p.arm = { ...p.arm, status: "failed", code };
  if (s.phase === "armed") {
    // Not sealed yet: nothing was cut. Back to shadowing (or to the hand-back card), the recording keeps playing.
    s.pass = null;
    s.passes -= 1;
    s.phase = s.lastOutcome === "handed_back" ? "done" : "idle";
    c.fx({ type: "notice", level: "error", code, message: `The AI half could not start: ${message}` });
    return;
  }
  // Sealed: the pipeline continues to CONNECTING, where the missing takeover ends the pass (see enterCompiling).
  if (s.phase === "compiling") giveUp(c, now, code, message);
}

// ------------------------------------------------------------------------------------------------ audio and sealing

function onSample(c: Ctx, sample: AudioSample): void {
  const s = c.s;
  s.sample = { now: sample.now, callMs: sample.callMs, playing: sample.playing, speaking: { ...sample.speaking }, quiet: sample.quiet, openPartial: { ...sample.openPartial } };
  const now = sample.now;
  switch (s.phase) {
    case "idle":
      return idleSample(c, now, sample);
    case "armed": {
      const p = c.p;
      if (p.source === "manual") {
        if (sample.quiet || !sample.playing) seal(c, now, sample.callMs);
      } else if (p.sealAtCallMs !== null && sample.callMs >= p.sealAtCallMs) {
        seal(c, now, sample.callMs);
      }
      return;
    }
    case "sealing":
      return maybeFinalsDone(c, now);
    default:
      return;
  }
}

function idleSample(c: Ctx, now: number, sample: AudioSample): void {
  const s = c.s;
  const h = s.cfg.handoff;
  if (!h || !sample.playing) return;
  if (s.cfg.aiHalf === "recorded") {
    if (!h.declined && !s.recordedStarted && sample.callMs >= acceptanceEndCallMs(h)) startRecorded(c, now);
    return;
  }
  if (autoBatonEligible(s.cfg) && !s.autoBatonUsed && s.passes === 0 && sample.callMs >= h.lineStartMs) onArm(c, now, "auto_handoff");
}

/** Rule 7: at the end of the recorded acceptance, the recorded AI session replaces the live AI half. */
function startRecorded(c: Ctx, now: number): void {
  const s = c.s;
  s.recordedStarted = true;
  c.fx({ type: "stop_playback", fadeMs: 30 });
  c.fx({ type: "terminate_stt" });
  if (s.cfg.hasRecordedBundle) {
    s.phase = "fallback";
    c.fx({ type: "play_recorded" });
  } else {
    s.phase = "done";
    c.fx({ type: "notice", level: "info", code: null, message: "Call ended: live AI unavailable; see the Explorer." });
  }
  void now;
}

function seal(c: Ctx, now: number, callMs: number): void {
  const s = c.s;
  const p = c.p;
  p.tCutMs = callMs;
  p.sealedAt = now;
  p.timings.sealed = now - p.t0;
  s.phase = "sealing";
  c.fx({ type: "stop_playback", fadeMs: 30 });
  if (p.source === "manual") {
    if (s.cfg.handoff && s.passes === 1 && s.lastOutcome === null) {
      // The rep's real line + 300 ms + the customer's real acceptance, cut from the same recording (rule 6).
      c.fx({ type: "hud_mark", name: "repLineStart", ctxMs: now });
      c.fx({ type: "play_handoff_clip" });
    } else {
      // No labelled line (or a second pass after a hand-back): nothing to mask; the greeting may start at once.
      p.repLineEnd = now;
    }
  }
  maybeFinalsDone(c, now);
}

function onTick(c: Ctx, now: number): void {
  const s = c.s;
  const p = s.pass;
  if (!p) return;
  switch (s.phase) {
    case "armed":
      if (p.source === "manual" && now >= p.t0 + T.ARM_TURN_END_MAX_MS) {
        const smp = s.sample;
        const speakingCh: Channel | null = smp?.speaking.rep ? "rep" : smp?.speaking.customer ? "customer" : null;
        p.capHit = speakingCh !== null;
        if (speakingCh) p.speakingCh = speakingCh;
        seal(c, now, smp?.callMs ?? p.tArmMs);
      } else if (p.source === "auto_handoff" && p.sealBackstopAt !== null && now >= p.sealBackstopAt) {
        seal(c, now, s.sample?.callMs ?? p.sealAtCallMs ?? p.tArmMs);
      }
      break;
    case "sealing":
      if (p.sealedAt !== null && !p.forceEndpointDone && now >= p.sealedAt + T.SEAL_TAIL_MS) forceEndpoints(c);
      if (p.sealedAt !== null && now >= p.sealedAt + T.FINALS_WAIT_MAX_MS) enterDraining(c, now);
      break;
    case "draining":
      if (p.drainStartedAt !== null && now >= p.drainStartedAt + T.DRAIN_MAX_MS + DRAIN_BACKSTOP_GRACE_MS) {
        onDrained(c, now, { completedTurnIds: [], pendingTurnIds: [], waitedMs: now - p.drainStartedAt });
      }
      break;
    case "compiling":
      if (p.compile.status === "server" && p.compile.startedAt !== null && now >= p.compile.startedAt + T.COMPILE_TIMEOUT_MS && p.drain) {
        p.compile.status = "local";
        c.fx({ type: "compile_local", drain: p.drain });
      }
      break;
    case "connecting":
    case "retrying":
      if (p.repLineEnd === null && p.sealedAt !== null && now >= p.sealedAt + CLIP_SCHEDULE_MAX_MS) {
        p.repLineEnd = now; // the clip never reported its schedule: nothing left to mask
        maybeStart(c, now);
      }
      break;
    case "closing":
      if (p.closing) {
        if (p.closing.step === "rep_back" && now >= p.closing.startedAt + REP_BACK_MAX_MS) onRepBackDone(c, now);
        else if (p.closing.step === "ending" && now >= p.closing.startedAt + T.SESSION_ENDED_WAIT_MS + CLOSE_BACKSTOP_MS) {
          c.fx({ type: "end_va_now", reason: "session_ended_timeout" });
          finishPass(c, now, null);
        }
      }
      return;
    default:
      break;
  }
  vaTimeouts(c, now);
}

/** Rule 1: forceEndpoint only after SEAL_TAIL_MS of fed silence, and only on channels with an open partial. */
function forceEndpoints(c: Ctx): void {
  const p = c.p;
  p.forceEndpointDone = true;
  const smp = c.s.sample;
  for (const ch of ["rep", "customer"] as const) if (smp?.openPartial[ch]) c.fx({ type: "force_endpoint", channel: ch });
}

function maybeFinalsDone(c: Ctx, now: number): void {
  if (c.s.phase !== "sealing") return;
  const smp = c.s.sample;
  if (!smp || (!smp.openPartial.rep && !smp.openPartial.customer)) enterDraining(c, now);
}

function onFinal(c: Ctx, f: { now: number; turnId: string; channel: Channel; startMs: number; endMs: number }): void {
  const p = c.s.pass;
  if (!p || p.tCutMs === null || p.drain !== null) return;
  // The in-progress turn on the speaking channel when the 1.5 s cap forced the cut (§5.5.3 capHit).
  if (p.capHit && f.channel === p.speakingCh && f.startMs <= p.tCutMs && !p.cutTurnIds.includes(f.turnId)) p.cutTurnIds.push(f.turnId);
}

function onClip(c: Ctx, now: number, endCtxMs: number): void {
  const p = c.s.pass;
  if (!p || p.repLineEnd !== null) return;
  p.repLineEnd = Math.max(now, endCtxMs);
  c.fx({ type: "hud_mark", name: "repLineEnd", ctxMs: p.repLineEnd });
  maybeStart(c, now);
}

// ------------------------------------------------------------------------------------------------ drain and compile

function enterDraining(c: Ctx, now: number): void {
  const p = c.p;
  if (!p.forceEndpointDone) p.forceEndpointDone = true; // finals are in (or the wait ran out): no later force
  c.s.phase = "draining";
  p.drainStartedAt = now;
  p.timings.finals = now - p.t0;
  c.fx({ type: "drain", timeoutMs: T.DRAIN_MAX_MS });
  c.fx({ type: "terminate_stt" });
}

function onDrained(c: Ctx, now: number, d: { completedTurnIds: string[]; pendingTurnIds: string[]; waitedMs: number }): void {
  const s = c.s;
  const p = s.pass;
  if (!p || s.phase !== "draining" || p.drain) return;
  p.timings.drained = now - p.t0;
  p.drain = {
    tArmMs: p.tArmMs,
    tCutMs: p.tCutMs ?? p.tArmMs,
    capHit: p.capHit,
    midUtterance: p.midUtterance,
    completedTurnIds: [...d.completedTurnIds],
    pendingTurnIds: d.pendingTurnIds.filter((id) => !d.completedTurnIds.includes(id)),
    cutTurnIds: [...p.cutTurnIds],
    waitedMs: d.waitedMs,
    timings: {
      armed: 0,
      ...(p.timings.sealed !== undefined ? { sealed: p.timings.sealed } : {}),
      ...(p.timings.finals !== undefined ? { finals: p.timings.finals } : {}),
      drained: p.timings.drained,
    },
  };
  enterCompiling(c, now);
}

function enterCompiling(c: Ctx, now: number): void {
  const p = c.p;
  c.s.phase = "compiling";
  if (p.arm.status === "failed") return giveUp(c, now, p.arm.code ?? "E_INTERNAL", "the takeover could not be created");
  if (p.arm.status === "pending" || !p.arm.takeoverId || !p.drain) {
    p.compile.status = "waiting_arm";
    return;
  }
  startServerCompile(c, now, p.arm.takeoverId, p.drain);
}

function startServerCompile(c: Ctx, now: number, takeoverId: string, drain: DrainReport): void {
  const p = c.p;
  p.compile = { ...p.compile, status: "server", startedAt: now };
  c.fx({ type: "post_compile", takeoverId, drain });
}

function onCompiled(c: Ctx, now: number, compiled: CompiledTakeover, by: "server" | "client"): void {
  const s = c.s;
  const p = s.pass;
  if (!p || p.compile.compiled || s.phase !== "compiling") return;
  p.compile = { ...p.compile, status: "done", compiled, by };
  p.timings.compiled = now - p.t0;
  enterConnecting(c, now);
}

function onCompileFailed(c: Ctx, now: number, by: "server" | "client", code: ErrorCode, message: string): void {
  const s = c.s;
  const p = s.pass;
  if (!p || s.phase !== "compiling" || p.compile.compiled) return;
  if (by === "server" && p.compile.status === "server" && p.drain) {
    p.compile.status = "local";
    c.fx({ type: "compile_local", drain: p.drain });
    return;
  }
  if (by === "client") giveUp(c, now, code, message);
}

// ------------------------------------------------------------------------------------------------ Voice Agent

function enterConnecting(c: Ctx, now: number): void {
  const s = c.s;
  const p = c.p;
  if (p.va.status === "dead") return giveUp(c, now, p.va.lastCode ?? "E_VA_TRANSIENT", "the live AI could not connect");
  s.phase = p.va.attempt === 1 ? "retrying" : "connecting";
  maybeStart(c, now);
}

/** CONNECTING → GREETING at tSend = max(now, repLineEnd − leadMs), once the WS is open and the config compiled. */
function maybeStart(c: Ctx, now: number): void {
  const s = c.s;
  const p = s.pass;
  if (!p || (s.phase !== "connecting" && s.phase !== "retrying")) return;
  const compiled = p.compile.compiled;
  if (!compiled || p.va.status !== "open" || p.repLineEnd === null) return;
  const sendAt = Math.max(now, p.repLineEnd - p.arm.leadMs);
  if (now < sendAt) {
    p.va.sendAt = sendAt;
    return;
  }
  p.va = { ...p.va, status: "starting", since: now, sendAt: null };
  p.timings.sessionUpdateSent = now - p.t0;
  s.phase = "greeting";
  c.fx({ type: "start_va", attempt: p.va.attempt, compiled, holdAudioUntilCtxMs: p.repLineEnd });
}

function onVaToken(c: Ctx, now: number, attempt: 0 | 1, liveSessionId: string): void {
  const p = c.s.pass;
  if (!p || p.va.attempt !== attempt || p.va.status !== "minting" || p.closing) return;
  p.va = { ...p.va, status: "opening", since: now, liveSessionId };
  c.fx({ type: "open_va", attempt });
}

function onVaOpen(c: Ctx, now: number, attempt: 0 | 1): void {
  const p = c.s.pass;
  if (!p || p.va.attempt !== attempt || p.va.status !== "opening" || p.closing) return;
  p.va = { ...p.va, status: "open", since: now };
  p.timings[attempt === 0 ? "wsOpen" : "wsOpenRetry"] = now - p.t0;
  maybeStart(c, now);
}

function onVaReady(c: Ctx, now: number, attempt: 0 | 1, sessionId: string): void {
  const p = c.s.pass;
  if (!p || p.va.attempt !== attempt || p.va.status !== "starting") return;
  p.va = { ...p.va, status: "ready", since: now, readyAt: now, sessionId };
  p.timings.sessionReady = now - p.t0;
  if (p.va.liveSessionId) c.fx({ type: "report_va", event: "opened", liveSessionId: p.va.liveSessionId, providerSessionId: sessionId });
}

function onVaAudible(c: Ctx, now: number, attempt: 0 | 1, ctxMs: number): void {
  const s = c.s;
  const p = s.pass;
  if (!p || p.va.attempt !== attempt || p.va.status !== "ready" || s.phase !== "greeting") return;
  p.va = { ...p.va, status: "audible", since: now };
  p.timings.firstAudiblePlayed = ctxMs - p.t0;
  s.phase = "active";
  if (p.arm.takeoverId) {
    c.fx({ type: "post_events", takeoverId: p.arm.takeoverId, phase: "active", timings: { ...p.timings }, ...(p.va.sessionId ? { vaSessionId: p.va.sessionId } : {}) });
  }
}

function vaTimeouts(c: Ctx, now: number): void {
  const s = c.s;
  const p = s.pass;
  if (!p || p.closing || !vaPhase(s.phase)) return;
  const va = p.va;
  const d = vaDeadline(s);
  if (d === null || now < d) return;
  if (va.status === "open" && va.sendAt !== null) return maybeStart(c, now);
  const what = va.status === "minting" ? "the live AI token" : va.status === "opening" ? "the live AI connection" : va.status === "starting" ? "session.ready" : "the first audible greeting";
  onVaFailure(c, now, va.attempt, "E_VA_TIMEOUT", true, `timed out waiting for ${what}`);
}

/** RETRYING (once, attempt 1) or, with no retry left, FALLBACK / FAILED (§5.5.3, §5.9.6). */
function onVaFailure(c: Ctx, now: number, attempt: 0 | 1, code: ErrorCode, retryable: boolean, message: string): void {
  const s = c.s;
  const p = s.pass;
  if (!p || p.va.attempt !== attempt || p.va.status === "dead" || p.va.status === "ended" || p.va.status === "idle") return;
  if (s.phase === "active" || s.phase === "paying") return failMidSession(c, now, code, message);
  if (s.phase === "closing" || s.phase === "done" || s.phase === "failed" || s.phase === "fallback") return;
  const takeoverId = p.arm.takeoverId;
  const hadSocket = hasSocket(p.va);
  if (attempt === 0 && retryable && takeoverId) {
    if (hadSocket) c.fx({ type: "abort_va", attempt: 0, reason: code });
    c.fx({ type: "report_failure", takeoverId, code });
    c.fx({ type: "mint_va", attempt: 1, takeoverId });
    p.va = { attempt: 1, status: "minting", since: now, liveSessionId: null, sessionId: null, readyAt: null, sendAt: null, lastCode: code };
    p.timings.retry = now - p.t0;
    if (s.phase === "connecting" || s.phase === "greeting") s.phase = "retrying";
    return;
  }
  if (hadSocket) c.fx({ type: "abort_va", attempt, reason: code });
  p.va = { ...p.va, status: "dead", since: now, lastCode: code };
  if (s.phase === "connecting" || s.phase === "retrying" || s.phase === "greeting") giveUp(c, now, code, message);
  // Earlier phases: the pass continues until CONNECTING, where enterConnecting gives up (the snapshot still freezes).
}

/** No live AI for this pass: the labelled recorded AI session if the call has one, else the error card. */
function giveUp(c: Ctx, now: number, code: ErrorCode, message: string): void {
  const s = c.s;
  const p = c.p;
  if (hasSocket(p.va)) c.fx({ type: "abort_va", attempt: p.va.attempt, reason: code });
  p.va = { ...p.va, status: "dead", lastCode: code };
  p.timings.gaveUp = now - p.t0;
  postEnd(c, "failed", `${code}: ${message}`, false);
  s.lastOutcome = "failed";
  if (s.cfg.hasRecordedBundle) {
    s.phase = "fallback";
    c.fx({ type: "notice", level: "info", code, message: "Live AI is unavailable, so the recorded AI session plays (labelled)." });
    c.fx({ type: "play_recorded" });
  } else {
    s.phase = "failed";
    c.fx({ type: "notice", level: "error", code, message: `The live AI could not start: ${message}` });
  }
}

function failMidSession(c: Ctx, now: number, code: ErrorCode, message: string): void {
  c.fx({ type: "notice", level: "error", code, message: `The live AI dropped: ${message}` });
  startClosing(c, now, "failed", code, "failed");
}

// ------------------------------------------------------------------------------------------------ active, paying, closing

function onPaying(c: Ctx, now: number, on: boolean): void {
  const s = c.s;
  if (on && s.phase === "active") s.phase = "paying";
  else if (!on && s.phase === "paying") s.phase = "active";
  void now;
}

function onCloseReady(c: Ctx, now: number): void {
  if (c.s.phase === "active" || c.s.phase === "paying") startClosing(c, now, "completed", "close_ready", "done");
}

function onHandBack(c: Ctx, now: number, reason: string): void {
  const s = c.s;
  if (s.phase !== "active" && s.phase !== "paying") return;
  startClosing(c, now, "handed_back", `hand_back:${reason}`, "done", true);
}

function onEndCall(c: Ctx, now: number, reason: string): void {
  const s = c.s;
  const p = s.pass;
  switch (s.phase) {
    case "greeting":
    case "active":
    case "paying":
      return startClosing(c, now, "abandoned", reason, "done");
    case "armed":
    case "sealing":
    case "draining":
    case "compiling":
    case "connecting":
    case "retrying":
      if (!p) return;
      if (hasSocket(p.va)) c.fx({ type: "abort_va", attempt: p.va.attempt, reason });
      p.va = { ...p.va, status: "dead" };
      if (s.phase === "armed") c.fx({ type: "stop_playback", fadeMs: 30 });
      c.fx({ type: "terminate_stt" });
      postEnd(c, "abandoned", reason, false);
      s.lastOutcome = "abandoned";
      s.phase = "done";
      return;
    case "fallback":
      c.fx({ type: "stop_recorded" });
      s.phase = "done";
      return;
    default:
      return;
  }
}

function startClosing(c: Ctx, now: number, outcome: TakeoverOutcome, reason: string, finalPhase: "done" | "failed", repBack = false): void {
  const s = c.s;
  const p = c.p;
  if (p.closing) return;
  s.phase = "closing";
  p.closing = { outcome, reason, finalPhase, startedAt: now, step: repBack ? "rep_back" : "ending" };
  p.timings.closing = now - p.t0;
  if (repBack) c.fx({ type: "play_rep_back" });
  else c.fx({ type: "end_va", reason });
}

function onRepBackDone(c: Ctx, now: number): void {
  const p = c.s.pass;
  if (!p?.closing || p.closing.step !== "rep_back") return;
  p.closing = { ...p.closing, step: "ending", startedAt: now };
  c.fx({ type: "end_va", reason: "hand_back" });
}

function onVaEnded(c: Ctx, now: number, attempt: 0 | 1, reason: string, sessionSeconds: number | null): void {
  const s = c.s;
  const p = s.pass;
  if (!p || p.va.attempt !== attempt || p.va.status === "ended" || p.va.status === "dead") return;
  if (s.phase === "closing") return finishPass(c, now, sessionSeconds);
  if (s.phase === "active" || s.phase === "paying") {
    // The VA controller ended the session itself: the dynamic cap or the absolute ceiling (§5.9.5).
    const cap = /cap|ceiling/i.test(reason);
    p.closing = { outcome: cap ? "handed_back" : "failed", reason: cap ? "cap" : `ended:${reason}`, finalPhase: cap ? "done" : "failed", startedAt: now, step: "ending" };
    s.phase = "closing";
    return finishPass(c, now, sessionSeconds);
  }
  // Before the greeting was heard, an unexpected end is a failure of this attempt.
  onVaFailure(c, now, attempt, "E_VA_TRANSIENT", true, `the session ended (${reason})`);
}

function finishPass(c: Ctx, now: number, sessionSeconds: number | null): void {
  const s = c.s;
  const p = c.p;
  const closing = p.closing;
  if (!closing) return;
  const wasOpen = p.va.status !== "idle" && p.va.status !== "minting" && p.va.status !== "dead";
  p.va = { ...p.va, status: "ended", since: now };
  if (wasOpen && p.va.liveSessionId) {
    c.fx({ type: "report_va", event: "closed", liveSessionId: p.va.liveSessionId, ...(sessionSeconds !== null ? { billedSeconds: sessionSeconds } : {}) });
  }
  p.timings.ended = now - p.t0;
  postEnd(c, closing.outcome, closing.reason, false);
  s.lastOutcome = closing.outcome;
  s.phase = closing.finalPhase;
}

function postEnd(c: Ctx, outcome: TakeoverOutcome, reason: string, keepalive: boolean): void {
  const p = c.p;
  if (p.endPosted || !p.arm.takeoverId) return;
  p.endPosted = true;
  c.fx({ type: "post_end", takeoverId: p.arm.takeoverId, outcome, vaSessionId: p.va.sessionId, reason, keepalive });
}

// ------------------------------------------------------------------------------------------------ end of recording, pagehide

function onRecordingEnded(c: Ctx, now: number): void {
  const s = c.s;
  if (s.phase === "armed" && s.pass) {
    // Auto-baton whose acceptance runs past the end of the recording, or a manual pass at the very end.
    seal(c, now, s.sample?.callMs ?? s.pass.tArmMs);
    return;
  }
  // Rule 8: the recording ended without a pass → release the unused VA hold.
  if (s.phase === "idle" && s.passes === 0 && !s.runReleased) {
    s.runReleased = true;
    c.fx({ type: "release_run", keepalive: false });
  }
}

/** Any state → session.end (sync) + STT terminate + keepalive /end + keepalive run release; then inert. */
function onPageHide(c: Ctx, now: number): void {
  const s = c.s;
  const p = s.pass;
  if (p) {
    if (hasSocket(p.va)) c.fx({ type: "end_va_now", reason: "pagehide" });
    const live = s.phase !== "done" && s.phase !== "failed" && s.phase !== "idle";
    if (live && !p.endPosted && p.arm.takeoverId) {
      p.endPosted = true;
      c.fx({ type: "post_end", takeoverId: p.arm.takeoverId, outcome: "abandoned", vaSessionId: p.va.sessionId, reason: "pagehide", keepalive: true });
    }
    p.timings.pagehide = now - p.t0;
  }
  if (s.phase === "fallback") c.fx({ type: "stop_recorded" });
  c.fx({ type: "terminate_stt" });
  c.fx({ type: "release_run", keepalive: true });
  s.runReleased = true;
  s.disposed = true;
}

// ================================================================================================ views

/** The DrainReport-independent view WP4's STT manager needs for the `late` flag (§5.1.7). */
export function armView(s: TakeoverMachineState): { armed: boolean; tArmMs: number | null } {
  const p = s.pass;
  const armed = !!p && s.phase !== "idle" && s.phase !== "done" && s.phase !== "failed" && s.phase !== "fallback";
  return { armed, tArmMs: armed && p ? p.tArmMs : null };
}

/**
 * contracts/services.ts - the seams between work packages (docs/TASKS.md §2). TYPES ONLY: no runtime code.
 * Frozen at G0. Code against these interfaces and inject dependencies, so you can stub what isn't built yet.
 *
 * Browser types (AudioContext) are referenced as ambient DOM lib types; nothing here is a value import.
 */
import type {
  ArmRequest, ArmResponse, CreateCaseResponse, EndTakeoverRequest, SessionReport, StartRunRequest, TakeoverEventsRequest,
} from "./api";
import type {
  CaseState, CaseStatus, Channel, ConflictCard, FactEvent, FieldId, PaymentStatus, PolicyRecord, Stage,
} from "./case";
import type { BatonEvent, HudMetric, TakeoverPhase } from "./events";
import type { ExtractTurnInput, ExtractTurnOutput, VerifierResult } from "./extract";
import type { RunPlan } from "./run";
import type { CallManifestEntry } from "./scenario";
import type { CompiledTakeover, DrainReport, InputModePlan, TranscriptionMode } from "./takeover";
import type { ToolArgs, ToolName, VaFunctionTool } from "./tools";
import type { TurnInput } from "./turns";

// ---------- limits authority (DESIGN §2.3; implemented by WP2 [db, remote] and WP0b [file guard]) ----------
export type OpenSource = "judge" | "script" | "synthetic" | "test" | "mirror";
// G0: `sessionIds` = one live_sessions id per granted open (length n; [rep, customer] for n = 2). Openers report with them.
export type SlotResult = { status: "granted"; grantId: string; sessionIds: string[] } | { status: "queued"; ticket: string; position: number; etaMs: number }
  | { status: "denied"; code: "E_BUDGET" | "E_MODE_REPLAY_ONLY" | "E_QUEUE_TIMEOUT" | "E_RATE_LIMITED" | "E_AAI_BALANCE"; message: string };
export interface LimitsAuthority {
  sttAcquire(req: { n: 1 | 2; visitorId: string; ipKey: string; ticket?: string; runId?: string; reconnect?: boolean;
                    source: OpenSource; deployId: string }): Promise<SlotResult>;            // ETA > 15 s ⇒ denied(E_QUEUE_TIMEOUT)
  sttCancel(ticket: string): Promise<void>;
  vaHold(req: { runId: string; visitorId: string; ipKey: string; expiresAt: string; estUsd: number; deployId: string }):
    Promise<{ ok: true; holdId: string } | { ok: false; code: "E_VA_CAPACITY" | "E_BUDGET" | "E_MODE_REPLAY_ONLY" | "E_AAI_BALANCE"; message: string }>;
  // G0: for VA, capMs is the ABSOLUTE ceiling vaAbsoluteCeilingMs(VA_SESSION_CAP_MAX_MS) (contracts/takeover.ts), not the
  // dynamic vaSessionCapMs (unknown at mint time); F5 marks the row stale at cap_ms + 60 s.
  vaAcquire(req: { holdId?: string; takeoverId?: string; attempt: 0 | 1; capMs: number; source: OpenSource; deployId: string }):
    Promise<{ ok: true; liveSessionId: string } | { ok: false; code: "E_VA_CAPACITY" | "E_BUDGET" | "E_MODE_REPLAY_ONLY" | "E_AAI_BALANCE"; message: string }>;
  release(liveSessionIdOrHoldId: string, reason: string): Promise<void>;
  heartbeat(liveSessionId: string): Promise<void>;
  report(r: SessionReport): Promise<void>;                                                   // opened/closed, billed seconds
  ledger: SpendLedger;
  flags(): Promise<AppFlags>;
}
export type GetLimitsAuthority = () => LimitsAuthority;   // by LIMITS_ROLE: "authority" → db; "remote" → HTTP; unset URL → file guard

// ---------- server (implemented in src/server/**) ----------
export interface RateLimiter { hit(bucket: string, key: string, limit: number, windowSec: number, cost?: number): Promise<{ ok: boolean; retryAfterSec: number }> }
export interface SpendLedger {
  reserve(e: { provider: "aai_stt" | "aai_va" | "aai_async" | "openai" | "polar"; action: string; refId: string; estUsd: number; env: string }):
    Promise<{ ok: true; id: string } | { ok: false; code: "E_BUDGET" }>;
  settle(id: string, actualUsd: number): Promise<void>; release(id: string): Promise<void>;
  summary(): Promise<{ sinceEpochUsd: number; todayUsd: Record<string, number>; dailyCapUsd: number; judgingBudgetUsd: number; pctToday: number;
                       byEnv: Record<string, number> }>;
}
export interface AppFlags { mode: "live" | "replay_only" | "maintenance"; reason: string | null; notice: string | null;
  paymentsModeOverride: "polar" | "mock" | null; aaiBalanceUsd: number | null }
export interface FlagStore { get(): Promise<AppFlags>; set(patch: Partial<AppFlags>, reason: string): Promise<void> }
export interface RunService { start(i: StartRunRequest & { visitorId: string; ipKey: string }): Promise<RunPlan>; release(runId: string): Promise<void> }
export type JobKind = "verify_takeover" | "purge" | "va_audit" | "budget_guard";
export interface JobRunner {
  register(kind: JobKind, step: (job: { id: string; refId: string; state: unknown; attempts: number }) => Promise<{ state: unknown; next: "done" | "failed" | { afterMs: number } }>): void;
  enqueue(kind: JobKind, refId: string, opts?: { runAfterMs?: number; state?: unknown }): Promise<string>;
  advance(jobId: string): Promise<"pending" | "running" | "done" | "failed">; tick(): Promise<number>;
}
export interface CaseRepository {
  create(input: { mode: "watch" | "live" | "spot" | "synthetic"; callId: string | null; scenarioId: string; visitorId: string; ipKey: string; prefillUntilMs?: number }): Promise<{ caseId: string; state: CaseState; policy: PolicyRecord }>;
  load(caseId: string): Promise<{ state: CaseState; version: number; policy: PolicyRecord; status: CaseStatus; tArmMs: number | null; scenarioId: string; callId: string | null; runPlan: RunPlan | null } | null>;   // G0: CaseStatus
  insertTurn(t: TurnInput): Promise<"inserted" | "duplicate">;
  applyEvents(caseId: string, expectedVersion: number, events: Omit<FactEvent, "seq">[]): Promise<{ state: CaseState; version: number }>;  // short tx + advisory lock; re-derives if newer events landed
  recompute(caseId: string, ctx?: { tArmMs?: number }): Promise<CaseState>;
  freezeSnapshot(caseId: string, takeoverId: string, drain: DrainReport): Promise<CaseState>;   // used by WP5 compile
  setRunPlan(caseId: string, plan: RunPlan): Promise<void>;
}
export interface Extractor { extractTurn(input: ExtractTurnInput): Promise<ExtractTurnOutput> }   // never called inside a DB transaction
export interface Verifier { verifyCase(input: { caseId: string; policy: PolicyRecord; callDate: string; turns: TurnInput[] }): Promise<VerifierResult & { ms: number; usd: number }> }
export interface ToolContext { caseId: string; takeoverId: string; callId: string; visitorId: string; origin: string }
export interface ToolOutcome { result: Record<string, unknown>; stage?: Stage; systemPrompt?: string; tools?: VaFunctionTool[];
  transcriptionMode?: TranscriptionMode; ui?: { sms?: string; link?: string; paymentId?: string; conflict?: ConflictCard } }
export interface ToolService { handle<N extends ToolName>(name: N, args: ToolArgs[N], ctx: ToolContext): Promise<ToolOutcome> }
export interface PaymentProvider { kind: "polar" | "mock";
  createCheckout(i: { paymentId: string; caseId: string; takeoverId: string; scenarioId: string; amountCents: number; policy: PolicyRecord; origin: string }):
    Promise<{ checkoutId: string | null; url: string | null; embed: { url: string; origin: string } | null; totalAmountCents: number | null; taxAmountCents: number | null }>;
  getStatus(checkoutId: string): Promise<{ status: PaymentStatus; totalAmountCents: number | null }> }
export interface TakeoverService {
  arm(i: ArmRequest & { visitorId: string }): Promise<ArmResponse>;
  compile(takeoverId: string, drain: DrainReport): Promise<CompiledTakeover>;       // runs validateFirstUpdate before returning
  recordEvents(takeoverId: string, e: TakeoverEventsRequest): Promise<void>;          // heartbeat → LimitsAuthority.heartbeat
  end(takeoverId: string, e: EndTakeoverRequest): Promise<{ verificationJobId: string | null }>;
}
export type EnqueueVerification = (takeoverId: string, vaSessionId: string | null) => Promise<string | null>;   // WP8

// ---------- pure core helpers other WPs call (implemented by WP1 in src/core/compiler/**) ----------
export type ValidateFirstUpdate = (msg: { type: "session.update"; session: Record<string, unknown> }, opts: { keytermsEnabled: boolean }) => void; // throws E_VA_CONFIG
export type InputModeFor = (next: { kind: "confirm" | "ask" | "disclosure" | "consent" | "none"; field: FieldId | null }) => InputModePlan;
export type VaSessionCapMs = (snapshot: CaseState, env: { baseMs: number; perFieldMs: number; maxMs: number }) => number;

// ---------- client (implemented in src/client/**) ----------
export interface EventSink { emit(ev: BatonEvent): void }
export interface CallTick { callMs: number; playing: boolean; rep: Uint8Array; customer: Uint8Array }   // source-format bytes since the last tick
export interface CallPlayback { start(fromMs: number): void; stop(fadeMs?: number): void; dispose(): void; readonly callMs: number;
  onTick(cb: (t: CallTick) => void): () => void; onEnded(cb: () => void): () => void; duck(level: number): void;
  channelEnergyDb(ch: Channel, windowMs: number): number; playSpan(ch: Channel | "both", fromMs: number, toMs: number): Promise<void>;
  playHandoffClip(h: NonNullable<CallManifestEntry["handoff"]>): Promise<{ endCtxMs: number }> }   // rep line + 300 ms + customer acceptance
export interface VaOutputPlayer { push(b64Pcm24k: string, replyId: string, audible: boolean): void; flush(): void; holdUntil(ctxTimeMs: number): void;
  onFirstAudiblePlayed(cb: (replyId: string, ctxTimeMs: number) => void): () => void; setVolume(v: number): void; readonly underruns: number }
export interface PacedFeeder { start(send: (frame24k: Uint8Array) => void): void; stop(): void; enqueueClip(pcm24k: Int16Array): Promise<{ endCtxMs: number }>;
  setMicSource(src: MicSource | null): void; clear(): void }
export interface MicSource { onFrame(cb: (pcm: Int16Array) => void): () => void; stop(): Promise<void>; energyDb(): number }
export interface AudioEngine { readonly ctx: AudioContext; unlockSync(): void;   // MUST be called synchronously inside the click handler (resume + iOS audioSession "playback")
  nowMs(): number; setAudioSession(kind: "playback" | "play-and-record"): void;
  loadCall(entry: CallManifestEntry, assets: CreateCaseResponse["assets"], onProgress?: (p: number) => void): Promise<CallPlayback>;
  createVaOutput(): VaOutputPlayer; createFeeder(): PacedFeeder; openMic(targetRate: 16000 | 24000): Promise<MicSource>;
  playPcm24k(pcm: Int16Array, opts?: { volume?: number }): Promise<void> }
export interface PageLifecycle { onPause(cb: (reason: "ios_background" | "audio_interrupted") => void): () => void;
  onResume(cb: () => void): () => void; readonly isIOS: boolean }                       // WP4, src/client/platform/lifecycle.ts
export interface SttChannelManager {
  open(p: { caseId: string; caseToken: string; runId: string; call: CallManifestEntry; policy: PolicyRecord; startOffsetMs: number;
            ctxCarry: "none" | "last_rep_turn"; seedAgentContext?: string }): Promise<"live" | "queued" | "denied">;
  feed(t: CallTick): void; hasOpenPartial(ch: Channel): boolean; forceEndpoint(ch: Channel): void; pause(): Promise<void>; resume(): Promise<void>;
  terminateAll(): Promise<{ channel: Channel; billedSeconds: number | null }[]>; readonly status: Record<Channel, "idle" | "queued" | "open" | "closed" | "cached" | "paused"> }
export interface CaseSync { enqueue(turn: TurnInput): void; drain(timeoutMs: number): Promise<Pick<DrainReport, "completedTurnIds" | "pendingTurnIds" | "waitedMs">>;
  readonly state: CaseState | null; onState(cb: (s: CaseState) => void): () => void }
export interface LatencyHud { mark(name: "arm" | "repLineStart" | "repLineEnd" | "updateSent" | "sessionReady" | "eos" | "replyStarted" | "firstAudiblePlayed", ctxMs: number, replyId?: string): void;
  summary(): Partial<Record<HudMetric, { last: number; p50: number; p90: number; n: number }>>; setSessionIds(ids: { rep?: string; customer?: string; va?: string }): void }
export interface TakeoverController { arm(source: "manual" | "auto_handoff"): Promise<void>; readonly phase: TakeoverPhase; abort(reason: string): void;
  readonly manualPassAllowed: boolean }                                                   // false when RunPlan.aiHalf === "recorded"
export interface VoiceAgentController {
  connect(token: string): Promise<void>; start(c: CompiledTakeover, opts: { holdAudioUntilCtxMs: number }): Promise<{ sessionId: string }>;
  applyStage(r: Pick<ToolOutcome, "systemPrompt" | "tools" | "stage" | "transcriptionMode">): void; say(instructions: string): void;   // reply.create
  setPayingState(phone: PhoneState): void;                                                 // drives the progress-aware hold (DESIGN §5.8)
  end(reason: string): Promise<void>; readonly sessionId: string | null }
export type PhoneState = "idle" | "sms-received" | "esign" | "signed" | "checkout-loading" | "checkout-open" | "processing" | "simulating"
  | "autopilot-countdown" | "paid" | "failed" | "expired" | "timeout";
export interface MockPhoneProps { events: BatonEvent[]; paymentId: string | null; takeoverToken: string; variant: "docked" | "floating";
  readOnly: boolean; autopilot: boolean; onState(s: PhoneState): void }                  // WP6 component; WP7 mounts it
export interface CustomerInput { mode: "autopilot" | "chips" | "typed" | "mic"; suggestions(): Suggestion[]; play(s: Suggestion): Promise<void>;
  sendTyped(text: string): Promise<void>; enableMic(): Promise<boolean>; setAutopilot(on: boolean): void }
export interface Suggestion { id: string; text: string; audioUrl: string | null; voice: "recorded" | "synthetic";
  kind: "confirm" | "answer" | "consent" | "handback" | "repeat" | "close" | "try" | "other" }
export interface ReplayPlayer { load(bundleUrl: string): Promise<void>; play(sink: EventSink): Promise<void>; stop(): void }
export interface BatonStore { dispatch(ev: BatonEvent): void; getState(): BatonUiState; subscribe(cb: () => void): () => void }   // BatonUiState: WP7

/**
 * The UI store state is WP7's. It is an (intentionally empty) interface so WP7 can declare its fields by module
 * augmentation from `src/core/contracts/ext/wp7-*.ts`:
 *   declare module "../services" { interface BatonUiState { phase: UiPhase; ... } }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface BatonUiState {}

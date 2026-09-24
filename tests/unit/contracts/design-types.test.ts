/**
 * Type-level parity: the zod-inferred contract types equal the DESIGN §4.1 interface text (copied verbatim below,
 * plus the G0 amendments marked `// G0:`; each one is listed under "Contract decisions" in docs/notes/g0.md) and the
 * HTTP schemas of route #28 equal the services.ts LimitsAuthority types. Checked by `npm run typecheck` (a mismatch
 * is a compile error); the runtime assertions are trivially true.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type * as C from "../../../src/core/contracts";
import type * as A from "../../../src/core/contracts/api";
import type * as S from "../../../src/core/contracts/services";

/** true iff X and Y are identical types (strict: optional extras and readonly differences fail too). */
type Same<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const same = <T extends true>(): T | undefined => undefined;

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace D {
  // ── contracts/case.ts (DESIGN §4.1, verbatim) ──
  export type Channel = "rep" | "customer";
  export type Party = Channel | "ai" | "policy" | "verifier";
  export type FieldStatus = "VERIFIED" | "PENDING" | "MISSING";
  export type FieldId =
    | "driver_full_name" | "driver_dob" | "driver_age" | "driver_relation"
    | "license_state" | "license_status" | "license_number" | "incidents_3y"
    | "vehicle_assignment" | "operator_type" | "garaging_zip" | "effective_date"
    | "good_student_discount" | "driver_training_discount" | "distant_student_discount" | "mature_driver_discount"
    | "coverage_change" | "underwriting_review"
    | "premium_new_monthly_usd" | "premium_change_monthly_usd" | "amount_due_today_usd";
  export type StatusReason =
    | "acknowledged" | "read_back" | "both_stated" | "policy_record" | "ai_confirmed"
    | "stated_once" | "late_turn" | "conflict" | "denied" | "verifier_disagrees"
    | "verifier_only" | "rep_only_violation"
    | "out_of_range"                                    // G0: §5.4.1 effective_date guard (PENDING)
    | "absent";
  export interface Evidence {
    channel: Channel | "ai" | "customer_ai";
    turnId: string; startMs: number; endMs: number;
    quote: string; source: "stt_live" | "stt_cache" | "va_transcript" | "async_ch2" | "async_ch1";
  }
  export type FactKind = "stated" | "readback" | "ack" | "corrected" | "denied" | "question" | "tool_update" | "policy"
    | "verifier";                                       // G0: §5.4.2 `case "verifier"`, F2 step 3
  export interface FactEvent {
    id: string; caseId: string; field: FieldId; kind: FactKind; party: Party;
    valueRaw: string | null; valueNorm: string | null;
    acknowledgesTurnId: string | null; confidence: "high" | "medium" | "low";
    turnId: string | null; turnEndMs: number; late: boolean; cut: boolean;
    evidence: Evidence | null; extractor: "luna" | "sol" | "tool" | "policy"; seq: number;
  }
  export interface FieldState {
    field: FieldId; status: FieldStatus; reason: StatusReason;
    value: string | null; display: string | null; source: Party | null;
    evidence: Evidence[];
    conflict: { values: string[]; evidence: Evidence[] } | null;
    flags: ("late_turn" | "cut_turn" | "verifier_disagrees" | "customer_corrected_verified"
      | "out_of_range")[];                              // G0
    updatedAtMs: number;
  }
  export interface Readiness { verified: number; pending: number; missing: number; requiredTotal: number; ready: boolean }
  export interface ConflictCard { field: FieldId; values: { value: string; party: Party; evidence: Evidence | null }[]; resolved: boolean; resolution?: string }
  export type Stage = "confirm" | "disclose" | "pay" | "close";
  export type PaymentStatus = "none" | "created" | "open" | "confirmed" | "succeeded" | "failed" | "expired" | "timeout";
  export interface PolicyVehicle { id: string; year: number; make: string; model: string; label: string }
  export interface PolicyRecord {
    policyNumber: string; carrier: string; agencyName: string; repFirstName: string;
    policyholder: { firstName: string; lastName: string };
    phoneOnFileLast4: string;
    address: { street: string; city: string; state: string; zip: string };
    existingDrivers: { name: string; relation: string }[]; vehicles: PolicyVehicle[];
    currentMonthlyPremiumUsd: number; callDate: string;
  }
  export interface CaseState {
    caseId: string; intent: "add_driver"; version: number; callClockMs: number;
    fields: Record<FieldId, FieldState>; readiness: Readiness; conflicts: ConflictCard[];
    stage: Stage | null; disclosuresGiven: ("premium_change" | "esign_consent")[];
    payment: { id: string; status: PaymentStatus; amountCents: number; totalAmountCents: number | null;
               provider: "polar" | "mock"; simulated: boolean } | null;
    confirmationNumber: string | null;
  }
  // ── contracts/turns.ts ──
  export interface WordTiming { text: string; startMs: number; endMs: number; confidence: number }
  export interface TurnInput {
    caseId: string; turnId: string;
    channel: Channel; text: string; startMs: number; endMs: number; words: WordTiming[];
    source: "stt_live" | "stt_cache" | "typed" | "mic";
    recvMs: number;
    cut: boolean; late: boolean;
  }
  // ── contracts/scenario.ts ──
  export type CallAudioFormat = { encoding: "pcm_mulaw"; sampleRate: 8000 } | { encoding: "pcm_s16le"; sampleRate: 16000 };
  export interface CallManifestEntry {
    callId: string; scenarioId: string; title: string; source: "golden16k" | "twilio8k";
    language: "en" | "hinglish"; durationMs: number; format: CallAudioFormat;
    publishAudio: boolean;
    inEval: boolean;
    featured: boolean;
    picker: "main" | "more" | "hidden";
    decisionPointMs: number | null;
    handoff: { lineStartMs: number; lineEndMs: number; acceptStartMs: number | null; acceptEndMs: number | null;
               declined: boolean } | null;
    recordedAiBundle: string | null;
    customerTailPack: string | null;
    assets: { rep: string; customer: string; peaks: string } | null;   // G0: content-hashed URLs (§5.1.1)
  }
  export interface Scenario {
    id: string; intent: "add_driver"; title: string; language: "en" | "hinglish"; callDate: string;
    policy: PolicyRecord;
    truth: Partial<Record<FieldId, string>>;
    expectedAtHandoff: Partial<Record<FieldId, FieldStatus>>;
    plannedHandoffS: number; handoffResponse: "accepts" | "accepts_after_question" | "declines";
    rating: { newMonthlyUsd: number; changeMonthlyUsd: number | null; dueTodayUsd: number };
    traps: string[];
  }
  export interface CallLabels {
    callId: string; reviewed: boolean;
    mentions: { field: FieldId; valueNorm: string; channel: Channel; statedAtMs: number; ackedAtMs: number | null; quote: string }[];
    handoff: { lineStartMs: number; lineEndMs: number; acceptStartMs: number | null; acceptEndMs: number | null } | null;
    diagnosisEndsMs: number | null; tailStartsMs: number | null;
  }
  // ── contracts/run.ts ──
  export interface RunPlan {
    runId: string; caseId: string;
    sttHalf: "live" | "cached";
    aiHalf: "live" | "recorded";
    vaHoldId: string | null;
    holdExpiresAt: string | null;
    reason: string | null;
    recordedHandoffMs: number | null;
  }
  // ── contracts/events.ts ──
  export type BatonEvent =
    | { t: number; type: "call.loaded"; callId: string; durationMs: number }
    | { t: number; type: "run.plan"; plan: RunPlan }
    | { t: number; type: "paused"; reason: "ios_background" | "audio_interrupted"; resumed: boolean }
    | { t: number; type: "phone.state"; state: string }
    | { t: number; type: "mode"; mode: "live" | "cached_replay" | "recorded_ai"; reason?: string }
    | { t: number; type: "stt.status"; channel: Channel; status: "queued" | "connecting" | "open" | "reconnecting" | "terminated" | "error"; detail?: string }
    | { t: number; type: "stt.partial"; channel: Channel; turnOrder: number; text: string }
    | { t: number; type: "stt.final"; turn: TurnInput }
    | { t: number; type: "case.state"; state: CaseState }
    | { t: number; type: "case.facts"; events: FactEvent[] }
    | { t: number; type: "verifier"; agrees: boolean; disagreements: FieldId[] }
    | { t: number; type: "takeover.phase"; phase: TakeoverPhase; atMs: number; detail?: Record<string, number | string> }
    | { t: number; type: "va.status"; status: "connecting" | "ready" | "ended" | "error"; sessionId?: string; code?: string }
    | { t: number; type: "va.reply"; replyId: string; phase: "started" | "first_audible" | "done"; kind?: ReplyKind; interrupted?: boolean }
    | { t: number; type: "va.caption"; replyId: string; words: { text: string; atMs: number }[] }
    | { t: number; type: "va.user"; text: string; final: boolean }
    | { t: number; type: "va.tool"; callId: string; name: ToolName; phase: "call" | "result"; args?: unknown; result?: unknown }
    | { t: number; type: "stage"; stage: Stage }
    | { t: number; type: "payment"; status: PaymentStatus; source?: "webhook" | "server_poll" | "mock" }
    | { t: number; type: "phone.sms"; text: string; link?: string }
    | { t: number; type: "qa"; qa: QaResult }
    | { t: number; type: "hud"; metric: HudMetric; ms: number }
    | { t: number; type: "fallback"; kind: FallbackKind; label: string }
    | { t: number; type: "error"; code: ErrorCode; message: string };
  export type ReplyKind = "speech" | "tool_preamble" | "unspoken_text" | "silent_no_output";
  export type TakeoverPhase = "idle" | "armed" | "sealing" | "draining" | "compiling" | "connecting" | "greeting"
    | "active" | "paying" | "closing" | "done" | "retrying" | "fallback" | "failed";
  export type HudMetric = "click_to_first_audible" | "dead_air_after_rep" | "turn_audible_latency" | "tool_turn_latency";
  export type FallbackKind = "cached_turn_replay" | "recorded_ai_session" | "typed_tts" | "mock_payment" | "hosted_checkout";
  export interface QaResult {
    provisional: boolean; reAsked: number; newlyAsked: number; pendingConfirmed: number; verifiedReconfirmed: number;
    disclosures: { kind: "premium_change" | "esign_consent"; similarity: number; ok: boolean; missingCritical: string[] }[];
    clickToFirstAudibleMs: number | null; deadAirAfterRepMs: number | null; turnLatencyP50Ms: number | null;
    payment: "verified_webhook" | "verified_poll" | "simulated" | "unpaid"; handedBack: boolean; aiSeconds: number;
    adviceFlags: number;
    details: { sentence: string; atMs: number; field: FieldId | null; classification: "reask" | "new" | "pending_confirm" | "verified_reconfirm" | "advice" | "other" }[];
  }
  // ── contracts/errors.ts ──
  export type ErrorCode =
    | "E_BUDGET" | "E_RATE_LIMITED" | "E_QUEUE_TIMEOUT" | "E_MODE_REPLAY_ONLY" | "E_MAINTENANCE"
    | "E_STT_AUTH" | "E_STT_RATE" | "E_STT_INPUT" | "E_STT_TRANSIENT" | "E_STT_INACTIVITY" | "E_AAI_BALANCE"
    | "E_VA_AUTH" | "E_VA_CONFIG" | "E_VA_CAPACITY" | "E_VA_SILENT" | "E_VA_TIMEOUT" | "E_VA_TRANSIENT"
    | "E_OPENAI_TIMEOUT" | "E_OPENAI_REFUSAL" | "E_OPENAI_RATE" | "E_POLAR_API" | "E_POLAR_SIG"
    | "E_MIC_DENIED" | "E_AUDIO_LOCKED" | "E_CASE_TOKEN" | "E_CASE_STATE" | "E_DB" | "E_INTERNAL"
    | "E_BAD_REQUEST" | "E_FORBIDDEN" | "E_NOT_FOUND";  // G0: the §4.4 400/403/404 conventions
  export interface ApiError { error: { code: ErrorCode; message: string; retryAfterMs?: number; fallback?: FallbackKind } }
  // ── contracts/tools.ts ──
  export type ToolName = "confirm_effective_date" | "get_disclosure" | "send_esign_and_pay_link" | "send_confirmation"
    | "update_case_field" | "hand_back_to_rep";
  export interface VaFunctionTool { type: "function"; name: ToolName; description: string; parameters: Record<string, unknown>;
    execution_mode: "interactive" | "hold"; timeout_seconds: number }
  // ── contracts/takeover.ts ──
  export interface DrainReport { tArmMs: number; tCutMs: number; capHit: boolean; midUtterance: boolean;
    completedTurnIds: string[]; pendingTurnIds: string[]; cutTurnIds: string[]; waitedMs: number;
    timings: Partial<Record<"armed" | "sealed" | "finals" | "drained", number>> }
  export type TranscriptionMode = "min_latency" | "balanced" | "max_accuracy";
  export interface CompiledTakeover { greeting: string; systemPrompt: string; keyterms: string[];
    tools: VaFunctionTool[]; stage: Stage; snapshot: CaseState; voice: string;
    transcriptionMode: TranscriptionMode;
    vaSessionCapMs: number;
    promptVersion: string; deployMarker: string;
    compiledBy: "server" | "client" }
  export interface InputModePlan { mode: TranscriptionMode; reason: "asks_entity" | "yes_no" | "disclosure" | "id_capture" }
  // ── contracts/extract.ts ──
  export interface ExtractTurnInput { caseId: string; policy: PolicyRecord; callDate: string; state: CaseState;
    recent: TurnInput[]; newTurns: TurnInput[] }
  export interface ExtractTurnOutput { events: Omit<FactEvent, "seq">[];   // G0: seq is assigned by the repository
    ms: number; usage: { input: number; output: number }; model: string;
    extractorVersion: string; cached: boolean }
  export interface VerifierResult { uptoRecvMs: number; fields: { field: FieldId; value: string | null;
    support: "stated_and_confirmed" | "stated_once" | "conflicting" | "absent"; turnIds: string[]; quote: string }[] }
  // ── contracts/eval.ts ──
  export type PipelineVersion = "v1" | "v2" | "v3";
  export type SttVariant = "pc_ctx" | "pc_noctx" | "mono_diar" | "pc_ctx_8k";
  export interface SttCacheRecord { callId: string; variant: SttVariant; channel: Channel | "mono"; recvMs: number;
    message: Record<string, unknown> }
  export interface SweepMetrics { entityAcc: number | null; verifiedPrecision: number | null; wrongAsserted: number;
    wrongPending: number; reaskProjected: number; pendingN: number; missingN: number; ready: boolean;
    statusAgreementAtPlanned: number | null }
  export interface SweepPoint { callId: string; version: PipelineVersion; variant: SttVariant;
    ablation: "none" | "verifier_off";                  // G0: §6.4 "verifier off" ablation
    tMs: number; midUtterance: boolean;
    tCutMs: number; capHit: boolean; protocolMs: number;
    snapshot: Record<FieldId, { status: FieldStatus; value: string | null; display: string | null }>;
    greeting: string; metrics: SweepMetrics }
}

// ---- DESIGN §4.1 parity (compile-time) ----
same<Same<C.Channel, D.Channel>>();
same<Same<C.Party, D.Party>>();
same<Same<C.FieldStatus, D.FieldStatus>>();
same<Same<C.FieldId, D.FieldId>>();
same<Same<C.StatusReason, D.StatusReason>>();
same<Same<C.Evidence, D.Evidence>>();
same<Same<C.FactKind, D.FactKind>>();
same<Same<C.FactEvent, D.FactEvent>>();
same<Same<C.FieldState, D.FieldState>>();
same<Same<C.Readiness, D.Readiness>>();
same<Same<C.ConflictCard, D.ConflictCard>>();
same<Same<C.Stage, D.Stage>>();
same<Same<C.PaymentStatus, D.PaymentStatus>>();
same<Same<C.PolicyVehicle, D.PolicyVehicle>>();
same<Same<C.PolicyRecord, D.PolicyRecord>>();
same<Same<C.CaseState, D.CaseState>>();
same<Same<C.WordTiming, D.WordTiming>>();
same<Same<C.TurnInput, D.TurnInput>>();
same<Same<C.CallAudioFormat, D.CallAudioFormat>>();
same<Same<C.CallManifestEntry, D.CallManifestEntry>>();
same<Same<C.Scenario, D.Scenario>>();
same<Same<C.CallLabels, D.CallLabels>>();
same<Same<C.RunPlan, D.RunPlan>>();
same<Same<C.BatonEvent, D.BatonEvent>>();
same<Same<C.ReplyKind, D.ReplyKind>>();
same<Same<C.TakeoverPhase, D.TakeoverPhase>>();
same<Same<C.HudMetric, D.HudMetric>>();
same<Same<C.FallbackKind, D.FallbackKind>>();
same<Same<C.QaResult, D.QaResult>>();
same<Same<C.ErrorCode, D.ErrorCode>>();
same<Same<C.ApiError, D.ApiError>>();
same<Same<C.ToolName, D.ToolName>>();
same<Same<C.VaFunctionTool, D.VaFunctionTool>>();
same<Same<C.DrainReport, D.DrainReport>>();
same<Same<C.TranscriptionMode, D.TranscriptionMode>>();
same<Same<C.CompiledTakeover, D.CompiledTakeover>>();
same<Same<C.InputModePlan, D.InputModePlan>>();
same<Same<C.ExtractTurnInput, D.ExtractTurnInput>>();
same<Same<C.ExtractTurnOutput, D.ExtractTurnOutput>>();
same<Same<C.VerifierResult, D.VerifierResult>>();
same<Same<C.PipelineVersion, D.PipelineVersion>>();
same<Same<C.SttVariant, D.SttVariant>>();
same<Same<C.SttCacheRecord, D.SttCacheRecord>>();
same<Same<C.SweepMetrics, D.SweepMetrics>>();
same<Same<C.SweepPoint, D.SweepPoint>>();

// ---- the route #28 HTTP schemas carry exactly the in-process LimitsAuthority / SpendLedger shapes ----
type LA = S.LimitsAuthority;
same<Same<z.infer<typeof A.SttAcquireRequestSchema>, Parameters<LA["sttAcquire"]>[0]>>();
same<Same<A.SlotResultDto, S.SlotResult>>();
same<Same<z.infer<typeof A.VaHoldRequestSchema>, Parameters<LA["vaHold"]>[0]>>();
same<Same<z.infer<typeof A.VaHoldResultSchema>, Awaited<ReturnType<LA["vaHold"]>>>>();
same<Same<z.infer<typeof A.VaAcquireRequestSchema>, Parameters<LA["vaAcquire"]>[0]>>();
same<Same<z.infer<typeof A.VaAcquireResultSchema>, Awaited<ReturnType<LA["vaAcquire"]>>>>();
same<Same<z.infer<typeof A.LedgerReserveRequestSchema>, Parameters<S.SpendLedger["reserve"]>[0]>>();
same<Same<z.infer<typeof A.LedgerReserveResultSchema>, Awaited<ReturnType<S.SpendLedger["reserve"]>>>>();
same<Same<A.LedgerSummary, Awaited<ReturnType<S.SpendLedger["summary"]>>>>();
same<Same<A.AppFlagsDto, S.AppFlags>>();
same<Same<z.infer<typeof A.OpenSourceSchema>, S.OpenSource>>();
same<Same<A.SessionReport, Parameters<LA["report"]>[0]>>();
// ToolOutcome (services) and ToolResponse (route #14) are the same shape.
same<Same<A.ToolResponse, S.ToolOutcome>>();
// InputModeFor's argument is the NextStep contract.
same<Same<C.NextStep, Parameters<S.InputModeFor>[0]>>();

describe("type-level contract parity", () => {
  it("compiles (see npm run typecheck)", () => {
    expect(same<true>()).toBeUndefined();
  });
});

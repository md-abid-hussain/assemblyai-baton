/**
 * contracts/api.ts - request/response shapes of every route in DESIGN §4.4 (zod; routes validate bodies with these)
 * plus the HTTP form of the LimitsAuthority (route #28, TASKS §2). Frozen at G0.
 *
 * Conventions: `XRequest`/`XResponse` types are `z.infer` of `XRequestSchema`/`XResponseSchema`. Errors are
 * `ApiError` (contracts/errors.ts) with the HTTP status of DESIGN §4.4: a body that fails its schema → 400
 * `E_BAD_REQUEST`, an unknown id → 404 `E_NOT_FOUND`, a token for another case/visitor/scope → 403 `E_FORBIDDEN`.
 *
 * pagehide (G0): the requests sent while the page is going away (#5b release, #7 closed report, #13 end) use
 * `fetch(url, { method: "POST", keepalive: true, headers: { Authorization: "Bearer <jwt>", "content-type":
 * "application/json" }, body })`, NOT `navigator.sendBeacon` (a beacon cannot carry the Authorization or
 * `x-baton-visitor` header, so every beacon would be a 401). Keep those bodies well under the 64 KiB keepalive cap.
 */
import { z } from "zod";
import {
  CaseStateSchema, ChannelSchema, ConflictCardSchema, FactEventSchema, PaymentProviderKindSchema, PaymentStatusSchema,
  PolicyRecordSchema, StageSchema,
} from "./case";
import { ErrorCodeSchema } from "./errors";
import { HudMetricSchema, QaResultSchema, TakeoverPhaseSchema } from "./events";
import { CallAssetsSchema, CallManifestEntrySchema } from "./scenario";
import { DrainReportSchema, TakeoverOutcomeSchema, TranscriptionModeSchema } from "./takeover";
import { SendEsignAndPayLinkFinalResultSchema, ToolNameSchema, VaFunctionToolSchema } from "./tools";
import { TurnInputSchema } from "./turns";

export { CompiledTakeoverSchema, type CompiledTakeover } from "./takeover";
export { RunPlanSchema, type RunPlan } from "./run";

const OkSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkSchema>;
export { OkSchema as OkResponseSchema };

// ============================================================================================ platform

/** #1 GET /api/health (no external calls). */
export const HealthResponseSchema = z.object({ ok: z.boolean(), db: z.boolean(), version: z.string() });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const APP_MODES = ["live", "replay_only", "maintenance"] as const;
export const AppModeSchema = z.enum(APP_MODES);
export type AppMode = z.infer<typeof AppModeSchema>;

/** Last synthetic check of one kind (F7); null when none has run yet. */
export const CheckSummarySchema = z.object({ ok: z.boolean(), at: z.string(), ageSec: z.number().nonnegative() });
export type CheckSummary = z.infer<typeof CheckSummarySchema>;

/** #2 GET /api/status. */
export const StatusResponseSchema = z.object({
  mode: AppModeSchema,
  reason: z.string().nullable(),
  notice: z.string().nullable(),
  /** 0..100, no $ amounts on the public page. */
  budgetPctToday: z.number(),
  sttQueueDepth: z.number().int().nonnegative(),
  aiHalfAvailable: z.boolean(),
  lastChecks: z.object({ light: CheckSummarySchema.nullable(), full: CheckSummarySchema.nullable() }),
  limits: z.object({ sttOpensPerMin: z.number().int(), vaMaxConcurrent: z.number().int() }),
  features: z.object({ beCustomer: z.boolean(), payments: PaymentProviderKindSchema }),
  deployId: z.string(),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// ============================================================================================ cases, streaming, extraction

/** #3 POST /api/cases. */
export const CreateCaseRequestSchema = z.object({
  mode: z.enum(["watch", "live"]),
  callId: z.string().min(1).optional(),
  /** Express: the server inserts cached turns and events up to here (no LLM calls, §5.1.6). */
  prefillUntilMs: z.number().nonnegative().optional(),
});
export type CreateCaseRequest = z.infer<typeof CreateCaseRequestSchema>;

/** Defined in scenario.ts (the manifest entry carries the same object, G0); re-exported for route #3. */
export { CallAssetsSchema };
export type { CallAssets } from "./scenario";

export const CreateCaseResponseSchema = z.object({
  caseId: z.string(),
  caseToken: z.string(),
  policy: PolicyRecordSchema,
  call: CallManifestEntrySchema.nullable(),
  state: CaseStateSchema,
  /** URLs of the call's channel assets; the handoff clip is a span of the rep asset (`call.handoff`). */
  assets: CallAssetsSchema,
  cachedTurnsUrl: z.string().nullable(),
  /** Signed visitor token for cookie-less browsers; sent back as `x-baton-visitor` (DESIGN §4.3). */
  visitorToken: z.string().optional(),
});
export type CreateCaseResponse = z.infer<typeof CreateCaseResponseSchema>;

/** Takeover summary inside CaseView. */
export const TakeoverViewSchema = z.object({
  id: z.string(),
  phase: TakeoverPhaseSchema,
  tArmMs: z.number(),
  midUtterance: z.boolean(),
  stage: StageSchema.nullable(),
  greeting: z.string().nullable(),
  vaSessionId: z.string().nullable(),
  retries: z.number().int().nonnegative(),
  outcome: TakeoverOutcomeSchema.nullable(),
  armedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type TakeoverView = z.infer<typeof TakeoverViewSchema>;

export const PAYMENT_STATUS_SOURCES = ["webhook", "server_poll", "mock"] as const;
export const PaymentStatusSourceSchema = z.enum(PAYMENT_STATUS_SOURCES);
export type PaymentStatusSource = z.infer<typeof PaymentStatusSourceSchema>;

/** #15 GET /api/payments/[id]. */
export const PaymentViewSchema = z.object({
  id: z.string(),
  status: PaymentStatusSchema,
  statusSource: PaymentStatusSourceSchema.nullable(),
  amountCents: z.number().int(),
  totalAmountCents: z.number().int().nullable(),
  provider: PaymentProviderKindSchema,
  simulated: z.boolean(),
  checkoutUrl: z.string().optional(),
  embed: z.object({ url: z.string(), origin: z.string() }).nullable(),
  failureReason: z.string().optional(),
  updatedAt: z.string(),
  /**
   * G0: once the payment is terminal (succeeded / failed / expired), the exact `tool.result` for the held
   * send_esign_and_pay_link call, built by the server (amount = Polar's total_amount formatted, server receipt,
   * `verified_by` from `statusSource`). The browser sends it verbatim; it only builds `timeout` itself.
   */
  toolResult: SendEsignAndPayLinkFinalResultSchema.optional(),
});
export type PaymentView = z.infer<typeof PaymentViewSchema>;

/** #4 GET /api/cases/[caseId]. */
export const CaseViewSchema = z.object({
  state: CaseStateSchema,
  turns: z.array(TurnInputSchema),
  facts: z.array(FactEventSchema),
  takeover: TakeoverViewSchema.nullable(),
  payment: PaymentViewSchema.nullable(),
});
export type CaseView = z.infer<typeof CaseViewSchema>;

/**
 * Streaming query params as the server hands them to the browser (wire names; mirrors `StreamingParams` in
 * src/core/aai/streaming.ts). Loose, so a param added by buildSttParams survives a parse.
 */
export const StreamingParamsSchema = z
  .object({
    speech_model: z.string().optional(),
    sample_rate: z.number().int().positive().optional(),
    encoding: z.enum(["pcm_s16le", "pcm_mulaw", "opus", "ogg_opus", "aac"]).optional(),
    /** Streaming turn mode (same three values as the Voice Agent's transcription_mode, different API). */
    mode: z.enum(["min_latency", "balanced", "max_accuracy"]).optional(),
    min_turn_silence: z.number().optional(),
    max_turn_silence: z.number().optional(),
    vad_threshold: z.number().optional(),
    interruption_delay: z.number().optional(),
    continuous_partials: z.boolean().optional(),
    include_partial_turns: z.boolean().optional(),
    end_of_turn_confidence_threshold: z.number().optional(),
    format_turns: z.boolean().optional(),
    prompt: z.string().max(1750).optional(),
    keyterms_prompt: z.array(z.string().max(50)).max(100).optional(),
    agent_context: z.string().max(1750).optional(),
    previous_context_n_turns: z.number().int().optional(),
    language_codes: z.array(z.string()).optional(),
    language_detection: z.boolean().optional(),
    domain: z.literal("medical-v1").optional(),
    voice_focus: z.enum(["near-field", "far-field"]).optional(),
    voice_focus_threshold: z.number().optional(),
    speaker_labels: z.boolean().optional(),
    max_speakers: z.number().int().optional(),
    speaker_labels_revision_interval_ms: z.number().optional(),
    redact_pii: z.boolean().optional(),
    redact_pii_policies: z.array(z.string()).optional(),
    redact_pii_sub: z.enum(["hash", "entity_name"]).optional(),
    filter_profanity: z.boolean().optional(),
    session_heartbeat: z.boolean().optional(),
    inactivity_timeout: z.number().int().optional(),
  })
  .loose();
export type StreamingParamsDto = z.infer<typeof StreamingParamsSchema>;

/** #5 POST /api/stt/token. n=2 opens rep + customer; n=1 (a one-channel reconnect, §5.1.9) names its `channel`. */
export const SttTokenRequestSchema = z
  .object({
    caseId: z.string().min(1),
    runId: z.string().min(1),
    n: z.union([z.literal(1), z.literal(2)]),
    /** G0: required when n = 1 (which channel the single session is for); ignored when n = 2. */
    channel: ChannelSchema.optional(),
    ticket: z.string().optional(),
    reconnect: z.boolean().optional(),
  })
  .refine((r) => r.n === 2 || r.channel !== undefined, { message: "channel is required when n = 1", path: ["channel"] });
export type SttTokenRequest = z.infer<typeof SttTokenRequestSchema>;

export const STT_DENIAL_CODES = ["E_BUDGET", "E_MODE_REPLAY_ONLY", "E_QUEUE_TIMEOUT", "E_RATE_LIMITED", "E_AAI_BALANCE"] as const;
export const SttDenialCodeSchema = z.enum(STT_DENIAL_CODES);

export const SttTokenGrantedSchema = z.object({
  status: z.literal("granted"),
  /** 10 s redemption window: connect right after the grant. */
  token: z.string(),
  expiresAt: z.string(),
  params: z.object({ rep: StreamingParamsSchema, customer: StreamingParamsSchema }),
  /**
   * G0: our live_sessions ids keyed by channel (for /api/sessions/report): both keys for n = 2, only the requested
   * `channel` for n = 1. The route maps `SlotResult.sessionIds` ([rep, customer] for n = 2) onto the channels.
   */
  sessionIds: z.partialRecord(ChannelSchema, z.string()),
});
export const SttTokenQueuedSchema = z.object({
  status: z.literal("queued"),
  ticket: z.string(),
  position: z.number().int().nonnegative(),
  /** Only while etaMs ≤ 15000. */
  etaMs: z.number().nonnegative(),
  pollMs: z.number().int().positive(),
});
export const SttTokenDeniedSchema = z.object({
  status: z.literal("denied"),
  code: SttDenialCodeSchema,
  /** Plain words. */
  message: z.string(),
  fallback: z.literal("cached_turn_replay"),
});
export const SttTokenResponseSchema = z.discriminatedUnion("status", [SttTokenGrantedSchema, SttTokenQueuedSchema, SttTokenDeniedSchema]);
export type SttTokenResponse = z.infer<typeof SttTokenResponseSchema>;

/** #5a POST /api/runs → RunPlan. */
export const StartRunRequestSchema = z.object({ caseId: z.string().min(1), callId: z.string().min(1), express: z.boolean() });
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

/**
 * #5b POST /api/runs/[runId]/release → {ok:true} (no body; case token in Authorization; on pagehide via keepalive
 * fetch, see the header comment). #6 DELETE /api/stt/queue/[ticket] → {ok:true}.
 */
export const RunReleaseResponseSchema = OkSchema;
export const SttQueueCancelResponseSchema = OkSchema;

/** #7 POST /api/sessions/report (also LimitsAuthority.report). */
export const SessionReportSchema = z.object({
  /** Our live_sessions id. */
  sessionId: z.string().min(1),
  kind: z.enum(["stt", "va"]),
  event: z.enum(["opened", "closed"]),
  providerSessionId: z.string().optional(),
  /** Fractional allowed (VA `session.ended.session_duration_seconds` is a float, 10a VA-2); stored as double precision. */
  billedSeconds: z.number().nonnegative().optional(),
  closeCode: z.number().int().optional(),
});
export type SessionReport = z.infer<typeof SessionReportSchema>;
export const SessionReportResponseSchema = OkSchema;

/** #8 POST /api/extract. Idempotent on (caseId, turnId). */
export const ExtractRequestSchema = z.object({ turn: TurnInputSchema });
export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;

export const ExtractResponseSchema = z.object({
  state: CaseStateSchema,
  events: z.array(FactEventSchema),
  extractMs: z.number(),
  skipped: z.enum(["duplicate", "after_takeover"]).optional(),
});
export type ExtractResponse = z.infer<typeof ExtractResponseSchema>;

// ============================================================================================ takeovers and tools

/** #9 POST /api/takeovers. Refused (409) for runs with aiHalf:"recorded". */
export const ArmRequestSchema = z.object({
  caseId: z.string().min(1),
  runId: z.string().min(1),
  tArmMs: z.number().nonnegative(),
  midUtterance: z.boolean(),
  source: z.enum(["manual", "auto_handoff"]),
});
export type ArmRequest = z.infer<typeof ArmRequestSchema>;

export const ArmResponseSchema = z.object({
  takeoverId: z.string(),
  takeoverToken: z.string(),
  /** Adaptive update → audible estimate (default 900). */
  leadMs: z.number(),
});
export type ArmResponse = z.infer<typeof ArmResponseSchema>;

/** #10 POST /api/va/token (takeover-keyed). Errors: ApiError(E_BUDGET|E_RATE_LIMITED|E_VA_CAPACITY|E_AAI_BALANCE, fallback recorded_ai_session). */
export const VaTokenRequestSchema = z.object({ takeoverId: z.string().min(1), attempt: z.union([z.literal(0), z.literal(1)]) });
export type VaTokenRequest = z.infer<typeof VaTokenRequestSchema>;

export const VaTokenResponseSchema = z.object({
  token: z.string(),
  /** 10. */
  expiresInSeconds: z.number().int().positive(),
  liveSessionId: z.string(),
});
export type VaTokenResponse = z.infer<typeof VaTokenResponseSchema>;

/** #11 POST /api/takeovers/[id]/compile → CompiledTakeover (validated by validateFirstUpdate on the server). */
export const CompileRequestSchema = z.object({ drain: DrainReportSchema });
export type CompileRequest = z.infer<typeof CompileRequestSchema>;

/** #12 POST /api/takeovers/[id]/events. `heartbeat` every 10 s while a VA session is open. */
export const TakeoverEventsRequestSchema = z.object({
  phase: TakeoverPhaseSchema.optional(),
  timings: z.record(z.string(), z.number()).optional(),
  vaSessionId: z.string().optional(),
  hud: z.partialRecord(HudMetricSchema, z.number()).optional(),
  provisionalQa: QaResultSchema.optional(),
  heartbeat: z.literal(true).optional(),
  /** Sets takeovers.last_failure_at. */
  failure: z.object({ code: ErrorCodeSchema }).optional(),
});
export type TakeoverEventsRequest = z.infer<typeof TakeoverEventsRequestSchema>;
export const TakeoverEventsResponseSchema = OkSchema;

/**
 * #13 POST /api/takeovers/[id]/end. Enqueues verify_takeover via enqueueVerification() (WP8). On pagehide it is sent
 * with a keepalive fetch carrying the takeover token (never sendBeacon; see the header comment).
 */
export const EndTakeoverRequestSchema = z.object({
  outcome: TakeoverOutcomeSchema,
  vaSessionId: z.string().nullable(),
  reason: z.string().optional(),
});
export type EndTakeoverRequest = z.infer<typeof EndTakeoverRequestSchema>;

export const EndTakeoverResponseSchema = z.object({ ok: z.literal(true), verificationJobId: z.string().nullable() });
export type EndTakeoverResponse = z.infer<typeof EndTakeoverResponseSchema>;

/** #14 POST /api/tools/[name]. Idempotent on (takeoverId, callId). `args` is validated with ToolArgsSchemas[name]. */
export const ToolRequestSchema = z.object({
  takeoverId: z.string().min(1),
  /** The Voice Agent call_id. */
  callId: z.string().min(1),
  args: z.unknown(),
});
export type ToolRequest = z.infer<typeof ToolRequestSchema>;

export const ToolUiSchema = z.object({
  sms: z.string().optional(),
  link: z.string().optional(),
  paymentId: z.string().optional(),
  conflict: ConflictCardSchema.optional(),
});
export type ToolUi = z.infer<typeof ToolUiSchema>;

export const ToolResponseSchema = z.object({
  /** Sent verbatim as the tool.result JSON. */
  result: z.record(z.string(), z.unknown()),
  /** New stage → the client sends session.update{system_prompt, tools} first (§5.9.4). */
  stage: StageSchema.optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(VaFunctionToolSchema).optional(),
  /** The next step's input mode (§5.9.1). */
  transcriptionMode: TranscriptionModeSchema.optional(),
  ui: ToolUiSchema.optional(),
});
export type ToolResponse = z.infer<typeof ToolResponseSchema>;

export const ToolNameParamSchema = ToolNameSchema;

// ============================================================================================ payments and webhooks

/** #16 POST /api/payments/[id]/esign. */
export const EsignRequestSchema = z.object({ consent: z.literal(true), typedName: z.string().trim().min(1).max(80) });
export type EsignRequest = z.infer<typeof EsignRequestSchema>;
export const EsignResponseSchema = z.object({ ok: z.literal(true), signedAt: z.string() });
export type EsignResponse = z.infer<typeof EsignResponseSchema>;

/** #17 POST /api/payments/[id]/simulate (any provider, any PAYMENTS_MODE). */
export const SimulatePaymentResponseSchema = OkSchema;

/** #19 POST /api/webhooks/assemblyai?job= body. */
export const AaiWebhookBodySchema = z.object({ transcript_id: z.string(), status: z.enum(["completed", "error"]) }).loose();
export type AaiWebhookBody = z.infer<typeof AaiWebhookBodySchema>;

/** #20 GET /api/verifications/[takeoverId] (advances the job one step if due). */
export const VerificationViewSchema = z.object({
  status: z.enum(["pending", "completed", "failed"]),
  qa: QaResultSchema.nullable(),
  elapsedMs: z.number().nonnegative(),
  /** Plain-words reason when failed. */
  reason: z.string().optional(),
});
export type VerificationView = z.infer<typeof VerificationViewSchema>;

// ============================================================================================ TTS, evals, promote, admin

/** #22 POST /api/tts → audio/pcm (24 kHz s16le mono, chunked). ≤200 chars. */
export const TTS_VOICES = ["marin", "cedar"] as const;
export const TtsRequestSchema = z.object({
  caseId: z.string().min(1),
  text: z.string().trim().min(1).max(200),
  voice: z.enum(TTS_VOICES),
  /** Rate-limit bucket: typed 20/h, autopilot 60/h per visitor (default typed). */
  purpose: z.enum(["typed", "autopilot"]).optional(),
});
export type TtsRequest = z.infer<typeof TtsRequestSchema>;

export const P50P90Schema = z.object({ p50: z.number().nullable(), p90: z.number().nullable() });

/** #23 GET /api/evals/summary. `static` = public/data/evals/summary.json (shape owned by WP9b). */
export const EvalSummaryResponseSchema = z.object({
  static: z.record(z.string(), z.unknown()),
  live: z.object({
    judgeRuns: z.object({
      n: z.number().int().nonnegative(),
      reAskRate: z.number().nullable(),
      handBackRate: z.number().nullable(),
      completionRate: z.number().nullable(),
      disclosureOkRate: z.number().nullable(),
      clickToAudible: P50P90Schema,
      deadAir: P50P90Schema,
    }),
  }),
});
export type EvalSummaryResponse = z.infer<typeof EvalSummaryResponseSchema>;

/** #24 Promote evidence card (§5.14). Rates are 0..1, null when n = 0. */
export const PromoteEvidenceSchema = z.object({
  n: z.number().int().nonnegative(),
  reAskRate: z.number().nullable(),
  handBackRate: z.number().nullable(),
  completionRate: z.number().nullable(),
  disclosureOkRate: z.number().nullable(),
  clickToAudibleP50Ms: z.number().nullable(),
  /** PROJECTED: share (0..1) of sweep points with reaskProjected = 0. */
  sweepReaskZeroShare: z.number().nullable(),
  /** Sweep points with wrongAsserted > 0 (gate requires 0). */
  sweepWrongAssertedPoints: z.number().int().nonnegative().nullable(),
});
export type PromoteEvidence = z.infer<typeof PromoteEvidenceSchema>;

export const PromoteGateSchema = z.object({ passed: z.boolean(), reasons: z.array(z.string()) });

export const PromoteRequestSchema = z.object({ intent: z.literal("add_driver") });
export type PromoteRequest = z.infer<typeof PromoteRequestSchema>;

export const PromoteResponseSchema = z.object({
  agentId: z.string(),
  created: z.boolean(),
  configHash: z.string(),
  evidence: PromoteEvidenceSchema,
  gate: PromoteGateSchema,
});
export type PromoteResponse = z.infer<typeof PromoteResponseSchema>;

/** GET /api/promote: the current promoted agent (if any), evidence and gate. */
export const PromoteStatusResponseSchema = z.object({
  agent: z.object({ agentId: z.string(), configHash: z.string(), createdAt: z.string() }).nullable(),
  evidence: PromoteEvidenceSchema,
  gate: PromoteGateSchema,
});
export type PromoteStatusResponse = z.infer<typeof PromoteStatusResponseSchema>;

/** #26 POST /api/internal/cron?kind=. */
export const CronKindSchema = z.enum(["light", "full", "purge", "tick"]);
export type CronKind = z.infer<typeof CronKindSchema>;
export const CronResponseSchema = z.object({ ok: z.boolean(), details: z.record(z.string(), z.unknown()) });
export type CronResponse = z.infer<typeof CronResponseSchema>;

/** App flags (services.ts `AppFlags`), as stored and as returned by the admin and limits routes. */
export const AppFlagsSchema = z.object({
  mode: AppModeSchema,
  reason: z.string().nullable(),
  notice: z.string().nullable(),
  paymentsModeOverride: PaymentProviderKindSchema.nullable(),
  aaiBalanceUsd: z.number().nullable(),
});
export type AppFlagsDto = z.infer<typeof AppFlagsSchema>;

/** #27 POST /api/admin/flags. A balance below AAI_RESERVE_USD flips replay_only (reason aai_balance). */
export const AdminFlagsRequestSchema = z.object({
  mode: AppModeSchema.optional(),
  notice: z.string().max(280).nullable().optional(),
  aaiBalanceUsd: z.number().nonnegative().nullable().optional(),
  paymentsModeOverride: PaymentProviderKindSchema.nullable().optional(),
  reason: z.string().max(200).optional(),
});
export type AdminFlagsRequest = z.infer<typeof AdminFlagsRequestSchema>;

export const LEDGER_PROVIDERS = ["aai_stt", "aai_va", "aai_async", "openai", "polar"] as const;
export const LedgerProviderSchema = z.enum(LEDGER_PROVIDERS);
export type LedgerProvider = z.infer<typeof LedgerProviderSchema>;

/** SpendLedger.summary() and #27 GET /api/admin/ledger. */
export const LedgerSummarySchema = z.object({
  sinceEpochUsd: z.number(),
  todayUsd: z.record(z.string(), z.number()),
  dailyCapUsd: z.number(),
  judgingBudgetUsd: z.number(),
  pctToday: z.number(),
  byEnv: z.record(z.string(), z.number()),
});
export type LedgerSummary = z.infer<typeof LedgerSummarySchema>;

// ============================================================================================ #28 limits authority over HTTP

export const OPEN_SOURCES = ["judge", "script", "synthetic", "test", "mirror"] as const;
export const OpenSourceSchema = z.enum(OPEN_SOURCES);

export const SttAcquireRequestSchema = z.object({
  n: z.union([z.literal(1), z.literal(2)]),
  visitorId: z.string(),
  ipKey: z.string(),
  ticket: z.string().optional(),
  runId: z.string().optional(),
  reconnect: z.boolean().optional(),
  source: OpenSourceSchema,
  deployId: z.string(),
});
export type SttAcquireRequest = z.infer<typeof SttAcquireRequestSchema>;

export const SlotResultSchema = z.discriminatedUnion("status", [
  /** G0: `sessionIds` = one live_sessions id per granted open (length n; [rep, customer] for n = 2). */
  z.object({ status: z.literal("granted"), grantId: z.string(), sessionIds: z.array(z.string()).min(1).max(2) }),
  z.object({ status: z.literal("queued"), ticket: z.string(), position: z.number().int().nonnegative(), etaMs: z.number().nonnegative() }),
  z.object({ status: z.literal("denied"), code: SttDenialCodeSchema, message: z.string() }),
]);
export type SlotResultDto = z.infer<typeof SlotResultSchema>;

export const SttCancelRequestSchema = z.object({ ticket: z.string() });

export const VA_DENIAL_CODES = ["E_VA_CAPACITY", "E_BUDGET", "E_MODE_REPLAY_ONLY", "E_AAI_BALANCE"] as const;
export const VaDenialCodeSchema = z.enum(VA_DENIAL_CODES);

export const VaHoldRequestSchema = z.object({
  runId: z.string(),
  visitorId: z.string(),
  ipKey: z.string(),
  expiresAt: z.string(),
  estUsd: z.number().nonnegative(),
  deployId: z.string(),
});
export const VaHoldResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), holdId: z.string() }),
  z.object({ ok: z.literal(false), code: VaDenialCodeSchema, message: z.string() }),
]);

export const VaAcquireRequestSchema = z.object({
  holdId: z.string().optional(),
  takeoverId: z.string().optional(),
  attempt: z.union([z.literal(0), z.literal(1)]),
  /** See services.ts `vaAcquire`: for VA this is the ABSOLUTE ceiling (`vaAbsoluteCeilingMs`), not the dynamic cap. */
  capMs: z.number().int().positive(),
  source: OpenSourceSchema,
  deployId: z.string(),
});
export const VaAcquireResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), liveSessionId: z.string() }),
  z.object({ ok: z.literal(false), code: VaDenialCodeSchema, message: z.string() }),
]);

/** `release(liveSessionIdOrHoldId, reason)`. */
export const LimitsReleaseRequestSchema = z.object({ id: z.string(), reason: z.string() });
export const HeartbeatRequestSchema = z.object({ liveSessionId: z.string() });

export const LedgerReserveRequestSchema = z.object({
  provider: LedgerProviderSchema,
  action: z.string(),
  refId: z.string(),
  estUsd: z.number().nonnegative(),
  env: z.string(),
});
export const LedgerReserveResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), id: z.string() }),
  z.object({ ok: z.literal(false), code: z.literal("E_BUDGET") }),
]);
export const LedgerSettleRequestSchema = z.object({ id: z.string(), actualUsd: z.number().nonnegative() });
export const LedgerReleaseRequestSchema = z.object({ id: z.string() });

/** Route #28 operation names → request / response schemas (same shapes as the in-process LimitsAuthority calls). */
export const LimitsRoutes = {
  "stt-acquire": { request: SttAcquireRequestSchema, response: SlotResultSchema },
  "stt-cancel": { request: SttCancelRequestSchema, response: OkSchema },
  "va-hold": { request: VaHoldRequestSchema, response: VaHoldResultSchema },
  "va-acquire": { request: VaAcquireRequestSchema, response: VaAcquireResultSchema },
  "va-release": { request: LimitsReleaseRequestSchema, response: OkSchema },
  heartbeat: { request: HeartbeatRequestSchema, response: OkSchema },
  report: { request: SessionReportSchema, response: OkSchema },
  reserve: { request: LedgerReserveRequestSchema, response: LedgerReserveResultSchema },
  settle: { request: LedgerSettleRequestSchema, response: OkSchema },
  release: { request: LedgerReleaseRequestSchema, response: OkSchema },
  summary: { request: z.object({}), response: LedgerSummarySchema },
  flags: { request: z.object({}), response: AppFlagsSchema },
} as const;
export type LimitsRouteName = keyof typeof LimitsRoutes;

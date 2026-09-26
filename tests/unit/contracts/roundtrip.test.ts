/**
 * WP0a acceptance: zod round-trips for every API schema (DESIGN §4.4, contracts/api.ts) and every core contract
 * schema (DESIGN §4.1). A value survives JSON serialization + parse unchanged; a meta-test fails when a new
 * `*Schema` export has no sample here.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as api from "../../../src/core/contracts/api";
import * as contracts from "../../../src/core/contracts";
import { BATON_EVENT_TYPES, type BatonEvent } from "../../../src/core/contracts";
import {
  call, caseState, compiled, drain, factEvent, labels, policy, qa, runPlan, scenario, sweepPoint, tool, turn,
} from "./fixtures";

const payment = {
  id: "pay_1",
  status: "open",
  statusSource: "server_poll",
  amountCents: 2340,
  totalAmountCents: 2340,
  provider: "polar",
  simulated: false,
  checkoutUrl: "https://sandbox.polar.sh/checkout/abc",
  embed: { url: "https://sandbox.polar.sh/checkout/abc?embed=true", origin: "https://app.example" },
  updatedAt: "2026-09-25T10:15:00.000Z",
} as const;

const takeoverView = {
  id: "tko_1",
  phase: "active",
  tArmMs: 60_000,
  midUtterance: true,
  stage: "disclose",
  greeting: "Hi Priya, ...",
  vaSessionId: "sess_1",
  retries: 0,
  outcome: null,
  armedAt: "2026-09-25T10:14:00.000Z",
  endedAt: null,
} as const;

const repParams = {
  speech_model: "universal-3-5-pro",
  encoding: "pcm_mulaw",
  sample_rate: 8000,
  mode: "min_latency",
  inactivity_timeout: 30,
  keyterms_prompt: ["Priya", "Raman", "Harborview"],
  prompt: "Recorded phone call at a US insurance agency.",
  min_turn_silence: 400,
  max_turn_silence: 2400,
} as const;
const customerParams = { ...repParams, language_codes: ["en", "hi"], language_detection: true, some_future_param: 1 };

const evidenceStatic = { headline: { share: 0.93 }, curves: [] };
const evidence = {
  n: 6,
  reAskRate: 0,
  handBackRate: 0.17,
  completionRate: 0.83,
  disclosureOkRate: 1,
  clickToAudibleP50Ms: 4100,
  sweepReaskZeroShare: 0.94,
  sweepWrongAssertedPoints: 0,
};
const flags = { mode: "live", reason: null, notice: null, paymentsModeOverride: null, aaiBalanceUsd: 36.2 } as const;

const { seq: _seq, ...newFactEvent } = factEvent;
const { id: _id, caseId: _caseId, ...cachedFactEvent } = newFactEvent;
const cachedTurnsFile = {
  callId: call.callId,
  variant: "pc_ctx",
  transcribedAt: "2026-09-25",
  channels: {
    rep: [
      { recvMs: 44_512.5, message: { type: "Turn", turn_order: 13, end_of_turn: false, transcript: "March 14th" } },
      { recvMs: 47_650, message: { type: "Turn", turn_order: 13, end_of_turn: true, transcript: "March 14th, 2009, got it." } },
    ],
    customer: [],
  },
};
const extractCacheFile = {
  callId: call.callId,
  version: "v3",
  variant: "pc_ctx",
  extractorVersion: "a1b2c3d4e5f6",
  model: "gpt-6-luna",
  createdAt: "2026-09-26T09:00:00.000Z",
  turns: [{ turnId: "rep-c13", channel: "rep", recvMs: 47_650, endMs: 47_200, extractMs: 1_830.2, events: [{ ...cachedFactEvent, turnId: "rep-c13" }] }],
};
const evalSummaryStatic = {
  generatedAt: "2026-09-28T12:00:00.000Z",
  gitSha: "b93b381",
  headline: { nCalls: 18, nPoints: 1_540, zeroWrongZeroReaskShare: 0.93, sweepReaskZeroShare: 0.94, sweepWrongAssertedPoints: 0, provenance: ["CACHED-STT SWEEP", "PROJECTED"] },
  curves: [{ key: "v3.pc_ctx", metric: "entityAcc" }],
};

/** Samples keyed by the exported schema name in contracts/api.ts. */
const API_SAMPLES: Record<string, unknown[]> = {
  OkResponseSchema: [{ ok: true }],
  HealthResponseSchema: [{ ok: true, db: true, version: "0.1.0+abc123" }],
  AppModeSchema: ["live", "replay_only", "maintenance"],
  CheckSummarySchema: [{ ok: true, at: "2026-09-25T10:00:00.000Z", ageSec: 900 }],
  StatusResponseSchema: [
    {
      mode: "live",
      reason: null,
      notice: null,
      budgetPctToday: 12.5,
      sttQueueDepth: 0,
      aiHalfAvailable: true,
      lastChecks: { light: { ok: true, at: "2026-09-25T10:00:00.000Z", ageSec: 900 }, full: null },
      limits: { sttOpensPerMin: 4, vaMaxConcurrent: 3 },
      features: { beCustomer: false, payments: "polar" },
      deployId: "zp-prod",
    },
  ],
  CreateCaseRequestSchema: [{ mode: "watch", callId: call.callId, prefillUntilMs: 70_000 }, { mode: "live" }],
  CallAssetsSchema: [{ rep: "/calls/s01/rep.3f2a.ulaw", customer: "/calls/s01/customer.9b1c.ulaw", peaks: "/calls/s01/peaks.json" }],
  CreateCaseResponseSchema: [
    {
      caseId: "case_s01",
      caseToken: "eyJ.jwt.sig",
      policy,
      call,
      state: caseState(),
      assets: { rep: "/calls/s01/rep.ulaw", customer: "/calls/s01/customer.ulaw", peaks: "/calls/s01/peaks.json" },
      cachedTurnsUrl: "/data/cached-turns/s01.json",
      visitorToken: "v1.abc.def",
    },
    { caseId: "case_2", caseToken: "t", policy, call: null, state: caseState("case_2"), assets: { rep: "", customer: "", peaks: "" }, cachedTurnsUrl: null },
  ],
  TakeoverViewSchema: [takeoverView],
  PaymentStatusSourceSchema: ["webhook", "server_poll", "mock"],
  PaymentViewSchema: [
    payment,
    { ...payment, status: "failed", statusSource: null, embed: null, failureReason: "amount_mismatch" },
    { ...payment, status: "succeeded", statusSource: "webhook", toolResult: { status: "paid", amount: "$23.40", receipt: "PAY-4821", verified_by: "polar_webhook" } },
    { ...payment, status: "expired", statusSource: "server_poll", toolResult: { status: "expired", instruction: "Tell the customer the link stays valid for 24 hours." } },
  ],
  CaseViewSchema: [{ state: caseState(), turns: [turn], facts: [factEvent], takeover: takeoverView, payment }, { state: caseState(), turns: [], facts: [], takeover: null, payment: null }],
  StreamingParamsSchema: [repParams, customerParams],
  SttTokenRequestSchema: [{ caseId: "case_s01", runId: "run_1", n: 2 }, { caseId: "c", runId: "r", n: 1, channel: "customer", ticket: "tk_1", reconnect: true }],
  SttDenialCodeSchema: ["E_BUDGET", "E_QUEUE_TIMEOUT"],
  SttTokenGrantedSchema: [{ status: "granted", token: "tok", expiresAt: "2026-09-25T10:00:10.000Z", params: { rep: repParams, customer: customerParams }, sessionIds: { rep: "ls_a", customer: "ls_b" } }],
  SttTokenQueuedSchema: [{ status: "queued", ticket: "tk_1", position: 2, etaMs: 10_000, pollMs: 2000 }],
  SttTokenDeniedSchema: [{ status: "denied", code: "E_QUEUE_TIMEOUT", message: "Several people ran live demos this hour.", fallback: "cached_turn_replay" }],
  SttTokenResponseSchema: [
    { status: "granted", token: "tok", expiresAt: "2026-09-25T10:00:10.000Z", params: { rep: repParams, customer: customerParams }, sessionIds: { rep: "ls_a", customer: "ls_b" } },
    { status: "queued", ticket: "tk_1", position: 1, etaMs: 4000, pollMs: 2000 },
    { status: "denied", code: "E_BUDGET", message: "Live budget for today is used up.", fallback: "cached_turn_replay" },
  ],
  StartRunRequestSchema: [{ caseId: "case_s01", callId: call.callId, express: true }],
  RunPlanSchema: [runPlan, { ...runPlan, aiHalf: "recorded", sttHalf: "cached", vaHoldId: null, holdExpiresAt: null, reason: "Live AI is busy", recordedHandoffMs: 95_000 }],
  RunReleaseResponseSchema: [{ ok: true }],
  SttQueueCancelResponseSchema: [{ ok: true }],
  SessionReportSchema: [
    { sessionId: "ls_a", kind: "stt", event: "opened", providerSessionId: "b3f1" },
    { sessionId: "ls_a", kind: "stt", event: "closed", providerSessionId: "b3f1", billedSeconds: 181, closeCode: 1000 },
    { sessionId: "ls_va_1", kind: "va", event: "closed", providerSessionId: "sess_1", billedSeconds: 102.250166 },
  ],
  SessionReportResponseSchema: [{ ok: true }],
  ExtractRequestSchema: [{ turn }],
  ExtractResponseSchema: [{ state: caseState(), events: [factEvent], extractMs: 1830 }, { state: caseState(), events: [], extractMs: 0, skipped: "after_takeover" }],
  ArmRequestSchema: [{ caseId: "case_s01", runId: "run_1", tArmMs: 60_000, midUtterance: true, source: "manual" }],
  ArmResponseSchema: [{ takeoverId: "tko_1", takeoverToken: "eyJ.tko", leadMs: 900 }],
  VaTokenRequestSchema: [{ takeoverId: "tko_1", attempt: 0 }, { takeoverId: "tko_1", attempt: 1 }],
  VaTokenResponseSchema: [{ token: "va_tok", expiresInSeconds: 10, liveSessionId: "ls_va_1" }],
  CompileRequestSchema: [{ drain }],
  CompiledTakeoverSchema: [compiled()],
  TakeoverEventsRequestSchema: [
    { heartbeat: true },
    { phase: "greeting", timings: { updateSent: 1200, sessionReady: 1640 }, vaSessionId: "sess_1", hud: { click_to_first_audible: 4100, dead_air_after_rep: 350 } },
    { provisionalQa: { ...qa, provisional: true } },
    { failure: { code: "E_VA_TRANSIENT" } },
  ],
  TakeoverEventsResponseSchema: [{ ok: true }],
  EndTakeoverRequestSchema: [{ outcome: "completed", vaSessionId: "sess_1" }, { outcome: "failed", vaSessionId: null, reason: "va_retry_failed" }],
  EndTakeoverResponseSchema: [{ ok: true, verificationJobId: "job_1" }, { ok: true, verificationJobId: null }],
  ToolRequestSchema: [{ takeoverId: "tko_1", callId: "chatcmpl-tool-1", args: { field: "license_state", value: "WI", reason: "newly_provided" } }],
  ToolUiSchema: [{ sms: "Harborview: Review & sign", link: "https://x/pay", paymentId: "pay_1" }],
  ToolResponseSchema: [
    { result: { result: "accepted", field: "license_state", status: "VERIFIED", value: "WI" }, transcriptionMode: "min_latency" },
    {
      result: { ok: true, disclosure_id: "dsc_1", text: "Here's the change.", instruction: "Read this exactly." },
      stage: "pay",
      systemPrompt: "IDENTITY ...",
      tools: [tool],
      ui: { conflict: caseState().conflicts[0]! },
    },
  ],
  ToolNameParamSchema: ["send_esign_and_pay_link"],
  EsignRequestSchema: [{ consent: true, typedName: "Priya Raman" }],
  EsignResponseSchema: [{ ok: true, signedAt: "2026-09-25T10:16:00.000Z" }],
  SimulatePaymentResponseSchema: [{ ok: true }],
  AaiWebhookBodySchema: [{ transcript_id: "tr_1", status: "completed" }],
  VerificationViewSchema: [{ status: "completed", qa, elapsedMs: 16_400 }, { status: "failed", qa: null, elapsedMs: 61_000, reason: "artifacts never appeared" }],
  TtsRequestSchema: [{ caseId: "case_s01", text: "Yes, that's right.", voice: "marin" }, { caseId: "c", text: "It's 4 4 1 0 7.", voice: "cedar", purpose: "autopilot" }],
  P50P90Schema: [{ p50: 4100, p90: null }],
  EvalSummaryResponseSchema: [
    { static: evalSummaryStatic, live: { judgeRuns: { n: 0, reAskRate: null, handBackRate: null, completionRate: null, disclosureOkRate: null, clickToAudible: { p50: null, p90: null }, deadAir: { p50: null, p90: null } } } },
    {
      static: evidenceStatic,
      live: {
        judgeRuns: { n: 0, reAskRate: null, handBackRate: null, completionRate: null, disclosureOkRate: null, clickToAudible: { p50: null, p90: null }, deadAir: { p50: null, p90: null } },
      },
    },
  ],
  PromoteEvidenceSchema: [evidence],
  PromoteGateSchema: [{ passed: false, reasons: ["n < 5"] }],
  PromoteRequestSchema: [{ intent: "add_driver" }],
  PromoteResponseSchema: [{ agentId: "agent_0123456789abcdef", created: true, configHash: "c0ffee12", evidence, gate: { passed: true, reasons: [] } }],
  PromoteStatusResponseSchema: [
    { agent: { agentId: "agent_1", configHash: "c0ffee12", createdAt: "2026-09-26T09:00:00.000Z" }, evidence, gate: { passed: true, reasons: [] } },
    { agent: null, evidence, gate: { passed: false, reasons: ["n < 5"] } },
  ],
  CronKindSchema: ["light", "full", "purge", "tick"],
  CronResponseSchema: [{ ok: true, details: { db: { ok: true, ms: 4 } } }],
  AppFlagsSchema: [flags],
  AdminFlagsRequestSchema: [{ mode: "replay_only", reason: "kill switch" }, { aaiBalanceUsd: 27.4 }, { notice: null, paymentsModeOverride: "mock" }],
  LedgerProviderSchema: ["aai_stt", "aai_va", "aai_async", "openai", "polar"],
  LedgerSummarySchema: [{ sinceEpochUsd: 1.2, todayUsd: { aai_stt: 0.3, aai_va: 0.9 }, dailyCapUsd: 3, judgingBudgetUsd: 31, pctToday: 40, byEnv: { "zp-prod": 1.2 } }],
  OpenSourceSchema: ["judge", "script", "synthetic", "test", "mirror"],
  SttAcquireRequestSchema: [{ n: 2, visitorId: "v_1", ipKey: "ip_1", source: "judge", deployId: "zp-prod" }, { n: 1, visitorId: "v", ipKey: "i", ticket: "tk", runId: "run_1", reconnect: true, source: "script", deployId: "dev-wp4" }],
  SlotResultSchema: [
    { status: "granted", grantId: "g_1", sessionIds: ["ls_a", "ls_b"] },
    { status: "queued", ticket: "tk_1", position: 1, etaMs: 8000 },
    { status: "denied", code: "E_RATE_LIMITED", message: "too many opens" },
  ],
  SttCancelRequestSchema: [{ ticket: "tk_1" }],
  VaDenialCodeSchema: ["E_VA_CAPACITY"],
  VaHoldRequestSchema: [{ runId: "run_1", visitorId: "v_1", ipKey: "ip_1", expiresAt: "2026-09-25T10:20:00.000Z", estUsd: 0.53, deployId: "zp-prod" }],
  VaHoldResultSchema: [{ ok: true, holdId: "ls_1" }, { ok: false, code: "E_VA_CAPACITY", message: "3 live AI sessions are running" }],
  VaAcquireRequestSchema: [{ holdId: "ls_1", takeoverId: "tko_1", attempt: 0, capMs: 165_000, source: "judge", deployId: "zp-prod" }],
  VaAcquireResultSchema: [{ ok: true, liveSessionId: "ls_1" }, { ok: false, code: "E_BUDGET", message: "budget" }],
  LimitsReleaseRequestSchema: [{ id: "ls_1", reason: "ended" }],
  HeartbeatRequestSchema: [{ liveSessionId: "ls_1" }],
  LedgerReserveRequestSchema: [{ provider: "aai_va", action: "takeover", refId: "ls_1", estUsd: 0.53, env: "zp-prod" }],
  LedgerReserveResultSchema: [{ ok: true, id: "led_1" }, { ok: false, code: "E_BUDGET" }],
  LedgerSettleRequestSchema: [{ id: "led_1", actualUsd: 0.18 }],
  LedgerReleaseRequestSchema: [{ id: "led_1" }],
};

/** One sample of every BatonEvent variant. */
const EVENTS: BatonEvent[] = [
  { t: 0, type: "call.loaded", callId: call.callId, durationMs: 118_000 },
  { t: 1, type: "run.plan", plan: runPlan },
  { t: 2, type: "paused", reason: "ios_background", resumed: false },
  { t: 3, type: "phone.state", state: "sms-received" },
  { t: 4, type: "mode", mode: "cached_replay", reason: "queue ETA > 15 s" },
  { t: 5, type: "stt.status", channel: "rep", status: "open", detail: "b3f1" },
  { t: 6, type: "stt.partial", channel: "customer", turnOrder: 3, text: "March four" },
  { t: 7, type: "stt.final", turn },
  { t: 8, type: "case.state", state: caseState() },
  { t: 9, type: "case.facts", events: [factEvent] },
  { t: 10, type: "verifier", agrees: false, disagreements: ["effective_date"] },
  { t: 11, type: "takeover.phase", phase: "draining", atMs: 60_450, detail: { waitedMs: 800, reason: "finals" } },
  { t: 12, type: "va.status", status: "ready", sessionId: "sess_1" },
  { t: 13, type: "va.reply", replyId: "resp_1", phase: "done", kind: "speech", interrupted: false },
  { t: 14, type: "va.caption", replyId: "resp_1", words: [{ text: "Hi", atMs: 12 }] },
  { t: 15, type: "va.user", text: "Yes, that's right.", final: true },
  { t: 16, type: "va.tool", callId: "chatcmpl-tool-1", name: "get_disclosure", phase: "call", args: { kind: "premium_change" } },
  { t: 17, type: "va.tool", callId: "chatcmpl-tool-1", name: "get_disclosure", phase: "result", result: { ok: true } },
  { t: 18, type: "stage", stage: "disclose" },
  { t: 19, type: "payment", status: "succeeded", source: "webhook" },
  { t: 20, type: "phone.sms", text: "Harborview: Review & sign", link: "https://x/pay" },
  { t: 21, type: "qa", qa },
  { t: 22, type: "hud", metric: "dead_air_after_rep", ms: 350 },
  { t: 23, type: "fallback", kind: "recorded_ai_session", label: "RECORDED AI SESSION from 2026-09-28" },
  { t: 24, type: "error", code: "E_VA_TRANSIENT", message: "retrying once" },
];

/** Core (§4.1) schemas with samples. */
const CORE_SAMPLES: [string, z.ZodType, unknown[]][] = [
  ["CaseStateSchema", contracts.CaseStateSchema, [caseState()]],
  ["FactEventSchema", contracts.FactEventSchema, [
    factEvent,
    { ...factEvent, kind: "ack", valueRaw: null, valueNorm: null, acknowledgesTurnId: "customer-12", evidence: null, turnId: null },
    // G0 verifier encoding (contracts/case.ts FACT_KINDS)
    { ...factEvent, kind: "verifier", party: "verifier", extractor: "sol", turnId: null, turnEndMs: 60_000, confidence: "medium", evidence: null },
    { ...factEvent, kind: "tool_update", party: "ai", extractor: "tool", turnId: null, turnEndMs: 60_000 + 8_412.5, evidence: null },
  ]],
  ["NewFactEventSchema", contracts.NewFactEventSchema, [newFactEvent]],
  ["CaseStatusSchema", contracts.CaseStatusSchema, [...contracts.CASE_STATUSES]],
  ["CaseModeSchema", contracts.CaseModeSchema, [...contracts.CASE_MODES]],
  ["TurnInputSchema", contracts.TurnInputSchema, [turn, { ...turn, turnId: "rep-c13", source: "stt_cache" }, { ...turn, turnId: "rep-4-r1", recvMs: 47_650.125 }]],
  ["TurnInputBaseSchema", contracts.TurnInputBaseSchema, [turn]],
  ["PolicyRecordSchema", contracts.PolicyRecordSchema, [policy]],
  ["CallManifestEntrySchema", contracts.CallManifestEntrySchema, [call, { ...call, format: { encoding: "pcm_s16le", sampleRate: 16000 }, source: "golden16k", handoff: null, decisionPointMs: null, publishAudio: false, assets: null }]],
  ["PeaksSchema", contracts.PeaksSchema, [{ ratePerSec: 50, rep: [0, 0.12, 1], customer: [0.5, 0, 0] }]],
  ["ScenarioSchema", contracts.ScenarioSchema, [scenario]],
  ["CallLabelsSchema", contracts.CallLabelsSchema, [labels]],
  ["RunPlanSchema", contracts.RunPlanSchema, [runPlan]],
  ["VaFunctionToolSchema", contracts.VaFunctionToolSchema, [tool]],
  ["DrainReportSchema", contracts.DrainReportSchema, [drain]],
  ["CompiledTakeoverSchema", contracts.CompiledTakeoverSchema, [compiled()]],
  ["InputModePlanSchema", contracts.InputModePlanSchema, [{ mode: "balanced", reason: "asks_entity" }]],
  ["NextStepSchema", contracts.NextStepSchema, [{ kind: "ask", field: "garaging_zip" }, { kind: "none", field: null }]],
  ["QaResultSchema", contracts.QaResultSchema, [qa]],
  ["BatonEventSchema", contracts.BatonEventSchema, EVENTS],
  ["ApiErrorSchema", contracts.ApiErrorSchema, [{ error: { code: "E_BUDGET", message: "Live budget used", retryAfterMs: 60_000, fallback: "cached_turn_replay" } }, { error: { code: "E_DB", message: "db" } }]],
  ["ExtractTurnInputSchema", contracts.ExtractTurnInputSchema, [{ caseId: "case_s01", policy, callDate: "2026-09-25", state: caseState(), recent: [turn], newTurns: [turn] }]],
  ["ExtractTurnOutputSchema", contracts.ExtractTurnOutputSchema, [{ events: [newFactEvent], ms: 1830.4, usage: { input: 1600, output: 180 }, model: "gpt-6-luna", extractorVersion: "a1b2c3d4e5f6", cached: false }]],
  ["VerifierResultSchema", contracts.VerifierResultSchema, [{ uptoRecvMs: 60_000, fields: [{ field: "effective_date", value: "2026-10-02", support: "stated_once", turnIds: ["customer-14"], quote: "next Friday" }] }]],
  ["RawPatchSchema", contracts.RawPatchSchema, [{ no_facts: false, events: [{ turn_id: "rep-13", field: "driver_dob", kind: "readback", value: "2009-03-14", quote: "March 14th, 2009, got it", acknowledges_turn_id: null, confidence: "high" }] }, { no_facts: true, events: [] }]],
  ["SttCacheRecordSchema", contracts.SttCacheRecordSchema, [{ callId: call.callId, variant: "pc_ctx", channel: "rep", recvMs: 1234, message: { type: "Turn", turn_order: 0, end_of_turn: true } }, { callId: "c", variant: "mono_diar", channel: "mono", recvMs: 0, message: { type: "Begin", id: "x" } }]],
  ["SweepPointSchema", contracts.SweepPointSchema, [sweepPoint(), { ...sweepPoint(), ablation: "verifier_off" }]],
  ["SweepAblationSchema", contracts.SweepAblationSchema, [...contracts.SWEEP_ABLATIONS]],
  ["CachedTurnsFileSchema", contracts.CachedTurnsFileSchema, [cachedTurnsFile]],
  ["CachedTurnRecordSchema", contracts.CachedTurnRecordSchema, cachedTurnsFile.channels.rep],
  ["CachedFactEventSchema", contracts.CachedFactEventSchema, [cachedFactEvent]],
  ["ExtractCacheFileSchema", contracts.ExtractCacheFileSchema, [extractCacheFile, { ...extractCacheFile, cutTurns: { "9f2c": { extractMs: 1700, events: [] } } }]],
  ["VerifierCacheFileSchema", contracts.VerifierCacheFileSchema, [{ callId: call.callId, variant: "pc_ctx", model: "gpt-6-sol", createdAt: "2026-09-26T12:00:00.000Z", runs: [{ startMs: 30_000, ms: 25_900, result: { uptoRecvMs: 30_000, fields: [] } }] }]],
  ["IterationEntrySchema", contracts.IterationEntrySchema, [{ version: "v3", date: "2026-09-27", gitSha: "b93b381", configHash: "c0ffee12", extractorVersion: "a1b2c3d4e5f6", promptVersion: "p3", variants: ["pc_ctx", "pc_noctx"], summary: { zeroWrongZeroReaskShare: 0.93 }, note: "late/cut rule" }]],
  ["EvalSummaryStaticSchema", contracts.EvalSummaryStaticSchema, [evalSummaryStatic]],
  ["SendEsignAndPayLinkFinalResultSchema", contracts.SendEsignAndPayLinkFinalResultSchema, [
    { status: "paid", amount: "$23.40", receipt: "PAY-4821", verified_by: "simulated" },
    { status: "timeout", instruction: "Offer to hand back to the rep." },
  ]],
];

const jsonRoundTrip = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("contracts/api.ts: every exported schema round-trips", () => {
  const schemaNames = Object.keys(api).filter((k) => k.endsWith("Schema"));

  it("has a sample for every exported *Schema", () => {
    const missing = schemaNames.filter((k) => !(k in API_SAMPLES));
    expect(missing).toEqual([]);
    const stale = Object.keys(API_SAMPLES).filter((k) => !schemaNames.includes(k));
    expect(stale).toEqual([]);
  });

  for (const [name, samples] of Object.entries(API_SAMPLES)) {
    it(`${name} parses its samples unchanged`, () => {
      const schema = (api as unknown as Record<string, z.ZodType>)[name]!;
      for (const s of samples) {
        const parsed = schema.parse(jsonRoundTrip(s));
        expect(parsed).toEqual(s);
      }
    });
  }

  it("LimitsRoutes maps every operation to request/response schemas that accept the samples", () => {
    for (const [name, r] of Object.entries(api.LimitsRoutes)) {
      expect(typeof r.request.parse, name).toBe("function");
      expect(typeof r.response.parse, name).toBe("function");
    }
    const granted = { status: "granted", grantId: "g", sessionIds: ["ls_1"] };
    expect(api.LimitsRoutes["stt-acquire"].response.parse(granted)).toEqual(granted);
    expect(api.LimitsRoutes["stt-acquire"].response.safeParse({ status: "granted", grantId: "g" }).success).toBe(false);
  });
});

describe("DESIGN §4.1 core contracts round-trip", () => {
  for (const [name, schema, samples] of CORE_SAMPLES) {
    it(`${name} parses its samples unchanged`, () => {
      for (const s of samples) expect(schema.parse(jsonRoundTrip(s))).toEqual(s);
    });
  }

  it("covers every BatonEvent variant", () => {
    const covered = new Set(EVENTS.map((e) => e.type));
    expect(BATON_EVENT_TYPES.filter((t) => !covered.has(t))).toEqual([]);
    expect(BATON_EVENT_TYPES).toHaveLength(24);
  });
});

describe("schemas reject invalid input", () => {
  const bad: [string, z.ZodType, unknown][] = [
    ["SttTokenRequest n:3", api.SttTokenRequestSchema, { caseId: "c", runId: "r", n: 3 }],
    ["EsignRequest consent:false", api.EsignRequestSchema, { consent: false, typedName: "x" }],
    ["EsignRequest typedName > 80", api.EsignRequestSchema, { consent: true, typedName: "x".repeat(81) }],
    ["TtsRequest > 200 chars", api.TtsRequestSchema, { caseId: "c", text: "a".repeat(201), voice: "marin" }],
    ["TtsRequest unknown voice", api.TtsRequestSchema, { caseId: "c", text: "hi", voice: "alloy" }],
    ["ArmRequest missing midUtterance", api.ArmRequestSchema, { caseId: "c", runId: "r", tArmMs: 1, source: "manual" }],
    ["VaTokenRequest attempt 2", api.VaTokenRequestSchema, { takeoverId: "t", attempt: 2 }],
    ["ToolResponse bad stage", api.ToolResponseSchema, { result: {}, stage: "done" }],
    ["StreamingParams 101 keyterms", api.StreamingParamsSchema, { keyterms_prompt: Array.from({ length: 101 }, (_, i) => `k${i}`) }],
    ["StreamingParams agent_context > 1750", api.StreamingParamsSchema, { agent_context: "a".repeat(1751) }],
    ["SessionReport bad kind", api.SessionReportSchema, { sessionId: "s", kind: "tts", event: "opened" }],
    ["TakeoverEvents heartbeat:false", api.TakeoverEventsRequestSchema, { heartbeat: false }],
    ["CaseState bad field id", contracts.CaseStateSchema, (() => {
      // P§4.7: the field map is keyed by the id grammar, so a state may carry any relay's fields (see the
      // acceptance below) but never a malformed id. "Missing a Baton field" is no longer a schema error:
      // completeness is the kernel's job (`readiness`), not the wire contract's.
      const s = caseState() as unknown as { fields: Record<string, unknown> };
      s.fields["Amount-Due"] = s.fields.amount_due_today_usd;
      delete s.fields.amount_due_today_usd;
      return s;
    })()],
    ["FieldState > 3 evidence", contracts.FieldStateSchema, { ...caseState().fields.driver_dob, evidence: [0, 1, 2, 3].map(() => caseState().fields.driver_dob?.evidence[0]) }],
    ["CallAudioFormat 8 kHz PCM16", contracts.CallAudioFormatSchema, { encoding: "pcm_s16le", sampleRate: 8000 }],
    ["BatonEvent unknown type", contracts.BatonEventSchema, { t: 0, type: "nope" }],
    ["TurnInput bad source", contracts.TurnInputSchema, { ...turn, source: "whisper" }],
    ["TurnInput invented turn id", contracts.TurnInputSchema, { ...turn, turnId: "rep_13" }],
    ["TurnInput id channel differs from channel", contracts.TurnInputSchema, { ...turn, turnId: "customer-13" }],
    ["TurnInput cached id from a live session", contracts.TurnInputSchema, { ...turn, turnId: "rep-c13" }],
    ["TurnInput stt_cache with a live id", contracts.TurnInputSchema, { ...turn, source: "stt_cache" }],
    ["SttTokenRequest n:1 without channel", api.SttTokenRequestSchema, { caseId: "c", runId: "r", n: 1, reconnect: true }],
    ["SlotResult granted without sessionIds", api.SlotResultSchema, { status: "granted", grantId: "g" }],
    ["FactEvent null confidence", contracts.FactEventSchema, { ...factEvent, confidence: null }],
    ["Peaks value above 1", contracts.PeaksSchema, { ratePerSec: 50, rep: [1.2], customer: [] }],
  ];
  for (const [name, schema, value] of bad) {
    it(`rejects ${name}`, () => {
      expect(schema.safeParse(value).success).toBe(false);
    });
  }

  it("accepts a relay's own field ids in CaseState (P§4.7)", () => {
    const s = caseState() as unknown as { intent: string; fields: Record<string, unknown> };
    s.intent = "relay";
    s.fields.appointment_date = { ...(s.fields.driver_dob as Record<string, unknown>), field: "appointment_date" };
    expect(contracts.CaseStateSchema.safeParse(s).success).toBe(true);
  });

  it("strips unknown keys on strict-shaped request bodies", () => {
    const parsed = api.StartRunRequestSchema.parse({ caseId: "c", callId: "k", express: false, evil: 1 });
    expect(parsed).toEqual({ caseId: "c", callId: "k", express: false });
  });
});

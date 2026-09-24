/**
 * contracts/case.ts - the case record (DESIGN §4.1). Frozen at G0.
 *
 * FieldId === the recording kit's FactField (copied into intents/add-driver.fields.ts; the parity test asserts it).
 * REQUIRED (10), SERVER_RESOLVABLE, REP_ONLY, AI_SETTABLE and ADVICE_DOMAIN also live in add-driver.fields.ts.
 */
import { z } from "zod";
import { FIELD_IDS, FIELD_STATUSES } from "../intents/add-driver.fields";

export const CHANNELS = ["rep", "customer"] as const;
export const ChannelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof ChannelSchema>;

export const PARTIES = ["rep", "customer", "ai", "policy", "verifier"] as const;
export const PartySchema = z.enum(PARTIES);
export type Party = z.infer<typeof PartySchema>;

export const FieldStatusSchema = z.enum(FIELD_STATUSES);
export type FieldStatus = z.infer<typeof FieldStatusSchema>;

export const FieldIdSchema = z.enum(FIELD_IDS);
export type FieldId = z.infer<typeof FieldIdSchema>;

export const STATUS_REASONS = [
  "acknowledged", "read_back", "both_stated", "policy_record", "ai_confirmed", // → VERIFIED
  "stated_once", "late_turn", "conflict", "denied", "verifier_disagrees",
  "verifier_only", "rep_only_violation", //                                        → PENDING
  // G0: §5.4.1 "effective_date outside callDate..callDate+60 → flag out_of_range and stay PENDING".
  "out_of_range", //                                                               → PENDING
  "absent", //                                                                     → MISSING
] as const;
export const StatusReasonSchema = z.enum(STATUS_REASONS);
export type StatusReason = z.infer<typeof StatusReasonSchema>;

export const EVIDENCE_SOURCES = ["stt_live", "stt_cache", "va_transcript", "async_ch2", "async_ch1"] as const;
export const EvidenceSchema = z.object({
  /** customer_ai = customer speech in the AI half (VA ch1). */
  channel: z.enum(["rep", "customer", "ai", "customer_ai"]),
  turnId: z.string(),
  /** Call clock (human half) or VA session clock (AI half). */
  startMs: z.number(),
  endMs: z.number(),
  quote: z.string(),
  source: z.enum(EVIDENCE_SOURCES),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * G0: "verifier" added (DESIGN §5.4.2 switches on `case "verifier"`; F2 step 3 inserts sol disagreements).
 * Encoding of a verifier event (WP3 writes, WP1 reads): `kind:"verifier"`, `party:"verifier"`, `extractor:"sol"`,
 * `turnId:null`, `turnEndMs = VerifierResult.uptoRecvMs`, `valueRaw`/`valueNorm` = sol's value (normalized),
 * `confidence` from sol's support (stated_and_confirmed → high, stated_once → medium, conflicting → low),
 * `evidence` = the first cited turn or null. `deriveField`'s main loop never adopts a verifier event as `cur`;
 * only `verifierOnly()` / `verifierDisagrees()` read them, so sol can never make a field VERIFIED (§5.4.3).
 */
export const FACT_KINDS = ["stated", "readback", "ack", "corrected", "denied", "question", "tool_update", "policy", "verifier"] as const;
export const FactKindSchema = z.enum(FACT_KINDS);
export type FactKind = z.infer<typeof FactKindSchema>;

export const CONFIDENCES = ["high", "medium", "low"] as const;
export const ConfidenceSchema = z.enum(CONFIDENCES);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const EXTRACTORS = ["luna", "sol", "tool", "policy"] as const;

/**
 * An append-only fact event (fact_events row). `confidence` is required (DB NOT NULL): policy and tool_update events
 * use "high".
 *
 * `turnEndMs` is the ordering key of `deriveCaseState` (sorted by `(turnEndMs, seq)`) and is ALWAYS on the CALL
 * clock (G0 decision), even where `evidence` uses the VA session clock:
 * - extractor events (luna): the source turn's `endMs` (call clock);
 * - `tool_update` (AI half): `cases.t_arm_ms + (server now − takeovers.armed_at)` in ms, computed by the tool route,
 *   so every AI-half event sorts after the human half;
 * - `verifier` (sol): `VerifierResult.uptoRecvMs`;
 * - `policy`: 0.
 * Values may be fractional (the DB column is double precision).
 */
export const FactEventSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  field: FieldIdSchema,
  kind: FactKindSchema,
  party: PartySchema,
  valueRaw: z.string().nullable(),
  /** From normalizeField(); null if unparseable (kept for audit only). */
  valueNorm: z.string().nullable(),
  acknowledgesTurnId: z.string().nullable(),
  confidence: ConfidenceSchema,
  turnId: z.string().nullable(),
  turnEndMs: z.number(),
  /** late / cut per §5.4 and §5.5. */
  late: z.boolean(),
  cut: z.boolean(),
  evidence: EvidenceSchema.nullable(),
  extractor: z.enum(EXTRACTORS),
  seq: z.number().int(),
});
export type FactEvent = z.infer<typeof FactEventSchema>;

/** A fact event before the repository assigns `seq` (§5.3 post-processing step 7): what extractors produce. */
export const NewFactEventSchema = FactEventSchema.omit({ seq: true });
export type NewFactEvent = z.infer<typeof NewFactEventSchema>;

/** G0: "out_of_range" added (§5.4.1 effective_date guard; the field stays PENDING with reason out_of_range). */
export const FIELD_FLAGS = ["late_turn", "cut_turn", "verifier_disagrees", "customer_corrected_verified", "out_of_range"] as const;

export const FieldStateSchema = z.object({
  field: FieldIdSchema,
  status: FieldStatusSchema,
  reason: StatusReasonSchema,
  value: z.string().nullable(),
  display: z.string().nullable(),
  source: PartySchema.nullable(),
  /** Newest first, ≤3. */
  evidence: z.array(EvidenceSchema).max(3),
  conflict: z.object({ values: z.array(z.string()), evidence: z.array(EvidenceSchema) }).nullable(),
  flags: z.array(z.enum(FIELD_FLAGS)),
  updatedAtMs: z.number(),
});
export type FieldState = z.infer<typeof FieldStateSchema>;

export const ReadinessSchema = z.object({
  verified: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  requiredTotal: z.number().int().nonnegative(),
  ready: z.boolean(),
});
export type Readiness = z.infer<typeof ReadinessSchema>;

export const ConflictCardSchema = z.object({
  field: FieldIdSchema,
  values: z.array(z.object({ value: z.string(), party: PartySchema, evidence: EvidenceSchema.nullable() })),
  resolved: z.boolean(),
  resolution: z.string().optional(),
});
export type ConflictCard = z.infer<typeof ConflictCardSchema>;

/** `cases.status` (DESIGN §4.2; G0: shared enum so WP2/3/5/6/8 agree). */
export const CASE_STATUSES = ["shadowing", "armed", "ai_active", "completed", "handed_back", "abandoned", "failed"] as const;
export const CaseStatusSchema = z.enum(CASE_STATUSES);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

/** `cases.mode` (DESIGN §4.2). */
export const CASE_MODES = ["watch", "live", "spot", "synthetic"] as const;
export const CaseModeSchema = z.enum(CASE_MODES);
export type CaseMode = z.infer<typeof CaseModeSchema>;

export const STAGES = ["confirm", "disclose", "pay", "close"] as const;
export const StageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof StageSchema>;

export const PAYMENT_STATUSES = ["none", "created", "open", "confirmed", "succeeded", "failed", "expired", "timeout"] as const;
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const PAYMENT_PROVIDERS = ["polar", "mock"] as const;
export const PaymentProviderKindSchema = z.enum(PAYMENT_PROVIDERS);
export type PaymentProviderKind = z.infer<typeof PaymentProviderKindSchema>;

/** id "veh1", label "2021 Honda Civic". */
export const PolicyVehicleSchema = z.object({
  id: z.string(),
  year: z.number().int(),
  make: z.string(),
  model: z.string(),
  label: z.string(),
});
export type PolicyVehicle = z.infer<typeof PolicyVehicleSchema>;

/** Mapped from kit Scenario.rep/customer (fictional data). */
export const PolicyRecordSchema = z.object({
  policyNumber: z.string(),
  carrier: z.string(),
  /** "Harborview Insurance Agency" */
  agencyName: z.string(),
  /** "Daniel" */
  repFirstName: z.string(),
  policyholder: z.object({ firstName: z.string(), lastName: z.string() }),
  /** Not in the kit: derived deterministically from the policy number digits. */
  phoneOnFileLast4: z.string(),
  address: z.object({ street: z.string(), city: z.string(), state: z.string(), zip: z.string() }),
  existingDrivers: z.array(z.object({ name: z.string(), relation: z.string() })),
  vehicles: z.array(PolicyVehicleSchema),
  currentMonthlyPremiumUsd: z.number(),
  /** ISO date (kit call_date). */
  callDate: z.string(),
});
export type PolicyRecord = z.infer<typeof PolicyRecordSchema>;

export const DISCLOSURE_KINDS = ["premium_change", "esign_consent"] as const;
export const DisclosureKindSchema = z.enum(DISCLOSURE_KINDS);
export type DisclosureKind = z.infer<typeof DisclosureKindSchema>;

export const CasePaymentSchema = z.object({
  id: z.string(),
  status: PaymentStatusSchema,
  /** Polar amounts are cents. */
  amountCents: z.number().int(),
  /** Polar's total_amount. */
  totalAmountCents: z.number().int().nullable(),
  provider: PaymentProviderKindSchema,
  simulated: z.boolean(),
});
export type CasePayment = z.infer<typeof CasePaymentSchema>;

export const CaseStateSchema = z.object({
  caseId: z.string(),
  intent: z.literal("add_driver"),
  version: z.number().int(),
  callClockMs: z.number(),
  /** Exhaustive: every FieldId has a FieldState. */
  fields: z.record(FieldIdSchema, FieldStateSchema),
  readiness: ReadinessSchema,
  conflicts: z.array(ConflictCardSchema),
  stage: StageSchema.nullable(),
  disclosuresGiven: z.array(DisclosureKindSchema),
  payment: CasePaymentSchema.nullable(),
  confirmationNumber: z.string().nullable(),
});
export type CaseState = z.infer<typeof CaseStateSchema>;

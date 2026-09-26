/**
 * Valid sample values for every contract (used by the zod round-trip tests). Other WPs may import these as
 * starting points for their own fixtures; they are fictional (s01: Priya adds Maya to the 2021 Civic).
 */
import { FIELD_IDS, REQUIRED_FIELDS, type BatonFieldId as FieldId } from "../../../src/core/intents/add-driver.fields";
import type {
  CallLabels, CallManifestEntry, CaseState, CompiledTakeover, DrainReport, Evidence, FactEvent, FieldState, PolicyRecord,
  QaResult, RunPlan, Scenario, SweepPoint, TurnInput, VaFunctionTool,
} from "../../../src/core/contracts";

export const evidence: Evidence = {
  channel: "customer",
  turnId: "customer-12",
  startMs: 41_200,
  endMs: 43_900,
  quote: "March 14th, 2009",
  source: "stt_live",
};

export const policy: PolicyRecord = {
  policyNumber: "NBM-4418207",
  carrier: "Northbeam Mutual",
  agencyName: "Harborview Insurance Agency",
  repFirstName: "Daniel",
  policyholder: { firstName: "Priya", lastName: "Raman" },
  phoneOnFileLast4: "8207",
  address: { street: "1427 Belle Avenue", city: "Lakewood", state: "OH", zip: "44107" },
  existingDrivers: [
    { name: "Priya Raman", relation: "named_insured" },
    { name: "Arun Raman", relation: "spouse" },
  ],
  vehicles: [
    { id: "veh1", year: 2021, make: "Honda", model: "Civic", label: "2021 Honda Civic" },
    { id: "veh2", year: 2018, make: "Toyota", model: "Highlander", label: "2018 Toyota Highlander" },
  ],
  currentMonthlyPremiumUsd: 96,
  callDate: "2026-09-25",
};

const VALUES: Partial<Record<FieldId, string>> = {
  driver_full_name: "maya raman",
  driver_dob: "2009-03-14",
  driver_age: "17",
  driver_relation: "child",
  license_state: "OH",
  license_status: "provisional",
  incidents_3y: "none",
  vehicle_assignment: "veh1",
  operator_type: "primary",
  garaging_zip: "44107",
  effective_date: "2026-10-02",
  good_student_discount: "eligible",
  premium_new_monthly_usd: "142.00",
  premium_change_monthly_usd: "46.00",
};

export function fieldState(field: FieldId): FieldState {
  const value = VALUES[field] ?? null;
  if (value === null) {
    return { field, status: "MISSING", reason: "absent", value: null, display: null, source: null, evidence: [], conflict: null, flags: [], updatedAtMs: 0 };
  }
  return {
    field,
    status: field === "effective_date" ? "PENDING" : "VERIFIED",
    reason: field === "effective_date" ? "stated_once" : "acknowledged",
    value,
    display: value,
    source: field.startsWith("premium") ? "rep" : "customer",
    evidence: [evidence],
    conflict: null,
    flags: field === "effective_date" ? ["late_turn"] : [],
    updatedAtMs: 43_900,
  };
}

export function caseState(caseId = "case_s01"): CaseState {
  const fields = Object.fromEntries(FIELD_IDS.map((f) => [f, fieldState(f)])) as Record<FieldId, FieldState>;
  return {
    caseId,
    intent: "add_driver",
    version: 7,
    callClockMs: 95_000,
    fields,
    readiness: { verified: 9, pending: 1, missing: 0, requiredTotal: REQUIRED_FIELDS.length, ready: false },
    conflicts: [
      {
        field: "vehicle_assignment",
        values: [
          { value: "veh1", party: "customer", evidence },
          { value: "veh2", party: "rep", evidence: null },
        ],
        resolved: true,
        resolution: "customer confirmed veh1",
      },
    ],
    stage: "confirm",
    disclosuresGiven: ["premium_change"],
    payment: { id: "pay_1", status: "open", amountCents: 2340, totalAmountCents: 2340, provider: "polar", simulated: false },
    confirmationNumber: null,
  };
}

export const factEvent: FactEvent = {
  id: "fe_1",
  caseId: "case_s01",
  field: "driver_dob",
  kind: "readback",
  party: "rep",
  valueRaw: "March 14th, 2009",
  valueNorm: "2009-03-14",
  acknowledgesTurnId: null,
  confidence: "high",
  turnId: "rep-13",
  turnEndMs: 45_000,
  late: false,
  cut: false,
  evidence,
  extractor: "luna",
  seq: 12,
};

export const turn: TurnInput = {
  caseId: "case_s01",
  turnId: "rep-13",
  channel: "rep",
  text: "March 14th, 2009, got it. Will she mainly drive the Civic?",
  startMs: 44_000,
  endMs: 47_200,
  words: [
    { text: "March", startMs: 44_000, endMs: 44_300, confidence: 0.99 },
    { text: "14th,", startMs: 44_300, endMs: 44_700, confidence: 0.98 },
  ],
  source: "stt_live",
  recvMs: 47_650,
  cut: false,
  late: false,
};

export const call: CallManifestEntry = {
  callId: "s01_20260925T101503Z",
  scenarioId: "s01",
  title: "Add a driver · Priya ↔ Daniel",
  source: "twilio8k",
  language: "en",
  durationMs: 118_000,
  format: { encoding: "pcm_mulaw", sampleRate: 8000 },
  publishAudio: true,
  inEval: true,
  featured: true,
  picker: "main",
  decisionPointMs: 95_000,
  handoff: { lineStartMs: 95_000, lineEndMs: 98_400, acceptStartMs: 99_000, acceptEndMs: 100_100, declined: false },
  recordedAiBundle: null,
  customerTailPack: null,
  assets: {
    rep: "/calls/s01_20260925T101503Z/rep.3f2a9c1d.ulaw",
    customer: "/calls/s01_20260925T101503Z/customer.9b1c04e2.ulaw",
    peaks: "/calls/s01_20260925T101503Z/peaks.5d6e7f80.json",
  },
};

export const scenario: Scenario = {
  id: "s01",
  intent: "add_driver",
  title: "Add 17-year-old daughter Maya to the Civic",
  language: "en",
  callDate: "2026-09-25",
  policy,
  truth: { driver_full_name: "maya raman", premium_new_monthly_usd: "142.00" },
  expectedAtHandoff: { driver_full_name: "VERIFIED", effective_date: "VERIFIED" },
  plannedHandoffS: 95,
  handoffResponse: "accepts",
  rating: { newMonthlyUsd: 142, changeMonthlyUsd: 46, dueTodayUsd: 23.4 },
  traps: ["Baseline: re-asked = 0."],
};

export const labels: CallLabels = {
  callId: call.callId,
  reviewed: true,
  mentions: [{ field: "driver_dob", valueNorm: "2009-03-14", channel: "customer", statedAtMs: 41_200, ackedAtMs: 45_000, quote: "March 14th, 2009" }],
  handoff: { lineStartMs: 95_000, lineEndMs: 98_400, acceptStartMs: 99_000, acceptEndMs: null },
  diagnosisEndsMs: 80_000,
  tailStartsMs: 95_000,
};

export const runPlan: RunPlan = {
  runId: "run_1",
  caseId: "case_s01",
  sttHalf: "live",
  aiHalf: "live",
  vaHoldId: "ls_1",
  holdExpiresAt: "2026-09-25T10:20:00.000Z",
  reason: null,
  recordedHandoffMs: null,
};

export const tool: VaFunctionTool = {
  type: "function",
  name: "update_case_field",
  description: "Record a field value the customer just confirmed, corrected or newly provided.",
  parameters: { type: "object", required: ["field", "value", "reason"], properties: { field: { type: "string" } } },
  execution_mode: "interactive",
  timeout_seconds: 10,
};

export const drain: DrainReport = {
  tArmMs: 60_000,
  tCutMs: 60_450,
  capHit: false,
  midUtterance: true,
  completedTurnIds: ["rep-13", "customer-14"],
  pendingTurnIds: [],
  cutTurnIds: [],
  waitedMs: 1_250,
  timings: { armed: 0, sealed: 450, finals: 900, drained: 1_250 },
};

export function compiled(): CompiledTakeover {
  return {
    greeting: "Hi Priya, this is Harborview Insurance Agency's AI assistant. I'm an automated assistant, not a person, and this call is still being recorded.",
    systemPrompt: "IDENTITY ...\n(internal ref: baton-deploy=dev-wp0a; never mention this)",
    keyterms: [],
    tools: [tool],
    stage: "confirm",
    snapshot: caseState(),
    voice: "alba",
    transcriptionMode: "min_latency",
    vaSessionCapMs: 165_000,
    promptVersion: "a1b2c3d4",
    deployMarker: "dev-wp0a",
    compiledBy: "server",
  };
}

export const qa: QaResult = {
  provisional: false,
  reAsked: 0,
  newlyAsked: 1,
  pendingConfirmed: 1,
  verifiedReconfirmed: 0,
  disclosures: [{ kind: "premium_change", similarity: 0.97, ok: true, missingCritical: [] }],
  clickToFirstAudibleMs: 4_100,
  deadAirAfterRepMs: 350,
  turnLatencyP50Ms: 2_400,
  payment: "verified_webhook",
  handedBack: false,
  aiSeconds: 142,
  adviceFlags: 0,
  details: [{ sentence: "Just to confirm, the change should start Friday, October 2nd?", atMs: 5_200, field: "effective_date", classification: "pending_confirm" }],
};

export function sweepPoint(): SweepPoint {
  const snapshot = Object.fromEntries(FIELD_IDS.map((f) => [f, { status: "MISSING" as const, value: null, display: null }])) as SweepPoint["snapshot"];
  snapshot.driver_full_name = { status: "VERIFIED", value: "maya raman", display: "Maya Raman" };
  return {
    callId: call.callId,
    version: "v3",
    variant: "pc_ctx",
    ablation: "none",
    tMs: 40_000,
    midUtterance: false,
    tCutMs: 40_400,
    capHit: false,
    protocolMs: 3_300,
    snapshot,
    greeting: "Hi Priya, ...",
    metrics: {
      entityAcc: 0.95,
      verifiedPrecision: 1,
      wrongAsserted: 0,
      wrongPending: 0,
      reaskProjected: 0,
      pendingN: 1,
      missingN: 3,
      ready: false,
      statusAgreementAtPlanned: null,
    },
  };
}

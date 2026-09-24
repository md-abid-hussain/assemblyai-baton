/**
 * compiler/stages.ts - stage progression (§5.8), the next step and its input mode (§5.9.1), the dynamic session
 * cap (§5.9.5) and the pure timing helpers of the hold protocol (§5.8) and the wrap-up (§5.9.5).
 * WP1 early deliverable; WP5/WP5b/WP6 import these.
 */
import type { CaseState, FieldId, Stage } from "../contracts/case";
import type { TakeoverPhase } from "../contracts/events";
import type { InputModeFor, PhoneState, VaSessionCapMs } from "../contracts/services";
import { TAKEOVER_TIMING, type InputModePlan, type NextStep } from "../contracts/takeover";
import { REQUIRED_SET, SERVER_RESOLVABLE_SET } from "../intents/add-driver.fields";
import { GREETING_PRIORITY } from "../intents/add-driver";

export const STAGE_ORDER: readonly Stage[] = ["confirm", "disclose", "pay", "close"];

/** Initial stage (§5.8): `disclose` if the snapshot is ready, else `confirm`. Neither contains a `hold` tool. */
export const initialStage = (snapshot: Pick<CaseState, "readiness">): Stage => (snapshot.readiness.ready ? "disclose" : "confirm");

/**
 * Forward-only stage progression (§5.8 handler semantics):
 * `confirm → disclose` when the case is ready; `disclose → pay` once the `esign_consent` disclosure was retrieved;
 * `pay → close` once the payment succeeded. Never moves backwards.
 */
export function nextStage(
  current: Stage | null,
  s: Pick<CaseState, "readiness" | "disclosuresGiven" | "payment">,
): Stage {
  let stage: Stage = current ?? initialStage(s);
  for (;;) {
    const before = stage;
    if (stage === "confirm" && s.readiness.ready) stage = "disclose";
    else if (stage === "disclose" && s.disclosuresGiven.includes("esign_consent")) stage = "pay";
    else if (stage === "pay" && s.payment?.status === "succeeded") stage = "close";
    if (stage === before) return stage;
  }
}

/**
 * The greeting's (and the agent's) next step (§5.6 sentence 4): the first PENDING field in priority order →
 * `confirm`; else the first required MISSING field (never the server-resolvable premium) → `ask`; else `none`.
 */
export function nextStepOf(snapshot: Pick<CaseState, "fields">): NextStep {
  for (const f of GREETING_PRIORITY) if (snapshot.fields[f]?.status === "PENDING") return { kind: "confirm", field: f };
  for (const f of GREETING_PRIORITY) {
    if (REQUIRED_SET.has(f) && !SERVER_RESOLVABLE_SET.has(f) && (snapshot.fields[f]?.status ?? "MISSING") === "MISSING") {
      return { kind: "ask", field: f };
    }
  }
  return { kind: "none", field: null };
}

/** Entity fields whose capture benefits from `balanced` turn detection (§5.9.1). */
export const ENTITY_FIELDS: ReadonlySet<FieldId> = new Set<FieldId>([
  "driver_dob", "garaging_zip", "license_state", "driver_full_name", "vehicle_assignment", "effective_date", "incidents_3y",
  "driver_relation", "license_status", "operator_type",
]);

/**
 * `inputModeFor(nextStep)` (§5.9.1, golden config 10 §3.5 rule 9):
 * - asking for `license_number` → `max_accuracy` (id_capture);
 * - asking for any other MISSING field → `balanced` (asks_entity);
 * - yes/no confirmations and "ready?" → `min_latency` (yes_no);
 * - disclosure and consent answers → `min_latency` (disclosure).
 */
export const inputModeFor: InputModeFor = (next) => {
  switch (next.kind) {
    case "ask":
      return next.field === "license_number" ? { mode: "max_accuracy", reason: "id_capture" } : { mode: "balanced", reason: "asks_entity" };
    case "disclosure":
    case "consent":
      return { mode: "min_latency", reason: "disclosure" };
    case "confirm":
    case "none":
      return { mode: "min_latency", reason: "yes_no" };
  }
};

/**
 * Fallback if T-D1-4 shows `transcription_mode` is immutable mid-session (§5.9.1): `balanced` whenever the
 * snapshot has any MISSING required entity field, else `min_latency`.
 */
export function staticInputMode(snapshot: Pick<CaseState, "fields">): InputModePlan {
  const missingEntity = [...ENTITY_FIELDS].some(
    (f) => REQUIRED_SET.has(f) && (snapshot.fields[f]?.status ?? "MISSING") === "MISSING",
  );
  return missingEntity ? { mode: "balanced", reason: "asks_entity" } : { mode: "min_latency", reason: "yes_no" };
}

// ------------------------------------------------------------------------------------------ session cap (§5.9.5)

export interface VaCapEnv {
  baseMs: number;
  perFieldMs: number;
  maxMs: number;
}
/** DESIGN §3.4 defaults: `VA_SESSION_CAP_BASE_MS` / `_PER_FIELD_MS` / `_MAX_MS`. */
export const DEFAULT_VA_CAP_ENV: VaCapEnv = { baseMs: 150_000, perFieldMs: 15_000, maxMs: 420_000 };

/** Required fields that are not VERIFIED at the snapshot, excluding the server-resolvable premium (never asked). */
export function openRequiredFields(snapshot: Pick<CaseState, "fields">): FieldId[] {
  return [...REQUIRED_SET].filter((f) => !SERVER_RESOLVABLE_SET.has(f) && snapshot.fields[f]?.status !== "VERIFIED");
}

/**
 * `vaSessionCapMs = min(MAX, BASE + PER_FIELD × open)` (§5.9.5), where `open` = PENDING + MISSING required fields
 * at the snapshot (the premium excluded: the AI never works on it). 150 s + 15 s per open field, at most 420 s.
 */
export const vaSessionCapMs: VaSessionCapMs = (snapshot, env) =>
  Math.min(env.maxMs, env.baseMs + env.perFieldMs * openRequiredFields(snapshot).length);

/** The effective cap: the dynamic cap plus the time spent in `paying` (the wrap-up clock pauses while holding). */
export const effectiveCapMs = (capMs: number, payingMs: number): number => capMs + Math.max(0, payingMs);

/**
 * Should the wrap-up `reply.create` fire now (§5.9.5)? At effective cap − `WRAP_UP_WARNING_MS`, never in
 * `paying` or `closing` (nor after the session is over), and only once.
 */
export function wrapUpDue(i: { phase: TakeoverPhase; elapsedMs: number; capMs: number; payingMs: number; alreadySent: boolean }): boolean {
  if (i.alreadySent) return false;
  if (i.phase !== "active" && i.phase !== "greeting") return false;
  return i.elapsedMs >= effectiveCapMs(i.capMs, i.payingMs) - TAKEOVER_TIMING.WRAP_UP_WARNING_MS;
}

/** The absolute ceiling (`VA_SESSION_CAP_MAX_MS` + 180 s of hold) ends the session in any stage (§5.9.5). */
export const absoluteCeilingReached = (elapsedMs: number, env: Pick<VaCapEnv, "maxMs">): boolean =>
  elapsedMs >= env.maxMs + TAKEOVER_TIMING.HOLD_MAX_MS;

// ------------------------------------------------------------------------------------------ hold protocol (§5.8)

/** Phone states that extend the hold deadline (§5.8 step 4). */
export const HOLD_EXTEND_STATES: ReadonlySet<PhoneState> = new Set<PhoneState>([
  "esign", "signed", "checkout-loading", "checkout-open", "processing", "simulating",
]);

/** The initial hold deadline: 60 s after the SMS. */
export const initialHoldDeadlineMs = (smsAtMs: number): number => smsAtMs + TAKEOVER_TIMING.HOLD_DEADLINE_MS;

/**
 * Advance the hold deadline (§5.8 step 4). When `nowMs` reaches the deadline while the phone is in an extending
 * state, the deadline moves by 30 s steps, never beyond `smsAtMs + 180 s`. Returns the (possibly unchanged)
 * deadline; the hold times out when `nowMs >= deadline` after this call.
 */
export function advanceHoldDeadline(i: { smsAtMs: number; deadlineMs: number; nowMs: number; phone: PhoneState }): number {
  const ceiling = i.smsAtMs + TAKEOVER_TIMING.HOLD_MAX_MS;
  let d = i.deadlineMs;
  while (i.nowMs >= d && HOLD_EXTEND_STATES.has(i.phone) && d < ceiling) d = Math.min(d + TAKEOVER_TIMING.HOLD_EXTEND_STEP_MS, ceiling);
  return d;
}

export const holdTimedOut = (i: { smsAtMs: number; deadlineMs: number; nowMs: number; phone: PhoneState }): boolean =>
  i.nowMs >= advanceHoldDeadline(i);

/**
 * Reassurance (§5.8 step 5): at +45 s after the SMS and every 45 s after, suppressed while the Polar overlay is
 * open or processing. Returns true when reassurance number `sentCount + 1` is due.
 */
export function reassuranceDue(i: { smsAtMs: number; nowMs: number; sentCount: number; phone: PhoneState }): boolean {
  if (i.phone === "checkout-open" || i.phone === "processing") return false;
  return i.nowMs - i.smsAtMs >= TAKEOVER_TIMING.REASSURE_EVERY_MS * (i.sentCount + 1);
}

/**
 * What a payment success means for the session (§5.8 step 8): while the hold is in flight → send the `paid`
 * tool.result (after the stage update); after a `timeout` result (or in push mode) → the push path
 * (`session.update{stage close}` then `reply.create`).
 */
export function onPaymentSucceeded(i: { holdInFlight: boolean; sessionOpen: boolean }): "tool_result" | "push_path" | "ignore" {
  if (!i.sessionOpen) return "ignore";
  return i.holdInFlight ? "tool_result" : "push_path";
}

export type { InputModePlan, NextStep };

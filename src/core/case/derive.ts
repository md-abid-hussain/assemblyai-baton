/**
 * case/derive.ts - `deriveCaseState` (DESIGN §5.4.2–§5.4.3): the whole CaseState recomputed from the append-only
 * fact events, every time. Pure and deterministic (exported for the sweep, §6.5). Also `deriveV1`, the naive v1
 * rule ("any stated value = VERIFIED", §6.4).
 */
import type {
  CasePayment, CaseState, ConflictCard, DisclosureKind, FieldId, FieldState, PolicyRecord, Stage,
} from "../contracts/case";
import type { VerifierResult } from "../contracts/extract";
import { displayValue } from "../intents/add-driver";
import { FIELD_IDS } from "../intents/add-driver.fields";
import { ageOn, dayNumber } from "./dates";
import { emptyFieldState, readinessOf } from "./state";
import { deriveField, verifierViewOf, type DerivableEvent, type VerifierOpinion } from "./status-rules";

export interface DeriveCtx {
  caseId: string;
  /** The case row version (default 0). */
  version?: number;
  /** Default: the latest `turnEndMs` among the events (0 if none). */
  callClockMs?: number;
  /** `cases.t_arm_ms`: human events of turns that ended after it count as late (§5.5.4 rule 2). */
  tArmMs?: number | null;
  /** The latest `VerifierResult` applied while shadowing (preferred over the verifier events; see status-rules). */
  verifier?: VerifierResult | null;
  /** Pipeline switches for the sweep: v2 = `{lateCut:false}`; the `verifier_off` ablation = `{verifierOverlay:false}`. */
  rules?: { lateCut?: boolean; verifierOverlay?: boolean };
  /** Carried through from the case row (not derivable from fact events). */
  stage?: Stage | null;
  disclosuresGiven?: DisclosureKind[];
  payment?: CasePayment | null;
  confirmationNumber?: string | null;
}

/** Stable `(turnEndMs, seq)` order; events without `seq` keep their array order among equals. */
export function sortEvents<E extends DerivableEvent>(events: readonly E[]): E[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.turnEndMs - b.e.turnEndMs || (a.e.seq ?? a.i) - (b.e.seq ?? b.i) || a.i - b.i)
    .map((x) => x.e);
}

function groupByField(events: readonly DerivableEvent[]): Map<FieldId, DerivableEvent[]> {
  const m = new Map<FieldId, DerivableEvent[]>();
  for (const e of events) {
    const arr = m.get(e.field);
    if (arr) arr.push(e);
    else m.set(e.field, [e]);
  }
  return m;
}

/**
 * §5.4.1 age rule: a VERIFIED `driver_dob` implies an age (a MISSING age becomes VERIFIED with the computed value;
 * a merely stated-once consistent age is upgraded). If both exist and disagree, both become PENDING (`conflict`)
 * unless one of them was confirmed by the AI.
 */
function applyAgeRule(fields: Record<FieldId, FieldState>, policy: PolicyRecord, callDate: string, cards: ConflictCard[]): void {
  const dob = fields.driver_dob;
  const age = fields.driver_age;
  if (dob.value === null || dayNumber(dob.value) === null || dayNumber(callDate) === null) return;
  const computed = String(ageOn(dob.value, callDate));
  if (age.value !== null && age.value !== computed) {
    if (dob.reason === "ai_confirmed" || age.reason === "ai_confirmed") return;
    const evidence = [...dob.evidence, ...age.evidence].slice(0, 3);
    const conflict = { values: [age.value, computed], evidence };
    fields.driver_dob = { ...dob, status: "PENDING", reason: "conflict", conflict: dob.conflict ?? { values: [dob.value], evidence: dob.evidence } };
    fields.driver_age = { ...age, status: "PENDING", reason: "conflict", conflict };
    cards.push({
      field: "driver_age",
      values: [
        { value: age.value, party: age.source ?? "customer", evidence: age.evidence[0] ?? null },
        { value: computed, party: dob.source ?? "customer", evidence: dob.evidence[0] ?? null },
      ],
      resolved: false,
    });
    return;
  }
  if (dob.status !== "VERIFIED") return;
  if (age.value === null || (age.status === "PENDING" && age.reason === "stated_once")) {
    fields.driver_age = {
      ...(age.value === null ? emptyFieldState("driver_age") : age),
      status: "VERIFIED",
      reason: dob.reason,
      value: computed,
      display: displayValue("driver_age", computed, policy),
      source: age.value === null ? dob.source : age.source,
      evidence: age.value === null ? dob.evidence : age.evidence,
      updatedAtMs: Math.max(age.updatedAtMs, dob.updatedAtMs),
    };
  }
}

/** `deriveCaseState(policy, events, ctx)`: recompute the full state from the events (§5.4). */
export function deriveCaseState(policy: PolicyRecord, events: readonly DerivableEvent[], ctx: DeriveCtx): CaseState {
  const sorted = sortEvents(events);
  const callDate = policy.callDate;
  const lateCut = ctx.rules?.lateCut ?? true;
  const verifier: Map<FieldId, VerifierOpinion> =
    ctx.rules?.verifierOverlay === false ? new Map() : verifierViewOf(sorted, ctx.verifier, { policy, callDate });
  const byField = groupByField(sorted);
  const cards: ConflictCard[] = [];
  const fields = {} as Record<FieldId, FieldState>;
  for (const f of FIELD_IDS) {
    const { state, card } = deriveField(f, byField.get(f) ?? [], { policy, callDate, tArmMs: ctx.tArmMs ?? null, lateCut, verifier });
    fields[f] = state;
    if (card) cards.push(card);
  }
  applyAgeRule(fields, policy, callDate, cards);
  const clock = sorted.length ? Math.max(...sorted.map((e) => e.turnEndMs)) : 0;
  return {
    caseId: ctx.caseId,
    intent: "add_driver",
    version: ctx.version ?? 0,
    callClockMs: ctx.callClockMs ?? clock,
    fields,
    readiness: readinessOf(fields),
    conflicts: cards,
    stage: ctx.stage ?? null,
    disclosuresGiven: ctx.disclosuresGiven ?? [],
    payment: ctx.payment ?? null,
    confirmationNumber: ctx.confirmationNumber ?? null,
  };
}

/**
 * `deriveV1` (§6.4 v1, naive): the latest non-null value of each field is VERIFIED, whoever said it, with no
 * acknowledgement, conflict, late/cut or verifier logic. Reason `stated_once` (it was stated; v1 asserts it anyway).
 */
export function deriveV1(policy: PolicyRecord, events: readonly DerivableEvent[], ctx: Pick<DeriveCtx, "caseId" | "version" | "callClockMs">): CaseState {
  const sorted = sortEvents(events);
  const fields = {} as Record<FieldId, FieldState>;
  for (const f of FIELD_IDS) fields[f] = emptyFieldState(f);
  for (const e of sorted) {
    if (e.kind === "question" || e.kind === "verifier" || e.valueNorm === null) continue;
    fields[e.field] = {
      ...fields[e.field],
      status: "VERIFIED",
      reason: "stated_once",
      value: e.valueNorm,
      display: displayValue(e.field, e.valueNorm, policy, e.valueRaw),
      source: e.party,
      evidence: e.evidence ? [e.evidence, ...fields[e.field].evidence].slice(0, 3) : fields[e.field].evidence,
      updatedAtMs: e.turnEndMs,
    };
  }
  const clock = sorted.length ? Math.max(...sorted.map((e) => e.turnEndMs)) : 0;
  return {
    caseId: ctx.caseId, intent: "add_driver", version: ctx.version ?? 0, callClockMs: ctx.callClockMs ?? clock, fields,
    readiness: readinessOf(fields), conflicts: [], stage: null, disclosuresGiven: [], payment: null, confirmationNumber: null,
  };
}

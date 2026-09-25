/**
 * case/state.ts - CaseState constructors and readiness (DESIGN §4.1, §5.4.3). Pure.
 * WP14a·3: optional trailing `spec?: IntentSpec` (TASKS-v2 §2 rule 9): the spec's fields and required set.
 */
import type { CaseState, FieldId, FieldState, Readiness } from "../contracts/case";
import type { IntentSpec } from "../contracts/v2/relay";
import { FIELD_IDS, REQUIRED_FIELDS, SERVER_RESOLVABLE_SET } from "../intents/add-driver.fields";
import { readinessFor } from "../relay/spec-link";

export const emptyFieldState = (field: FieldId): FieldState => ({
  field, status: "MISSING", reason: "absent", value: null, display: null, source: null, evidence: [], conflict: null, flags: [], updatedAtMs: 0,
});

export function emptyFields(spec?: IntentSpec): Record<FieldId, FieldState> {
  const ids = spec ? (spec.fieldIds as readonly FieldId[]) : FIELD_IDS;
  return Object.fromEntries(ids.map((f) => [f, emptyFieldState(f)])) as Record<FieldId, FieldState>;
}

/**
 * Readiness (§5.4.3): `requiredTotal` = 10; `ready` = every required field VERIFIED, except the SERVER_RESOLVABLE
 * premium, which never blocks (the disclosure takes a VERIFIED rep quote when present, else the rating tool; the AI
 * never asks for it and cannot set it, so a PENDING premium must not block either).
 */
export function readinessOf(fields: Readonly<Record<FieldId, Pick<FieldState, "status">>>, spec?: IntentSpec): Readiness {
  if (spec) return readinessFor(spec, { fields: fields as CaseState["fields"] });
  let verified = 0, pending = 0, missing = 0;
  let ready = true;
  for (const f of REQUIRED_FIELDS) {
    const st = fields[f]?.status ?? "MISSING";
    if (st === "VERIFIED") verified++;
    else if (st === "PENDING") pending++;
    else missing++;
    if (st !== "VERIFIED" && !SERVER_RESOLVABLE_SET.has(f)) ready = false;
  }
  return { verified, pending, missing, requiredTotal: REQUIRED_FIELDS.length, ready };
}

/** A fresh case: every field MISSING, no stage, no payment. */
export function emptyCaseState(caseId: string, spec?: IntentSpec): CaseState {
  const fields = emptyFields(spec);
  return {
    caseId, intent: "add_driver", version: 0, callClockMs: 0, fields, readiness: readinessOf(fields, spec), conflicts: [],
    stage: null, disclosuresGiven: [], payment: null, confirmationNumber: null,
  };
}

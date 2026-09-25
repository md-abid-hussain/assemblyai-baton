/**
 * case/state.ts - CaseState constructors and readiness (DESIGN §4.1, §5.4.3). Pure.
 */
import type { CaseState, FieldId, FieldState, Readiness } from "../contracts/case";
import { FIELD_IDS, REQUIRED_FIELDS, SERVER_RESOLVABLE_SET } from "../intents/add-driver.fields";

export const emptyFieldState = (field: FieldId): FieldState => ({
  field, status: "MISSING", reason: "absent", value: null, display: null, source: null, evidence: [], conflict: null, flags: [], updatedAtMs: 0,
});

export function emptyFields(): Record<FieldId, FieldState> {
  return Object.fromEntries(FIELD_IDS.map((f) => [f, emptyFieldState(f)])) as Record<FieldId, FieldState>;
}

/**
 * Readiness (§5.4.3): `requiredTotal` = 10; `ready` = every required field VERIFIED, except the SERVER_RESOLVABLE
 * premium, which never blocks (the disclosure takes a VERIFIED rep quote when present, else the rating tool; the AI
 * never asks for it and cannot set it, so a PENDING premium must not block either).
 */
export function readinessOf(fields: Readonly<Record<FieldId, Pick<FieldState, "status">>>): Readiness {
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
export function emptyCaseState(caseId: string): CaseState {
  const fields = emptyFields();
  return {
    caseId, intent: "add_driver", version: 0, callClockMs: 0, fields, readiness: readinessOf(fields), conflicts: [],
    stage: null, disclosuresGiven: [], payment: null, confirmationNumber: null,
  };
}

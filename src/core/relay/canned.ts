/**
 * relay/canned.ts - the 4 canned snapshot states (PLATFORM §3.4 G2, §7.2 Track/Playbook: "the greeting renders live
 * for 4 canned snapshot states"). WP14a. Pure and isomorphic.
 *
 *   all_verified  every required field VERIFIED (rep_only fields from the rep, the rest from the customer);
 *   one_pending   the same, but the first open-able field (next-step priority, required, not rep_only) is PENDING;
 *   one_missing   the same, but that field is MISSING;
 *   nothing       every field MISSING.
 * Optional fields stay MISSING. Values come from each field's first `examples` entry that normalizes against the
 * account (so a lookup example like "the Civic" becomes the row id), else from a per-type sample value. Baton's
 * canned states match the parity corpus's `canned:*` snapshots (scripts/relay/parity-corpus.ts).
 */
import type { CaseState, FieldState } from "../contracts/case";
import type { AccountRecord, Blueprint, BlueprintField } from "../contracts/v2/blueprint";
import { CANNED_STATES, type CannedState, type IntentSpec } from "../contracts/v2/relay";
import type { CompiledRelay } from "../contracts/v2/services";
import type { Fields } from "./scope";
import { buildIntentSpec } from "./spec";
import { readinessFor } from "./spec-link";

export { CANNED_STATES, type CannedState };

const addDays = (ymd: string, days: number): string => {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + days * 86_400_000).toISOString().slice(0, 10) : ymd;
};

/** A plausible raw value per field type, used when no example normalizes. */
function fallbackRaw(bp: Blueprint, f: BlueprintField, account: AccountRecord): string {
  switch (f.type) {
    case "person_name": return `${account.customer.firstName} ${account.customer.lastName}`;
    case "date": return addDays(account.callDate, f.normalizer === "date_of_birth" ? -365 * 30 : 7);
    case "money": return "100.00";
    case "signed_money": return "10.00";
    case "number": case "integer": return String(f.validation.min ?? 2);
    case "enum": return f.enumValues?.[0]?.value ?? "yes";
    case "lookup": {
      const def = f.lookup ? bp.context.tables.find((t) => t.id === f.lookup!.table) : undefined;
      const row = def ? account.tables[def.id]?.[0] : undefined;
      return (def && row?.[def.idColumn]) || "1";
    }
    case "phone": return "5550100123";
    case "zip": return account.customer.address?.zip ?? "12345";
    case "state": return account.customer.address?.state ?? "CA";
    case "boolean": return "yes";
    case "email": return "alex@example.com";
    case "id_code": return "AB1234";
    case "text": return "sample";
  }
}

/** The canned value of a field: `{ value, display }` (normalized when the spec can). */
export function cannedFieldValue(bp: Blueprint, spec: IntentSpec, f: BlueprintField, account: AccountRecord): { value: string; display: string } {
  const ctx = { callDate: account.callDate, account };
  for (const raw of [...f.examples, fallbackRaw(bp, f, account)]) {
    try {
      const n = spec.normalize(f.id, raw, ctx);
      if (n) return { value: n.norm, display: n.display };
    } catch { /* a normalizer that throws on a sample value falls through */ }
  }
  const raw = fallbackRaw(bp, f, account);
  return { value: raw, display: raw };
}

const fieldState = (f: BlueprintField, status: FieldState["status"], v: { value: string; display: string } | null): FieldState => ({
  field: f.id as FieldState["field"],
  status,
  reason: "acknowledged",
  value: status === "MISSING" || !v ? null : v.value,
  display: status === "MISSING" || !v ? null : v.display,
  source: status === "MISSING" ? null : f.setBy === "rep_only" ? "rep" : "customer",
  evidence: [],
  conflict: null,
  flags: [],
  updatedAtMs: 0,
});

/** The field `one_pending`/`one_missing` changes: the first required, non-rep-only field in next-step priority, else in field order. */
export function cannedFocusField(bp: Blueprint, spec: IntentSpec = buildIntentSpec(bp)): string | null {
  const open = (id: string) => { const f = bp.fields.find((x) => x.id === id); return !!f && f.required && f.setBy !== "rep_only"; };
  return spec.priority.find(open) ?? bp.fields.find((f) => open(f.id))?.id ?? null;
}

/** A canned snapshot (`fields` only) for a blueprint and an account. */
export function cannedSnapshot(bp: Blueprint, state: CannedState, account: AccountRecord, spec: IntentSpec = buildIntentSpec(bp)): Fields {
  const focus = state === "one_pending" || state === "one_missing" ? cannedFocusField(bp, spec) : null;
  const fields: Record<string, FieldState> = {};
  for (const f of bp.fields) {
    if (state === "nothing" || !f.required) { fields[f.id] = fieldState(f, "MISSING", null); continue; }
    const v = cannedFieldValue(bp, spec, f, account);
    const status: FieldState["status"] = f.id !== focus ? "VERIFIED" : state === "one_pending" ? "PENDING" : "MISSING";
    fields[f.id] = fieldState(f, status, v);
  }
  return { fields } as unknown as Fields;
}

/**
 * A full `CaseState` in a canned state for a kernel-compiled relay (WP14b's `KernelBinding.cannedSnapshot`; the
 * server's compiled view renders greetings, prompts, tools and the first update from it, as the Studio does).
 * Readiness follows the relay's required fields. `intent` stays the v1 literal until the P§4.7 widening.
 */
export function cannedCaseState(compiled: CompiledRelay, account: AccountRecord, state: CannedState, caseId = `case_canned_${state}`): CaseState {
  const bp = compiled.blueprint;
  if (!bp) throw new Error("cannedCaseState needs a kernel-compiled relay (compileRelay), not the legacy engine");
  const snap = cannedSnapshot(bp, state, account, compiled.spec);
  return {
    caseId, intent: "add_driver", version: 0, callClockMs: 0, fields: snap.fields,
    readiness: readinessFor(compiled.spec, snap), conflicts: [], stage: null, disclosuresGiven: [], payment: null, confirmationNumber: null,
  };
}

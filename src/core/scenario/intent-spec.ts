/**
 * scenario/intent-spec.ts - what the data pipeline needs to know about an intent, looked up by the scenario's own
 * `intent` (Changeover: a relay blueprint names its fields; Baton's add-driver is the one registered today).
 *
 * The pipeline (normalize, plan, labels, extraction replay) never hard-codes a field list: it iterates the fields the
 * scenario states and checks them against the spec of that scenario's intent. A new blueprint registers one spec.
 */
import type { FieldId, PolicyRecord } from "../contracts/case";
import { FIELD_IDS, FIELD_LABEL, REQUIRED_FIELDS, isFieldId } from "../intents/add-driver.fields";
import { normalizeField } from "../intents/add-driver";

export interface IntentSpec {
  intent: string;
  /** Every field id the blueprint knows (order = display order). */
  fieldIds: readonly FieldId[];
  isField(x: string): x is FieldId;
  /** Required for readiness; the decision point falls back to the last acknowledged one (§6.1). */
  requiredFields: readonly FieldId[];
  /** Human label (labeller prompt, review CLI). */
  label(f: FieldId): string;
  /** The production normalizer (value → norm), null = unparseable. */
  normalize(f: FieldId, raw: string | number | boolean, ctx: { policy: PolicyRecord; callDate: string }): string | null;
  /** The money field that carries the new premium (rating), or null when the blueprint has no rating. */
  ratingFields: { newMonthly: FieldId; changeMonthly: FieldId | null; dueToday: FieldId | null; effectiveDate: FieldId | null } | null;
}

export const ADD_DRIVER_SPEC: IntentSpec = {
  intent: "add_driver",
  fieldIds: FIELD_IDS,
  isField: (x: string): x is FieldId => isFieldId(x),
  requiredFields: REQUIRED_FIELDS,
  label: (f) => FIELD_LABEL[f],
  normalize: (f, raw, ctx) => normalizeField(f, raw, ctx)?.norm ?? null,
  ratingFields: {
    newMonthly: "premium_new_monthly_usd",
    changeMonthly: "premium_change_monthly_usd",
    dueToday: "amount_due_today_usd",
    effectiveDate: "effective_date",
  },
};

const REGISTRY = new Map<string, IntentSpec>([[ADD_DRIVER_SPEC.intent, ADD_DRIVER_SPEC]]);

/** The spec of a scenario's intent, or null (the build warns and skips that scenario). */
export const intentSpecOf = (intent: string): IntentSpec | null => REGISTRY.get(intent) ?? null;

/** Register another blueprint's spec (tests, future intents). Returns an unregister function. */
export function registerIntentSpec(spec: IntentSpec): () => void {
  const prev = REGISTRY.get(spec.intent);
  REGISTRY.set(spec.intent, spec);
  return () => {
    if (prev) REGISTRY.set(spec.intent, prev);
    else REGISTRY.delete(spec.intent);
  };
}

/**
 * case/field-ops.ts - the per-field operations derivation and post-processing need, from either today's Baton
 * functions (no spec) or an `IntentSpec` (WP14a·3 spec injection, TASKS-v2 §2 rule 9). Pure.
 *
 * Without a spec the operations ARE the legacy functions (the legacy path is unchanged). With a spec, the `policy`
 * argument of the caller is read through `accountFor` (a `PolicyRecord` → `policyToAccount`; a generic relay's
 * `AccountRecord` passed through the unchanged parameter → itself).
 */
import type { FieldId, PolicyRecord } from "../contracts/case";
import type { IntentSpec } from "../contracts/v2/relay";
import { compatible, displayValue, effectiveDateInRange, mergeValues, normalizeField } from "../intents/add-driver";
import { REP_ONLY_SET } from "../intents/add-driver.fields";
import { accountFor } from "../relay/account";

export interface FieldOps {
  /** Normalized value and its display (null = unparseable). */
  normalize(field: FieldId, raw: string | number | boolean | null | undefined): { norm: string; display: string } | null;
  display(field: FieldId, norm: string, raw?: string | null): string;
  compatible(field: FieldId, a: string | null, b: string | null): boolean;
  merge(field: FieldId, a: string, b: string): string;
  repOnly(field: FieldId): boolean;
  /** Date range validation (Baton: effective_date within 0–90 days of the call). */
  inRange(field: FieldId, norm: string): boolean;
}

export function fieldOps(ctx: { policy: PolicyRecord; callDate: string }, spec?: IntentSpec): FieldOps {
  const { policy, callDate } = ctx;
  if (!spec) {
    return {
      normalize: (f, raw) => normalizeField(f, raw, { policy, callDate }),
      display: (f, norm, raw) => displayValue(f, norm, policy, raw),
      compatible,
      merge: mergeValues,
      repOnly: (f) => REP_ONLY_SET.has(f),
      inRange: (f, norm) => f !== "effective_date" || effectiveDateInRange(norm, callDate),
    };
  }
  const account = accountFor(policy);
  return {
    normalize: (f, raw) => spec.normalize(f, raw, { callDate, account }),
    display: (f, norm, raw) => spec.display(f, norm, account, raw),
    compatible: (f, a, b) => spec.compatible(f, a, b),
    merge: (f, a, b) => spec.merge(f, a, b),
    repOnly: (f) => spec.repOnly.has(f),
    inRange: (f, norm) => spec.inRange(f, norm, callDate),
  };
}

/** The ids a derivation iterates (the spec's, in blueprint order; else the 21 Baton fields). */
export const fieldIdsOf = (spec: IntentSpec | undefined, legacy: readonly FieldId[]): readonly FieldId[] =>
  spec ? (spec.fieldIds as readonly FieldId[]) : legacy;

/**
 * scenario/normalize.ts - `normalizeScenario(kitScenario, sidecar)` → Baton `Scenario` (DESIGN §6.1).
 *
 * - facts `value` → `truth` through WP1's `normalizeField` (norm formats equal the kit formats; money → "142.00");
 * - `status_at_handoff` → `expectedAtHandoff`;
 * - the take's `sidecar.review.fact_overrides` / `status_overrides` are applied ON TOP (the take's actual words win);
 * - `rep` + `customer` → `PolicyRecord` (same rules as WP1's fixtures and WP3's `policyFromKitScenario`:
 *   `phoneOnFileLast4` = last 4 policy-number digits, vehicle label "<year> <make> <model>");
 * - `handoff` → `plannedHandoffS` / `handoffResponse`; `eval.traps` → `traps`;
 * - `rating` from the facts; `dueTodayUsd` = the kit's `amount_due_today_usd`, else prorated exactly like WP1's
 *   `resolveDueToday` (new − current) × daysLeft/daysInMonth from the effective date, min $0.50.
 *
 * `normalizeField` is INJECTED (WP1 owns it in src/core/intents/add-driver.ts). `kitValueNorm` is the fallback for
 * values that are already in the kit's canonical format (the kit validator guarantees that); a parity test pins it
 * against WP1's normalizer on all 22 scenarios whenever WP1's module is reachable.
 */
import type { FieldId, FieldStatus, PolicyRecord } from "../contracts/case";
import type { Scenario } from "../contracts/scenario";
import { FIELD_IDS, FIELD_KIND } from "../intents/add-driver.fields";
import type { KitFactValue, KitScenario, KitSidecar } from "./kit";

/** WP1's `normalizeField` signature (structural; WP1's function is assignable to it). */
export type NormalizeFieldFn = (
  field: FieldId,
  raw: string | number | boolean | null | undefined,
  ctx: { policy: PolicyRecord; callDate: string },
) => { norm: string; display: string } | null;

/** WP1's minimum amount due today (disclosures.ts MIN_DUE_TODAY_USD). */
export const MIN_DUE_TODAY_USD = 0.5;

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Kit `rep` + `customer` → PolicyRecord (DESIGN §6.1; identical to WP1 fixtures / WP3 kit-policy.ts). */
export function policyFromKit(s: Pick<KitScenario, "rep" | "customer" | "call_date">): PolicyRecord {
  const [first = "", ...rest] = collapse(s.customer.name).split(" ");
  const digits = s.customer.policy_number.replace(/\D/g, "");
  return {
    policyNumber: s.customer.policy_number,
    carrier: s.customer.carrier,
    agencyName: s.rep.agency,
    repFirstName: collapse(s.rep.name).split(" ")[0] ?? "",
    policyholder: { firstName: first, lastName: rest.join(" ") },
    phoneOnFileLast4: digits.slice(-4),
    address: { street: s.customer.address.street, city: s.customer.address.city, state: s.customer.address.state, zip: s.customer.address.zip },
    existingDrivers: s.customer.existing_drivers.map((d) => ({ name: d.name, relation: d.relation })),
    vehicles: s.customer.vehicles.map((v) => ({ id: v.id, year: v.year, make: v.make, model: v.model, label: `${v.year} ${v.make} ${v.model}` })),
    currentMonthlyPremiumUsd: s.customer.current_premium_monthly_usd,
    callDate: s.call_date,
  };
}

/**
 * Fallback normalizer for values ALREADY in the kit's canonical format (kit validateScenario: ISO dates, 2-letter
 * states, 5-digit ZIPs, enum literals, vehicle ids, numbers for money). Mirrors WP1's norm formats: names lower-case,
 * money with 2 decimals, booleans "true"/"false", licence numbers upper-case alphanumerics.
 */
export function kitValueNorm(field: FieldId, value: KitFactValue): string | null {
  const kind = FIELD_KIND[field];
  switch (kind.t) {
    case "money":
    case "signed_money": {
      const n = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n)) return null;
      if (kind.t === "money" && n < 0) return null;
      return (Math.round(n * 100) / 100).toFixed(2);
    }
    case "boolean":
      return typeof value === "boolean" ? String(value) : /^(true|false)$/i.test(String(value)) ? String(value).toLowerCase() : null;
    case "int":
      return Number.isInteger(Number(value)) ? String(Number(value)) : null;
    case "state":
      return String(value).toUpperCase();
    default:
      break;
  }
  const s = collapse(String(value));
  if (!s) return null;
  if (field === "driver_full_name") return collapse(s.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'"));
  if (field === "license_number") return s.toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
  if (field === "incidents_3y" || field === "coverage_change") return s.toLowerCase().replace(/[’‘]/g, "'");
  return s;
}

export interface NormalizeScenarioOptions {
  /** WP1 `normalizeField`; the fallback is `kitValueNorm`. */
  normalizeField?: NormalizeFieldFn | null;
  /** Called for every fact whose value the normalizer rejected (kept out of `truth`). */
  onDrop?: (field: FieldId, value: KitFactValue, why: string) => void;
}

function normTruth(field: FieldId, value: KitFactValue, policy: PolicyRecord, callDate: string, o: NormalizeScenarioOptions): string | null {
  if (o.normalizeField) return o.normalizeField(field, String(value), { policy, callDate })?.norm ?? null;
  return kitValueNorm(field, value);
}

/** Days in a month (1-based month). */
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** WP1 `resolveDueToday`'s prorated branch, on the scenario's own truth (effective date, else the call date). */
export function proratedDueTodayUsd(newMonthlyUsd: number, currentMonthlyUsd: number, fromIsoDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromIsoDate);
  if (!m) throw new Error(`proratedDueTodayUsd: not an ISO date: ${fromIsoDate}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dim = daysInMonth(y, mo);
  const daysLeft = dim - d + 1;
  const raw = (newMonthlyUsd - currentMonthlyUsd) * (daysLeft / dim);
  const cents = Math.max(Math.round(raw * 100), Math.round(MIN_DUE_TODAY_USD * 100));
  return cents / 100;
}

/**
 * The kit scenario (+ the take's sidecar, when normalizing for one take) → Baton `Scenario`. Overrides win over the
 * scenario design. Throws when the result has no `premium_new_monthly_usd` (a required field of every kit scenario).
 */
export function normalizeScenario(kit: KitScenario, sidecar: Pick<KitSidecar, "review"> | null, o: NormalizeScenarioOptions = {}): Scenario {
  const policy = policyFromKit(kit);
  const callDate = kit.call_date;
  const values = new Map<FieldId, KitFactValue>();
  const statuses = new Map<FieldId, FieldStatus>();
  for (const f of FIELD_IDS) {
    const fact = kit.facts[f];
    if (!fact) continue;
    values.set(f, fact.value);
    statuses.set(f, fact.status_at_handoff);
  }
  for (const [f, v] of Object.entries(sidecar?.review.fact_overrides ?? {}) as [FieldId, KitFactValue | undefined][]) {
    if (v !== undefined) values.set(f, v);
  }
  for (const [f, st] of Object.entries(sidecar?.review.status_overrides ?? {}) as [FieldId, FieldStatus | undefined][]) {
    if (st !== undefined) statuses.set(f, st);
  }

  const truth: Partial<Record<FieldId, string>> = {};
  for (const f of FIELD_IDS) {
    const v = values.get(f);
    if (v === undefined) continue;
    const n = normTruth(f, v, policy, callDate, o);
    if (n === null) o.onDrop?.(f, v, "normalizer returned null");
    else truth[f] = n;
  }
  const expectedAtHandoff: Partial<Record<FieldId, FieldStatus>> = {};
  for (const f of FIELD_IDS) {
    const st = statuses.get(f);
    if (st) expectedAtHandoff[f] = st;
  }

  const money = (f: FieldId): number | null => {
    const t = truth[f];
    return t === undefined ? null : Number(t);
  };
  const newMonthlyUsd = money("premium_new_monthly_usd");
  if (newMonthlyUsd === null) throw new Error(`${kit.id}: no premium_new_monthly_usd truth (required by the kit schema)`);
  const changeMonthlyUsd = money("premium_change_monthly_usd");
  const dueToday = money("amount_due_today_usd");
  const eff = truth.effective_date;
  const dueTodayUsd = dueToday ?? proratedDueTodayUsd(newMonthlyUsd, kit.customer.current_premium_monthly_usd, eff && /^\d{4}-\d{2}-\d{2}$/.test(eff) ? eff : callDate);

  return {
    id: kit.id,
    intent: "add_driver",
    title: kit.title,
    language: kit.language,
    callDate,
    policy,
    truth,
    expectedAtHandoff,
    plannedHandoffS: kit.handoff.approx_at_s,
    handoffResponse: kit.handoff.customer_response,
    rating: { newMonthlyUsd, changeMonthlyUsd, dueTodayUsd },
    traps: [...kit.eval.traps],
  };
}

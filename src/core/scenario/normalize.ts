/**
 * scenario/normalize.ts - `normalizeScenario(kitScenario, sidecar)` → Baton `Scenario` (DESIGN §6.1).
 *
 * - facts `value` → `truth` through the intent's production normalizer (WP1 `normalizeField` for add_driver; norm
 *   formats equal the kit formats; money → "142.00");
 * - `status_at_handoff` → `expectedAtHandoff`;
 * - the take's `sidecar.review.fact_overrides` / `status_overrides` are applied ON TOP (the take's actual words win);
 * - `rep` + `customer` → `PolicyRecord` (same rules as WP1's fixtures and WP3's `policyFromKitScenario`:
 *   `phoneOnFileLast4` = last 4 policy-number digits, vehicle label "<year> <make> <model>");
 * - `handoff` → `plannedHandoffS` / `handoffResponse`; `eval.traps` → `traps`;
 * - `rating` from the facts; `dueTodayUsd` = the kit's `amount_due_today_usd`, else prorated exactly like WP1's
 *   `resolveDueToday` (new − current) × daysLeft/daysInMonth from the effective date, min $0.50.
 *
 * Field ids are never hard-coded here: the scenario's own `facts` keys are checked against its intent's spec.
 */
import type { FieldId, FieldStatus, PolicyRecord } from "../contracts/case";
import type { Scenario } from "../contracts/scenario";
import { HANDOFF_RESPONSES, LANGUAGES, type HandoffResponse, type Language } from "../intents/add-driver.fields";
import { ADD_DRIVER_SPEC, intentSpecOf, type IntentSpec } from "./intent-spec";
import type { KitFactValue, KitScenario, KitSidecar } from "./kit";

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

export interface NormalizeScenarioOptions {
  /** Override the intent spec (tests); default: the spec registered for `kit.intent`. */
  spec?: IntentSpec;
  /** Called for every fact that is dropped (unknown field, or the normalizer rejected its value). */
  onDrop?: (field: string, value: KitFactValue | undefined, why: string) => void;
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

const isLanguage = (x: string): x is Language => (LANGUAGES as readonly string[]).includes(x);
const isHandoffResponse = (x: string): x is HandoffResponse => (HANDOFF_RESPONSES as readonly string[]).includes(x);

/**
 * The kit scenario (+ the take's sidecar, when normalizing for one take) → Baton `Scenario`. Overrides win over the
 * scenario design. Throws on an unknown intent / language / hand-off response, or when the blueprint has a rating
 * and the result has no new-premium truth.
 */
export function normalizeScenario(kit: KitScenario, sidecar: Pick<KitSidecar, "review"> | null, o: NormalizeScenarioOptions = {}): Scenario {
  const spec = o.spec ?? intentSpecOf(kit.intent);
  if (!spec) throw new Error(`${kit.id}: no intent spec registered for intent "${kit.intent}"`);
  if (spec.intent !== ADD_DRIVER_SPEC.intent) throw new Error(`${kit.id}: the Scenario contract only carries add_driver today (got ${spec.intent})`);
  if (!isLanguage(kit.language)) throw new Error(`${kit.id}: unsupported language "${kit.language}"`);
  const handoffResponse = kit.handoff.customer_response;
  if (!isHandoffResponse(handoffResponse)) throw new Error(`${kit.id}: unsupported handoff.customer_response "${handoffResponse}"`);
  const policy = policyFromKit(kit);
  const callDate = kit.call_date;

  const values = new Map<FieldId, KitFactValue>();
  const statuses = new Map<FieldId, FieldStatus>();
  for (const [key, fact] of Object.entries(kit.facts)) {
    if (!spec.isField(key)) {
      o.onDrop?.(key, fact.value, `not a field of intent ${spec.intent}`);
      continue;
    }
    values.set(key, fact.value);
    statuses.set(key, fact.status_at_handoff);
  }
  for (const [key, v] of Object.entries(sidecar?.review.fact_overrides ?? {})) {
    if (!spec.isField(key)) o.onDrop?.(key, v, `override of an unknown field (intent ${spec.intent})`);
    else values.set(key, v);
  }
  for (const [key, st] of Object.entries(sidecar?.review.status_overrides ?? {})) {
    if (!spec.isField(key)) o.onDrop?.(key, undefined, `status override of an unknown field (intent ${spec.intent})`);
    else statuses.set(key, st);
  }

  const truth: Partial<Record<FieldId, string>> = {};
  const expectedAtHandoff: Partial<Record<FieldId, FieldStatus>> = {};
  for (const f of spec.fieldIds) {
    const v = values.get(f);
    if (v !== undefined) {
      const n = spec.normalize(f, v, { policy, callDate });
      if (n === null) o.onDrop?.(f, v, "normalizer returned null");
      else truth[f] = n;
    }
    const st = statuses.get(f);
    if (st) expectedAtHandoff[f] = st;
  }

  const money = (f: FieldId | null | undefined): number | null => {
    const t = f ? truth[f] : undefined;
    return t === undefined ? null : Number(t);
  };
  const rf = spec.ratingFields;
  const newMonthlyUsd = money(rf?.newMonthly);
  if (newMonthlyUsd === null) throw new Error(`${kit.id}: no ${rf?.newMonthly ?? "new-premium"} truth (required by the kit schema)`);
  const changeMonthlyUsd = money(rf?.changeMonthly);
  const dueToday = money(rf?.dueToday);
  const eff = rf?.effectiveDate ? truth[rf.effectiveDate] : undefined;
  const from = eff && /^\d{4}-\d{2}-\d{2}$/.test(eff) ? eff : callDate;
  const dueTodayUsd = dueToday ?? proratedDueTodayUsd(newMonthlyUsd, kit.customer.current_premium_monthly_usd, from);

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
    handoffResponse,
    rating: { newMonthlyUsd, changeMonthlyUsd, dueTodayUsd },
    traps: [...kit.eval.traps],
  };
}

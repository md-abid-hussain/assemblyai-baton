/**
 * relay/account.ts - the account record (PLATFORM §4.2): `policyToAccount` maps the legacy Baton `PolicyRecord`
 * (plus the scenario's rating) to the generic `AccountRecord` every relay runs on; `accountFromStored` reads either
 * kind of `cases.policy` jsonb. WP14a. Pure and isomorphic.
 */
import type { PolicyRecord } from "../contracts/case";
import type { AccountRecord } from "../contracts/v2/blueprint";
import { ACCOUNT_KIND_MARKER } from "../contracts/v2/relay";

/** The scenario rating the legacy `get_disclosure` handler resolves money from (`Scenario.rating`). */
export interface BatonRating {
  newMonthlyUsd: number;
  dueTodayUsd?: number | null;
}

/** Baton's account facts (PLATFORM §4.2, plus the street and city the STT keyterms use). */
export const BATON_FACT_KEYS = [
  "policy_number", "carrier", "address_street", "address_city", "address_zip", "address_state",
  "current_monthly_premium_usd", "rating_new_monthly_usd", "scenario_due_today_usd",
] as const;

/** Baton's vehicle table columns. `make_model` is the "make model" spoken form (keyterms, QA). */
export const BATON_VEHICLE_COLUMNS = ["id", "year", "make", "model", "label", "make_model"] as const;

/**
 * `policyToAccount(policy, rating)` (PLATFORM §4.2):
 * customer ← policyholder + phoneOnFileLast4 (+ the address); org ← agencyName + repFirstName; callDate;
 * facts ← policy number, carrier, address, current premium and, when given, the rating (new monthly, due today);
 * tables ← vehicles [{id, year, make, model, label, make_model}] and existing_drivers [{name, relation}].
 */
export function policyToAccount(policy: PolicyRecord, rating?: BatonRating | null): AccountRecord {
  const facts: Record<string, string> = {
    policy_number: policy.policyNumber,
    carrier: policy.carrier,
    address_street: policy.address.street,
    address_city: policy.address.city,
    address_zip: policy.address.zip,
    address_state: policy.address.state,
    current_monthly_premium_usd: String(policy.currentMonthlyPremiumUsd),
  };
  if (rating) {
    facts.rating_new_monthly_usd = String(rating.newMonthlyUsd);
    if (rating.dueTodayUsd !== null && rating.dueTodayUsd !== undefined) facts.scenario_due_today_usd = String(rating.dueTodayUsd);
  }
  return {
    customer: {
      firstName: policy.policyholder.firstName,
      lastName: policy.policyholder.lastName,
      phoneLast4: policy.phoneOnFileLast4,
      address: { line1: policy.address.street, city: policy.address.city, state: policy.address.state, zip: policy.address.zip },
    },
    org: { name: policy.agencyName, repFirstName: policy.repFirstName },
    callDate: policy.callDate,
    facts,
    tables: {
      vehicles: policy.vehicles.map((v) => ({
        id: v.id, year: String(v.year), make: v.make, model: v.model, label: v.label, make_model: `${v.make} ${v.model}`,
      })),
      existing_drivers: policy.existingDrivers.map((d) => ({ name: d.name, relation: d.relation })),
    },
  };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The account of a `cases.policy` value (PLATFORM §4.2): a relay row stores an `AccountRecord` with
 * `"$kind": "account"` (returned without the marker); a legacy Baton row stores a `PolicyRecord` (mapped with
 * `policyToAccount`, with the rating when the caller has it). Shape is not validated here (the server parses).
 */
export function accountFromStored(stored: unknown, rating?: BatonRating | null): AccountRecord {
  if (isObj(stored) && stored.$kind === ACCOUNT_KIND_MARKER) {
    const { $kind: _k, ...account } = stored;
    return account as unknown as AccountRecord;
  }
  return policyToAccount(stored as PolicyRecord, rating);
}

/** Stores an account for a relay run (`cases.policy`, with the marker). */
export const storedAccount = (account: AccountRecord): AccountRecord & { $kind: typeof ACCOUNT_KIND_MARKER } =>
  ({ $kind: ACCOUNT_KIND_MARKER, ...account });

// ============================================================================================ both directions (WP14a·3)

const isAccountShaped = (x: object): boolean => !("policyholder" in x) && "customer" in x && "org" in x;

/**
 * The inverse of `policyToAccount` for Baton-shaped accounts (the legacy language layer reads a `PolicyRecord`):
 * facts → policy number, carrier, address, current premium; tables `vehicles` and `existing_drivers` → the lists.
 * Missing keys become "" / 0. `policyToAccount(accountToPolicy(a))` equals `a` for every Baton account without a rating.
 */
export function accountToPolicy(a: AccountRecord): PolicyRecord {
  const f = a.facts;
  const addr = a.customer.address;
  return {
    policyNumber: f.policy_number ?? "",
    carrier: f.carrier ?? "",
    agencyName: a.org.name,
    repFirstName: a.org.repFirstName,
    policyholder: { firstName: a.customer.firstName, lastName: a.customer.lastName },
    phoneOnFileLast4: a.customer.phoneLast4,
    address: {
      street: f.address_street ?? addr?.line1 ?? "", city: f.address_city ?? addr?.city ?? "",
      state: f.address_state ?? addr?.state ?? "", zip: f.address_zip ?? addr?.zip ?? "",
    },
    existingDrivers: (a.tables.existing_drivers ?? []).map((r) => ({ name: r.name ?? "", relation: r.relation ?? "" })),
    vehicles: (a.tables.vehicles ?? []).map((r) => ({ id: r.id ?? "", year: Number(r.year ?? 0), make: r.make ?? "", model: r.model ?? "", label: r.label ?? "" })),
    currentMonthlyPremiumUsd: Number(f.current_monthly_premium_usd ?? 0),
    callDate: a.callDate,
  };
}

const ACCOUNT_OF = new WeakMap<object, AccountRecord>();
const POLICY_OF = new WeakMap<object, PolicyRecord>();

/**
 * The account behind a legacy `policy` argument (spec injection, TASKS-v2 §2 rule 9): a `PolicyRecord` is mapped with
 * `policyToAccount` (no rating); an `AccountRecord` (a generic relay's row passed through the unchanged `PolicyRecord`
 * parameter until the P§4.7 widening) is returned as is, without the stored-account marker. Cached per object.
 */
export function accountFor(p: PolicyRecord | AccountRecord): AccountRecord {
  const hit = ACCOUNT_OF.get(p);
  if (hit) return hit;
  let a: AccountRecord;
  if (isAccountShaped(p)) {
    const { $kind: _k, ...rest } = p as AccountRecord & { $kind?: unknown };
    a = rest as AccountRecord;
  } else a = policyToAccount(p as PolicyRecord);
  ACCOUNT_OF.set(p, a);
  return a;
}

/** The `PolicyRecord` view of an account (cached per object; a `PolicyRecord` is returned as is). */
export function policyFor(a: AccountRecord | PolicyRecord): PolicyRecord {
  if (!isAccountShaped(a)) return a as PolicyRecord;
  const hit = POLICY_OF.get(a);
  if (hit) return hit;
  const p = accountToPolicy(a as AccountRecord);
  POLICY_OF.set(a, p);
  return p;
}

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

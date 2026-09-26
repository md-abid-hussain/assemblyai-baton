import "server-only";

import type { PolicyRecord } from "../../core/contracts/case";
import type { AccountRecord } from "../../core/contracts/v2/blueprint";

/**
 * The `payment_link` adapter (PLATFORM §6.1, WP16·2): a relay's `AccountRecord` becomes the two `PolicyRecord`
 * fields `buildCheckoutCreate` prefills (`policyholder` and `address`), and every relay run bills the ONE generic
 * Polar sandbox demo customer.
 *
 * Why the address matters: without `customerBillingAddress`, Polar asks a US buyer for a full address
 * (research/12 §12) and the judge types 20–40 s more mid-demo. Every gallery sample carries a fictional address
 * (`AccountRecordSchema.customer.address`), and a sample that somehow has none falls back to
 * `RELAY_FALLBACK_ADDRESS` — fictional, US, and valid for Polar's form — rather than dropping the prefill.
 *
 * Why one customer: `POLAR_DEMO_CUSTOMERS` is keyed by Baton scenario id (`s01`, `s02`, …), written by
 * `scripts/polar/setup.ts --write-env`. A relay has no scenario, so `relay:<slug>` would match nothing and the
 * checkout would ask for name and email too. Relay payments therefore pass `scenarioId = RELAY_DEMO_CUSTOMER_KEY`
 * ("relay"), which the user sets up once in the sandbox (TASKS-v2 §11 D2). If it is missing, the checkout still
 * works: Polar falls back to `customerName` + the prefilled address, and only the email is typed.
 */

/** `POLAR_DEMO_CUSTOMERS["relay"]`: the generic sandbox demo customer every relay run bills (PLATFORM §6.1). */
export const RELAY_DEMO_CUSTOMER_KEY = "relay";

/** PLATFORM §6.1: the amount is clamped to $1–$999 before it ever reaches Polar. */
export const PAYMENT_MIN_CENTS = 100;
export const PAYMENT_MAX_CENTS = 99_900;

/** Fictional, and only used when a sample carries no address at all. */
export const RELAY_FALLBACK_ADDRESS = { street: "418 Harborview Lane", city: "Lakewood", state: "OH", zip: "44107" } as const;

export interface ClampedAmount {
  cents: number;
  clamped: boolean;
  /** The value before clamping (for the owner-facing log line). */
  requestedCents: number;
}

/** Clamp to 100–99 900 cents. A non-finite or non-positive amount clamps to the minimum. */
export function clampPaymentCents(cents: number): ClampedAmount {
  const requestedCents = Number.isFinite(cents) ? Math.round(cents) : 0;
  const c = Math.min(PAYMENT_MAX_CENTS, Math.max(PAYMENT_MIN_CENTS, requestedCents));
  return { cents: c, clamped: c !== requestedCents, requestedCents };
}

/** The `{policyholder, address}` Polar prefills, from a relay account (PLATFORM §6.1 "Adapter"). */
export function accountToPolarCustomer(account: AccountRecord): Pick<PolicyRecord, "policyholder" | "address"> {
  const a = account.customer.address;
  return {
    policyholder: { firstName: account.customer.firstName, lastName: account.customer.lastName },
    address: a
      ? { street: a.line1, city: a.city, state: a.state, zip: a.zip }
      : { ...RELAY_FALLBACK_ADDRESS },
  };
}

/**
 * A `PolicyRecord`-shaped value for `PaymentService.create`, built from a relay account. Only `policyholder` and
 * `address` reach Polar (`buildCheckoutCreate`); the rest is filled from the account so nothing in the payment
 * layer sees a half-built record. `facts.policy_number` is used when the relay happens to have one.
 */
export function relayPaymentPolicy(account: AccountRecord): PolicyRecord {
  const { policyholder, address } = accountToPolarCustomer(account);
  return {
    policyNumber: account.facts.policy_number ?? "RELAY",
    carrier: account.org.name,
    agencyName: account.org.name,
    repFirstName: account.org.repFirstName,
    policyholder,
    phoneOnFileLast4: account.customer.phoneLast4,
    address,
    existingDrivers: [],
    vehicles: [],
    currentMonthlyPremiumUsd: 0,
    callDate: account.callDate,
  };
}

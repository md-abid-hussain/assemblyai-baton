/**
 * contracts/v3/plans.ts - plans as data (SAAS §14, §4.1). WP19; frozen at C3.
 *
 * `PLANS[plan].limits` is the ONE table the pricing page, the Billing page, the usage meters and every limit check
 * read. `org_entitlements.overrides` (WP21) may raise a single limit for a single org; nothing else forks it.
 * Prices are a [HYPOTHESIS] for the pitch and everything runs in the Polar sandbox: no real money moves.
 */
import type { PlanId } from "./identity";

export interface PlanLimits {
  accountRequired: boolean;
  /** Members plus pending invites. */
  seats: number;
  /** Non-gallery, non-archived relays. */
  relays: number;
  liveRunsPerDay: number;
  aiMinutesPerMonth: number;
  /** `null` = overage is blocked rather than billed. */
  overageUsdPerMin: number | null;
  dryRunsPerDay: number;
  voicedSimsPerDay: number;
  draftsPerDay: number;
  livePublications: number;
  /** `null` = no idle expiry. */
  publicationIdleHours: number | null;
  /** `http_action` to the org's own hosts (SAAS §5.6). */
  httpAction: boolean;
  connectorHosts: number;
  secrets: number;
  /** `null` = secrets do not expire. */
  secretTtlDays: number | null;
  apiKeys: number;
  apiKeyScopes: "none" | "build" | "all";
  apiRatePerMin: number;
  webhookEndpoints: number;
  auditRetentionDays: number;
  analyticsDays: number;
}

/** Exactly the SAAS §4.1 table. `priceUsdMonthly: null` = not purchasable (the guest plan). */
export const PLANS: Readonly<
  Record<PlanId, { name: string; priceUsdMonthly: number | null; limits: PlanLimits }>
> = Object.freeze({
  guest: Object.freeze({
    name: "Guest",
    priceUsdMonthly: null,
    limits: Object.freeze({
      accountRequired: false, seats: 1, relays: 3, liveRunsPerDay: 3, aiMinutesPerMonth: 10,
      overageUsdPerMin: null, dryRunsPerDay: 3, voicedSimsPerDay: 0, draftsPerDay: 1,
      livePublications: 1, publicationIdleHours: 24, httpAction: false, connectorHosts: 0,
      secrets: 3, secretTtlDays: 7, apiKeys: 0, apiKeyScopes: "none", apiRatePerMin: 0,
      webhookEndpoints: 0, auditRetentionDays: 7, analyticsDays: 7,
    }) satisfies PlanLimits,
  }),
  free: Object.freeze({
    name: "Free",
    priceUsdMonthly: 0,
    limits: Object.freeze({
      accountRequired: true, seats: 3, relays: 5, liveRunsPerDay: 5, aiMinutesPerMonth: 15,
      overageUsdPerMin: null, dryRunsPerDay: 5, voicedSimsPerDay: 0, draftsPerDay: 3,
      livePublications: 1, publicationIdleHours: 72, httpAction: false, connectorHosts: 0,
      secrets: 5, secretTtlDays: 30, apiKeys: 2, apiKeyScopes: "build", apiRatePerMin: 60,
      webhookEndpoints: 0, auditRetentionDays: 7, analyticsDays: 30,
    }) satisfies PlanLimits,
  }),
  pro: Object.freeze({
    name: "Pro",
    priceUsdMonthly: 49,
    limits: Object.freeze({
      accountRequired: true, seats: 10, relays: 50, liveRunsPerDay: 25, aiMinutesPerMonth: 150,
      overageUsdPerMin: 0.3, dryRunsPerDay: 30, voicedSimsPerDay: 2, draftsPerDay: 10,
      livePublications: 5, publicationIdleHours: null, httpAction: true, connectorHosts: 10,
      secrets: 50, secretTtlDays: null, apiKeys: 10, apiKeyScopes: "all", apiRatePerMin: 600,
      webhookEndpoints: 3, auditRetentionDays: 90, analyticsDays: 90,
    }) satisfies PlanLimits,
  }),
  business: Object.freeze({
    name: "Business",
    priceUsdMonthly: 299,
    limits: Object.freeze({
      accountRequired: true, seats: 50, relays: 500, liveRunsPerDay: 100, aiMinutesPerMonth: 1000,
      overageUsdPerMin: 0.25, dryRunsPerDay: 100, voicedSimsPerDay: 5, draftsPerDay: 30,
      livePublications: 25, publicationIdleHours: null, httpAction: true, connectorHosts: 50,
      secrets: 200, secretTtlDays: null, apiKeys: 50, apiKeyScopes: "all", apiRatePerMin: 1200,
      webhookEndpoints: 10, auditRetentionDays: 365, analyticsDays: 365,
    }) satisfies PlanLimits,
  }),
});

/** Limits checked by counting existing rows (`Entitlements.assertCount`). */
export type CountLimitKey = "seats" | "relays" | "livePublications" | "secrets" | "apiKeys" | "webhookEndpoints" | "connectorHosts";
/** Limits checked against a rolling window (`Entitlements.checkRate`). */
export type RateLimitKey = "liveRunsPerDay" | "dryRunsPerDay" | "voicedSimsPerDay" | "draftsPerDay" | "aiMinutesPerMonth";

/** What an org is entitled to right now: the plan's limits with any per-org overrides already applied. */
export interface EntitlementView {
  orgId: string;
  plan: PlanId;
  status: "active" | "trialing" | "past_due" | "canceled" | "none";
  source: "default" | "polar" | "simulated" | "admin";
  limits: PlanLimits;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  syncedAt: string | null;
}

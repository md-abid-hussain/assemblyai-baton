/**
 * WP19·1 acceptance: `PLANS` equals SAAS §4.1.
 *
 * The expected table is the spec transcribed column by column, in the spec's own row order, so a diff here is a
 * diff against §4.1. Pricing, the Billing page, the usage meters and every limit check read this one table.
 */
import { describe, expect, it } from "vitest";

import type { PlanId } from "@/core/contracts/v3/identity";
import { PLANS, type PlanLimits } from "@/core/contracts/v3/plans";

/** SAAS §4.1, one entry per row of the table. */
const SPEC: Record<PlanId, { name: string; price: number | null; limits: PlanLimits }> = {
  guest: {
    name: "Guest", price: null,
    limits: {
      accountRequired: false, seats: 1, relays: 3, liveRunsPerDay: 3, aiMinutesPerMonth: 10, overageUsdPerMin: null,
      dryRunsPerDay: 3, voicedSimsPerDay: 0, draftsPerDay: 1, livePublications: 1, publicationIdleHours: 24,
      httpAction: false, connectorHosts: 0, secrets: 3, secretTtlDays: 7, apiKeys: 0, apiKeyScopes: "none",
      apiRatePerMin: 0, webhookEndpoints: 0, auditRetentionDays: 7, analyticsDays: 7,
    },
  },
  free: {
    name: "Free", price: 0,
    limits: {
      accountRequired: true, seats: 3, relays: 5, liveRunsPerDay: 5, aiMinutesPerMonth: 15, overageUsdPerMin: null,
      dryRunsPerDay: 5, voicedSimsPerDay: 0, draftsPerDay: 3, livePublications: 1, publicationIdleHours: 72,
      httpAction: false, connectorHosts: 0, secrets: 5, secretTtlDays: 30, apiKeys: 2, apiKeyScopes: "build",
      apiRatePerMin: 60, webhookEndpoints: 0, auditRetentionDays: 7, analyticsDays: 30,
    },
  },
  pro: {
    name: "Pro", price: 49,
    limits: {
      accountRequired: true, seats: 10, relays: 50, liveRunsPerDay: 25, aiMinutesPerMonth: 150, overageUsdPerMin: 0.3,
      dryRunsPerDay: 30, voicedSimsPerDay: 2, draftsPerDay: 10, livePublications: 5, publicationIdleHours: null,
      httpAction: true, connectorHosts: 10, secrets: 50, secretTtlDays: null, apiKeys: 10, apiKeyScopes: "all",
      apiRatePerMin: 600, webhookEndpoints: 3, auditRetentionDays: 90, analyticsDays: 90,
    },
  },
  business: {
    name: "Business", price: 299,
    limits: {
      accountRequired: true, seats: 50, relays: 500, liveRunsPerDay: 100, aiMinutesPerMonth: 1000,
      overageUsdPerMin: 0.25, dryRunsPerDay: 100, voicedSimsPerDay: 5, draftsPerDay: 30, livePublications: 25,
      publicationIdleHours: null, httpAction: true, connectorHosts: 50, secrets: 200, secretTtlDays: null,
      apiKeys: 50, apiKeyScopes: "all", apiRatePerMin: 1200, webhookEndpoints: 10, auditRetentionDays: 365,
      analyticsDays: 365,
    },
  },
};

const PLAN_IDS = Object.keys(SPEC) as PlanId[];

describe("SAAS §4.1 plans as data", () => {
  it("has exactly the four plans, in order", () => {
    expect(Object.keys(PLANS)).toEqual(PLAN_IDS);
  });

  for (const id of PLAN_IDS) {
    it(`${id} matches §4.1`, () => {
      expect(PLANS[id].name).toBe(SPEC[id].name);
      expect(PLANS[id].priceUsdMonthly).toBe(SPEC[id].price);
      expect({ ...PLANS[id].limits }).toEqual(SPEC[id].limits);
    });
  }

  it("every plan defines every limit key (no undefined holes)", () => {
    const keys = Object.keys(SPEC.pro.limits).sort();
    for (const id of PLAN_IDS) expect(Object.keys(PLANS[id].limits).sort()).toEqual(keys);
  });

  it("overage is blocked below Pro and billed above it", () => {
    expect(PLANS.guest.limits.overageUsdPerMin).toBeNull();
    expect(PLANS.free.limits.overageUsdPerMin).toBeNull();
    expect(PLANS.pro.limits.overageUsdPerMin).toBe(0.3);
    expect(PLANS.business.limits.overageUsdPerMin).toBe(0.25);
  });

  it("the developer surface is free on every plan, and http_action is the Pro wedge", () => {
    expect(PLANS.guest.limits.httpAction).toBe(false);
    expect(PLANS.free.limits.httpAction).toBe(false);
    expect(PLANS.pro.limits.httpAction).toBe(true);
    expect(PLANS.free.limits.apiKeyScopes).toBe("build");
    expect(PLANS.pro.limits.apiKeyScopes).toBe("all");
  });

  it("only the guest plan runs without an account", () => {
    expect(PLANS.guest.limits.accountRequired).toBe(false);
    for (const id of ["free", "pro", "business"] as const) expect(PLANS[id].limits.accountRequired).toBe(true);
  });

  it("the numeric limits never decrease as the plan grows", () => {
    const order: PlanId[] = ["guest", "free", "pro", "business"];
    const keys = ["seats", "relays", "liveRunsPerDay", "aiMinutesPerMonth", "dryRunsPerDay", "voicedSimsPerDay",
      "draftsPerDay", "livePublications", "connectorHosts", "secrets", "apiKeys", "apiRatePerMin",
      "webhookEndpoints", "auditRetentionDays", "analyticsDays"] as const;
    for (const k of keys) {
      for (let i = 1; i < order.length; i++) {
        const prev = PLANS[order[i - 1]!].limits[k];
        const next = PLANS[order[i]!].limits[k];
        expect([k, order[i], next >= prev]).toEqual([k, order[i], true]);
      }
    }
  });

  it("PLANS is frozen, so nothing can raise a limit in place (overrides are per org, WP21)", () => {
    expect(Object.isFrozen(PLANS)).toBe(true);
    expect(Object.isFrozen(PLANS.pro.limits)).toBe(true);
  });
});

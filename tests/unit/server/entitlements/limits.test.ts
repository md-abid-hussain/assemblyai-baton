/**
 * WP21·1: `org_entitlements.overrides` applied to `PLANS` (SAAS §4.1).
 *
 * The property under test is narrow but load-bearing: **an override raises a limit and can never lower one.** An
 * override that could lower a limit would be an unauditable downgrade that no page explains and that §4.6's
 * non-destructive rules never run for — the one way the "PLANS is the single table" invariant could be broken
 * quietly. Everything else here is the `null`-means-unlimited bookkeeping that makes "raise only" well defined
 * for TTLs and for blocked overage.
 *
 * $0: pure data.
 */
import { describe, expect, it } from "vitest";

import { PLANS } from "@/core/contracts/v3/plans";
import { applyOverrides, LIMIT_NOUNS } from "@/server/entitlements/limits";

describe("applyOverrides", () => {
  it("returns the plan's own limits when there is nothing to apply", () => {
    expect(applyOverrides("free", null)).toBe(PLANS.free.limits);
    expect(applyOverrides("free", {})).toBe(PLANS.free.limits);
    expect(applyOverrides("pro", undefined)).toBe(PLANS.pro.limits);
  });

  it("raises a numeric limit", () => {
    const l = applyOverrides("free", { relays: 42 });
    expect(l.relays).toBe(42);
    // and nothing else moved
    expect(l.seats).toBe(PLANS.free.limits.seats);
    expect(l.apiKeys).toBe(PLANS.free.limits.apiKeys);
  });

  it("never lowers a numeric limit, however the override is written", () => {
    const l = applyOverrides("pro", { relays: 1, seats: 0, apiRatePerMin: -100 });
    expect(l.relays).toBe(PLANS.pro.limits.relays);
    expect(l.seats).toBe(PLANS.pro.limits.seats);
    expect(l.apiRatePerMin).toBe(PLANS.pro.limits.apiRatePerMin);
  });

  it("ignores junk: overrides are loose JSON written by an operator", () => {
    const l = applyOverrides("free", {
      relays: "500" as unknown,
      seats: Number.NaN,
      apiKeys: Infinity,
      nonsense: 9999,
    } as Record<string, unknown>);
    expect(l.relays).toBe(PLANS.free.limits.relays);
    expect(l.seats).toBe(PLANS.free.limits.seats);
    // Infinity is not finite, so it is not a number we will honour.
    expect(l.apiKeys).toBe(PLANS.free.limits.apiKeys);
    expect(l).not.toHaveProperty("nonsense");
  });

  it("`null` beats any number where null means 'no ceiling'", () => {
    const l = applyOverrides("free", { secretTtlDays: null, publicationIdleHours: null });
    expect(l.secretTtlDays).toBeNull();
    expect(l.publicationIdleHours).toBeNull();
  });

  it("a longer TTL is a raise; a shorter one is ignored; unlimited stays unlimited", () => {
    expect(applyOverrides("free", { secretTtlDays: 90 }).secretTtlDays).toBe(90);
    expect(applyOverrides("free", { secretTtlDays: 1 }).secretTtlDays).toBe(PLANS.free.limits.secretTtlDays);
    expect(applyOverrides("pro", { secretTtlDays: 5 }).secretTtlDays).toBeNull();
  });

  it("overage: a price is a raise over 'blocked', and a lower price is still a raise", () => {
    // Free blocks overage (null). Giving it a rate is strictly more than blocking it.
    expect(applyOverrides("free", { overageUsdPerMin: 0.3 }).overageUsdPerMin).toBe(0.3);
    // On Pro, a different rate is an operator's deliberate per-org price, not a limit to compare numerically.
    expect(applyOverrides("pro", { overageUsdPerMin: 0.25 }).overageUsdPerMin).toBe(0.25);
    // `null` would *block* overage, i.e. lower the entitlement, so it is ignored.
    expect(applyOverrides("pro", { overageUsdPerMin: null }).overageUsdPerMin).toBe(PLANS.pro.limits.overageUsdPerMin);
  });

  it("booleans and scopes move one way only", () => {
    expect(applyOverrides("free", { httpAction: true }).httpAction).toBe(true);
    expect(applyOverrides("pro", { httpAction: false }).httpAction).toBe(true);
    expect(applyOverrides("guest", { accountRequired: false }).accountRequired).toBe(false);
    expect(applyOverrides("free", { accountRequired: true }).accountRequired).toBe(true);

    expect(applyOverrides("free", { apiKeyScopes: "all" }).apiKeyScopes).toBe("all");
    expect(applyOverrides("pro", { apiKeyScopes: "build" }).apiKeyScopes).toBe("all");
    expect(applyOverrides("guest", { apiKeyScopes: "build" }).apiKeyScopes).toBe("build");
    expect(applyOverrides("pro", { apiKeyScopes: "nope" as unknown as "all" }).apiKeyScopes).toBe("all");
  });

  it("the result is frozen, so no caller can mutate the shared PLANS row through it", () => {
    const l = applyOverrides("free", { relays: 10 });
    expect(Object.isFrozen(l)).toBe(true);
    expect(PLANS.free.limits.relays).toBe(5);
  });

  it("every count limit has a human noun for the E_PLAN_LIMIT message", () => {
    for (const key of ["seats", "relays", "livePublications", "secrets", "apiKeys", "webhookEndpoints", "connectorHosts"]) {
      expect(LIMIT_NOUNS[key], key).toBeTruthy();
    }
  });
});

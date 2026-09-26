/**
 * WP21·1: the plan badge says the same thing on the server and in the browser (SAAS §4.6 step 5, §4.7).
 *
 * The badge is the **proof on screen** that the upgrade is real and that no real money moved — TASKS-v3 §17 I4
 * says outright that it, not an inbox, is what the video shows. It is therefore written twice: once for the API
 * (`badgeFor`) and once for a component that must render without importing a server module (`planBadgeText`).
 * Two copies of a sentence are fine; two copies that can drift are not, so this file is the join.
 *
 * $0: pure strings.
 */
import { describe, expect, it } from "vitest";

import { PLANS } from "@/core/contracts/v3/plans";
import type { PlanId } from "@/core/contracts/v3/identity";
import { planBadgeText, type PlanSource } from "@/components/billing/plan-notice";
import { badgeFor } from "@/server/billing/routes";

const PLAN_IDS = ["guest", "free", "pro", "business"] as const satisfies readonly PlanId[];
const SOURCES = ["default", "polar", "simulated", "admin"] as const satisfies readonly PlanSource[];

describe("the plan badge", () => {
  it("agrees for every plan × source pair", () => {
    for (const plan of PLAN_IDS) {
      for (const source of SOURCES) {
        expect(planBadgeText(plan, source), `${plan}/${source}`).toBe(badgeFor({ plan, source }));
      }
    }
  });

  it("says Test mode for a real sandbox subscription, and simulated for a simulated one", () => {
    expect(badgeFor({ plan: "pro", source: "polar" })).toBe("Pro · Test mode (Polar sandbox) — no real money");
    expect(badgeFor({ plan: "business", source: "polar" })).toBe(
      "Business · Test mode (Polar sandbox) — no real money",
    );
    expect(badgeFor({ plan: "pro", source: "simulated" })).toBe("Pro · simulated");
  });

  it("never claims a payment for a plan nobody paid for", () => {
    for (const plan of PLAN_IDS) {
      expect(badgeFor({ plan, source: "default" })).toBe(PLANS[plan].name);
    }
  });

  it("a paid badge always carries its 'no real money' or 'simulated' qualifier", () => {
    for (const plan of ["pro", "business"] as const) {
      for (const source of ["polar", "simulated"] as const) {
        expect(badgeFor({ plan, source })).toMatch(/no real money|simulated/);
      }
    }
  });
});

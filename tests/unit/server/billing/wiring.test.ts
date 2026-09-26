/**
 * QA-FIX (docs/notes/qa-fix.md): the billing mode the page reports is the one the buttons obey.
 *
 * The judge-path QA pass hit a complete dead end on a *correctly configured* deployment: the Billing page said
 * "Polar Sandbox (Test Mode)" and `GET /api/app/billing` reported `"mode":"polar"`, but "Upgrade to Pro"
 * redirected to the local simulated-checkout page, and confirming there was refused with *"Billing is configured
 * on this deployment; use the real checkout."* There was no path to Pro in either direction.
 *
 * Two causes, both fixed:
 *  1. **`registerBilling()` was never called** by anything (grep found only its own definition). It is the only
 *     thing that hands `getBilling()` the Better Auth `checkout` endpoint, so `getBilling()` always fell back to
 *     the simulated provider. `src/instrumentation.ts` now has a `[WIRE-BILLING]` step (covered in
 *     `tests/unit/platform/instrumentation.test.ts`).
 *  2. **The two sides read different things**: the page and `postCheckout` reported `billingMode()` (pure env),
 *     while the provider had degraded. They now both read `effectiveBillingMode()`.
 *
 * This file is the second half: with no DB and no network, the reported mode must track the provider.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EntitlementView } from "@/core/contracts/v3/plans";
import { PLANS } from "@/core/contracts/v3/plans";
import { billingMode } from "@/server/billing/config";
import { effectiveBillingMode, getBilling, registerBilling, resetBillingRegistration } from "@/server/billing/register";
import { billingViewOf } from "@/server/billing/routes";

const POLAR_ENV = {
  POLAR_ACCESS_TOKEN: ["polar", "oat", "w".repeat(24)].join("_"),
  POLAR_SERVER: "sandbox",
  POLAR_PRODUCT_PRO: "prod_pro_wiring",
  POLAR_PRODUCT_BUSINESS: "prod_biz_wiring",
} as const;

const view: EntitlementView = {
  orgId: "org_w1",
  plan: "free",
  status: "active",
  source: "default",
  limits: PLANS.free.limits,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  syncedAt: null,
};

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [k, v] of Object.entries(POLAR_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  saved.BILLING_MODE = process.env.BILLING_MODE;
  delete process.env.BILLING_MODE;
  resetBillingRegistration();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetBillingRegistration();
});

describe("effectiveBillingMode", () => {
  it("is simulated while the Polar plugin is not mounted, even though the environment says polar", () => {
    expect(billingMode()).toBe("polar"); // the environment is genuinely complete
    expect(getBilling().mode).toBe("simulated"); // …but nothing registered an auth api
    expect(effectiveBillingMode()).toBe("simulated");
  });

  it("becomes polar as soon as the checkout endpoint is registered", () => {
    registerBilling(() => ({ checkout: async () => ({ url: "https://sandbox.polar.sh/checkout/x" }) }));
    expect(effectiveBillingMode()).toBe("polar");
  });

  it("stays simulated when BILLING_MODE=simulated forces it (the K-BILL kill switch)", () => {
    registerBilling(() => ({ checkout: async () => ({ url: "https://sandbox.polar.sh/checkout/x" }) }));
    process.env.BILLING_MODE = "simulated";
    expect(effectiveBillingMode()).toBe("simulated");
  });
});

describe("the Billing page's reported mode", () => {
  it("matches the provider, so the simulated confirm is never refused on a page that offered it", () => {
    // Unmounted plugin: the page must say "simulated", which is the mode `postSimulatedConfirm` requires.
    expect(billingViewOf(view, true, false).mode).toBe("simulated");
    expect(billingViewOf(view, true, false).mode).toBe(effectiveBillingMode());

    registerBilling(() => ({ checkout: async () => ({ url: "https://sandbox.polar.sh/checkout/x" }) }));
    expect(billingViewOf(view, true, false).mode).toBe("polar");
    expect(billingViewOf(view, true, false).mode).toBe(effectiveBillingMode());
  });

  it("keeps the rest of the view untouched", () => {
    const v = billingViewOf(view, true, false);
    expect(v).toMatchObject({ orgId: "org_w1", plan: "free", planName: PLANS.free.name, canManage: true });
    expect(v.upgrades.map((u) => u.plan)).toEqual(["pro", "business"]);
  });
});

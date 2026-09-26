/**
 * WP21·1: which billing mode a deployment gets, and why (SAAS §4.3, §4.7).
 *
 * The rule this file pins down: **`polar` is never selected on a doubt.** A missing token, a missing product id,
 * or a `POLAR_SERVER` that is not `sandbox` all select `simulated`, and `BILLING_MODE` can force `simulated` but
 * cannot force `polar`. That asymmetry is the whole safety argument for running a live checkout in a demo — a
 * misconfigured deployment degrades to a labelled simulation instead of pointing a card form at production.
 *
 * $0: pure environment reading, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appPath, billingMissing, billingMode, isPaidPlan, isSandbox, PAID_PLANS, planForOrgKind, productList,
} from "@/server/billing/config";

const NAMES = [
  "POLAR_ACCESS_TOKEN", "POLAR_SERVER", "POLAR_PRODUCT_PRO", "POLAR_PRODUCT_BUSINESS", "BILLING_MODE", "APP_URL",
] as const;

let saved: Record<string, string | undefined>;

/** A token-shaped value built at runtime: no credential-shaped literal is ever written in this repo. */
const FAKE_TOKEN = ["polar", "oat", "z".repeat(24)].join("_");

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Everything Polar needs, present and sane. */
function configure(): void {
  process.env.POLAR_ACCESS_TOKEN = FAKE_TOKEN;
  process.env.POLAR_SERVER = "sandbox";
  process.env.POLAR_PRODUCT_PRO = "prod_pro_1";
  process.env.POLAR_PRODUCT_BUSINESS = "prod_biz_1";
}

describe("billingMode", () => {
  it("is simulated with nothing configured, and says which names are missing", () => {
    expect(billingMode()).toBe("simulated");
    expect(billingMissing()).toEqual(["POLAR_ACCESS_TOKEN", "POLAR_PRODUCT_PRO", "POLAR_PRODUCT_BUSINESS"]);
  });

  it("is polar only when the token, both product ids and the sandbox server are all present", () => {
    configure();
    expect(billingMissing()).toEqual([]);
    expect(billingMode()).toBe("polar");
  });

  it("a missing product id alone is enough to fall back", () => {
    configure();
    delete process.env.POLAR_PRODUCT_BUSINESS;
    expect(billingMode()).toBe("simulated");
    expect(billingMissing()).toEqual(["POLAR_PRODUCT_BUSINESS"]);
  });

  it("POLAR_SERVER=production disables billing rather than enabling it", () => {
    configure();
    process.env.POLAR_SERVER = "production";
    expect(isSandbox()).toBe(false);
    expect(billingMode()).toBe("simulated");
    expect(billingMissing()).toContain("POLAR_SERVER=sandbox");
  });

  it("an unset POLAR_SERVER defaults to sandbox", () => {
    configure();
    delete process.env.POLAR_SERVER;
    expect(isSandbox()).toBe(true);
    expect(billingMode()).toBe("polar");
  });

  it("BILLING_MODE can force simulated (K-BILL) but cannot force polar", () => {
    configure();
    process.env.BILLING_MODE = "simulated";
    expect(billingMode()).toBe("simulated");

    delete process.env.BILLING_MODE;
    delete process.env.POLAR_ACCESS_TOKEN;
    process.env.BILLING_MODE = "polar";
    expect(billingMode()).toBe("simulated");
  });
});

describe("products and paths", () => {
  it("productList drops the plans that have no id, keeping slug → productId", () => {
    process.env.POLAR_PRODUCT_PRO = "prod_pro_1";
    expect(productList()).toEqual([{ productId: "prod_pro_1", slug: "pro" }]);
    process.env.POLAR_PRODUCT_BUSINESS = "prod_biz_1";
    expect(productList()).toEqual([
      { productId: "prod_pro_1", slug: "pro" },
      { productId: "prod_biz_1", slug: "business" },
    ]);
  });

  it("appPath is relative without APP_URL and absolute with it, with no double slash", () => {
    expect(appPath("/app/settings/billing")).toBe("/app/settings/billing");
    process.env.APP_URL = "https://app.example.test/";
    expect(appPath("/app/settings/billing")).toBe("https://app.example.test/app/settings/billing");
  });

  it("only pro and business are purchasable", () => {
    expect([...PAID_PLANS]).toEqual(["pro", "business"]);
    expect(isPaidPlan("pro")).toBe(true);
    expect(isPaidPlan("business")).toBe(true);
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan("guest")).toBe(false);
    expect(isPaidPlan(undefined)).toBe(false);
  });

  it("an org with nothing bought follows its kind (SAAS §4.4 rule 1)", () => {
    expect(planForOrgKind("guest")).toBe("guest");
    expect(planForOrgKind("personal")).toBe("free");
    expect(planForOrgKind("team")).toBe("free");
    expect(planForOrgKind(null)).toBe("free");
  });
});

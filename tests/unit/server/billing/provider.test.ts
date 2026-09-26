/**
 * WP21·1 acceptance, against a real Postgres (SAAS §4.3, §4.4, §4.6, §4.7).
 *
 * The five acceptance items of TASKS-v3 §7 WP21·1, and where each one is covered:
 *
 * | # | Acceptance | Covered by |
 * |---|---|---|
 * | 1 | a sandbox upgrade → `pro` within 20 s | "the upgrade" (the mechanism; the live 4242 run is K-BILL) |
 * | 2 | a forged `referenceId` or a non-owner payer is refused | "a checkout that is not ours" |
 * | 3 | a Polar error keeps the last plan | "fail-static" |
 * | 4 | simulated mode works end to end and is labelled | "simulated mode" |
 * | 5 | anonymous users never create Polar customers | "anonymous users" |
 *
 * **How it points at a throwaway database.** `getDb()` memoizes a pool from `DATABASE_URL`, so the variable is
 * repointed at the fresh database *before* any billing module is imported, and every import happens inside
 * `beforeAll`. Vitest isolates each file in its own worker, so this cannot leak into another suite.
 *
 * **No network at all.** `PolarBillingDeps` is injected, so the "Polar" in these tests is three functions. The
 * one real sandbox call this unit makes is the token-scope probe recorded in `docs/notes/wp21.md`. $0.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";

const APP_URL = "https://app.example.test";
const PRO_PRODUCT = "prod_pro_test";
const BIZ_PRODUCT = "prod_biz_test";
/** A token-shaped value built at runtime: no credential-shaped literal is ever written in this repo. */
const FAKE_TOKEN = ["polar", "oat", "t".repeat(24)].join("_");

type Mod = {
  provider: typeof import("@/server/billing/provider");
  routes: typeof import("@/server/billing/routes");
  config: typeof import("@/server/billing/config");
  store: typeof import("@/server/entitlements/store");
  ports: typeof import("@/server/saas/ports");
  db: typeof import("@/server/db/client");
  schemaAuth: typeof import("@/server/db/schema-auth");
  schemaSaas: typeof import("@/server/db/schema-saas");
  drizzle: typeof import("drizzle-orm");
};

let t: TestDb;
let m: Mod;
let audit: ReturnType<Mod["ports"]["createMemoryAuditWriter"]>;

/** Calls the fake Polar made, so a test can assert that a refused path never reached the provider. */
interface Calls {
  checkout: { slug: string; referenceId: string }[];
  state: string[];
  getCheckout: string[];
}
let calls: Calls;

/** What the fake `customers.getStateExternal` returns; a test sets it per case. */
let stateResponse: unknown;
/** When set, the fake `customers.getStateExternal` throws it instead (the §4.4 fail-static case). */
let stateError: Error | null;
/** What the fake `checkouts.get` returns. */
let checkoutResponse: unknown;

function deps(): import("@/server/billing/provider").PolarBillingDeps {
  return {
    async checkout(a) {
      calls.checkout.push(a.body);
      return { url: `https://sandbox.polar.sh/checkout/${a.body.slug}` };
    },
    async customerState(externalId) {
      calls.state.push(externalId);
      if (stateError) throw stateError;
      return stateResponse;
    },
    async getCheckout(id) {
      calls.getCheckout.push(id);
      return checkoutResponse;
    },
  };
}

/** One active subscription, in the SDK's camelCase shape. */
const sub = (o: { productId?: string; referenceId?: string | null; status?: string; cancel?: boolean } = {}) => ({
  id: "sub_1",
  productId: o.productId ?? PRO_PRODUCT,
  status: o.status ?? "active",
  currentPeriodEnd: new Date("2026-10-26T00:00:00.000Z"),
  cancelAtPeriodEnd: o.cancel ?? false,
  metadata: o.referenceId === null ? {} : { referenceId: o.referenceId ?? "" },
});

const stateWith = (subs: unknown[]) => ({ id: "cus_1", externalId: "user_owner", activeSubscriptions: subs });

let seq = 0;
/** A user, an org, its owner membership, `org_meta` and an `org_entitlements` row — what `createOrg` writes. */
async function makeOrg(o: { kind?: "guest" | "personal" | "team"; plan?: "guest" | "free" | "pro" } = {}) {
  const n = ++seq;
  const userId = `user_${n}`;
  const orgId = `org_${n}`;
  const db = m.db.getDb();
  await db.insert(m.schemaAuth.users).values({ id: userId, name: `Owner ${n}`, email: `owner${n}@example.test` });
  await db.insert(m.schemaAuth.organizations).values({ id: orgId, name: `Org ${n}`, slug: `org-${n}`, createdAt: new Date() });
  await db.insert(m.schemaAuth.members).values({ id: `mem_${n}`, organizationId: orgId, userId, role: "owner", createdAt: new Date() });
  await db.insert(m.schemaSaas.orgMeta).values({ orgId, kind: o.kind ?? "team", createdVia: "onboarding" });
  await db.insert(m.schemaSaas.orgEntitlements).values({
    orgId, plan: o.plan ?? "free", status: "active", source: "default", overrides: {},
  });
  return { userId, orgId };
}

/** Point `billing_user_id` at a user, which is what `startCheckout` does in production. */
async function setBillingUser(orgId: string, userId: string | null): Promise<void> {
  await m.db
    .getDb()
    .update(m.schemaSaas.orgEntitlements)
    .set({ billingUserId: userId })
    .where(m.drizzle.eq(m.schemaSaas.orgEntitlements.orgId, orgId));
}

const actionsFor = (orgId: string): string[] =>
  audit.entries.filter((e) => e.orgId === orgId).map((e) => e.action);

async function caught(fn: () => Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await fn();
  } catch (e) {
    const err = e as { code?: string; status?: number };
    return { code: err.code ?? String(e), status: err.status ?? 0 };
  }
  throw new Error("expected this call to throw a SaasError, but it resolved");
}

describe.skipIf(!HAS_DB)("WP21·1 billing", () => {
  beforeAll(async () => {
    t = await createTestDb("wp21_billing");

    // Repoint the environment, then import. Order matters: see the file header.
    process.env.DATABASE_URL = t.url;
    process.env.APP_URL = APP_URL;
    process.env.POLAR_ACCESS_TOKEN = FAKE_TOKEN;
    process.env.POLAR_SERVER = "sandbox";
    process.env.POLAR_PRODUCT_PRO = PRO_PRODUCT;
    process.env.POLAR_PRODUCT_BUSINESS = BIZ_PRODUCT;
    delete process.env.BILLING_MODE;
    (await import("@/server/env")).resetEnvCache();

    m = {
      provider: await import("@/server/billing/provider"),
      routes: await import("@/server/billing/routes"),
      config: await import("@/server/billing/config"),
      store: await import("@/server/entitlements/store"),
      ports: await import("@/server/saas/ports"),
      db: await import("@/server/db/client"),
      schemaAuth: await import("@/server/db/schema-auth"),
      schemaSaas: await import("@/server/db/schema-saas"),
      drizzle: await import("drizzle-orm"),
    };
  }, 60_000);

  afterAll(async () => {
    await m?.db.closeDb().catch(() => undefined);
    await t?.drop();
  });

  beforeEach(() => {
    m.ports.resetSaasPorts();
    audit = m.ports.createMemoryAuditWriter();
    m.ports.setAuditWriter(audit);
    m.ports.setEntitlements(m.store.createDbEntitlements());
    calls = { checkout: [], state: [], getCheckout: [] };
    stateResponse = stateWith([]);
    stateError = null;
    checkoutResponse = { id: "chk_1", metadata: {} };
  });

  // -------------------------------------------------------------------------------------- acceptance 1

  describe("the upgrade", () => {
    it("checkout is created for the principal's org and audited, and billing_user_id is the caller", async () => {
      const { orgId, userId } = await makeOrg();
      const billing = m.provider.createPolarBilling(deps());
      const { url } = await billing.startCheckout({ orgId, userId, plan: "pro", headers: new Headers() });

      expect(url).toContain("sandbox.polar.sh");
      // §10.1 rule 3: the org in the checkout is the principal's, not anything the caller sent.
      expect(calls.checkout).toEqual([{ slug: "pro", referenceId: orgId }]);
      expect((await m.store.readRow(orgId)).billingUserId).toBe(userId);
      expect(actionsFor(orgId)).toEqual(["billing.checkout_started"]);
    });

    it("the checkout return syncs the org to pro, with the Test-mode badge and a plan_changed row", async () => {
      const { orgId, userId } = await makeOrg();
      await setBillingUser(orgId, userId);
      stateResponse = stateWith([sub({ referenceId: orgId })]);
      checkoutResponse = { id: "chk_1", metadata: { referenceId: orgId } };

      const view = await m.provider.createPolarBilling(deps()).syncCheckout("chk_1", orgId, userId);

      expect(view.plan).toBe("pro");
      expect(view.source).toBe("polar");
      expect(view.status).toBe("active");
      expect(view.limits.relays).toBe(50);
      expect(view.limits.httpAction).toBe(true);
      expect(view.currentPeriodEnd).toBe("2026-10-26T00:00:00.000Z");
      expect(m.routes.badgeFor(view)).toBe("Pro · Test mode (Polar sandbox) — no real money");
      expect(actionsFor(orgId)).toEqual(["billing.plan_changed"]);
    });

    it("re-syncing an unchanged plan writes no second plan_changed row", async () => {
      const { orgId, userId } = await makeOrg();
      await setBillingUser(orgId, userId);
      stateResponse = stateWith([sub({ referenceId: orgId })]);
      const billing = m.provider.createPolarBilling(deps());
      await billing.syncOrg(orgId);
      await billing.syncOrg(orgId);
      expect(actionsFor(orgId)).toEqual(["billing.plan_changed"]);
    });

    it("upgrading an org that is already on that plan is a 409, and never reaches Polar", async () => {
      const { orgId, userId } = await makeOrg();
      await setBillingUser(orgId, userId);
      stateResponse = stateWith([sub({ referenceId: orgId })]);
      const billing = m.provider.createPolarBilling(deps());
      await billing.syncOrg(orgId);
      calls.checkout = [];

      const err = await caught(() => billing.startCheckout({ orgId, userId, plan: "pro", headers: new Headers() }));
      expect(err).toEqual({ code: "E_CONFLICT", status: 409 });
      expect(calls.checkout).toEqual([]);
    });

    it("a subscription on a product we do not recognise is not an upgrade", async () => {
      const { orgId, userId } = await makeOrg();
      await setBillingUser(orgId, userId);
      stateResponse = stateWith([sub({ productId: "prod_someone_elses", referenceId: orgId })]);
      const view = await m.provider.createPolarBilling(deps()).syncOrg(orgId);
      expect(view.plan).toBe("free");
      expect(actionsFor(orgId)).toEqual([]);
    });

    it("cancel-at-period-end is carried through for the §4.6 banner", async () => {
      const { orgId, userId } = await makeOrg();
      await setBillingUser(orgId, userId);
      stateResponse = stateWith([sub({ referenceId: orgId, cancel: true })]);
      const view = await m.provider.createPolarBilling(deps()).syncOrg(orgId);
      expect(view.plan).toBe("pro");
      expect(view.cancelAtPeriodEnd).toBe(true);
    });

    it("a revoked subscription drops the org back to free, non-destructively and audited", async () => {
      const { orgId, userId } = await makeOrg();
      await setBillingUser(orgId, userId);
      stateResponse = stateWith([sub({ referenceId: orgId })]);
      const billing = m.provider.createPolarBilling(deps());
      await billing.syncOrg(orgId);

      stateResponse = stateWith([]);
      const view = await billing.syncOrg(orgId);
      expect(view.plan).toBe("free");
      expect(actionsFor(orgId)).toEqual(["billing.plan_changed", "billing.plan_changed"]);
    });
  });

  // -------------------------------------------------------------------------------------- acceptance 2

  describe("a checkout that is not ours", () => {
    it("a checkout whose referenceId is another org is refused with 403, and nothing is written", async () => {
      const a = await makeOrg();
      const b = await makeOrg();
      await setBillingUser(a.orgId, a.userId);
      checkoutResponse = { id: "chk_x", metadata: { referenceId: b.orgId } };
      stateResponse = stateWith([sub({ referenceId: b.orgId })]);

      const err = await caught(() =>
        m.provider.createPolarBilling(deps()).syncCheckout("chk_x", a.orgId, a.userId),
      );
      expect(err).toEqual({ code: "E_FORBIDDEN", status: 403 });
      expect((await m.store.readRow(a.orgId)).plan).toBe("free");
      expect(calls.state).toEqual([]);
    });

    it("a payer who is not an owner of the org is refused, even with the right checkout", async () => {
      const { orgId, userId } = await makeOrg();
      await setBillingUser(orgId, userId);
      const outsider = await makeOrg();
      checkoutResponse = { id: "chk_1", metadata: { referenceId: orgId } };

      const err = await caught(() =>
        m.provider.createPolarBilling(deps()).syncCheckout("chk_1", orgId, outsider.userId),
      );
      expect(err).toEqual({ code: "E_FORBIDDEN", status: 403 });
      expect((await m.store.readRow(orgId)).plan).toBe("free");
    });

    it("a member (not an owner) of the org is refused too: billing:manage is owner-only", async () => {
      const { orgId, userId } = await makeOrg();
      const other = await makeOrg();
      await m.db.getDb().insert(m.schemaAuth.members).values({
        id: `mem_member_${orgId}`, organizationId: orgId, userId: other.userId, role: "member", createdAt: new Date(),
      });
      await setBillingUser(orgId, userId);
      checkoutResponse = { id: "chk_1", metadata: { referenceId: orgId } };

      const err = await caught(() =>
        m.provider.createPolarBilling(deps()).syncCheckout("chk_1", orgId, other.userId),
      );
      expect(err).toEqual({ code: "E_FORBIDDEN", status: 403 });
    });

    it("another org's subscription inside our own customer state never entitles us", async () => {
      const a = await makeOrg();
      const b = await makeOrg();
      await setBillingUser(a.orgId, a.userId);
      // One customer, two orgs: only the subscription labelled for `a` may count for `a`.
      stateResponse = stateWith([sub({ referenceId: b.orgId }), { ...sub({ referenceId: b.orgId }), id: "sub_2" }]);
      const view = await m.provider.createPolarBilling(deps()).syncOrg(a.orgId);
      expect(view.plan).toBe("free");
    });

    it("several unlabelled subscriptions are never guessed at; exactly one is the documented fallback", async () => {
      const a = await makeOrg();
      await setBillingUser(a.orgId, a.userId);
      const billing = m.provider.createPolarBilling(deps());

      stateResponse = stateWith([sub({ referenceId: null }), { ...sub({ referenceId: null }), id: "sub_2" }]);
      expect((await billing.syncOrg(a.orgId)).plan).toBe("free");

      // The §16 fallback: Customer State without metadata, and only one candidate.
      stateResponse = stateWith([sub({ referenceId: null })]);
      expect((await billing.syncOrg(a.orgId)).plan).toBe("pro");
    });
  });

  // -------------------------------------------------------------------------------------- acceptance 3

  describe("fail-static", () => {
    it("a Polar error keeps the last confirmed plan and never grants a higher one", async () => {
      const { orgId, userId } = await makeOrg();
      await setBillingUser(orgId, userId);
      stateResponse = stateWith([sub({ referenceId: orgId })]);
      const billing = m.provider.createPolarBilling(deps());
      await billing.syncOrg(orgId);
      expect((await m.store.readRow(orgId)).plan).toBe("pro");

      stateError = new Error("polar is down");
      const err = await caught(() => billing.syncOrg(orgId));
      expect(err).toEqual({ code: "E_BILLING_UNAVAILABLE", status: 503 });
      // The row is untouched: still Pro, still `polar`.
      const row = await m.store.readRow(orgId);
      expect(row.plan).toBe("pro");
      expect(row.source).toBe("polar");
    });

    it("`Entitlements.refresh` swallows the error and returns the last known view", async () => {
      const { orgId, userId } = await makeOrg();
      await setBillingUser(orgId, userId);
      stateResponse = stateWith([sub({ referenceId: orgId })]);
      const billing = m.provider.createPolarBilling(deps());
      await billing.syncOrg(orgId);

      m.store.setEntitlementRefresher(async (id) => void (await billing.syncOrg(id)));
      stateError = new Error("polar is down");
      const view = await m.ports.getEntitlements().refresh(orgId, "test");
      expect(view.plan).toBe("pro");
      m.store.setEntitlementRefresher(null);
    });

    it("a failed checkout is E_BILLING_UNAVAILABLE, and the plan is unchanged", async () => {
      const { orgId, userId } = await makeOrg();
      const d = deps();
      d.checkout = async () => {
        throw new Error("polar is down");
      };
      const err = await caught(() =>
        m.provider.createPolarBilling(d).startCheckout({ orgId, userId, plan: "pro", headers: new Headers() }),
      );
      expect(err).toEqual({ code: "E_BILLING_UNAVAILABLE", status: 503 });
      expect((await m.store.readRow(orgId)).plan).toBe("free");
      expect(actionsFor(orgId)).toEqual([]);
    });

    it("an org that never bought anything is not looked up in Polar at all", async () => {
      const { orgId } = await makeOrg();
      const view = await m.provider.createPolarBilling(deps()).syncOrg(orgId);
      expect(view.plan).toBe("free");
      expect(calls.state).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------- acceptance 4

  describe("simulated mode", () => {
    it("checkout goes to the labelled local page, and confirming applies the plan with source=simulated", async () => {
      const { orgId, userId } = await makeOrg();
      const billing = m.provider.createSimulatedBilling();
      const { url } = await billing.startCheckout({ orgId, userId, plan: "pro", headers: new Headers() });
      expect(url).toBe(`${APP_URL}/app/settings/billing/simulated-checkout?plan=pro`);

      const view = await m.provider.confirmSimulated(orgId, userId, "pro");
      expect(view.plan).toBe("pro");
      expect(view.source).toBe("simulated");
      expect(m.routes.badgeFor(view)).toBe("Pro · simulated");
      expect(actionsFor(orgId)).toEqual(["billing.plan_changed"]);
    });

    it("the simulated plan drives the real limits, so everything downstream behaves identically", async () => {
      const { orgId, userId } = await makeOrg();
      await m.provider.confirmSimulated(orgId, userId, "business");
      const view = await m.ports.getEntitlements().get(orgId);
      expect(view.plan).toBe("business");
      expect(view.limits.relays).toBe(500);
      expect(view.limits.webhookEndpoints).toBe(10);
      expect(view.limits.apiKeyScopes).toBe("all");
    });

    it("a plan that is not purchasable is refused, in either mode", async () => {
      const { orgId, userId } = await makeOrg();
      const bad = { orgId, userId, plan: "free" as unknown as "pro", headers: new Headers() };
      expect((await caught(() => m.provider.createSimulatedBilling().startCheckout(bad))).code).toBe("E_UNPROCESSABLE");
      expect((await caught(() => m.provider.createPolarBilling(deps()).startCheckout(bad))).code).toBe("E_UNPROCESSABLE");
    });
  });

  // -------------------------------------------------------------------------------------- acceptance 5

  describe("anonymous users", () => {
    it("the plugin config keeps createCustomerOnSignUp off and checkout authenticated-only", async () => {
      // Read the shipped configuration rather than trusting the comment above it: these two settings *are*
      // acceptance 5, and a later edit that flips either one has to fail a test.
      const src = await import("node:fs").then((fs) =>
        fs.readFileSync("src/server/billing/polar-plugin.ts", "utf8"),
      );
      expect(src).toMatch(/createCustomerOnSignUp:\s*false/);
      expect(src).toMatch(/authenticatedUsersOnly:\s*true/);
    });

    it("a guest workspace reads as the guest plan and is never given a billing user", async () => {
      const { orgId } = await makeOrg({ kind: "guest", plan: "guest" });
      const view = await m.ports.getEntitlements().get(orgId);
      expect(view.plan).toBe("guest");
      expect(view.limits.accountRequired).toBe(false);
      expect((await m.store.readRow(orgId)).billingUserId).toBeNull();
      expect(calls.state).toEqual([]);
    });

    it("a legacy ws_<visitorId> workspace with no row at all reads as a guest, without touching Polar", async () => {
      const view = await m.ports.getEntitlements().get("ws_visitor123");
      expect(view.plan).toBe("guest");
      expect(view.source).toBe("default");
      expect(view.limits.relays).toBe(3);
    });
  });

  // ------------------------------------------------------------------------------------------- the store

  describe("the DB entitlements", () => {
    it("assertCount throws E_PLAN_LIMIT with the numbers the UI needs", async () => {
      const { orgId } = await makeOrg();
      m.ports.setOrgCounter("relays", () => 5);
      const err = await caught(() => m.ports.getEntitlements().assertCount(orgId, "relays"));
      expect(err).toEqual({ code: "E_PLAN_LIMIT", status: 402 });
    });

    it("an override raises the limit the check uses, and survives a sync", async () => {
      const { orgId, userId } = await makeOrg();
      await m.db
        .getDb()
        .update(m.schemaSaas.orgEntitlements)
        .set({ overrides: { relays: 25 }, billingUserId: userId })
        .where(m.drizzle.eq(m.schemaSaas.orgEntitlements.orgId, orgId));

      m.ports.setOrgCounter("relays", () => 5);
      await expect(m.ports.getEntitlements().assertCount(orgId, "relays")).resolves.toBeUndefined();

      stateResponse = stateWith([sub({ referenceId: orgId })]);
      await m.provider.createPolarBilling(deps()).syncOrg(orgId);
      const row = await m.store.readRow(orgId);
      expect(row.plan).toBe("pro");
      expect(row.overrides).toEqual({ relays: 25 });
    });

    it("checkRate reads the meter and never blends simulated minutes into the allowance", async () => {
      const { orgId } = await makeOrg();
      const meter = m.ports.createMemoryUsageMeter();
      m.ports.setUsageMeter(meter);
      await meter.record({
        orgId, kind: "ai_minutes", quantity: 14, source: "simulated",
        idempotencyKey: "ai_minutes:sim1",
      });
      expect(await m.ports.getEntitlements().checkRate(orgId, "aiMinutesPerMonth", 1)).toEqual({
        ok: true, used: 0, limit: 15,
      });

      await meter.record({
        orgId, kind: "ai_minutes", quantity: 15, source: "recorded",
        idempotencyKey: "ai_minutes:rec1",
      });
      expect(await m.ports.getEntitlements().checkRate(orgId, "aiMinutesPerMonth", 1)).toEqual({
        ok: false, used: 15, limit: 15,
      });
    });
  });

  // -------------------------------------------------------------------------------------------- the view

  describe("the billing view", () => {
    it("names the upgrades available from each plan, and none from Business", async () => {
      const { orgId, userId } = await makeOrg();
      const free = m.routes.billingViewOf(await m.ports.getEntitlements().get(orgId), true, false);
      expect(free.upgrades.map((u) => u.plan)).toEqual(["pro", "business"]);
      expect(free.upgrades[0]).toMatchObject({ name: "Pro", priceUsdMonthly: 49 });

      await m.provider.confirmSimulated(orgId, userId, "pro");
      const pro = m.routes.billingViewOf(await m.ports.getEntitlements().get(orgId), true, false);
      expect(pro.upgrades.map((u) => u.plan)).toEqual(["business"]);

      await m.provider.confirmSimulated(orgId, userId, "business");
      const biz = m.routes.billingViewOf(await m.ports.getEntitlements().get(orgId), true, false);
      expect(biz.upgrades).toEqual([]);
    });

    it("a Billing page load re-syncs only when the row is stale (SAAS §4.4)", () => {
      const now = Date.parse("2026-09-26T12:00:00.000Z");
      expect(m.routes.isStale(null, now)).toBe(true);
      expect(m.routes.isStale("2026-09-26T11:59:30.000Z", now)).toBe(false);
      expect(m.routes.isStale("2026-09-26T11:58:00.000Z", now)).toBe(true);
    });
  });
});

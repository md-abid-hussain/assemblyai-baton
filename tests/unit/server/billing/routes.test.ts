/**
 * WP21·1: the `/api/app/billing/**` routes (SAAS §4.3, §4.6, §4.7, §10.1).
 *
 * The three things a route test can prove that a provider test cannot:
 *  1. **every route resolves its org through `requirePrincipal`** and never from the request — a body carrying
 *     `orgId` or `referenceId` changes nothing;
 *  2. a **guest** clicking Upgrade gets `E_ACCOUNT_REQUIRED` (the §4.6 step-2 wall), not an anonymous Polar
 *     customer and not a raw Polar error;
 *  3. the errors come back in the §6.3 envelope with the right status, which is what the page renders.
 *
 * The principal is stubbed through the port registry rather than by mounting Better Auth: the resolver's own
 * behaviour is WP19's suite, and re-testing it here would only couple two units' tests together. $0.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Principal } from "@/core/contracts/v3/identity";
import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";

const APP_URL = "https://app.example.test";
const PRO_PRODUCT = "prod_pro_routes";
const BIZ_PRODUCT = "prod_biz_routes";
const FAKE_TOKEN = ["polar", "oat", "r".repeat(24)].join("_");

type Mod = {
  routes: typeof import("@/server/billing/routes");
  register: typeof import("@/server/billing/register");
  provider: typeof import("@/server/billing/provider");
  store: typeof import("@/server/entitlements/store");
  ports: typeof import("@/server/saas/ports");
  principal: typeof import("@/server/saas/principal");
  identity: typeof import("@/server/identity");
  db: typeof import("@/server/db/client");
  schemaAuth: typeof import("@/server/db/schema-auth");
  schemaSaas: typeof import("@/server/db/schema-saas");
};

let t: TestDb;
let m: Mod;

let seq = 0;
async function makeOrg(o: { kind?: "guest" | "personal" | "team" } = {}) {
  const n = ++seq;
  const userId = `user_r${n}`;
  const orgId = `org_r${n}`;
  const db = m.db.getDb();
  await db.insert(m.schemaAuth.users).values({ id: userId, name: `Owner ${n}`, email: `owner-r${n}@example.test` });
  await db.insert(m.schemaAuth.organizations).values({ id: orgId, name: `Org ${n}`, slug: `org-r${n}`, createdAt: new Date() });
  await db.insert(m.schemaAuth.members).values({ id: `mem_r${n}`, organizationId: orgId, userId, role: "owner", createdAt: new Date() });
  await db.insert(m.schemaSaas.orgMeta).values({ orgId, kind: o.kind ?? "team", createdVia: "onboarding" });
  await db.insert(m.schemaSaas.orgEntitlements).values({
    orgId, plan: o.kind === "guest" ? "guest" : "free", status: "active", source: "default", overrides: {},
  });
  return { userId, orgId };
}

/** The principal the stubbed resolver hands back, with the §2.3 `need` rules still applied on top. */
function principal(o: Partial<Principal> = {}): Principal {
  return {
    kind: "session", userId: "user_r1", isAnonymous: false, orgId: "org_r1", orgKind: "team", role: "owner",
    scopes: [], apiKeyId: null, plan: "free", visitorId: "vid_test", ipKey: "ip_test", requestId: "req_test",
    ...o,
  };
}

function stubPrincipal(p: Principal): void {
  m.ports.setPrincipalResolver({
    async resolve(req, need) {
      return m.principal.applyNeed(p, need, req);
    },
  });
}

const req = (path: string, init: RequestInit = {}): Request =>
  new Request(`${APP_URL}${path}`, {
    ...init,
    headers: new Headers({ origin: APP_URL, "content-type": "application/json", ...(init.headers as object) }),
  });

/** A `Response` body can be read once, so it is cached per response: several assertions per call are normal. */
const bodies = new WeakMap<Response, Promise<Record<string, unknown>>>();
const body = (r: Response): Promise<Record<string, unknown>> => {
  let p = bodies.get(r);
  if (!p) {
    p = r.json().then((v) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}));
    bodies.set(r, p);
  }
  return p;
};
const codeOf = async (r: Response): Promise<string> =>
  ((await body(r)).error as { code?: string } | undefined)?.code ?? "";

describe.skipIf(!HAS_DB)("WP21·1 billing routes", () => {
  beforeAll(async () => {
    t = await createTestDb("wp21_routes");
    process.env.DATABASE_URL = t.url;
    process.env.APP_URL = APP_URL;
    process.env.POLAR_SERVER = "sandbox";
    delete process.env.POLAR_ACCESS_TOKEN;
    delete process.env.POLAR_PRODUCT_PRO;
    delete process.env.POLAR_PRODUCT_BUSINESS;
    delete process.env.BILLING_MODE;
    (await import("@/server/env")).resetEnvCache();

    m = {
      routes: await import("@/server/billing/routes"),
      register: await import("@/server/billing/register"),
      provider: await import("@/server/billing/provider"),
      store: await import("@/server/entitlements/store"),
      ports: await import("@/server/saas/ports"),
      principal: await import("@/server/saas/principal"),
      identity: await import("@/server/identity"),
      db: await import("@/server/db/client"),
      schemaAuth: await import("@/server/db/schema-auth"),
      schemaSaas: await import("@/server/db/schema-saas"),
    };
    // Run the handlers' one-time `installIdentity()` here, so the per-test stub below is not overwritten by it.
    m.identity.installIdentity();
  }, 60_000);

  afterAll(async () => {
    await m?.db.closeDb().catch(() => undefined);
    await t?.drop();
  });

  beforeEach(() => {
    m.ports.resetSaasPorts();
    m.ports.setAuditWriter(m.ports.createMemoryAuditWriter());
    m.ports.setEntitlements(m.store.createDbEntitlements());
    m.register.registerBilling(() => null);
  });

  describe("GET /api/app/billing", () => {
    it("returns the org's plan, its limits and the simulated badge", async () => {
      const { orgId } = await makeOrg();
      stubPrincipal(principal({ orgId }));
      const res = await m.routes.getBillingState(req("/api/app/billing"));
      expect(res.status).toBe(200);
      const v = await body(res);
      expect(v).toMatchObject({ orgId, plan: "free", planName: "Free", mode: "simulated", canManage: true });
      expect((v.limits as { relays: number }).relays).toBe(5);
      expect(v.badge).toBe("Free");
    });

    it("a visitor with no org gets 401 with the /start path, not a crash", async () => {
      stubPrincipal(principal({ kind: "visitor", userId: null, orgId: null, role: null }));
      const res = await m.routes.getBillingState(req("/api/app/billing"));
      expect(res.status).toBe(401);
      expect(await codeOf(res)).toBe("E_AUTH_REQUIRED");
      expect((await body(res)).start).toContain("/start?next=");
    });

    it("an admin sees the plan but not the buttons: billing:read yes, billing:manage no (§3.7)", async () => {
      const { orgId } = await makeOrg();
      stubPrincipal(principal({ orgId, role: "admin" }));
      const res = await m.routes.getBillingState(req("/api/app/billing"));
      expect(res.status).toBe(200);
      expect((await body(res)).canManage).toBe(false);
    });

    it("a member or a viewer has no billing:read at all (Usage is their page, §4.5)", async () => {
      const { orgId } = await makeOrg();
      for (const role of ["member", "viewer"] as const) {
        stubPrincipal(principal({ orgId, role }));
        const res = await m.routes.getBillingState(req("/api/app/billing"));
        expect(res.status, role).toBe(403);
        expect(await codeOf(res)).toBe("E_FORBIDDEN");
      }
    });
  });

  describe("POST /api/app/billing/checkout", () => {
    it("a guest gets the §4.6 step-2 account wall, and no checkout is attempted", async () => {
      const { orgId } = await makeOrg({ kind: "guest" });
      stubPrincipal(principal({ orgId, kind: "visitor", userId: null, plan: "guest" }));
      const res = await m.routes.postCheckout(req("/api/app/billing/checkout", { method: "POST", body: '{"plan":"pro"}' }));
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("E_ACCOUNT_REQUIRED");
    });

    it("an anonymous account is refused the same way: no Polar customer is ever created for one", async () => {
      const { orgId, userId } = await makeOrg({ kind: "guest" });
      stubPrincipal(principal({ orgId, userId, isAnonymous: true, plan: "guest" }));
      const res = await m.routes.postCheckout(req("/api/app/billing/checkout", { method: "POST", body: '{"plan":"pro"}' }));
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("E_ACCOUNT_REQUIRED");
    });

    it("an admin cannot buy: billing:manage is owner-only in the §3.7 matrix", async () => {
      const { orgId, userId } = await makeOrg();
      stubPrincipal(principal({ orgId, userId, role: "admin" }));
      const res = await m.routes.postCheckout(req("/api/app/billing/checkout", { method: "POST", body: '{"plan":"pro"}' }));
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("E_FORBIDDEN");
    });

    it("an unknown plan is a 400 with the field named, and never reaches billing", async () => {
      const { orgId, userId } = await makeOrg();
      stubPrincipal(principal({ orgId, userId }));
      for (const raw of ['{"plan":"enterprise"}', '{"plan":"free"}', "{}", "not json"]) {
        const res = await m.routes.postCheckout(req("/api/app/billing/checkout", { method: "POST", body: raw }));
        expect(res.status, raw).toBe(400);
        expect(await codeOf(res)).toBe("E_VALIDATION");
      }
    });

    it("in simulated mode the owner is sent to the labelled local page", async () => {
      const { orgId, userId } = await makeOrg();
      stubPrincipal(principal({ orgId, userId }));
      const res = await m.routes.postCheckout(req("/api/app/billing/checkout", { method: "POST", body: '{"plan":"pro"}' }));
      expect(res.status).toBe(200);
      expect(await body(res)).toEqual({
        url: `${APP_URL}/app/settings/billing/simulated-checkout?plan=pro`,
        mode: "simulated",
      });
    });

    it("an orgId in the body is ignored: the org comes from the principal (§10.1 rule 3)", async () => {
      const mine = await makeOrg();
      const theirs = await makeOrg();
      stubPrincipal(principal({ orgId: mine.orgId, userId: mine.userId }));
      const res = await m.routes.postCheckout(
        req("/api/app/billing/checkout", {
          method: "POST",
          body: JSON.stringify({ plan: "pro", orgId: theirs.orgId, referenceId: theirs.orgId }),
        }),
      );
      expect(res.status).toBe(200);
      // The simulated provider wrote nothing yet, and the *other* org is untouched either way.
      expect((await m.store.readRow(theirs.orgId)).plan).toBe("free");
    });

    it("a session POST from another origin is refused as CSRF before anything is written", async () => {
      const { orgId, userId } = await makeOrg();
      stubPrincipal(principal({ orgId, userId }));
      const res = await m.routes.postCheckout(
        new Request(`${APP_URL}/api/app/billing/checkout`, {
          method: "POST",
          headers: { origin: "https://evil.test", "content-type": "application/json" },
          body: '{"plan":"pro"}',
        }),
      );
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("E_CSRF");
    });
  });

  describe("POST /api/app/billing/simulated", () => {
    it("the owner's confirm applies the plan and labels it", async () => {
      const { orgId, userId } = await makeOrg();
      stubPrincipal(principal({ orgId, userId }));
      const res = await m.routes.postSimulatedConfirm(
        req("/api/app/billing/simulated", { method: "POST", body: '{"plan":"pro"}' }),
      );
      expect(res.status).toBe(200);
      expect(await body(res)).toMatchObject({ plan: "pro", source: "simulated", badge: "Pro · simulated" });
      expect((await m.store.readRow(orgId)).plan).toBe("pro");
    });

    it("a principal claiming owner who is not one in the database is refused", async () => {
      const mine = await makeOrg();
      const outsider = await makeOrg();
      // The role says owner; the `members` row does not exist for this (user, org) pair.
      stubPrincipal(principal({ orgId: mine.orgId, userId: outsider.userId, role: "owner" }));
      const res = await m.routes.postSimulatedConfirm(
        req("/api/app/billing/simulated", { method: "POST", body: '{"plan":"pro"}' }),
      );
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("E_FORBIDDEN");
      expect((await m.store.readRow(mine.orgId)).plan).toBe("free");
    });

    it("it is refused outright once Polar is really configured", async () => {
      const { orgId, userId } = await makeOrg();
      stubPrincipal(principal({ orgId, userId }));
      process.env.POLAR_ACCESS_TOKEN = FAKE_TOKEN;
      process.env.POLAR_PRODUCT_PRO = PRO_PRODUCT;
      process.env.POLAR_PRODUCT_BUSINESS = BIZ_PRODUCT;
      try {
        const res = await m.routes.postSimulatedConfirm(
          req("/api/app/billing/simulated", { method: "POST", body: '{"plan":"pro"}' }),
        );
        expect(res.status).toBe(409);
        expect(await codeOf(res)).toBe("E_CONFLICT");
      } finally {
        delete process.env.POLAR_ACCESS_TOKEN;
        delete process.env.POLAR_PRODUCT_PRO;
        delete process.env.POLAR_PRODUCT_BUSINESS;
      }
    });
  });

  describe("the registered provider", () => {
    it("polar mode with no plugin mounted degrades to simulated rather than failing a checkout", async () => {
      process.env.POLAR_ACCESS_TOKEN = FAKE_TOKEN;
      process.env.POLAR_PRODUCT_PRO = PRO_PRODUCT;
      process.env.POLAR_PRODUCT_BUSINESS = BIZ_PRODUCT;
      try {
        expect(m.register.getBilling().mode).toBe("simulated");
      } finally {
        delete process.env.POLAR_ACCESS_TOKEN;
        delete process.env.POLAR_PRODUCT_PRO;
        delete process.env.POLAR_PRODUCT_BUSINESS;
      }
    });

    it("registerBilling puts the DB entitlements on the port registry", async () => {
      const { orgId } = await makeOrg();
      await m.provider.confirmSimulated(orgId, "user_r1", "business");
      expect((await m.ports.getEntitlements().get(orgId)).limits.relays).toBe(500);
    });
  });
});

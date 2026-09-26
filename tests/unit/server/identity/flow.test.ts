/**
 * WP19·2 end-to-end, against a real Postgres and a real Better Auth instance (SAAS §3.3, §3.4, §2.6, §2.3).
 *
 * This is the suite the C3b acceptance list is written against:
 *
 * | # | Acceptance (TASKS-v3 §7 WP19·2) | Covered by |
 * |---|---|---|
 * | 2 | guest start: the four §3.3 limits, the 400 ms p50, Set-Cookie flags (incl. `Secure` in production), the seeded org, the `GuestSeeder` port | "guest start" |
 * | 3 | every carry-over test in §3.4 | "the carry-over" |
 * | 4 | `claimVisitorData` is idempotent and refuses a forged `bvid` | "the device claim" |
 * | 5 | the principal matrix: key/session/visitor × legacy/orgs | "the principal" + "the principal matrix" |
 * | 6 | the blocked client paths return 403 `E_USE_APP_API` | "the catch-all" (and `units.test.ts`) |
 * | 7 | the CSRF check | "the CSRF check" |
 *
 * **How it points at a throwaway database.** `getDb()` memoizes a pool from `DATABASE_URL`, so the env var is
 * repointed at the fresh database *before* the identity modules are imported, and every import here is dynamic and
 * happens inside `beforeAll`. Vitest isolates each file in its own worker, so this cannot leak into another suite.
 *
 * $0: no AssemblyAI, no OpenAI, no network beyond the local Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";

/** ≥ 32 characters (§15). A literal test value: it is not a credential for anything. */
const TEST_SECRET = "wp19-test-secret-0000000000000000000000";
const APP_URL = "https://app.example.test";

type Mod = {
  identity: typeof import("@/server/identity");
  routes: typeof import("@/server/identity/routes");
  ports: typeof import("@/server/saas/ports");
  visitor: typeof import("@/server/auth/visitor");
  schemaAuth: typeof import("@/server/db/schema-auth");
  schemaSaas: typeof import("@/server/db/schema-saas");
  schema: typeof import("@/server/db/schema");
  drizzle: typeof import("drizzle-orm");
  v2: typeof import("@/core/contracts/v2/api");
  saasPrincipal: typeof import("@/server/saas/principal");
  env: typeof import("@/server/env");
};

let t: TestDb;
let m: Mod;
let auth: NonNullable<ReturnType<Mod["identity"]["getAuth"]>>;
let audit: ReturnType<Mod["ports"]["createMemoryAuditWriter"]>;

/** The audit actions recorded for one org, in order. */
const actionsFor = (orgId: string): string[] =>
  audit.entries.filter((e) => e.orgId === orgId).map((e) => e.action);

/**
 * A request carrying a signed `bvid` cookie for `visitorId`, like the v2 proxy sets. Any `cookie` the caller
 * passes is **kept** and the device cookie is appended — overwriting it would silently drop the session cookie and
 * make a "signed-in" case test the signed-out path instead.
 *
 * `x-real-ip` defaults to one shared address but a caller may set its own. That matters: the §3.3 per-ipKey
 * buckets are real rows in this database, so a test that starts several guests on the shared address spends the
 * *suite's* hourly allowance. Every test below that starts more than one guest passes its own address.
 */
function deviceReq(visitorId: string, init: RequestInit & { url?: string } = {}): Request {
  const headers = new Headers(init.headers);
  const device = `${m.visitor.VISITOR_COOKIE}=${encodeURIComponent(m.visitor.signVisitorId(visitorId))}`;
  const existing = headers.get("cookie");
  headers.set("cookie", existing ? `${existing}; ${device}` : device);
  if (!headers.has("x-real-ip")) headers.set("x-real-ip", "203.0.113.7");
  return new Request(init.url ?? `${APP_URL}/api/guest/start`, {
    method: init.method ?? "POST",
    headers,
    ...(init.body ? { body: init.body } : {}),
  });
}

/** Set environment variables for one call and put them back afterwards, whatever happens. */
async function withEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(over).map((k) => [k, process.env[k]] as const));
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** `process.env.NODE_ENV` is declared read-only by `@types/node`; at runtime it is an ordinary variable. */
function setNodeEnv(value: string | undefined): void {
  const e = process.env as Record<string, string | undefined>;
  if (value === undefined) delete e.NODE_ENV;
  else e.NODE_ENV = value;
}

/** The `{ code, status }` of the `SaasError` a call threw. Fails the test if it did not throw. */
async function caught(fn: () => Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await fn();
  } catch (e) {
    const err = e as { code?: string; status?: number };
    return { code: err.code ?? String(e), status: err.status ?? 0 };
  }
  throw new Error("expected this call to throw a SaasError, but it resolved");
}

/** The session cookie from a Set-Cookie list, as a `cookie:` header value. */
function cookieHeader(setCookie: string[]): string {
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

describe.skipIf(!HAS_DB)("WP19·2 identity flow", () => {
  beforeAll(async () => {
    t = await createTestDb("wp19_flow");

    // Repoint the environment, then import. Order matters: see the file header.
    process.env.DATABASE_URL = t.url;
    process.env.BETTER_AUTH_SECRET = TEST_SECRET;
    process.env.BETTER_AUTH_URL = APP_URL;
    process.env.APP_URL = APP_URL;
    process.env.TENANCY_MODE = "orgs";
    // v2's device cookie signer. A literal test value, like TEST_SECRET above.
    process.env.VISITOR_SECRET ??= "wp19-test-visitor-secret-000000000000";
    (await import("@/server/env")).resetEnvCache();

    m = {
      identity: await import("@/server/identity"),
      routes: await import("@/server/identity/routes"),
      ports: await import("@/server/saas/ports"),
      visitor: await import("@/server/auth/visitor"),
      schemaAuth: await import("@/server/db/schema-auth"),
      schemaSaas: await import("@/server/db/schema-saas"),
      schema: await import("@/server/db/schema"),
      drizzle: await import("drizzle-orm"),
      v2: await import("@/core/contracts/v2/api"),
      saasPrincipal: await import("@/server/saas/principal"),
      env: await import("@/server/env"),
    };

    const a = m.identity.getAuth();
    expect(a, "the test secret should configure the identity layer").not.toBeNull();
    auth = a!;
    m.identity.installIdentity();
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  /**
   * WP19·2 writes audit rows **through the `AuditWriter` port**, and the port's default is the in-memory writer —
   * the real `src/server/audit/**` writer is WP19·3's deliverable. So the assertions below read the port, not the
   * `audit_log` table; the table is exercised by WP19·3's suite and by the 0003 trigger test.
   */
  beforeEach(() => {
    m.ports.resetSaasPorts();
    audit = m.ports.createMemoryAuditWriter();
    m.ports.setAuditWriter(audit);
  });

  /**
   * A fresh guest session, as the browser would hold it. `ip` is the test's own `x-real-ip` so that starting
   * several guests here never spends the shared per-ipKey allowance of the tests above.
   */
  async function newGuestSession(ip: string): Promise<{ cookie: string; orgId: string }> {
    const res = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId(), { headers: { "x-real-ip": ip } }));
    expect(res.status, "the fixture guest start should succeed").toBe(200);
    const { orgId } = (await res.json()) as { orgId: string };
    return { cookie: cookieHeader(res.headers.getSetCookie()), orgId };
  }

  // ------------------------------------------------------------------ acceptance 2: guest start

  describe("guest start (§3.3)", () => {
    it("mints an anonymous session, a guest org, the owner membership and the audit row", async () => {
      const res = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { orgId: string; relayIds?: string[] };
      expect(body.orgId).toMatch(/^org_/);

      const { eq } = m.drizzle;
      const [org] = await t.db.select().from(m.schemaAuth.organizations).where(eq(m.schemaAuth.organizations.id, body.orgId));
      expect(org?.name).toBe(m.identity.GUEST_ORG_NAME);

      const [meta] = await t.db.select().from(m.schemaSaas.orgMeta).where(eq(m.schemaSaas.orgMeta.orgId, body.orgId));
      expect(meta?.kind).toBe("guest");
      expect(meta?.createdVia).toBe("guest_start");

      const [ent] = await t.db
        .select()
        .from(m.schemaSaas.orgEntitlements)
        .where(eq(m.schemaSaas.orgEntitlements.orgId, body.orgId));
      expect(ent?.plan).toBe("guest");

      const members = await t.db
        .select()
        .from(m.schemaAuth.members)
        .where(eq(m.schemaAuth.members.organizationId, body.orgId));
      expect(members).toHaveLength(1);
      expect(members[0]?.role).toBe("owner");

      // §3.3 step 7: the creation row goes out with the org.
      expect(actionsFor(body.orgId)).toContain("org.created");
    });

    it("sets the session cookie with the §3.9 flags (no Secure outside production)", async () => {
      const res = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      const setCookie = res.headers.getSetCookie();
      const session = setCookie.find((c) => c.startsWith("co.session_token"));
      expect(session, "the anonymous Set-Cookie must reach the browser").toBeTruthy();
      expect(session).toContain("HttpOnly");
      expect(session).toContain("SameSite=Lax");
      expect(session).toContain("Path=/");
      // NODE_ENV is "test" here; `useSecureCookies: isProd()` is what adds Secure on Zerops.
      expect(session).not.toContain("Secure");
    });

    it("makes the new org the session's active org, so /app has a tenant immediately", async () => {
      const res = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      const { orgId } = (await res.json()) as { orgId: string };
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: cookieHeader(res.headers.getSetCookie()) }),
      });
      expect(session?.session.activeOrganizationId).toBe(orgId);
      expect((session?.user as { isAnonymous?: boolean })?.isAnonymous).toBe(true);
    });

    it("is a no-op for a request that already has a session (step 1)", async () => {
      const first = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      const { orgId } = (await first.json()) as { orgId: string };

      const again = await m.routes.guestStart(
        deviceReq(m.visitor.newVisitorId(), { headers: { cookie: cookieHeader(first.headers.getSetCookie()) } }),
      );
      const body = (await again.json()) as { orgId: string; reused?: true };
      expect(body).toEqual({ orgId, reused: true });
    });

    /**
     * Regression, C3b review finding 1: **step 1 is unconditional.**
     *
     * Before the fix the reuse leg only fired when the session already had an `activeOrganizationId`; a session
     * without one fell through to `signInAnonymous`. Better Auth's anonymous plugin only refuses to re-anonymize
     * a session that is *already* anonymous, so a real signed-in user would have been given a brand-new guest
     * user, a guest org and a `Set-Cookie` that overwrites their session cookie — a silent logout, and reachable
     * cross-site because this endpoint takes no session and no origin check. The window is the ordinary one:
     * every sign-up has `activeOrganizationId = null` until `/app` runs `ensurePersonalOrg()`.
     */
    it("never re-anonymizes a real session that has no active org yet (step 1 is unconditional)", async () => {
      const email = "noorg@example.test";
      const signUp = await auth.api.signUpEmail({
        body: { email, password: "a-long-enough-password", name: "Nora Keys" },
        asResponse: true,
      });
      const cookie = cookieHeader(signUp.headers.getSetCookie());
      const before = await auth.api.getSession({ headers: new Headers({ cookie }) });
      expect(before?.session.activeOrganizationId ?? null, "precondition: signed in, no org yet").toBeNull();
      expect((before?.user as { isAnonymous?: boolean })?.isAnonymous ?? false).toBe(false);

      const orgsBefore = await t.db.select({ id: m.schemaAuth.organizations.id }).from(m.schemaAuth.organizations);

      const res = await m.routes.guestStart(
        deviceReq(m.visitor.newVisitorId(), { headers: { cookie } }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ orgId: null, reused: true });

      // Nothing minted, nothing overwritten: no Set-Cookie at all, and the cookie the browser holds still
      // resolves to the same real account.
      expect(res.headers.getSetCookie()).toEqual([]);
      const after = await auth.api.getSession({ headers: new Headers({ cookie }) });
      expect(after?.user.id).toBe(before!.user.id);
      expect(after?.user.email).toBe(email);
      expect((after?.user as { isAnonymous?: boolean })?.isAnonymous ?? false).toBe(false);

      // …and no guest organization appeared as a side effect.
      const orgsAfter = await t.db.select({ id: m.schemaAuth.organizations.id }).from(m.schemaAuth.organizations);
      expect(orgsAfter).toHaveLength(orgsBefore.length);

      // Once the user does have a membership, the reuse leg names it even though the session row still says
      // null — that is `pickActiveOrg`, not a new org.
      const own = await m.identity.ensurePersonalOrg(before!.user.id, t.db);
      expect(own.created).toBe(true);
      const res2 = await m.routes.guestStart(
        deviceReq(m.visitor.newVisitorId(), { headers: { cookie } }),
      );
      expect(await res2.json()).toEqual({ orgId: own.org!.id, reused: true });
      expect(res2.headers.getSetCookie()).toEqual([]);
    });

    it("seeds through the GuestSeeder port and survives a seeder that throws", async () => {
      const seen: string[] = [];
      m.ports.setGuestSeeder({
        async seed(orgId: string) {
          seen.push(orgId);
          return { relayIds: ["rel_dental_copy"] };
        },
      });
      const res = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      const body = (await res.json()) as { orgId: string; relayIds: string[] };
      expect(seen).toEqual([body.orgId]);
      expect(body.relayIds).toContain("rel_dental_copy");

      // A failing seeder leaves a usable, empty workspace rather than failing the start.
      m.ports.setGuestSeeder({
        async seed() {
          throw new Error("seeder exploded");
        },
      });
      const res2 = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      expect(res2.status).toBe(200);
      expect((await res2.json()).orgId).toMatch(/^org_/);
    });

    /**
     * G3. Step 5 pins the flagship from inside the org-creating transaction, which runs BEFORE `seed()`, and
     * `flagshipRelayIds()` reads the `relays` table directly. On a cold deployment that table is empty until
     * something lists relays, and this endpoint never does — so the first visitor got an unpinned workspace
     * and every visitor after them got Baton. The seeder's optional `ensureGallery` is what closes that, and
     * it has to be awaited before the pin read, not just before the copy.
     */
    it("asks the seeder to fill the gallery BEFORE it reads the flagship to pin", async () => {
      const order: string[] = [];
      m.ports.setGuestSeeder({
        async ensureGallery() {
          order.push("ensureGallery");
        },
        async seed(orgId: string) {
          order.push("seed");
          return { relayIds: [`rel_copy_${orgId.slice(-4)}`] };
        },
      } as never);

      const res = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      expect(res.status).toBe(200);
      expect(order).toEqual(["ensureGallery", "seed"]);

      // A seeder without the optional method (C3b's no-op, and the port contract) still works.
      m.ports.setGuestSeeder({ async seed() { return { relayIds: [] }; } });
      const res2 = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      expect(res2.status).toBe(200);

      // …and one whose `ensureGallery` throws does not fail the start.
      m.ports.setGuestSeeder({
        async ensureGallery() { throw new Error("gallery seed exploded"); },
        async seed() { return { relayIds: [] }; },
      } as never);
      const res3 = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      expect(res3.status).toBe(200);
    });

    it("degrades rather than blocks when a limit is hit (step 2)", async () => {
      const saved = process.env.GUEST_PER_DEVICE_DAILY;
      process.env.GUEST_PER_DEVICE_DAILY = "0";
      try {
        const res = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
        expect(res.status).toBe(429);
        const body = (await res.json()) as { degraded: boolean; fallback: string[]; reason: string };
        expect(body.degraded).toBe(true);
        expect(body.reason).toBe("device");
        // The judged URL must never read like an outage: the UI is told where to go instead.
        expect(body.fallback.length).toBeGreaterThan(0);
        expect(JSON.stringify(body)).not.toMatch(/error|outage|unavailable/i);
      } finally {
        if (saved === undefined) delete process.env.GUEST_PER_DEVICE_DAILY;
        else process.env.GUEST_PER_DEVICE_DAILY = saved;
      }
    });

    /**
     * §3.3 step 2 has **four** buckets, and the reason is what the UI logs and what a judge-path incident would be
     * read back from. The test above proves the shape of the degrade; this one proves each bucket is actually
     * wired to its own environment variable — a copy-paste in `checkLimits` would otherwise let one bucket answer
     * for another and nothing would notice until the deployment-wide cap failed to hold.
     */
    it("names the bucket that spoke: device, ipkey_hour, ipkey_day and the deployment-wide cap", async () => {
      const buckets: [string, string][] = [
        ["GUEST_PER_DEVICE_DAILY", "device"],
        ["GUEST_PER_IPKEY_HOURLY", "ipkey_hour"],
        ["GUEST_PER_IPKEY_DAILY", "ipkey_day"],
        ["GUEST_DAILY_CAP", "global"],
      ];
      for (const [envName, reason] of buckets) {
        await withEnv({ [envName]: "0" }, async () => {
          const res = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
          expect(res.status, envName).toBe(429);
          const body = (await res.json()) as { degraded: boolean; reason: string };
          expect(body, envName).toMatchObject({ degraded: true, reason });
        });
      }
    });

    /**
     * §3.3's budget: ≤ 400 ms p50 locally, with no external and no paid call. The landing CTA fires this with
     * `keepalive` and navigates away, so a regression here would not show up as a slow page — it would show up as
     * a guest whose workspace is not ready when they arrive. One warm-up start pays for the pool, the compiled
     * statements and the first-import cost; the median of the next seven is the number §3.3 names.
     */
    it("starts a guest inside the §3.3 400 ms p50 budget locally", async () => {
      const ip = "198.51.100.11";
      await m.routes.guestStart(deviceReq(m.visitor.newVisitorId(), { headers: { "x-real-ip": ip } }));

      const samples: number[] = [];
      for (let i = 0; i < 7; i++) {
        const started = performance.now();
        const res = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId(), { headers: { "x-real-ip": ip } }));
        samples.push(performance.now() - started);
        expect(res.status).toBe(200);
      }

      const p50 = [...samples].sort((a, b) => a - b)[3]!;
      expect(p50, `p50 ${p50.toFixed(0)} ms over [${samples.map((n) => n.toFixed(0)).join(", ")}]`).toBeLessThanOrEqual(400);
    }, 30_000);

    /**
     * The negative half is asserted above; this is the half that matters on Zerops. TLS ends at the shared L7
     * balancer and plain HTTP is forwarded, so nothing about the *request* tells Better Auth the site is https —
     * `useSecureCookies: isProd()` is the only thing that adds the flag, and a session cookie without it on a
     * public deployment is the finding an auditor opens with.
     */
    it("mints a Secure session cookie once NODE_ENV is production (§3.9)", async () => {
      const savedNodeEnv = process.env.NODE_ENV;
      try {
        setNodeEnv("production");
        m.env.resetEnvCache();
        m.identity.resetAuth(); // the flag is baked into the instance at construction time

        const res = await m.routes.guestStart(
          deviceReq(m.visitor.newVisitorId(), { headers: { "x-real-ip": "198.51.100.12", origin: APP_URL } }),
        );
        expect(res.status).toBe(200);
        const session = res.headers.getSetCookie().find((c) => c.includes("session_token"));
        expect(session, "the anonymous Set-Cookie must still reach the browser").toBeTruthy();
        expect(session).toContain("Secure");
        expect(session).toContain("HttpOnly");
      } finally {
        setNodeEnv(savedNodeEnv);
        m.env.resetEnvCache();
        m.identity.resetAuth();
        auth = m.identity.getAuth()!;
      }
    });
  });

  // ------------------------------------------------------------------ acceptance 3: §3.4 carry-over

  describe("the carry-over (§3.4)", () => {
    /** Guest start, then sign up in the same browser session. Returns the ids on both sides. */
    async function guestThenSignUp(email: string) {
      const start = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      const { orgId } = (await start.json()) as { orgId: string };
      const cookie = cookieHeader(start.headers.getSetCookie());
      const before = await auth.api.getSession({ headers: new Headers({ cookie }) });

      const res = await auth.api.signUpEmail({
        body: { email, password: "a-long-enough-password", name: "Mark Delgado" },
        headers: new Headers({ cookie }),
        asResponse: true,
      });
      const after = await auth.api.getSession({
        headers: new Headers({ cookie: cookieHeader(res.headers.getSetCookie()) }),
      });
      return { orgId, anonUserId: before!.user.id, newUserId: after!.user.id, after };
    }

    it("keeps the SAME org id — nothing is re-created, so open tabs and share links survive", async () => {
      const { orgId, anonUserId, newUserId } = await guestThenSignUp("carry1@example.test");
      expect(newUserId).not.toBe(anonUserId);

      const { eq } = m.drizzle;
      const members = await t.db
        .select()
        .from(m.schemaAuth.members)
        .where(eq(m.schemaAuth.members.organizationId, orgId));
      expect(members).toHaveLength(1);
      expect(members[0]?.userId).toBe(newUserId); // the owner moved, the org did not
      expect(members[0]?.role).toBe("owner");
    });

    it("turns the guest org into a personal one: renamed, kind=personal, off the guest plan", async () => {
      const { orgId } = await guestThenSignUp("carry2@example.test");
      const { eq } = m.drizzle;

      const [org] = await t.db.select().from(m.schemaAuth.organizations).where(eq(m.schemaAuth.organizations.id, orgId));
      expect(org?.name).not.toBe(m.identity.GUEST_ORG_NAME);
      expect(org?.name).toContain("Mark");

      const [meta] = await t.db.select().from(m.schemaSaas.orgMeta).where(eq(m.schemaSaas.orgMeta.orgId, orgId));
      expect(meta?.kind).toBe("personal");

      const [ent] = await t.db
        .select()
        .from(m.schemaSaas.orgEntitlements)
        .where(eq(m.schemaSaas.orgEntitlements.orgId, orgId));
      expect(ent?.plan).toBe("free");
    });

    it("writes the guest.claimed audit row and leaves older rows attributed to the guest", async () => {
      const { orgId } = await guestThenSignUp("carry3@example.test");
      const rows = audit.entries.filter((e) => e.orgId === orgId);
      const actions = rows.map((e) => e.action);
      expect(actions).toContain("org.created");
      expect(actions).toContain("guest.claimed");
      // §3.4 step 4: the log is append-only history, not a record to be rewritten — the guest's own row keeps
      // saying "guest" after the account exists.
      expect(rows.find((e) => e.action === "org.created")?.actor.type).toBe("guest");
      expect(rows.find((e) => e.action === "guest.claimed")?.actor.type).toBe("user");
    });

    it("the anonymous user row is gone afterwards, and the hook still ran (VERIFY d)", async () => {
      const { anonUserId } = await guestThenSignUp("carry4@example.test");
      const { eq } = m.drizzle;
      const left = await t.db.select().from(m.schemaAuth.users).where(eq(m.schemaAuth.users.id, anonUserId));
      expect(left).toHaveLength(0);
    });

    it("carries over on sign-IN to a pre-existing account too, keeping that account's own org", async () => {
      // An account that already has its own org.
      const email = "carry5@example.test";
      await auth.api.signUpEmail({ body: { email, password: "a-long-enough-password", name: "Ana" } });
      const { eq } = m.drizzle;
      const [user] = await t.db.select().from(m.schemaAuth.users).where(eq(m.schemaAuth.users.email, email));
      const own = await m.identity.ensurePersonalOrg(user!.id, t.db);
      expect(own.created).toBe(true);

      // A guest session in the same browser, then sign in.
      const start = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      const { orgId: guestOrgId } = (await start.json()) as { orgId: string };
      await auth.api.signInEmail({
        body: { email, password: "a-long-enough-password" },
        headers: new Headers({ cookie: cookieHeader(start.headers.getSetCookie()) }),
        asResponse: true,
      });

      const mine = await m.identity.listMembershipsByRecency(user!.id, t.db);
      const ids = mine.map((r) => r.orgId);
      expect(ids).toContain(guestOrgId); // the guest org came along
      expect(ids).toContain(own.org!.id); // and the account's own org is untouched

      // It is a second workspace, not a replacement personal org.
      const [meta] = await t.db.select().from(m.schemaSaas.orgMeta).where(eq(m.schemaSaas.orgMeta.orgId, guestOrgId));
      expect(meta?.kind).toBe("team");
      const [org] = await t.db
        .select()
        .from(m.schemaAuth.organizations)
        .where(eq(m.schemaAuth.organizations.id, guestOrgId));
      expect(org?.name).toContain("claimed");
    });
  });

  // ------------------------------------------------------------------ acceptance 4: the device claim

  describe("the device claim (§2.6 R1)", () => {
    it("moves the device's runs once, and a second call moves nothing", async () => {
      const visitorId = m.visitor.newVisitorId();
      const ws = m.v2.workspaceOf(visitorId);
      const start = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      const { orgId } = (await start.json()) as { orgId: string };

      await t.db.insert(m.schema.cases).values({
        id: `case_${Math.random().toString(36).slice(2, 10)}`,
        mode: "watch",
        scenarioId: "s01",
        policy: {} as never,
        state: {} as never,
        visitorId,
        ipKey: "ip1",
      });
      await t.db.insert(m.schema.relays).values({
        id: `rel_${Math.random().toString(36).slice(2, 10)}`,
        workspaceId: ws,
        slug: `device-relay-${Math.random().toString(36).slice(2, 8)}`,
        title: "Device relay",
        draft: {} as never,
        origin: "user",
      } as never);

      const first = await m.identity.claimVisitorData(visitorId, orgId, { via: "confirmed" }, t.db);
      expect(first.cases).toBe(1);
      expect(first.relays).toBe(1);

      const second = await m.identity.claimVisitorData(visitorId, orgId, { via: "confirmed" }, t.db);
      expect(second).toEqual({ cases: 0, relays: 0, drafts: 0, secrets: 0, publications: 0 });

      // One audit row, not two: a repeat claim moved nothing, so it does not spam the log.
      expect(actionsFor(orgId).filter((a) => a === "guest.claimed_device")).toHaveLength(1);
    });

    it("moves nothing for a visitor id that owns nothing (a forged bvid buys no data)", async () => {
      const start = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      const { orgId } = (await start.json()) as { orgId: string };
      const counts = await m.identity.claimVisitorData("v_forged_not_a_real_device", orgId, {}, t.db);
      expect(counts).toEqual({ cases: 0, relays: 0, drafts: 0, secrets: 0, publications: 0 });
    });

    it("refuses to claim a workspace into itself, and ignores empty input", async () => {
      const visitorId = m.visitor.newVisitorId();
      const ws = m.v2.workspaceOf(visitorId);
      expect(await m.identity.claimVisitorData(visitorId, ws, {}, t.db)).toEqual({
        cases: 0, relays: 0, drafts: 0, secrets: 0, publications: 0,
      });
      expect(await m.identity.claimVisitorData("", "org_x", {}, t.db)).toEqual({
        cases: 0, relays: 0, drafts: 0, secrets: 0, publications: 0,
      });
    });

    it("a decline is permanent for that (org, device) pair", async () => {
      const visitorId = m.visitor.newVisitorId();
      const start = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      const { orgId } = (await start.json()) as { orgId: string };

      await t.db.insert(m.schema.cases).values({
        id: `case_${Math.random().toString(36).slice(2, 10)}`,
        mode: "watch",
        scenarioId: "s01",
        policy: {} as never,
        state: {} as never,
        visitorId,
        ipKey: "ip1",
      });
      expect((await m.identity.claimOffer(orgId, visitorId, t.db)).offer).toBe(true);

      await m.identity.declineDeviceClaim(orgId, visitorId, t.db);
      expect(await m.identity.hasDeclinedDeviceClaim(orgId, visitorId, t.db)).toBe(true);
      expect((await m.identity.claimOffer(orgId, visitorId, t.db)).offer).toBe(false);
      // Idempotent: declining twice is still declined.
      await m.identity.declineDeviceClaim(orgId, visitorId, t.db);
      expect((await m.identity.claimOffer(orgId, visitorId, t.db)).offer).toBe(false);

      // A second device declining on the same org must not erase the first. This is the case the old
      // `jsonb_set('{claimDeclined,<vid>}', …, true)` got wrong: with no parent key it wrote nothing at all.
      const other = m.visitor.newVisitorId();
      await m.identity.declineDeviceClaim(orgId, other, t.db);
      expect(await m.identity.hasDeclinedDeviceClaim(orgId, other, t.db)).toBe(true);
      expect(await m.identity.hasDeclinedDeviceClaim(orgId, visitorId, t.db)).toBe(true);
      // And a device that never declined is still offered.
      expect(await m.identity.hasDeclinedDeviceClaim(orgId, m.visitor.newVisitorId(), t.db)).toBe(false);
    });
  });

  // ------------------------------------------------------------------ acceptance 5 + 6

  describe("the principal (§2.3) and the catch-all (§3.8)", () => {
    it("a session request resolves to its active org, with the owner role", async () => {
      const start = await m.routes.guestStart(deviceReq(m.visitor.newVisitorId()));
      const { orgId } = (await start.json()) as { orgId: string };
      const cookie = cookieHeader(start.headers.getSetCookie());

      const p = await m.identity.resolvePrincipal(deviceReq(m.visitor.newVisitorId(), { headers: { cookie } }));
      expect(p.kind).toBe("session");
      expect(p.orgId).toBe(orgId);
      expect(p.role).toBe("owner");
      expect(p.orgKind).toBe("guest");
      expect(p.plan).toBe("guest");
      expect(p.isAnonymous).toBe(true);
    });

    it("a request with no session is still a device principal (the legacy floor holds in orgs mode)", async () => {
      const visitorId = m.visitor.newVisitorId();
      const p = await m.identity.resolvePrincipal(deviceReq(visitorId));
      expect(p.kind).toBe("visitor");
      expect(p.userId).toBeNull();
    });

    it("the catch-all refuses a blocked path with 403 E_USE_APP_API", async () => {
      const { POST } = m.routes.authCatchAll();
      const res = await POST(
        new Request(`${APP_URL}/api/auth/organization/create`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: APP_URL },
          body: JSON.stringify({ name: "Sneaky", slug: "sneaky" }),
        }),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("E_USE_APP_API");
      expect(body.error.message).toMatch(/\/api\/app/);

      // And it really did not create anything.
      const { eq } = m.drizzle;
      const rows = await t.db
        .select()
        .from(m.schemaAuth.organizations)
        .where(eq(m.schemaAuth.organizations.slug, "sneaky"));
      expect(rows).toHaveLength(0);
    });

    it("the catch-all still serves a read path", async () => {
      const { GET } = m.routes.authCatchAll();
      const res = await GET(new Request(`${APP_URL}/api/auth/get-session`, { headers: { origin: APP_URL } }));
      expect(res.status).toBeLessThan(500);
    });
  });

  // ------------------------------------------------- acceptance 5: the matrix, both tenancy modes and the key row

  /**
   * §2.3's three principal kinds against §2.8's two tenancy modes. `tests/unit/server/saas/principal.test.ts`
   * covers the same rules over *stub* principals at C3; these run them through the resolver that is actually
   * registered from C3b, against a real session, so the two cannot drift apart silently.
   *
   * The file's `beforeEach` calls `resetSaasPorts()`, which drops the registered resolver back to the C3 legacy
   * one — so these call `resolveSessionPrincipal` (the exact function `registerSessionPrincipal` installs) rather
   * than `requirePrincipal`, except where the point of the test is the registry itself.
   */
  describe("the principal matrix (§2.3) × TENANCY_MODE (§2.8)", () => {
    it("a session keeps its org under TENANCY_MODE=legacy — the mode only moves the visitor row", async () => {
      const { cookie, orgId } = await newGuestSession("198.51.100.21");

      await withEnv({ TENANCY_MODE: "legacy" }, async () => {
        const p = await m.identity.resolvePrincipal(
          deviceReq(m.visitor.newVisitorId(), { headers: { cookie, "x-real-ip": "198.51.100.21" } }),
        );
        // §2.3 rule 3 scopes the mode to the *visitor* principal: someone who signed in still gets their org, which
        // is what makes `legacy` a safe default rather than a feature freeze.
        expect(p.kind).toBe("session");
        expect(p.orgId).toBe(orgId);
        expect(p.role).toBe("owner");
      });
    });

    it("a visitor is ws_<vid>/owner/guest in legacy mode and org-less in orgs mode", async () => {
      const visitorId = m.visitor.newVisitorId();

      const legacy = await withEnv({ TENANCY_MODE: "legacy" }, () =>
        m.identity.resolvePrincipal(deviceReq(visitorId)),
      );
      expect(legacy.kind).toBe("visitor");
      expect(legacy.orgId).toBe(m.v2.workspaceOf(visitorId));
      expect(legacy.role).toBe("owner");
      expect(legacy.plan).toBe("guest");

      const orgs = await withEnv({ TENANCY_MODE: "orgs" }, () =>
        m.identity.resolvePrincipal(deviceReq(visitorId)),
      );
      expect(orgs.kind).toBe("visitor");
      expect(orgs.orgId).toBeNull();

      // …and the org-less visitor is a 401 with the start path, not a 500 (§2.3).
      const e = await caught(() =>
        withEnv({ TENANCY_MODE: "orgs" }, () => m.identity.resolveSessionPrincipal(deviceReq(visitorId))),
      );
      expect([e.code, e.status]).toEqual(["E_AUTH_REQUIRED", 401]);
    });

    /**
     * §2.3 step 1. WP22's `@better-auth/api-key` plugin is a `[]` stub until WP22·1, so `verifyApiKey` is absent
     * and no key can verify yet — but the *branch* ships now, and the rule worth pinning is the one a later unit
     * could quietly break: an unverifiable key must not fall back to cookies. Downgrading it to a visitor would
     * turn an honest 401 into a confusing 404 on some org resource three layers down.
     */
    it("reads an API key on /api/v1/** only, and never degrades an unverifiable key into a visitor", async () => {
      // Built at runtime: no credential-shaped literal is committed, even a fake one.
      const key = ["cko", "k".repeat(24)].join("_");
      const onV1 = deviceReq(m.visitor.newVisitorId(), {
        url: `${APP_URL}/api/v1/relays`,
        headers: { authorization: `Bearer ${key}` },
      });

      const p = await m.identity.resolvePrincipal(onV1);
      expect(p.kind).toBe("api_key");
      expect(p.userId).toBeNull();
      expect(p.orgId).toBeNull(); // nothing verified it, so it carries no tenant
      expect(p.scopes).toEqual([]);
      expect(m.identity.apiKeyOf(onV1)).toBe(key);

      const e = await caught(() => m.identity.resolveSessionPrincipal(onV1));
      expect([e.code, e.status]).toEqual(["E_AUTH_REQUIRED", 401]);
    });

    it("ignores a key-shaped header outside /api/v1/**, so the session still decides", async () => {
      const key = ["cko", "k".repeat(24)].join("_");
      const { cookie, orgId } = await newGuestSession("198.51.100.22");

      const req = deviceReq(m.visitor.newVisitorId(), {
        url: `${APP_URL}/api/relays/rel_1`,
        headers: { cookie, authorization: `Bearer ${key}`, "x-real-ip": "198.51.100.22" },
      });
      expect(m.identity.apiKeyOf(req)).toBeNull();

      const p = await m.identity.resolvePrincipal(req);
      expect(p.kind).toBe("session");
      expect(p.orgId).toBe(orgId);
    });
  });

  // ------------------------------------------------------------------------------ acceptance 7: the CSRF check

  /**
   * §3.9's second layer, over a **real** session rather than a stub principal. `SameSite=Lax` is the first layer;
   * this is what stops a cross-site POST that a `Lax` cookie still rides along with. The exemptions matter as much
   * as the rule: a safe method, and an API key (which reads no cookies and so cannot be ridden).
   */
  describe("the CSRF check (§3.9) over a real session", () => {
    let cookie: string;

    beforeEach(async () => {
      m.identity.registerSessionPrincipal(); // the file's beforeEach reset the registry to the C3 resolver
      ({ cookie } = await newGuestSession("198.51.100.31"));
    });

    const sessionReq = (init: RequestInit & { url?: string }): Request =>
      deviceReq(m.visitor.newVisitorId(), {
        url: `${APP_URL}/api/app/orgs`,
        ...init,
        headers: { cookie, "x-real-ip": "198.51.100.31", ...(init.headers as Record<string, string>) },
      });

    it("refuses a cross-origin POST with 403 E_CSRF, through requirePrincipal", async () => {
      const e = await caught(() =>
        m.saasPrincipal.requirePrincipal(sessionReq({ method: "POST", headers: { origin: "https://evil.test" } })),
      );
      expect([e.code, e.status]).toEqual(["E_CSRF", 403]);
    });

    it("refuses a POST with no Origin at all — a browser always sends one cross-site", async () => {
      const e = await caught(() => m.identity.resolveSessionPrincipal(sessionReq({ method: "POST" })));
      expect([e.code, e.status]).toEqual(["E_CSRF", 403]);
    });

    it("accepts Origin: APP_URL, and Sec-Fetch-Site: same-origin with no Origin header", async () => {
      const byOrigin = await m.identity.resolveSessionPrincipal(
        sessionReq({ method: "POST", headers: { origin: APP_URL } }),
      );
      expect(byOrigin.kind).toBe("session");

      const byFetchSite = await m.identity.resolveSessionPrincipal(
        sessionReq({ method: "POST", headers: { "sec-fetch-site": "same-origin" } }),
      );
      expect(byFetchSite.kind).toBe("session");
    });

    it("never refuses a safe method: a cross-origin GET is not a CSRF risk", async () => {
      const p = await m.identity.resolveSessionPrincipal(
        sessionReq({ method: "GET", headers: { origin: "https://evil.test" } }),
      );
      expect(p.kind).toBe("session");
    });

    it("exempts an API key: a cross-origin POST with a key is 401, never E_CSRF", async () => {
      const key = ["cko", "k".repeat(24)].join("_");
      const e = await caught(() =>
        m.identity.resolveSessionPrincipal(
          deviceReq(m.visitor.newVisitorId(), {
            url: `${APP_URL}/api/v1/relays`,
            method: "POST",
            headers: { authorization: `Bearer ${key}`, origin: "https://evil.test" },
          }),
        ),
      );
      // The key never verifies while WP22's plugin is a stub, so the honest answer is "who are you", not "bad origin".
      expect(e.code).toBe("E_AUTH_REQUIRED");
    });

    it("leaves a device POST alone in legacy mode, so no v2 route becomes 403", async () => {
      const p = await withEnv({ TENANCY_MODE: "legacy" }, () =>
        m.identity.resolveSessionPrincipal(
          deviceReq(m.visitor.newVisitorId(), {
            url: `${APP_URL}/api/cases`,
            method: "POST",
            headers: { origin: "https://evil.test", "x-real-ip": "198.51.100.32" },
          }),
        ),
      );
      expect(p.kind).toBe("visitor");
      expect(p.orgId).toMatch(/^ws_/);
    });
  });
});

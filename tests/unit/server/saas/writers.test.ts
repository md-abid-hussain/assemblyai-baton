/**
 * The database `DomainEvents` outbox and `UsageMeter` (SAAS §7.1, §4.5), and the ports they slot into. WP19·3.
 *
 * Two properties carry the weight here, and both belong to Postgres rather than to our code, so both are tested
 * against a real one:
 *
 * - **`domain_events.dedupe_key` is unique**, which is what makes "one delivery per run" survive a job that runs
 *   twice — including two that run *at the same time*, which a read-then-write could never guarantee;
 * - **`usage_events.idempotency_key` is unique**, which is what makes a retried meter call free.
 *
 * The in-memory defaults in `ports.ts` compute the same summary numbers from the same records, and the last
 * block asserts the two agree — a drift between them would mean the numbers change when WP19·3 is merged.
 *
 * $0: no AssemblyAI, no OpenAI, no network beyond the local Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";

type Mod = {
  outbox: typeof import("@/server/events/outbox");
  usage: typeof import("@/server/saas/usage-writer");
  ports: typeof import("@/server/saas/ports");
  writers: typeof import("@/server/saas/writers");
  schemaAuth: typeof import("@/server/db/schema-auth");
  schemaSaas: typeof import("@/server/db/schema-saas");
  drizzle: typeof import("drizzle-orm");
};

let t: TestDb;
let m: Mod;

const ORG = "org_writers_a";
const OTHER = "org_writers_b";

async function seedOrg(orgId: string, plan: "guest" | "free" | "pro" | "business"): Promise<void> {
  await t.db
    .insert(m.schemaAuth.organizations)
    .values({ id: orgId, name: orgId, slug: orgId.replace(/_/g, "-"), createdAt: new Date() });
  await t.db.insert(m.schemaSaas.orgEntitlements).values({ orgId, plan, status: "active", source: "default" });
}

describe.skipIf(!HAS_DB)("WP19·3 writers", () => {
  beforeAll(async () => {
    t = await createTestDb("wp19_writers");
    process.env.DATABASE_URL = t.url;
    (await import("@/server/env")).resetEnvCache();
    m = {
      outbox: await import("@/server/events/outbox"),
      usage: await import("@/server/saas/usage-writer"),
      ports: await import("@/server/saas/ports"),
      writers: await import("@/server/saas/writers"),
      schemaAuth: await import("@/server/db/schema-auth"),
      schemaSaas: await import("@/server/db/schema-saas"),
      drizzle: await import("drizzle-orm"),
    };
    await seedOrg(ORG, "pro");
    await seedOrg(OTHER, "free");
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.pool.query("delete from domain_events");
    await t.pool.query("delete from usage_events");
    m.ports.resetSaasPorts();
    m.writers.resetWritersInstall();
  });

  // --------------------------------------------------------------------------------------------- the outbox

  describe("the outbox (§7.1)", () => {
    const run = () => m.outbox.createDbDomainEvents({ db: t.db });

    it("writes a row and returns its id", async () => {
      const r = await run().emit({ orgId: ORG, type: "run.completed", data: { run_id: "tk_1" } });
      expect(r.created).toBe(true);
      expect(r.eventId.startsWith(m.outbox.EVENT_ID_PREFIX)).toBe(true);
      const rows = await m.outbox.pendingEvents(ORG, t.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("run.completed");
    });

    it("is idempotent on the dedupe key and hands back the original id", async () => {
      const key = "run.completed:tk_2";
      const first = await run().emit({ orgId: ORG, type: "run.completed", data: { a: 1 }, dedupeKey: key });
      const second = await run().emit({ orgId: ORG, type: "run.completed", data: { a: 2 }, dedupeKey: key });
      expect(second).toEqual({ eventId: first.eventId, created: false });
      expect(await m.outbox.pendingEvents(ORG, t.db)).toHaveLength(1);
    });

    it("holds under concurrency: five parallel emits of one key make one row", async () => {
      const key = "run.completed:tk_3";
      const results = await Promise.all(
        Array.from({ length: 5 }, () => run().emit({ orgId: ORG, type: "run.completed", data: {}, dedupeKey: key })),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.eventId)).size).toBe(1);
      expect(await m.outbox.pendingEvents(ORG, t.db)).toHaveLength(1);
    });

    it("treats a null dedupe key as always new", async () => {
      await run().emit({ orgId: ORG, type: "webhook.test", data: { message: "Hello from Changeover" } });
      await run().emit({ orgId: ORG, type: "webhook.test", data: { message: "Hello from Changeover" } });
      expect(await m.outbox.pendingEvents(ORG, t.db)).toHaveLength(2);
    });

    it("drops an event with no org rather than inventing a tenant (§2.6)", async () => {
      const r = await run().emit({ orgId: "", type: "run.completed", data: {} });
      expect(r).toEqual({ eventId: "", created: false });
      expect(await m.outbox.pendingEvents(ORG, t.db)).toHaveLength(0);
    });

    it("rolls back with the caller's transaction", async () => {
      await expect(
        t.db.transaction(async (tx) => {
          await run().emit({ orgId: ORG, type: "run.completed", data: {}, dedupeKey: "tx" }, tx);
          throw new Error("the run did not actually complete");
        }),
      ).rejects.toThrow();
      expect(await m.outbox.pendingEvents(ORG, t.db)).toHaveLength(0);
    });

    it("keeps A's events out of B's list", async () => {
      await run().emit({ orgId: ORG, type: "run.completed", data: {}, dedupeKey: "a" });
      await run().emit({ orgId: OTHER, type: "run.completed", data: {}, dedupeKey: "b" });
      expect(await m.outbox.pendingEvents(ORG, t.db)).toHaveLength(1);
      expect(await m.outbox.pendingEvents(OTHER, t.db)).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------------------------------------- the usage meter

  describe("the usage meter (§4.5)", () => {
    const meter = (now?: () => number) => m.usage.createDbUsageMeter({ db: t.db, ...(now ? { now } : {}) });

    beforeEach(() => {
      m.writers.installWriters();
    });

    it("records once per idempotency key", async () => {
      const u = { orgId: ORG, kind: "live_run" as const, quantity: 1, idempotencyKey: "live_run:tk_1" };
      await meter().record(u);
      await meter().record(u);
      const { eq, sql } = m.drizzle;
      const [r] = await t.db
        .select({ n: sql<string>`count(*)` })
        .from(m.schemaSaas.usageEvents)
        .where(eq(m.schemaSaas.usageEvents.orgId, ORG));
      expect(Number(r?.n)).toBe(1);
    });

    it("chooses the unit from the kind, so the column can never disagree", async () => {
      await meter().record({ orgId: ORG, kind: "ai_minutes", quantity: 2.5, idempotencyKey: "m1" });
      await meter().record({ orgId: ORG, kind: "dry_run", quantity: 1, idempotencyKey: "d1" });
      const { eq } = m.drizzle;
      const rows = await t.db
        .select({ kind: m.schemaSaas.usageEvents.kind, unit: m.schemaSaas.usageEvents.unit })
        .from(m.schemaSaas.usageEvents)
        .where(eq(m.schemaSaas.usageEvents.orgId, ORG));
      expect(rows.find((r) => r.kind === "ai_minutes")?.unit).toBe("minutes");
      expect(rows.find((r) => r.kind === "dry_run")?.unit).toBe("count");
    });

    it("keeps recorded, simulated and published minutes apart, and bills only two of them", async () => {
      const at = new Date().toISOString();
      for (const [source, q, key] of [
        ["recorded", 10, "r"],
        ["simulated", 100, "s"],
        ["published", 5, "p"],
        ["replay", 0, "y"],
      ] as const) {
        await meter().record({
          orgId: ORG, kind: "ai_minutes", quantity: q, source, idempotencyKey: key, occurredAt: at,
        });
      }
      const s = await meter().summary(ORG);
      expect(s.aiMinutes.recorded).toBe(10);
      expect(s.aiMinutes.simulated).toBe(100);
      expect(s.aiMinutes.published).toBe(5);
      // Pro: 150 minutes included, so 15 billable minutes are inside the allowance.
      expect(s.plan).toBe("pro");
      expect(s.aiMinutes.allowance).toBe(150);
      expect(s.aiMinutes.overageUsdEstimate).toBe(0);
    });

    it("estimates the overage from the plan's rate, on billable minutes only", async () => {
      const at = new Date().toISOString();
      await meter().record({ orgId: ORG, kind: "ai_minutes", quantity: 160, source: "recorded", idempotencyKey: "big", occurredAt: at });
      await meter().record({ orgId: ORG, kind: "ai_minutes", quantity: 500, source: "simulated", idempotencyKey: "sim", occurredAt: at });
      const s = await meter().summary(ORG);
      // 160 - 150 = 10 minutes over, at Pro's $0.30.
      expect(s.aiMinutes.overageUsdEstimate).toBeCloseTo(3, 6);
    });

    it("counts today's runs by kind", async () => {
      const at = new Date().toISOString();
      await meter().record({ orgId: ORG, kind: "live_run", quantity: 1, idempotencyKey: "l1", occurredAt: at });
      await meter().record({ orgId: ORG, kind: "live_run", quantity: 1, idempotencyKey: "l2", occurredAt: at });
      await meter().record({ orgId: ORG, kind: "dry_run", quantity: 1, idempotencyKey: "d1", occurredAt: at });
      const s = await meter().summary(ORG);
      expect(s.today).toMatchObject({ liveRuns: 2, dryRuns: 1, voicedSims: 0, drafts: 0 });
    });

    it("never reports another org's usage", async () => {
      const at = new Date().toISOString();
      await meter().record({ orgId: OTHER, kind: "live_run", quantity: 9, idempotencyKey: "other", occurredAt: at });
      expect((await meter().summary(ORG)).today.liveRuns).toBe(0);
      expect((await meter().summary(OTHER)).today.liveRuns).toBe(9);
    });

    it("agrees with the in-memory default the ports ship with", async () => {
      const at = new Date().toISOString();
      const records = [
        { orgId: ORG, kind: "ai_minutes" as const, quantity: 12, source: "recorded" as const, idempotencyKey: "a", occurredAt: at },
        { orgId: ORG, kind: "ai_minutes" as const, quantity: 4, source: "published" as const, idempotencyKey: "b", occurredAt: at },
        { orgId: ORG, kind: "ai_minutes" as const, quantity: 40, source: "simulated" as const, idempotencyKey: "c", occurredAt: at },
        { orgId: ORG, kind: "live_run" as const, quantity: 3, idempotencyKey: "d", occurredAt: at },
        { orgId: ORG, kind: "draft" as const, quantity: 2, idempotencyKey: "e", occurredAt: at },
      ];
      const memory = m.ports.createMemoryUsageMeter();
      for (const r of records) {
        await meter().record(r);
        await memory.record(r);
      }
      const [db, mem] = [await meter().summary(ORG), await memory.summary(ORG)];
      expect(db.aiMinutes).toEqual(mem.aiMinutes);
      expect(db.today).toEqual(mem.today);
      expect(db.daily).toEqual(mem.daily);
    });
  });

  // --------------------------------------------------------------------------------------- the registration

  describe("installWriters()", () => {
    it("registers all three writers, the plan resolver and the seats counter", async () => {
      m.writers.installWriters();
      await m.ports.getUsageMeter().record({ orgId: ORG, kind: "draft", quantity: 1, idempotencyKey: "reg" });
      const { eq, sql } = m.drizzle;
      const [r] = await t.db
        .select({ n: sql<string>`count(*)` })
        .from(m.schemaSaas.usageEvents)
        .where(eq(m.schemaSaas.usageEvents.orgId, ORG));
      expect(Number(r?.n), "the registered meter is the database one").toBe(1);
      expect(await m.ports.resolvePlan(ORG)).toBe("pro");
      expect(await m.ports.resolvePlan(OTHER)).toBe("free");
    });

    it("keeps a legacy `ws_<visitorId>` workspace on the guest plan (§2.6, §4.1)", async () => {
      m.writers.installWriters();
      expect(await m.ports.resolvePlan("ws_somevisitor")).toBe("guest");
      const view = await m.ports.getEntitlements().get("ws_somevisitor");
      expect(view.plan).toBe("guest");
      expect(view.limits.liveRunsPerDay).toBe(3);
    });

    it("is idempotent", () => {
      m.writers.installWriters();
      const first = m.ports.getAuditWriter();
      m.writers.installWriters();
      expect(m.ports.getAuditWriter()).toBe(first);
    });
  });
});

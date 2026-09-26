/**
 * The database `AuditWriter`, the append-only trigger and the retention purge (SAAS §9, §3.5). WP19·3.
 *
 * Against a real Postgres with the real `0002`/`0003` migrations, because every property here is the database's:
 * the unique-ness of nothing, the refusal of `UPDATE`, the escape hatch `SET LOCAL changeover.audit_purge`, and
 * the `(occurred_at, id)` order the cursor depends on.
 *
 * The same import dance as `tests/unit/server/identity/flow.test.ts`: `DATABASE_URL` is repointed before the
 * server modules are imported, and every import is dynamic inside `beforeAll`.
 *
 * $0: no AssemblyAI, no OpenAI, no network beyond the local Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";

type Mod = {
  writer: typeof import("@/server/audit/writer");
  read: typeof import("@/server/audit/read");
  retention: typeof import("@/server/audit/retention");
  actor: typeof import("@/server/audit/actor");
  schemaAuth: typeof import("@/server/db/schema-auth");
  schemaSaas: typeof import("@/server/db/schema-saas");
  drizzle: typeof import("drizzle-orm");
  ports: typeof import("@/server/saas/ports");
};

let t: TestDb;
let m: Mod;

const ORG = "org_audit_a";
const OTHER = "org_audit_b";

/**
 * An org with an entitlements row, so the retention purge can see its plan. The `organizations` row has to exist
 * first: `org_entitlements` cascades from it (§2.7), which is the point — it *is* the org's record.
 */
async function seedOrg(orgId: string, plan: "guest" | "free" | "pro" | "business"): Promise<void> {
  await t.db
    .insert(m.schemaAuth.organizations)
    .values({ id: orgId, name: orgId, slug: orgId.replace(/_/g, "-"), createdAt: new Date() });
  await t.db.insert(m.schemaSaas.orgEntitlements).values({ orgId, plan, status: "active", source: "default" });
}

async function rowCount(orgId: string): Promise<number> {
  const { eq, sql } = m.drizzle;
  const [r] = await t.db
    .select({ n: sql<string>`count(*)` })
    .from(m.schemaSaas.auditLog)
    .where(eq(m.schemaSaas.auditLog.orgId, orgId));
  return Number(r?.n ?? 0);
}

describe.skipIf(!HAS_DB)("WP19·3 audit", () => {
  beforeAll(async () => {
    t = await createTestDb("wp19_audit");
    process.env.DATABASE_URL = t.url;
    (await import("@/server/env")).resetEnvCache();
    m = {
      writer: await import("@/server/audit/writer"),
      read: await import("@/server/audit/read"),
      retention: await import("@/server/audit/retention"),
      actor: await import("@/server/audit/actor"),
      schemaAuth: await import("@/server/db/schema-auth"),
      schemaSaas: await import("@/server/db/schema-saas"),
      drizzle: await import("drizzle-orm"),
      ports: await import("@/server/saas/ports"),
    };
    // `organizations` rows are not needed: `audit_log.org_id` has no foreign key on purpose (§2.7), which is
    // exactly what lets a row outlive its org. Only `org_entitlements` matters, for the per-plan window.
    await seedOrg(ORG, "free");
    await seedOrg(OTHER, "pro");
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.pool.query("begin; set local changeover.audit_purge = 'on'; delete from audit_log; commit;");
  });

  // ------------------------------------------------------------------------------------------- the writer

  describe("the writer", () => {
    it("writes the row, hoisting ipKey and requestId out of metadata into their own columns", async () => {
      const w = m.writer.createDbAuditWriter({ db: t.db });
      await w.write({
        orgId: ORG,
        actor: { type: "user", id: "usr_1", label: "ada@example.test" },
        action: "org.renamed",
        target: { type: "organization", id: ORG },
        metadata: { ipKey: "ipk_abc", requestId: "req_1", from: "Old", to: "New" },
      });

      const { eq } = m.drizzle;
      const [row] = await t.db
        .select()
        .from(m.schemaSaas.auditLog)
        .where(eq(m.schemaSaas.auditLog.orgId, ORG));
      expect(row?.action).toBe("org.renamed");
      expect(row?.actorLabel).toBe("ada@example.test");
      expect(row?.ipKey).toBe("ipk_abc");
      expect(row?.requestId).toBe("req_1");
      expect(row?.metadata).toEqual({ from: "Old", to: "New" });
      expect(row?.id.startsWith(m.writer.AUDIT_ID_PREFIX)).toBe(true);
    });

    it("writes inside the caller's transaction, so a rollback takes the row with it (S13)", async () => {
      const w = m.writer.createDbAuditWriter({ db: t.db });
      await expect(
        t.db.transaction(async (tx) => {
          await w.write(
            { orgId: ORG, actor: { type: "system", id: null, label: "x" }, action: "org.created" },
            tx,
          );
          throw new Error("the change this row describes failed");
        }),
      ).rejects.toThrow("the change this row describes failed");
      expect(await rowCount(ORG)).toBe(0);
    });

    it("is the port's implementation once `installWriters` has run", async () => {
      const { installWriters, resetWritersInstall } = await import("@/server/saas/writers");
      m.ports.resetSaasPorts();
      resetWritersInstall();
      installWriters();
      await m.ports.getAuditWriter().write({
        orgId: ORG,
        actor: { type: "system", id: null, label: "system" },
        action: "org.created",
      });
      expect(await rowCount(ORG)).toBe(1);
      resetWritersInstall();
      m.ports.resetSaasPorts();
    });
  });

  // ------------------------------------------------------------------------------- relay.source_saved (§9)

  describe("relay.source_saved coalescing (§9)", () => {
    const save = (w: ReturnType<Mod["writer"]["createDbAuditWriter"]>, rev: number, user = "usr_1") =>
      w.write({
        orgId: ORG,
        actor: { type: "user", id: user, label: "ada@example.test" },
        action: "relay.source_saved",
        target: { type: "relay", id: "rl_1" },
        metadata: { rev, via: "studio", hash: `h${rev}` },
      });

    it("collapses a burst of autosaves to one row per window, per user and relay", async () => {
      const w = m.writer.createDbAuditWriter({ db: t.db, coalesceMs: 600_000 });
      await save(w, 1);
      await save(w, 2);
      await save(w, 3);
      expect(await rowCount(ORG)).toBe(1);
    });

    it("writes again once the window has passed", async () => {
      let now = Date.parse("2026-09-26T10:00:00.000Z");
      const w = m.writer.createDbAuditWriter({ db: t.db, coalesceMs: 600_000, now: () => now });
      await save(w, 1);
      now += 599_000;
      await save(w, 2);
      expect(await rowCount(ORG), "still inside the ten minutes").toBe(1);
      now += 2_000;
      await save(w, 3);
      expect(await rowCount(ORG)).toBe(2);
    });

    it("never writes the same rev twice, even long after the window", async () => {
      let now = Date.parse("2026-09-26T10:00:00.000Z");
      const w = m.writer.createDbAuditWriter({ db: t.db, coalesceMs: 600_000, now: () => now });
      await save(w, 7);
      now += 86_400_000;
      await save(w, 7);
      expect(await rowCount(ORG)).toBe(1);
      await save(w, 8);
      expect(await rowCount(ORG)).toBe(2);
    });

    it("coalesces per user and per relay, not globally", async () => {
      const w = m.writer.createDbAuditWriter({ db: t.db, coalesceMs: 600_000 });
      await save(w, 1, "usr_1");
      await save(w, 1, "usr_2");
      await w.write({
        orgId: ORG,
        actor: { type: "user", id: "usr_1", label: "ada@example.test" },
        action: "relay.source_saved",
        target: { type: "relay", id: "rl_2" },
        metadata: { rev: 1, via: "studio" },
      });
      expect(await rowCount(ORG)).toBe(3);
    });

    it("does not coalesce any other action", async () => {
      const w = m.writer.createDbAuditWriter({ db: t.db, coalesceMs: 600_000 });
      for (let i = 0; i < 3; i++) {
        await w.write({
          orgId: ORG,
          actor: { type: "user", id: "usr_1", label: "ada@example.test" },
          action: "relay.published",
          target: { type: "relay", id: "rl_1" },
        });
      }
      expect(await rowCount(ORG)).toBe(3);
    });
  });

  // -------------------------------------------------------------------------------- 0003: append-only (§9)

  describe("the append-only trigger (0003)", () => {
    beforeEach(async () => {
      const w = m.writer.createDbAuditWriter({ db: t.db });
      await w.write({ orgId: ORG, actor: { type: "system", id: null, label: "s" }, action: "org.created" });
    });

    it("refuses an UPDATE", async () => {
      await expect(t.pool.query("update audit_log set action = 'org.deleted'")).rejects.toThrow(
        /audit_log is append-only/,
      );
    });

    it("refuses a DELETE outside a purge transaction", async () => {
      await expect(t.pool.query("delete from audit_log")).rejects.toThrow(/audit_log is append-only/);
    });

    it("refuses a TRUNCATE even inside a purge transaction (the statement-level guard)", async () => {
      await expect(
        t.pool.query("begin; set local changeover.audit_purge = 'on'; truncate audit_log; commit;"),
      ).rejects.toThrow(/audit_log is append-only/);
      await t.pool.query("rollback").catch(() => undefined);
    });

    it("allows the DELETE the retention purge makes", async () => {
      const before = await rowCount(ORG);
      expect(before).toBeGreaterThan(0);
      const r = await m.retention.purgeAuditRetention(t.db, Date.now() + 8 * 86_400_000);
      expect(r.total).toBe(before);
      expect(await rowCount(ORG)).toBe(0);
    });

    it("the escape hatch does not leak past its transaction", async () => {
      await t.pool.query("begin; set local changeover.audit_purge = 'on'; commit;");
      await expect(t.pool.query("delete from audit_log")).rejects.toThrow(/audit_log is append-only/);
    });
  });

  // ------------------------------------------------------------------------------------- retention (§3.5)

  describe("the retention purge", () => {
    async function writeAged(orgId: string, daysAgo: number): Promise<void> {
      const now = Date.now() - daysAgo * 86_400_000;
      await m.writer
        .createDbAuditWriter({ db: t.db, now: () => now })
        .write({ orgId, actor: { type: "system", id: null, label: "s" }, action: "org.created" });
    }

    it("keeps each org's rows for its own plan's window", async () => {
      // Free keeps 7 days; Pro keeps 90.
      await writeAged(ORG, 3);
      await writeAged(ORG, 30);
      await writeAged(OTHER, 30);
      await writeAged(OTHER, 200);

      const r = await m.retention.purgeAuditRetention(t.db);
      expect(r.byPlan.free).toBe(1);
      expect(r.byPlan.pro).toBe(1);
      expect(await rowCount(ORG)).toBe(1);
      expect(await rowCount(OTHER)).toBe(1);
    });

    it("keeps a deleted org's rows for the orphan window and then collects them", async () => {
      await writeAged("org_gone", 10);
      await writeAged("org_gone", 40);
      const r = await m.retention.purgeAuditRetention(t.db);
      expect(r.orphans).toBe(1);
      expect(await rowCount("org_gone"), "the 10-day-old row is inside the 30-day orphan window").toBe(1);
    });

    it("collects org-less rows the same way", async () => {
      await m.writer
        .createDbAuditWriter({ db: t.db, now: () => Date.now() - 40 * 86_400_000 })
        .write({ orgId: null, actor: { type: "user", id: "usr_1", label: "ada@x" }, action: "session.signed_in" });
      const r = await m.retention.purgeAuditRetention(t.db);
      expect(r.orphans).toBe(1);
    });

    it("the step shape WP12 mounts reports its counts", async () => {
      await writeAged(ORG, 30);
      const out = await m.retention.auditRetentionStep({ db: t.db, now: Date.now() });
      expect(out).toEqual({ audit: 1, auditOrphans: 0 });
    });
  });

  // --------------------------------------------------------------------------------------- the read model

  describe("reading a page (§9 read API)", () => {
    beforeEach(async () => {
      const w = m.writer.createDbAuditWriter({ db: t.db });
      for (let i = 0; i < 7; i++) {
        await w.write({
          orgId: i < 5 ? ORG : OTHER,
          actor: { type: "user", id: `usr_${i % 2}`, label: `u${i % 2}@x` },
          action: i % 2 === 0 ? "org.renamed" : "member.invited",
          target: { type: "organization", id: ORG },
          metadata: { i },
        });
      }
    });

    it("returns only the org's own rows, newest first", async () => {
      const page = await m.read.readAuditPage(ORG, {}, t.db);
      expect(page.rows).toHaveLength(5);
      const times = page.rows.map((r) => r.occurredAt);
      expect([...times].sort().reverse()).toEqual(times);
    });

    it("pages with a total order and never repeats a row", async () => {
      const seen: string[] = [];
      let cursor: string | null | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page: Awaited<ReturnType<Mod["read"]["readAuditPage"]>> = await m.read.readAuditPage(
          ORG,
          { limit: 2, ...(cursor ? { cursor } : {}) },
          t.db,
        );
        seen.push(...page.rows.map((r) => r.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it("filters by actor and by action", async () => {
      const byActor = await m.read.readAuditPage(ORG, { actor: "usr_0" }, t.db);
      expect(byActor.rows.every((r) => r.actor.id === "usr_0")).toBe(true);
      const byAction = await m.read.readAuditPage(ORG, { action: "member.invited" }, t.db);
      expect(byAction.rows.every((r) => r.action === "member.invited")).toBe(true);
      expect(byActor.rows.length + byAction.rows.length).toBeGreaterThan(0);
    });

    it("an unparsable cursor is a 400, not a silent first page", async () => {
      await expect(m.read.readAuditPage(ORG, { cursor: "not-a-cursor" }, t.db)).rejects.toMatchObject({
        code: "E_VALIDATION",
      });
    });

    it("a malformed date filter is a 400 too", async () => {
      await expect(m.read.readAuditPage(ORG, { from: "yesterday" }, t.db)).rejects.toMatchObject({
        code: "E_VALIDATION",
      });
    });
  });

  // ---------------------------------------------------------------------------------------------- actors

  describe("the actor label", () => {
    it("freezes a key as `cko_…` with only its last four characters", () => {
      const a = m.actor.actorOf(
        {
          kind: "api_key", userId: null, isAnonymous: false, orgId: ORG, orgKind: null, role: null,
          scopes: [], apiKeyId: "akr_abcd1234", plan: "pro", visitorId: "v", ipKey: "i", requestId: "r",
        },
        null,
      );
      expect(a).toEqual({ actorType: "api_key", actorId: "akr_abcd1234", actorLabel: "key cko_…1234" });
    });

    it("calls an anonymous session a guest, not a user", () => {
      const a = m.actor.actorOf({
        kind: "session", userId: "usr_9", isAnonymous: true, orgId: ORG, orgKind: "guest", role: "owner",
        scopes: [], apiKeyId: null, plan: "guest", visitorId: "v", ipKey: "i", requestId: "r",
      });
      expect(a.actorType).toBe("guest");
    });
  });
});

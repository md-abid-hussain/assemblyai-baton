/**
 * DrizzleTakeoverStore on real Postgres 17 (a throwaway database; skipped without DATABASE_URL): the arm transaction,
 * jsonb merges that preserve other packages' keys (WP3 protocol.freeze, WP6 metrics.disclosures), idempotent end
 * and the case status flips, and the adaptive-lead history query.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CaseStatus } from "../../../../src/core/contracts/case";
import { cases, takeovers } from "../../../../src/server/db/schema";
import { ARMABLE_CASE_STATUSES, DrizzleTakeoverStore } from "../../../../src/server/takeovers/store";
import { caseState, policy, runPlan } from "../../contracts/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "./_db";

describe.skipIf(!HAS_DB)("DrizzleTakeoverStore (real Postgres)", () => {
  let t: TestDb;
  let store: DrizzleTakeoverStore;
  const now = new Date("2026-09-25T10:00:00Z");

  beforeAll(async () => {
    t = await createTestDb("wp5store");
    store = new DrizzleTakeoverStore(() => t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  async function addCase(id: string, status: CaseStatus = "shadowing") {
    await t.db.insert(cases).values({
      id, mode: "watch", callId: "call_s01", scenarioId: "s01", policy: policy as unknown as Record<string, unknown>,
      state: caseState(id) as unknown as Record<string, unknown>, status, visitorId: "vis_1", ipKey: "ip_1",
      runPlan: { ...runPlan, caseId: id } as unknown as Record<string, unknown>,
    });
  }
  const caseStatus = async (id: string) => (await t.db.select({ s: cases.status }).from(cases).where(eq(cases.id, id)))[0]?.s;
  const arm = (id: string, caseId: string, o: { tArmMs?: number } = {}) =>
    store.createArmed({ id, caseId, tArmMs: o.tArmMs ?? 61_234.625, midUtterance: true, protocol: { source: "manual", runId: "run_1", timings: {} }, fromStatuses: ARMABLE_CASE_STATUSES, maxPerCase: 3, now });

  it("loadCase returns the run plan and policy", async () => {
    await addCase("c_load");
    const c = await store.loadCase("c_load");
    expect(c).toMatchObject({ id: "c_load", status: "shadowing", visitorId: "vis_1", runPlan: { runId: "run_1", aiHalf: "live" }, scenarioId: "s01" });
    expect(c?.policy.policyNumber).toBe(policy.policyNumber);
    expect(await store.loadCase("nope")).toBeNull();
  });

  it("createArmed inserts the row (fractional tArm) and flips the case; a second arm conflicts; 3 per case", async () => {
    await addCase("c_arm");
    expect(await arm("tko_a1", "c_arm")).toBe("ok");
    expect(await caseStatus("c_arm")).toBe("armed");
    const r = await store.load("tko_a1");
    expect(r).toMatchObject({ caseId: "c_arm", tArmMs: 61_234.625, midUtterance: true, phase: "armed", retries: 0, outcome: null, endedAt: null, hasSnapshot: false });
    expect(r?.armedAt.toISOString()).toBe(now.toISOString());
    expect(await arm("tko_a2", "c_arm")).toBe("conflict");
    // hand-backs allow new passes up to the limit
    for (const id of ["tko_a1", "tko_b", "tko_c"]) {
      if (id !== "tko_a1") expect(await arm(id, "c_arm")).toBe("ok");
      await store.end(id, { outcome: "handed_back", vaSessionId: null, reason: "x", endedAt: now, phase: "done" });
      expect(await caseStatus("c_arm")).toBe("handed_back");
    }
    expect(await arm("tko_d", "c_arm")).toBe("limit");
    expect(await arm("tko_e", "missing_case")).toBe("conflict");
  });

  it("concurrent arms of one case: exactly one wins", async () => {
    await addCase("c_race");
    const rs = await Promise.all([arm("tko_r1", "c_race"), arm("tko_r2", "c_race"), arm("tko_r3", "c_race")]);
    expect(rs.filter((r) => r === "ok")).toHaveLength(1);
    expect(rs.filter((r) => r === "conflict")).toHaveLength(2);
  });

  it("saveCompiled and recordEvents merge jsonb and keep other packages' keys", async () => {
    await addCase("c_merge");
    await arm("tko_m", "c_merge");
    // WP3's freezeSnapshot writes protocol.freeze; WP6 writes metrics.disclosures
    await t.db.update(takeovers).set({
      protocol: sql`${takeovers.protocol} || ${JSON.stringify({ freeze: { takeoverId: "tko_m", tArmMs: 61_234.625 } })}::jsonb`,
      metrics: sql`${takeovers.metrics} || ${JSON.stringify({ disclosures: { premium_change: { text: "…" } } })}::jsonb`,
    }).where(eq(takeovers.id, "tko_m"));
    await store.saveCompiled("tko_m", { greeting: "Hi Priya", systemPromptHash: "ab".repeat(32), promptVersion: "1a2b3c4d", stage: "confirm", vaSessionCapMs: 165_000.4, phase: "compiling", protocol: { drain: { cut: ["customer-7"] }, compile: { by: "server" } } });
    await store.recordEvents("tko_m", { phase: "active", timings: { sessionUpdateSent: 2612.5, firstAudiblePlayed: 3480.25 }, vaSessionId: "sess_A", hud: { click_to_first_audible: 3480.25 } });
    await store.recordEvents("tko_m", { timings: { closing: 91_000 }, hud: { dead_air_after_rep: 410 }, provisionalQa: { reAsked: 0 } });
    const failAt = new Date("2026-09-25T10:00:04Z");
    await store.recordEvents("tko_m", { failureAt: failAt, failureCode: "E_VA_TIMEOUT" });
    await store.recordEvents("tko_m", {}); // no-op
    const r = (await store.load("tko_m"))!;
    expect(r).toMatchObject({ greeting: "Hi Priya", stage: "confirm", vaSessionCapMs: 165_000, phase: "active", vaSessionId: "sess_A" });
    expect(r.lastFailureAt?.toISOString()).toBe(failAt.toISOString());
    expect(r.protocol).toMatchObject({
      source: "manual",
      freeze: { takeoverId: "tko_m" },
      drain: { cut: ["customer-7"] },
      compile: { by: "server" },
      timings: { sessionUpdateSent: 2612.5, firstAudiblePlayed: 3480.25, closing: 91_000 },
      failures: { [failAt.toISOString()]: "E_VA_TIMEOUT" },
    });
    expect(r.metrics).toEqual({
      disclosures: { premium_change: { text: "…" } },
      hud: { click_to_first_audible: 3480.25, dead_air_after_rep: 410 },
      provisionalQa: { reAsked: 0 },
    });
  });

  it("end is idempotent, flips the case to the outcome only from armed/ai_active, and keeps the job id", async () => {
    await addCase("c_end");
    await arm("tko_end", "c_end");
    await t.db.update(cases).set({ status: "ai_active" }).where(eq(cases.id, "c_end"));
    const first = await store.end("tko_end", { outcome: "completed", vaSessionId: "sess_Z", reason: "close_ready", endedAt: now, phase: "done" });
    expect(first.first).toBe(true);
    expect(first.record).toMatchObject({ outcome: "completed", phase: "done", vaSessionId: "sess_Z" });
    expect(first.record?.protocol.end).toMatchObject({ outcome: "completed", reason: "close_ready" });
    expect(await caseStatus("c_end")).toBe("completed");
    await store.setVerificationJob("tko_end", "job_42");
    const again = await store.end("tko_end", { outcome: "abandoned", vaSessionId: null, reason: "pagehide", endedAt: now, phase: "done" });
    expect(again.first).toBe(false);
    expect(again.record).toMatchObject({ outcome: "completed", metrics: { verificationJobId: "job_42" } });
    expect(await caseStatus("c_end")).toBe("completed");
    expect(await store.end("nope", { outcome: "failed", vaSessionId: null, reason: null, endedAt: now, phase: "failed" })).toEqual({ first: false, record: null });
  });

  it("recentLeadTimings returns only takeovers with both timings, newest first", async () => {
    await addCase("c_lead");
    const ids = ["tko_l1", "tko_l2", "tko_l3"];
    for (const [i, id] of ids.entries()) {
      await t.db.insert(takeovers).values({ id, caseId: "c_lead", armedAt: new Date(now.getTime() + i * 1000), tArmMs: 1, protocol: {} });
    }
    await store.recordEvents("tko_l1", { timings: { sessionUpdateSent: 100, firstAudiblePlayed: 900 } });
    await store.recordEvents("tko_l2", { timings: { sessionUpdateSent: 100 } });
    await store.recordEvents("tko_l3", { timings: { sessionUpdateSent: 200, firstAudiblePlayed: 1300 } });
    const rows = await store.recentLeadTimings(20);
    const mine = rows.filter((r) => r.sessionUpdateSent === 100 || r.sessionUpdateSent === 200);
    expect(mine).toEqual([
      { sessionUpdateSent: 200, firstAudiblePlayed: 1300 },
      { sessionUpdateSent: 100, firstAudiblePlayed: 900 },
    ]);
  });
});

/**
 * The portable job runner (DESIGN §4.5): lease, one step per advance, retry/backoff/failed, tick, the per-process
 * in-process worker guard, and the sweeper's default verify_takeover enqueue for stale VA slots.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { jobs } from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import { defaultLimitsConfig } from "@/server/limits/config";
import { DbLimitsAuthority } from "@/server/limits/db-authority";
import { DbJobRunner, installBuiltinSteps, startInprocWorker, stopInprocWorker, type JobStep } from "@/server/jobs/runner";
import { registerStaleVaHandler, setFallbackVerificationEnqueue, sweepRegistry } from "@/server/registry/sweeper";
import { createTestDb, fakeClock, HAS_DB, type TestDb } from "../limits/helpers/test-db";

describe.skipIf(!HAS_DB)("DbJobRunner (real Postgres)", () => {
  let t: TestDb;
  let clock: ReturnType<typeof fakeClock>;
  let runner: DbJobRunner;
  let steps: Map<string, JobStep>;

  beforeAll(async () => {
    t = await createTestDb("jobs");
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.execute(sql`truncate jobs, live_sessions, spend_ledger`);
    clock = fakeClock("2026-10-01T10:00:00.000Z");
    steps = new Map();
    runner = new DbJobRunner(t.db, clock.now, steps as never);
  });
  afterEach(() => {
    registerStaleVaHandler(null);
    setFallbackVerificationEnqueue(null);
  });

  const row = async (id: string) => (await t.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

  it("runs one step per advance, persists state, and schedules the next step", async () => {
    const seen: unknown[] = [];
    runner.register("verify_takeover", async (job) => {
      seen.push(job.state);
      const n = ((job.state as { n?: number } | null)?.n ?? 0) + 1;
      return { state: { n }, next: n < 3 ? { afterMs: 3000 } : "done" };
    });
    const id = await runner.enqueue("verify_takeover", "tko1", { state: { n: 0 } });
    expect(await runner.advance(id)).toBe("pending");
    expect(await row(id)).toMatchObject({ status: "pending", state: { n: 1 } });
    expect(await runner.advance(id)).toBe("pending"); // not due yet: no step ran
    expect(seen).toHaveLength(1);
    clock.advance(3000);
    expect(await runner.advance(id)).toBe("pending");
    clock.advance(3000);
    expect(await runner.advance(id)).toBe("done");
    expect(seen).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
    expect(await runner.advance(id)).toBe("done");
  });

  it("a throwing step is retried with backoff and fails after 3 consecutive throws; errors are scrubbed", async () => {
    runner.register("purge", async () => {
      throw new Error("boom ?token=supersecretvalue123");
    });
    const id = await runner.enqueue("purge", "d");
    expect(await runner.advance(id)).toBe("pending");
    expect((await row(id)).attempts).toBe(1);
    clock.advance(2000);
    expect(await runner.advance(id)).toBe("pending");
    clock.advance(4000);
    expect(await runner.advance(id)).toBe("failed");
    const r = await row(id);
    expect(r.attempts).toBe(3);
    expect(r.lastError).toContain("boom");
    expect(r.lastError).not.toContain("supersecretvalue123");
  });

  it("the lease makes concurrent advances run the step once", async () => {
    let calls = 0;
    runner.register("va_audit", async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return { state: null, next: "done" };
    });
    const id = await runner.enqueue("va_audit", "x");
    const out = await Promise.all([runner.advance(id), runner.advance(id), runner.advance(id)]);
    expect(calls).toBe(1);
    expect(out.filter((s) => s === "done")).toHaveLength(1);
  });

  it("a kind with no step in this process stays pending; tick advances due jobs; enqueueOnce dedupes", async () => {
    const orphan = await runner.enqueue("budget_guard", "x");
    expect(await runner.advance(orphan)).toBe("pending");
    runner.register("purge", async () => ({ state: { ok: true }, next: "done" }));
    const a = await runner.enqueue("purge", "a");
    const b = await runner.enqueue("purge", "b", { runAfterMs: 60_000 });
    expect(await runner.tick()).toBe(1);
    expect((await row(a)).status).toBe("done");
    expect((await row(b)).status).toBe("pending");
    clock.advance(61_000);
    expect(await runner.tick()).toBeGreaterThanOrEqual(1);
    expect((await row(b)).status).toBe("done");
    expect(await runner.enqueueOnce("purge", "a")).toBe(a);
    expect(await runner.enqueueOnce("purge", "c")).not.toBe(a);
  });

  it("a stale VA slot enqueues verify_takeover once for its takeover (default handler)", async () => {
    await installBuiltinSteps(runner);
    const a = new DbLimitsAuthority({ db: t.db, config: defaultLimitsConfig(), now: clock.now });
    await a.vaAcquire({ takeoverId: "tkoZ", attempt: 0, capMs: 600_000, source: "judge", deployId: "dev-test" });
    await a.report({ sessionId: "va_tkoZ_0", kind: "va", event: "opened", providerSessionId: "sess_Z" });
    clock.advance(31_000);
    expect((await sweepRegistry(a)).staleVa).toBe(1);
    clock.advance(31_000);
    await sweepRegistry(a);
    const vj = await t.db.select().from(jobs).where(eq(jobs.kind, "verify_takeover"));
    expect(vj).toHaveLength(1);
    expect(vj[0]).toMatchObject({ refId: "tkoZ", state: { vaSessionId: "sess_Z", from: "sweeper" } });
  });
});

describe("startInprocWorker", () => {
  afterEach(() => {
    stopInprocWorker();
    delete process.env.ENABLE_INPROC_WORKER;
    resetEnvCache();
  });

  it("is idempotent per process (globalThis guard) and off unless ENABLE_INPROC_WORKER=1", () => {
    const g = globalThis as { __batonInprocWorker?: unknown };
    delete process.env.ENABLE_INPROC_WORKER;
    resetEnvCache();
    startInprocWorker();
    expect(g.__batonInprocWorker).toBeUndefined();
    process.env.ENABLE_INPROC_WORKER = "1";
    resetEnvCache();
    startInprocWorker();
    const first = g.__batonInprocWorker;
    expect(first).toBeTruthy();
    startInprocWorker();
    startInprocWorker();
    expect(g.__batonInprocWorker).toBe(first);
    stopInprocWorker();
    expect(g.__batonInprocWorker).toBeUndefined();
  });
});

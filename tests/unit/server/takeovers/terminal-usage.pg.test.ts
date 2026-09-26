/**
 * WP14b·4 — the terminal transition's SaaS half on real Postgres (SAAS §4.5, §7).
 *
 * The acceptance line is "the events and usage rows are idempotent on a replayed terminal transition", so that is
 * what this pins: a second `/end` on an already-ended takeover writes no second event and no second usage row,
 * and a case with no org writes nothing at all (the v2 device path is unchanged).
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { DomainEvents, UsageMeter } from "../../../../src/core/contracts/v3";
import type { UsageRecord } from "../../../../src/core/contracts/v3/usage";
import { cases } from "../../../../src/server/db/schema";
import { resetSaasPorts, setDomainEvents, setUsageMeter } from "../../../../src/server/saas/ports";
import { ARMABLE_CASE_STATUSES, DrizzleTakeoverStore } from "../../../../src/server/takeovers/store";
import { billableMinutes, runLinks } from "../../../../src/server/takeovers/terminal-usage";
import { caseState, policy, runPlan } from "../../contracts/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "./_db";

describe.skipIf(!HAS_DB)("the terminal transition records the run (WP14b·4)", () => {
  let t: TestDb;
  let store: DrizzleTakeoverStore;
  const now = new Date("2026-09-26T10:00:00Z");

  /** Collecting fakes for the two ports, with the real idempotency rule applied to usage. */
  let events: { orgId: string; type: string; dedupeKey?: string; data: unknown }[] = [];
  let usage: UsageRecord[] = [];

  const fakeEvents: DomainEvents = {
    async emit(e) {
      const seen = events.some((x) => x.dedupeKey && x.dedupeKey === e.dedupeKey);
      if (!seen) events.push(e);
      return { eventId: e.dedupeKey ?? "evt", created: !seen };
    },
  };
  const fakeUsage: UsageMeter = {
    async record(u) {
      if (!usage.some((x) => x.idempotencyKey === u.idempotencyKey)) usage.push(u);
    },
    async summary() {
      throw new Error("not used");
    },
  };

  beforeAll(async () => {
    t = await createTestDb("wp14b4term");
    store = new DrizzleTakeoverStore(() => t.db);
  }, 60_000);
  afterAll(async () => {
    resetSaasPorts();
    await t?.drop();
  });
  afterEach(() => {
    events = [];
    usage = [];
  });

  async function addCase(id: string, orgId: string | null) {
    await t.db.insert(cases).values({
      id, mode: "watch", callId: "call_s01", scenarioId: "s01", policy: policy as unknown as Record<string, unknown>,
      state: caseState(id) as unknown as Record<string, unknown>, status: "shadowing", visitorId: "vis_1", ipKey: "ip_1",
      runPlan: { ...runPlan, caseId: id } as unknown as Record<string, unknown>, orgId,
    });
  }
  /** Arm from `shadowing` (the only armable status), then move the case to `ai_active` as a live run would. */
  const arm = async (id: string, caseId: string) => {
    const r = await store.createArmed({ id, caseId, tArmMs: 61_234, midUtterance: false, protocol: { source: "manual", runId: "run_1", timings: {} }, fromStatuses: ARMABLE_CASE_STATUSES, maxPerCase: 3, now });
    expect(r).toBe("ok");
    await t.db.update(cases).set({ status: "ai_active" }).where(eq(cases.id, caseId));
  };

  it("emits run.completed and both usage rows once; a replayed end adds nothing", async () => {
    setDomainEvents(fakeEvents);
    setUsageMeter(fakeUsage);
    await addCase("c_term", "org_alpha");
    await arm("tko_term", "c_term");

    const endedAt = new Date(now.getTime() + 90_000);
    const first = await store.end("tko_term", { outcome: "completed", vaSessionId: "sess_1", reason: "close_ready", endedAt, phase: "done" });
    expect(first.first).toBe(true);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ orgId: "org_alpha", type: "run.completed", dedupeKey: "run.completed:tko_term" });
    const data = events[0]!.data as Record<string, unknown>;
    expect(data).toMatchObject({ run_id: "tko_term", outcome: "completed", payment_status: "none", ended_at: endedAt.toISOString() });
    expect(data.links).toEqual(runLinks("tko_term"));

    expect(usage.map((u) => u.kind).sort()).toEqual(["ai_minutes", "live_run"]);
    expect(usage.find((u) => u.kind === "live_run")).toMatchObject({ orgId: "org_alpha", quantity: 1, caseId: "c_term", idempotencyKey: "live_run:tko_term" });

    // The replay: the row is already ended, so nothing is emitted and nothing is recorded a second time.
    const again = await store.end("tko_term", { outcome: "abandoned", vaSessionId: null, reason: "pagehide", endedAt, phase: "done" });
    expect(again.first).toBe(false);
    expect(events).toHaveLength(1);
    expect(usage).toHaveLength(2);
  });

  it("a case with no org writes nothing: the v2 device path is unchanged", async () => {
    setDomainEvents(fakeEvents);
    setUsageMeter(fakeUsage);
    await addCase("c_noorg", null);
    await arm("tko_noorg", "c_noorg");
    await store.end("tko_noorg", { outcome: "handed_back", vaSessionId: null, reason: null, endedAt: now, phase: "done" });
    expect(events).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it("a failing meter never fails the takeover", async () => {
    setDomainEvents({ async emit() { throw new Error("events are down"); } });
    setUsageMeter(fakeUsage);
    await addCase("c_boom", "org_beta");
    await arm("tko_boom", "c_boom");
    const r = await store.end("tko_boom", { outcome: "completed", vaSessionId: null, reason: null, endedAt: now, phase: "done" });
    expect(r.first).toBe(true);
    expect(r.record?.outcome).toBe("completed");
  });

  it("simulated and replayed runs are countable but never billable", () => {
    expect(billableMinutes("recorded", 90)).toBeCloseTo(1.5);
    expect(billableMinutes("published", 30)).toBeCloseTo(0.5);
    expect(billableMinutes("simulated", 90)).toBe(0);
    expect(billableMinutes("replay", 90)).toBe(0);
    expect(billableMinutes("recorded", -5)).toBe(0);
  });
});

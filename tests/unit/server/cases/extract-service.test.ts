/**
 * F1 extraction on real Postgres (TASKS WP3 acceptance 2 and 5, DESIGN §4.5 F1, §5.3 batching, §5.5.4 rule 2).
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaseState } from "@/core/contracts/case";
import type { DrainReport } from "@/core/contracts/takeover";
import { takeovers } from "@/server/db/schema";
import { batchSizeFor } from "@/server/cases/extract-service";
import { dialog, harness, newCase, shuffled, sleep, turnOf } from "./helpers/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "./helpers/test-db";

const comparable = (s: CaseState) => ({ fields: s.fields, readiness: s.readiness, conflicts: s.conflicts, callClockMs: s.callClockMs });

async function armAndFreeze(t: TestDb, h: ReturnType<typeof harness>, caseId: string, drain: Partial<DrainReport> = {}) {
  const takeoverId = `tko_${caseId.slice(0, 8)}`;
  await t.db.insert(takeovers).values({ id: takeoverId, caseId, tArmMs: drain.tArmMs ?? 52_000 });
  const d: DrainReport = {
    tArmMs: 52_000, tCutMs: 52_900, capHit: false, midUtterance: false, completedTurnIds: [], pendingTurnIds: [], cutTurnIds: [],
    waitedMs: 300, timings: {}, ...drain,
  };
  const snap = await h.repo.freezeSnapshot(caseId, takeoverId, d);
  return { takeoverId, snap };
}

describe.skipIf(!HAS_DB)("ExtractService (F1) on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("wp3_extract", { poolMax: 15 });
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("extracts a turn, returns its events with seq and bumps the version", async () => {
    const h = harness(t);
    const caseId = await newCase(h, { callId: null });
    const r = await h.service.handle(turnOf(caseId, dialog.turns[3]!));
    expect(r.skipped).toBeUndefined();
    expect(r.events.map((e) => e.field)).toEqual(["driver_full_name", "driver_dob", "driver_age"]);
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(r.state.version).toBe(1);
    expect(r.state.fields.driver_dob.status).toBe("PENDING");
    const turn = await h.repo.getTurn(caseId, "customer-1");
    expect(turn?.extractStatus).toBe("done");
    // readback by the other party verifies it
    const r2 = await h.service.handle(turnOf(caseId, dialog.turns[4]!));
    expect(r2.state.fields.driver_dob.status).toBe("VERIFIED");
    expect(r2.state.version).toBe(2);
  });

  it("is idempotent on (caseId, turnId): a repeat returns skipped:duplicate with the stored events, no second LLM call", async () => {
    const h = harness(t);
    const caseId = await newCase(h, { callId: null });
    const turn = turnOf(caseId, dialog.turns[5]!);
    const [a, b] = await Promise.all([h.service.handle(turn), h.service.handle(turn)]);
    const later = await h.service.handle(turn);
    expect(h.extractor.calls).toBe(1);
    const dup = [a, b].find((x) => x.skipped === "duplicate");
    expect(dup).toBeDefined();
    expect(dup!.events.map((e) => e.seq)).toEqual(a.skipped ? b.events.map((e) => e.seq) : a.events.map((e) => e.seq));
    expect(later.skipped).toBe("duplicate");
    expect(later.events).toHaveLength(3);
    expect(later.state.version).toBe(1);
  });

  it("batches only a backlog: >2 queued → up to 3 per luna call, else one turn per call", async () => {
    expect([0, 1, 2, 3, 4, 7].map((n) => batchSizeFor(n, 3))).toEqual([1, 1, 1, 3, 3, 3]);
    const h = harness(t, { latencyMs: (ids) => (ids.includes("rep-0") ? 1000 : 120) });
    const caseId = await newCase(h, { callId: null });
    const turns = dialog.turns.slice(0, 7).map((f) => turnOf(caseId, f));
    // G1: under the full parallel suite, DB timing decided which of 7 simultaneous calls ran first (flaky). Start rep-0
    // alone, wait until its luna call is in flight (held 1 s), then send the other 6 so they queue up behind it.
    const first = h.service.handle(turns[0]!);
    await vi.waitFor(() => expect(h.extractor.calls).toBe(1));
    await Promise.all([first, ...turns.slice(1).map((x) => h.service.handle(x))]);
    // 1 starts alone; 6 queue up → 3, then 3 → 3
    expect(h.extractor.batchSizes).toEqual([1, 3, 3]);
    expect(h.extractor.inputs[1]!.newTurns.map((x) => x.turnId)).toEqual(["customer-0", "rep-1", "customer-1"]);
    expect(h.extractor.inputs[1]!.recent.map((x) => x.turnId)).toEqual(["rep-0"]);
  });

  it("an upstream failure is a 200-style result: turn failed, state unchanged except the version", async () => {
    const h = harness(t, { failTurnIds: new Set(["customer-2"]) });
    const caseId = await newCase(h, { callId: null });
    const r = await h.service.handle(turnOf(caseId, dialog.turns[5]!));
    expect(r.events).toEqual([]);
    expect(r.status).toBe("failed");
    expect((await h.repo.getTurn(caseId, "customer-2"))?.extractStatus).toBe("failed");
  });

  it("acceptance 2: 20 turns in random order at 10/s = sequential application; no duplicate seq; ≤3 turns per luna call", async () => {
    // sequential reference
    const hs = harness(t);
    const seqCase = await newCase(hs, { callId: null });
    for (const f of dialog.turns) await hs.service.handle(turnOf(seqCase, f));
    const reference = (await hs.repo.loadRow(seqCase))!.state;

    // random order, 100 ms apart, with jittered luna latency
    const h = harness(t, { latencyMs: (ids) => 40 + ((ids.join("").length * 37) % 160) });
    const caseId = await newCase(h, { callId: null });
    const order = shuffled(dialog.turns, 7);
    const pending: Promise<unknown>[] = [];
    for (const f of order) {
      pending.push(h.service.handle(turnOf(caseId, f)));
      await sleep(100);
    }
    const results = await Promise.all(pending);
    expect(results).toHaveLength(20);
    const final = (await h.repo.loadRow(caseId))!.state;
    expect(comparable(final)).toEqual(comparable(reference));
    const facts = await h.repo.listFacts(caseId);
    const seqs = facts.map((f) => f.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(facts.length).toBe((await hs.repo.listFacts(seqCase)).length);
    expect(Math.max(...h.extractor.batchSizes)).toBeLessThanOrEqual(3);
    expect(h.extractor.maxConcurrent).toBe(1); // one extraction per case at a time
  });

  it("acceptance 2: no pool exhaustion with 3 concurrent cases + payment polling on a 15-connection pool", async () => {
    const h = harness(t, { latencyMs: () => 150 });
    const ids = [await newCase(h, { callId: null }), await newCase(h, { callId: null }), await newCase(h, { callId: null })];
    let polls = 0;
    let stop = false;
    const poller = (async () => {
      while (!stop) {
        await Promise.all(ids.map(async (id) => {
          await t.db.execute(sql`select id, status from payments where case_id = ${id}`);
          await h.repo.loadRow(id);
          polls++;
        }));
        await sleep(100);
      }
    })();
    const errors: unknown[] = [];
    await Promise.all(ids.map(async (caseId, k) => {
      const tasks: Promise<unknown>[] = [];
      for (const f of shuffled(dialog.turns, 100 + k)) {
        tasks.push(h.service.handle(turnOf(caseId, f)).catch((e) => errors.push(e)));
        await sleep(100);
      }
      await Promise.all(tasks);
    }));
    stop = true;
    await poller;
    expect(errors).toEqual([]);
    expect(polls).toBeGreaterThan(10);
    expect(t.pool.totalCount).toBeLessThanOrEqual(15);
    for (const id of ids) {
      const facts = await h.repo.listFacts(id);
      expect(new Set(facts.map((f) => f.seq)).size).toBe(facts.length);
      expect((await h.repo.loadRow(id))!.version).toBeGreaterThanOrEqual(7);
    }
  });

  it("acceptance 5: after the freeze a turn returns skipped:after_takeover and never alters takeovers.snapshot", async () => {
    const h = harness(t);
    const caseId = await newCase(h, { callId: null });
    for (const f of dialog.turns.slice(0, 8)) await h.service.handle(turnOf(caseId, f));
    const { takeoverId, snap } = await armAndFreeze(t, h, caseId, { tArmMs: 52_000, pendingTurnIds: ["rep-4"] });
    expect(snap.version).toBeGreaterThan(0);
    const row = await h.repo.loadRow(caseId);
    expect(row?.status).toBe("ai_active");
    expect(row?.tArmMs).toBe(52_000);

    const late = await h.service.handle(turnOf(caseId, dialog.turns[9]!, { late: true }));
    expect(late.skipped).toBe("after_takeover");
    expect(late.events).toEqual([]);
    expect((await h.repo.getTurn(caseId, "customer-4"))?.extractStatus).toBe("skipped");

    // a DrainReport.pending turn within 3 s is extracted and shown, the snapshot still never changes
    const pend = await h.service.handle(turnOf(caseId, dialog.turns[8]!, { late: true }));
    expect(pend.skipped).toBeUndefined();
    expect(pend.events.length).toBeGreaterThan(0);
    expect(pend.events.every((e) => e.late)).toBe(true);

    // outside the 3 s window even a pending id is skipped
    h.clock.t += 3_500;
    const [tko] = await t.db.select().from(takeovers).where(sql`${takeovers.id} = ${takeoverId}`);
    const again = await h.service.handle(turnOf(caseId, dialog.turns[10]!, { late: true }));
    expect(again.skipped).toBe("after_takeover");
    const [tko2] = await t.db.select().from(takeovers).where(sql`${takeovers.id} = ${takeoverId}`);
    expect(tko2!.snapshot).toEqual(tko!.snapshot);
    expect(tko2!.snapshot).toEqual(snap);

    // freezeSnapshot is idempotent: a compile retry gets the same frozen state
    const d: DrainReport = { tArmMs: 1, tCutMs: 2, capHit: false, midUtterance: false, completedTurnIds: [], pendingTurnIds: [], cutTurnIds: [], waitedMs: 0, timings: {} };
    expect(await h.repo.freezeSnapshot(caseId, takeoverId, d)).toEqual(snap);
  });

  it("freeze marks turns after tArm late and drain cut turns cut, and the snapshot stops trusting them", async () => {
    const h = harness(t);
    const caseId = await newCase(h, { callId: null });
    for (const f of dialog.turns.slice(0, 7)) await h.service.handle(turnOf(caseId, f)); // up to rep-3 (ends 44700)
    const before = (await h.repo.loadRow(caseId))!.state;
    expect(before.fields.license_state.status).toBe("VERIFIED"); // customer-2 stated, rep-3 read back
    const { snap } = await armAndFreeze(t, h, caseId, { tArmMs: 40_000, cutTurnIds: ["rep-3"] });
    const rep3 = await h.repo.getTurn(caseId, "rep-3");
    expect(rep3?.late).toBe(true);
    expect(rep3?.cut).toBe(true);
    expect((await h.repo.getTurn(caseId, "customer-2"))?.late).toBe(false);
    expect(snap.fields.license_state.status).toBe("PENDING");
    expect(snap.fields.driver_dob.status).toBe("VERIFIED");
  });
});

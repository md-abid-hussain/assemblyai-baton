/**
 * F2 background verifier (TASKS WP3 acceptance 3: "the verifier never upgrades; runs never overlap"; DESIGN §4.5 F2,
 * §5.4.3). Real Postgres, fake sol.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { VerifierResult } from "@/core/contracts/extract";
import type { SpendLedger } from "@/core/contracts/services";
import { takeovers, verifierRuns } from "@/server/db/schema";
import { VerifierRunner } from "@/server/cases/verifier-runner";
import { dialog, FakeVerifier, harness, newCase, sleep, turnOf } from "./helpers/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "./helpers/test-db";

type Fields = VerifierResult["fields"];
const agreeAll = (): Fields => [
  { field: "driver_full_name", value: "Maya Raman", support: "stated_and_confirmed", turnIds: ["customer-1"], quote: "Maya Raman" },
  { field: "license_state", value: "OH", support: "stated_and_confirmed", turnIds: ["customer-2"], quote: "Ohio" },
  // sol claims confirmation for fields luna only has as stated once
  { field: "vehicle_assignment", value: "veh1", support: "stated_and_confirmed", turnIds: ["customer-3"], quote: "The Civic" },
  { field: "garaging_zip", value: "44107", support: "stated_and_confirmed", turnIds: ["customer-3"], quote: "44107" },
  // and a field luna never saw
  { field: "license_number", value: "RX12345", support: "stated_and_confirmed", turnIds: ["customer-3"], quote: "44107" },
];

describe.skipIf(!HAS_DB)("VerifierRunner (F2)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("wp3_verifier");
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("never upgrades: sol's 'stated_and_confirmed' leaves PENDING fields PENDING and MISSING fields not VERIFIED", async () => {
    const h = harness(t, { verifierFields: agreeAll });
    const caseId = await newCase(h, { callId: null });
    for (const f of dialog.turns.slice(0, 8)) await h.service.handle(turnOf(caseId, f)); // customer-3 stated, not read back yet
    const before = (await h.repo.loadRow(caseId))!.state;
    expect(before.fields.vehicle_assignment?.status).toBe("PENDING");
    expect(before.fields.license_number?.status).toBe("MISSING");
    const r = await h.runner.maybeRun(caseId);
    expect(r).toMatchObject({ ran: true, applied: true });
    const after = (await h.repo.loadRow(caseId))!.state;
    expect(after.fields.vehicle_assignment?.status).toBe("PENDING");
    expect(after.fields.garaging_zip?.status).toBe("PENDING");
    expect(after.fields.license_number?.status).not.toBe("VERIFIED");
    for (const f of Object.keys(after.fields) as (keyof typeof after.fields)[]) {
      if (before.fields[f]!.status !== "VERIFIED") expect(after.fields[f]!.status).not.toBe("VERIFIED");
    }
    const [run] = await t.db.select().from(verifierRuns).where(eq(verifierRuns.caseId, caseId));
    expect(run).toBeDefined();
    expect((run!.result as { applied?: boolean }).applied).toBe(true);
  });

  it("a disagreement downgrades a VERIFIED field (verifier events are inserted for disagreements only)", async () => {
    const h = harness(t, {
      verifierFields: () => [
        { field: "driver_dob", value: "2009-03-15", support: "stated_once", turnIds: ["customer-1"], quote: "March 14th, 2009" },
        { field: "license_state", value: "OH", support: "stated_and_confirmed", turnIds: ["customer-2"], quote: "Ohio" },
      ],
    });
    const caseId = await newCase(h, { callId: null });
    for (const f of dialog.turns.slice(0, 7)) await h.service.handle(turnOf(caseId, f));
    expect((await h.repo.loadRow(caseId))!.state.fields.driver_dob?.status).toBe("VERIFIED");
    await h.runner.maybeRun(caseId);
    const after = (await h.repo.loadRow(caseId))!.state;
    expect(after.fields.driver_dob?.status).toBe("PENDING");
    expect(after.fields.driver_dob?.reason).toBe("verifier_disagrees");
    expect(after.fields.license_state?.status).toBe("VERIFIED");
    const facts = (await h.repo.listFacts(caseId)).filter((e) => e.kind === "verifier");
    expect(facts.map((e) => e.field)).toEqual(["driver_dob"]);
    expect(facts[0]).toMatchObject({ party: "verifier", extractor: "sol", turnId: null, confidence: "medium" });
  });

  it("runs never overlap: concurrent triggers during a slow run start exactly one; cadence, new-final and max-run gates", async () => {
    const h = harness(t, { verifierFields: () => [], verifierLatencyMs: 250 });
    const caseId = await newCase(h, { callId: null });
    await h.service.handle(turnOf(caseId, dialog.turns[1]!));
    const first = h.runner.maybeRun(caseId);
    const others = await Promise.all(Array.from({ length: 10 }, () => h.runner.maybeRun(caseId)));
    expect(others.every((o) => !o.ran && o.reason === "in_flight")).toBe(true);
    expect(await first).toMatchObject({ ran: true });
    expect(h.verifier.calls).toBe(1);
    expect(h.verifier.maxConcurrent).toBe(1);

    // < 15 s since the last start → too soon; ≥ 15 s but no new final → no_new_turns
    await h.service.handle(turnOf(caseId, dialog.turns[3]!));
    expect(await h.runner.maybeRun(caseId)).toEqual({ ran: false, reason: "too_soon" });
    h.clock.t += 15_000;
    expect(await h.runner.maybeRun(caseId)).toMatchObject({ ran: true });
    h.clock.t += 15_000;
    expect(await h.runner.maybeRun(caseId)).toEqual({ ran: false, reason: "no_new_turns" });

    // at most 8 runs per case
    for (let i = 4; i < 12; i++) {
      await h.service.handle(turnOf(caseId, dialog.turns[i]!));
      h.clock.t += 15_000;
      await h.runner.maybeRun(caseId);
    }
    expect(h.verifier.calls).toBe(8);
    await h.service.handle(turnOf(caseId, dialog.turns[12]!));
    h.clock.t += 15_000;
    expect(await h.runner.maybeRun(caseId)).toEqual({ ran: false, reason: "max_runs" });
  });

  it("extraction schedules F2 in the background; a burst of turns still yields one run at a time", async () => {
    const h = harness(t, { withVerifier: true, verifierFields: () => [], verifierLatencyMs: 120 });
    const caseId = await newCase(h, { callId: null });
    await Promise.all(dialog.turns.slice(0, 6).map((f) => h.service.handle(turnOf(caseId, f))));
    await Promise.all(h.deferred);
    expect(h.verifier.calls).toBe(1);
    expect(h.verifier.maxConcurrent).toBe(1);
  });

  it("a result that lands after the freeze is stored with applied:false and does not touch the state", async () => {
    const h = harness(t, {
      verifierLatencyMs: 200,
      verifierFields: () => [{ field: "driver_dob", value: "2010-01-01", support: "stated_once", turnIds: ["customer-1"], quote: "x" }],
    });
    const caseId = await newCase(h, { callId: null });
    for (const f of dialog.turns.slice(0, 5)) await h.service.handle(turnOf(caseId, f));
    const running = h.runner.maybeRun(caseId);
    await sleep(50);
    await t.db.insert(takeovers).values({ id: `tko_${caseId}`, caseId, tArmMs: 31_000 });
    const snap = await h.repo.freezeSnapshot(caseId, `tko_${caseId}`, {
      tArmMs: 31_000, tCutMs: 31_500, capHit: false, midUtterance: false, completedTurnIds: [], pendingTurnIds: [], cutTurnIds: [], waitedMs: 0, timings: {},
    });
    expect(await running).toMatchObject({ ran: true, applied: false, disagreements: 0 });
    const row = (await h.repo.loadRow(caseId))!;
    expect(row.state).toEqual(snap);
    expect(row.state.fields.driver_dob?.status).toBe("VERIFIED");
    const [run] = await t.db.select().from(verifierRuns).where(eq(verifierRuns.caseId, caseId));
    expect((run!.result as { applied?: boolean }).applied).toBe(false);
    // a later re-derive (e.g. an AI-half tool update) must not pick the late run up either
    const again = await h.repo.recompute(caseId);
    expect(again.fields.driver_dob?.status).toBe("VERIFIED");
  });

  it("the OpenAI budget gate: a refused reservation skips the run; a run settles its actual cost", async () => {
    const calls: string[] = [];
    const ledger = (ok: boolean): SpendLedger => ({
      reserve: async (e) => (calls.push(`reserve:${e.provider}:${e.action}`), ok ? { ok: true, id: "r1" } : { ok: false, code: "E_BUDGET" }),
      settle: async (id, usd) => void calls.push(`settle:${id}:${usd}`),
      release: async (id) => void calls.push(`release:${id}`),
      summary: async () => ({ sinceEpochUsd: 0, todayUsd: {}, dailyCapUsd: 0, judgingBudgetUsd: 0, pctToday: 0, byEnv: {} }),
    });
    const h = harness(t);
    const caseId = await newCase(h, { callId: null });
    await h.service.handle(turnOf(caseId, dialog.turns[1]!));
    const verifier = new FakeVerifier(() => []);
    const refused = new VerifierRunner({ repo: h.repo, engine: h.engine, verifier, ledger: () => ledger(false) });
    expect(await refused.maybeRun(caseId)).toEqual({ ran: false, reason: "budget" });
    expect(verifier.calls).toBe(0);
    const ok = new VerifierRunner({ repo: h.repo, engine: h.engine, verifier, ledger: () => ledger(true) });
    expect(await ok.maybeRun(caseId)).toMatchObject({ ran: true });
    expect(calls).toEqual(["reserve:openai:verifier", "reserve:openai:verifier", "settle:r1:0.01"]);
  });
});

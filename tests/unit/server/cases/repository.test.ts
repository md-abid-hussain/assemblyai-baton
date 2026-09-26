/**
 * `CaseRepository` seam used by other WPs (TASKS §2): create/load, idempotent turns, applyEvents (WP6 tool updates),
 * the non-derivable state parts under the lock, run plan, recompute.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NewFactEvent } from "@/core/contracts/case";
import type { RunPlan } from "@/core/contracts/run";
import { dialog, harness, newCase, turnOf } from "./helpers/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "./helpers/test-db";

describe.skipIf(!HAS_DB)("PgCaseRepository", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("wp3_repo");
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("create → load: shadowing, version 0, policy from the data source, every field MISSING", async () => {
    const h = harness(t);
    const caseId = await newCase(h);
    const c = await h.repo.load(caseId);
    expect(c).toMatchObject({ status: "shadowing", version: 0, tArmMs: null, scenarioId: "s01", callId: "s01_take1", runPlan: null });
    expect(c!.policy.vehicles.map((v) => v.label)).toEqual(["2021 Honda Civic", "2018 Toyota Highlander"]);
    expect(Object.values(c!.state.fields).every((f) => f.status === "MISSING")).toBe(true);
    expect(await h.repo.load("nope")).toBeNull();
    await expect(h.repo.create({ mode: "watch", callId: null, scenarioId: "s99", visitorId: "v", ipKey: "i" })).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  });

  it("insertTurn is idempotent on (caseId, turnId); fractional call-clock ms round-trip", async () => {
    const h = harness(t);
    const caseId = await newCase(h);
    const turn = { ...turnOf(caseId, dialog.turns[1]!), startMs: 5600.125, endMs: 10100.375, recvMs: 10520.625 };
    expect(await h.repo.insertTurn(turn)).toBe("inserted");
    expect(await h.repo.insertTurn(turn)).toBe("duplicate");
    const back = await h.repo.getTurn(caseId, "customer-0");
    expect(back).toMatchObject({ startMs: 5600.125, endMs: 10100.375, recvMs: 10520.625, extractStatus: "pending", turnId: "customer-0" });
  });

  it("applyEvents (a WP6 tool_update) assigns seq, bumps version and derives ai_confirmed", async () => {
    const h = harness(t);
    const caseId = await newCase(h);
    await h.service.handle(turnOf(caseId, dialog.turns[9]!)); // customer-4 states the effective date (seq 1)
    const row = (await h.repo.loadRow(caseId))!;
    const ev: NewFactEvent = {
      id: `${caseId}:tool:1`, caseId, field: "effective_date", kind: "tool_update", party: "ai", valueRaw: "2026-10-02", valueNorm: "2026-10-02",
      acknowledgesTurnId: null, confidence: "high", turnId: null, turnEndMs: 130_000.5, late: false, cut: false, evidence: null, extractor: "tool",
    };
    const r = await h.repo.applyEvents(caseId, row.version, [ev]);
    expect(r.version).toBe(row.version + 1);
    expect(r.state.fields.effective_date).toMatchObject({ status: "VERIFIED", reason: "ai_confirmed" });
    const facts = await h.repo.listFacts(caseId);
    expect(facts.at(-1)).toMatchObject({ id: ev.id, seq: 2, turnEndMs: 130_000.5 });
    // replaying the same event id is harmless
    const again = await h.repo.applyEvents(caseId, r.version, [ev]);
    expect((await h.repo.listFacts(caseId)).length).toBe(facts.length);
    expect(again.version).toBe(r.version + 1);
  });

  it("setCaseExtras keeps stage/disclosures/payment through later derivations; setRunPlan; recompute", async () => {
    const h = harness(t);
    const caseId = await newCase(h);
    const s = await h.repo.setCaseExtras(caseId, { stage: "pay", disclosuresGiven: ["premium_change"], confirmationNumber: "HB-123" });
    expect(s).toMatchObject({ stage: "pay", disclosuresGiven: ["premium_change"], confirmationNumber: "HB-123", version: 1 });
    const r = await h.service.handle(turnOf(caseId, dialog.turns[3]!));
    expect(r.state).toMatchObject({ stage: "pay", disclosuresGiven: ["premium_change"], confirmationNumber: "HB-123", version: 2 });
    const plan = { runId: "run_1" } as unknown as RunPlan;
    await h.repo.setRunPlan(caseId, plan);
    expect((await h.repo.load(caseId))!.runPlan).toEqual(plan);
    const re = await h.repo.recompute(caseId, { tArmMs: 20_000 });
    expect(re.version).toBe(3);
    expect(re.fields.driver_dob?.status).toBe("PENDING"); // customer-1 ended after the arm point
  });
});

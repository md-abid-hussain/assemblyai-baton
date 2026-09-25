/**
 * TakeoverService (DESIGN §4.4 #9, #11–#13, §5.5.4 rules 2 and 5) against in-memory fakes.
 */
import { describe, expect, it } from "vitest";

import { BatonError } from "../../../../src/core/contracts/errors";
import { TAKEOVER_TIMING as T } from "../../../../src/core/contracts/takeover";
import { computeLeadMs, sha256Hex } from "../../../../src/server/takeovers/service";
import { armReq, drainFor, harness, recordedPlan } from "./_fakes";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof BatonError) return e.code;
    throw e;
  }
  return "OK";
};

describe("arm (#9)", () => {
  it("inserts the takeover, flips the case to armed, re-issues the token with tko, returns leadMs", async () => {
    const h = harness();
    h.store.addCase({ id: "case_1" });
    const r = await h.svc.arm(armReq());
    expect(r).toEqual({ takeoverId: "tko_1", takeoverToken: "jwt.tko_1", leadMs: T.DEFAULT_LEAD_MS });
    expect(h.calls.tokens).toEqual([{ caseId: "case_1", visitorId: "vis_1", takeoverId: "tko_1" }]);
    const row = h.store.rows.get("tko_1")!;
    expect(row).toMatchObject({ caseId: "case_1", tArmMs: 61_234.5, midUtterance: true, phase: "armed" });
    expect(row.protocol).toMatchObject({ source: "manual", runId: "run_1" });
    expect(row.armedAt.getTime()).toBe(h.clock.t);
    expect(h.store.cases.get("case_1")!.status).toBe("armed");
  });

  it("refuses runs with aiHalf:recorded (409, recorded fallback)", async () => {
    const h = harness();
    h.store.addCase({ id: "case_1", runPlan: recordedPlan("case_1") });
    const e = await h.svc.arm(armReq()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BatonError);
    expect((e as BatonError).code).toBe("E_CASE_STATE");
    expect((e as BatonError).fallback).toBe("recorded_ai_session");
    expect(h.store.rows.size).toBe(0);
  });

  it("checks the case, visitor, run and status", async () => {
    const h = harness();
    expect(await code(h.svc.arm(armReq()))).toBe("E_NOT_FOUND");
    h.store.addCase({ id: "case_1" });
    expect(await code(h.svc.arm(armReq({ visitorId: "vis_other" })))).toBe("E_FORBIDDEN");
    expect(await code(h.svc.arm(armReq({ runId: "run_old" })))).toBe("E_CASE_STATE");
    h.store.addCase({ id: "case_2", runPlan: null });
    expect(await code(h.svc.arm(armReq({ caseId: "case_2" })))).toBe("E_CASE_STATE");
    h.store.addCase({ id: "case_3", status: "completed", runPlan: { ...recordedPlan("case_3"), aiHalf: "live" } });
    expect(await code(h.svc.arm(armReq({ caseId: "case_3" })))).toBe("E_CASE_STATE");
  });

  it("a second arm while one is running is a 409", async () => {
    const h = harness();
    h.store.addCase({ id: "case_1" });
    await h.svc.arm(armReq());
    expect(await code(h.svc.arm(armReq()))).toBe("E_CASE_STATE");
  });

  it("allows a new pass after a hand-back, up to 3 per case", async () => {
    const h = harness();
    h.store.addCase({ id: "case_1" });
    for (let i = 1; i <= 3; i++) {
      const r = await h.svc.arm(armReq());
      expect(r.takeoverId).toBe(`tko_${i}`);
      await h.svc.end(r.takeoverId, { outcome: "handed_back", vaSessionId: null, reason: "customer_request" });
      expect(h.store.cases.get("case_1")!.status).toBe("handed_back");
    }
    expect(await code(h.svc.arm(armReq()))).toBe("E_RATE_LIMITED");
  });

  it("leadMs = median(firstAudiblePlayed − sessionUpdateSent) of recent takeovers, clamped; history errors → default", async () => {
    const h = harness();
    h.store.addCase({ id: "case_1" });
    h.store.leadTimings = [
      { sessionUpdateSent: 4000, firstAudiblePlayed: 4700 },
      { sessionUpdateSent: 3000, firstAudiblePlayed: 4100 },
      { sessionUpdateSent: 5000, firstAudiblePlayed: 5800 },
    ];
    expect((await h.svc.arm(armReq())).leadMs).toBe(800);
    h.store.failLead = true;
    expect(await h.svc.leadMs()).toBe(T.DEFAULT_LEAD_MS);
  });
});

describe("computeLeadMs (rule 5)", () => {
  it("medians, clamps and ignores incomplete samples", () => {
    expect(computeLeadMs([])).toBe(900);
    expect(computeLeadMs([{ sessionUpdateSent: 1 }])).toBe(900);
    expect(computeLeadMs([{ sessionUpdateSent: 0, firstAudiblePlayed: 200 }])).toBe(500);
    expect(computeLeadMs([{ sessionUpdateSent: 0, firstAudiblePlayed: 4000 }])).toBe(1500);
    expect(computeLeadMs([{ sessionUpdateSent: 0, firstAudiblePlayed: 700 }, { sessionUpdateSent: 0, firstAudiblePlayed: 1000 }])).toBe(850);
    expect(computeLeadMs([{ sessionUpdateSent: 10, firstAudiblePlayed: 5 }, { sessionUpdateSent: 0, firstAudiblePlayed: 1100 }])).toBe(1100);
  });
});

describe("compile (#11)", () => {
  it("freezes the snapshot (WP3), compiles it (WP1), validates the first update, stores the compile facts", async () => {
    const h = harness();
    h.store.addCase({ id: "case_1" });
    const { takeoverId } = await h.svc.arm(armReq());
    const drain = drainFor(61_234.5, { cutTurnIds: ["customer-7"], pendingTurnIds: ["rep-9"] });
    const c = await h.svc.compile(takeoverId, drain);
    expect(h.calls.freeze).toEqual([{ caseId: "case_1", takeoverId, drain }]);
    expect(h.calls.compile).toHaveLength(1);
    expect(h.calls.compile[0]!.opts).toEqual({
      deployId: "dev-wp5", voice: "alba", keytermsEnabled: true, compiledBy: "server", payToolMode: "push",
      capEnv: { baseMs: 150_000, perFieldMs: 15_000, maxMs: 420_000 },
    });
    expect(c.snapshot.callClockMs).toBe(61_234.5);
    expect(h.calls.validate).toEqual([{ type: "session.update", session: { system_prompt: c.systemPrompt, greeting: c.greeting } }]);
    const row = h.store.rows.get(takeoverId)! as unknown as Record<string, unknown> & { protocol: Record<string, unknown> };
    expect(row.greeting).toBe(c.greeting);
    expect(row.stage).toBe(c.stage);
    expect(row.vaSessionCapMs).toBe(c.vaSessionCapMs);
    expect(row.systemPromptHash).toBe(sha256Hex(c.systemPrompt));
    expect(row.protocol.drain).toMatchObject({ cut: ["customer-7"], pending: ["rep-9"], capHit: false });
    expect(row.protocol.source).toBe("manual"); // merged, not overwritten
  });

  it("a first update that fails validation is an E_VA_CONFIG error and nothing is stored", async () => {
    const h = harness({ validate: () => { throw new BatonError("E_VA_CONFIG", "tool schema keyword"); } });
    h.store.addCase({ id: "case_1" });
    const { takeoverId } = await h.svc.arm(armReq());
    expect(await code(h.svc.compile(takeoverId, drainFor(61_234.5)))).toBe("E_VA_CONFIG");
    expect(h.store.rows.get(takeoverId)!.greeting).toBeNull();
  });

  it("refuses unknown and ended takeovers and a drain for another pass point", async () => {
    const h = harness();
    h.store.addCase({ id: "case_1" });
    expect(await code(h.svc.compile("tko_x", drainFor(1)))).toBe("E_NOT_FOUND");
    const { takeoverId } = await h.svc.arm(armReq());
    expect(await code(h.svc.compile(takeoverId, drainFor(99)))).toBe("E_BAD_REQUEST");
    await h.svc.end(takeoverId, { outcome: "abandoned", vaSessionId: null });
    expect(await code(h.svc.compile(takeoverId, drainFor(61_234.5)))).toBe("E_CASE_STATE");
  });
});

describe("recordEvents (#12)", () => {
  it("heartbeat → LimitsAuthority.heartbeat on the current attempt's slot", async () => {
    const h = harness();
    h.store.addCase({ id: "case_1" });
    const { takeoverId } = await h.svc.arm(armReq());
    await h.svc.recordEvents(takeoverId, { heartbeat: true, vaSessionId: "sess_A" });
    h.store.rows.get(takeoverId)!.retries = 1; // route #10 minted attempt 1
    await h.svc.recordEvents(takeoverId, { heartbeat: true });
    expect(h.calls.heartbeat).toEqual([`va_${takeoverId}_0`, `va_${takeoverId}_1`]);
    expect(h.store.rows.get(takeoverId)!.vaSessionId).toBe("sess_A");
  });

  it("failure sets last_failure_at (before the client mints attempt 1)", async () => {
    const h = harness();
    h.store.addCase({ id: "case_1" });
    const { takeoverId } = await h.svc.arm(armReq());
    h.clock.t += 4200;
    await h.svc.recordEvents(takeoverId, { failure: { code: "E_VA_TIMEOUT" } });
    expect(h.store.rows.get(takeoverId)!.lastFailureAt?.getTime()).toBe(h.clock.t);
  });

  it("phase, timings, hud and provisional QA are merged", async () => {
    const h = harness();
    h.store.addCase({ id: "case_1" });
    const { takeoverId } = await h.svc.arm(armReq());
    await h.svc.recordEvents(takeoverId, { phase: "active", timings: { sessionUpdateSent: 2600, firstAudiblePlayed: 3450 } });
    await h.svc.recordEvents(takeoverId, { timings: { closing: 90_000 }, hud: { click_to_first_audible: 3450 } });
    const row = h.store.rows.get(takeoverId)!;
    expect(row.phase).toBe("active");
    expect(row.protocol.timings).toEqual({ sessionUpdateSent: 2600, firstAudiblePlayed: 3450, closing: 90_000 });
    expect(row.metrics.hud).toEqual({ click_to_first_audible: 3450 });
  });

  it("after /end: phase, failure and heartbeat are ignored; late HUD numbers are still merged (WP8 reads them)", async () => {
    const h = harness();
    h.store.addCase({ id: "case_1" });
    const { takeoverId } = await h.svc.arm(armReq());
    await h.svc.end(takeoverId, { outcome: "completed", vaSessionId: "sess_A" });
    await h.svc.recordEvents(takeoverId, { heartbeat: true, phase: "active", failure: { code: "E_VA_SILENT" }, hud: { dead_air_after_rep: 380 } });
    expect(h.calls.heartbeat).toEqual([]);
    const row = h.store.rows.get(takeoverId)!;
    expect(row.phase).toBe("done");
    expect(row.lastFailureAt).toBeNull();
    expect(row.metrics.hud).toEqual({ dead_air_after_rep: 380 });
    expect(await code(h.svc.recordEvents("nope", { heartbeat: true }))).toBe("E_NOT_FOUND");
  });
});

describe("end (#13)", () => {
  it("sets the outcome, the case status, releases the slot and enqueues verification; idempotent", async () => {
    const h = harness();
    h.store.addCase({ id: "case_1" });
    const { takeoverId } = await h.svc.arm(armReq());
    await h.svc.compile(takeoverId, drainFor(61_234.5));
    const r = await h.svc.end(takeoverId, { outcome: "completed", vaSessionId: "sess_A", reason: "close_ready" });
    expect(r).toEqual({ verificationJobId: "job_1" });
    const row = h.store.rows.get(takeoverId)!;
    expect(row).toMatchObject({ outcome: "completed", phase: "done", vaSessionId: "sess_A" });
    expect(h.store.cases.get("case_1")!.status).toBe("completed");
    expect(h.calls.release).toEqual([{ id: `va_${takeoverId}_0`, reason: "takeover_completed" }]);
    expect(h.calls.verify).toEqual([{ takeoverId, vaSessionId: "sess_A" }]);
    // a second /end (pagehide after a normal end) changes nothing and returns the same job
    expect(await h.svc.end(takeoverId, { outcome: "abandoned", vaSessionId: null, reason: "pagehide" })).toEqual({ verificationJobId: "job_1" });
    expect(h.store.rows.get(takeoverId)!.outcome).toBe("completed");
    expect(h.calls.verify).toHaveLength(1);
  });

  it("failed → phase failed, case failed; a missing WP8 (null job) is fine", async () => {
    const h = harness({ verificationJobId: null });
    h.store.addCase({ id: "case_1" });
    const { takeoverId } = await h.svc.arm(armReq());
    h.store.rows.get(takeoverId)!.retries = 1;
    expect(await h.svc.end(takeoverId, { outcome: "failed", vaSessionId: null, reason: "E_VA_TIMEOUT" })).toEqual({ verificationJobId: null });
    expect(h.store.rows.get(takeoverId)!.phase).toBe("failed");
    expect(h.store.cases.get("case_1")!.status).toBe("failed");
    expect(h.calls.release[0]!.id).toBe(`va_${takeoverId}_1`);
  });

  it("a verification enqueue error never fails /end", async () => {
    const h = harness();
    h.deps.enqueueVerification = async () => { throw new Error("jobs table down"); };
    h.store.addCase({ id: "case_1" });
    const { takeoverId } = await h.svc.arm(armReq());
    expect(await h.svc.end(takeoverId, { outcome: "abandoned", vaSessionId: null })).toEqual({ verificationJobId: null });
  });
});

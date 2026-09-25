/**
 * WP2 acceptance 4 (POST /api/runs: live with a hold, or recorded with a plain reason; a hold expires and is released
 * by the sweeper; #5b release) and 5 (/api/va/token attempt/retry rules; a missing heartbeat frees a slot).
 * Route handlers in-process against real Postgres; token minting is faked (no network).
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RunPlanSchema } from "@/core/contracts/api";
import type { CallManifestEntry } from "@/core/contracts/scenario";
import { POST as releasePost } from "@/app/api/runs/[runId]/release/route";
import { POST as runsPost } from "@/app/api/runs/route";
import { POST as vaTokenPost } from "@/app/api/va/token/route";
import { cases, liveSessions, spendLedger, takeovers } from "@/server/db/schema";
import { defaultLimitsConfig } from "@/server/limits/config";
import { DbLimitsAuthority, vaSessionIdFor } from "@/server/limits/db-authority";
import { sweepRegistry } from "@/server/registry/sweeper";
import { registerCallLookup } from "@/server/runs/calls";
import { createTestDb, HAS_DB, type TestDb } from "../limits/helpers/test-db";
import { call, caseAuthHeaders, fakeMinter, insertCase, insertTakeover, setupRouteEnv, truncateAll, type RouteEnv } from "../limits/helpers/routes";

const CALL: CallManifestEntry = {
  callId: "s01_take1",
  scenarioId: "s01",
  title: "Add a teen driver",
  source: "twilio8k",
  language: "en",
  durationMs: 240_000,
  format: { encoding: "pcm_mulaw", sampleRate: 8000 },
  publishAudio: true,
  inEval: true,
  featured: true,
  picker: "main",
  decisionPointMs: 95_000,
  handoff: { lineStartMs: 95_000, lineEndMs: 98_000, acceptStartMs: 98_300, acceptEndMs: 99_000, declined: false },
  recordedAiBundle: "s01-main",
  customerTailPack: null,
  assets: null,
};

describe.skipIf(!HAS_DB)("runs (#5a/#5b) and VA token (#10) routes", () => {
  let t: TestDb;
  let env: RouteEnv;

  beforeAll(async () => {
    t = await createTestDb("runs");
    registerCallLookup((id) => (id === CALL.callId ? CALL : null));
  }, 60_000);
  afterAll(async () => {
    registerCallLookup(null);
    await t?.drop();
  });
  beforeEach(async () => {
    await truncateAll(t);
    env = await setupRouteEnv(t);
  });
  afterEach(async () => {
    await env.restore();
  });

  const startRun = async (caseId: string, visitorId: string, express = false) =>
    call(runsPost, { headers: await caseAuthHeaders(caseId, visitorId, { ip: `198.51.100.${caseId.length}` }), body: { caseId, callId: CALL.callId, express } });

  it("aiHalf live with a held VA slot and the VA budget reserved; the plan is saved on the case", async () => {
    await insertCase(t, { id: "case1", visitorId: "vis1" });
    const r = await startRun("case1", "vis1", true);
    expect(r.status).toBe(200);
    const plan = RunPlanSchema.parse(r.body);
    expect(plan).toMatchObject({ caseId: "case1", sttHalf: "live", aiHalf: "live", reason: null, recordedHandoffMs: null });
    const [hold] = await t.db.select().from(liveSessions).where(eq(liveSessions.id, plan.vaHoldId!));
    expect(hold).toMatchObject({ kind: "va", status: "held", caseId: "case1", runId: plan.runId });
    // Express: remaining = 240 − (95 − 25) = 170 s; the hold expires at remaining + 60 s.
    const ttl = Date.parse(plan.holdExpiresAt!) - Date.now();
    expect(ttl).toBeGreaterThan(225_000);
    expect(ttl).toBeLessThanOrEqual(230_000);
    const [l] = await t.db.select().from(spendLedger).where(eq(spendLedger.id, hold!.ledgerId!));
    expect(l).toMatchObject({ provider: "aai_va", status: "reserved", estUsd: 0.525 });
    const [c] = await t.db.select({ runPlan: cases.runPlan }).from(cases).where(eq(cases.id, "case1"));
    expect(c?.runPlan).toMatchObject({ runId: plan.runId });
  });

  it("aiHalf recorded with a plain reason when the VA slots are exhausted", async () => {
    for (let i = 1; i <= 4; i++) await insertCase(t, { id: `case${i}`, visitorId: `vis${i}` });
    for (let i = 1; i <= 3; i++) expect(RunPlanSchema.parse((await startRun(`case${i}`, `vis${i}`)).body).aiHalf).toBe("live");
    const plan = RunPlanSchema.parse((await startRun("case4", "vis4")).body);
    expect(plan).toMatchObject({ aiHalf: "recorded", vaHoldId: null, recordedHandoffMs: 95_000, sttHalf: "live" });
    expect(plan.reason).toBe("Live AI is busy right now: you'll watch the recorded AI session at Daniel's handoff line (01:35).");
  });

  it("aiHalf recorded (and cached STT) when today's budget is used up", async () => {
    await insertCase(t, { id: "case1", visitorId: "vis1" });
    await env.flags.set({ mode: "replay_only" }, "budget_daily");
    const plan = RunPlanSchema.parse((await startRun("case1", "vis1")).body);
    expect(plan).toMatchObject({ aiHalf: "recorded", sttHalf: "cached", vaHoldId: null });
    expect(plan.reason).toContain("Today's live AI budget is used up");
    expect(plan.reason).toContain("labelled replay");
  });

  it("aiHalf recorded when the ledger refuses the VA reservation (dev guard)", async () => {
    await insertCase(t, { id: "case1", visitorId: "vis1" });
    await env.authority.ledger.reserve({ provider: "aai_stt", action: "x", refId: "x", estUsd: 2.9, env: "dev-other" });
    const plan = RunPlanSchema.parse((await startRun("case1", "vis1")).body);
    expect(plan.aiHalf).toBe("recorded"); // 2.9 + 0.525 > $3 (dev guard)
    expect(plan.sttHalf).toBe("live"); // 2.9 + 2 × (270 s × $0.45/h) = 2.97 still fits
    expect(plan.reason).toMatch(/budget/i);
  });

  it("a hold expires and the sweeper releases it (and its reservation)", async () => {
    await insertCase(t, { id: "case1", visitorId: "vis1" });
    const plan = RunPlanSchema.parse((await startRun("case1", "vis1")).body);
    const later = new DbLimitsAuthority({ db: t.db, config: defaultLimitsConfig(), now: () => Date.parse(plan.holdExpiresAt!) + 1000 });
    expect((await sweepRegistry(later)).holdsReleased).toBe(1);
    const [hold] = await t.db.select().from(liveSessions).where(eq(liveSessions.id, plan.vaHoldId!));
    expect(hold?.status).toBe("released");
    const [l] = await t.db.select().from(spendLedger).where(eq(spendLedger.id, hold!.ledgerId!));
    expect(l?.status).toBe("released");
  });

  it("#5b releases an unused hold; a runId of another case is ignored; a new Start supersedes the old hold", async () => {
    await insertCase(t, { id: "case1", visitorId: "vis1" });
    await insertCase(t, { id: "case2", visitorId: "vis2" });
    const p1 = RunPlanSchema.parse((await startRun("case1", "vis1")).body);
    const p2 = RunPlanSchema.parse((await startRun("case2", "vis2")).body);
    // case2's token cannot release case1's run.
    expect((await call(releasePost, { headers: await caseAuthHeaders("case2", "vis2"), params: { runId: p1.runId } })).status).toBe(200);
    expect((await env.authority.session(p1.vaHoldId!))?.status).toBe("held");
    expect((await call(releasePost, { headers: await caseAuthHeaders("case1", "vis1"), params: { runId: p1.runId } })).body).toEqual({ ok: true });
    expect((await env.authority.session(p1.vaHoldId!))?.status).toBe("released");
    const p2b = RunPlanSchema.parse((await startRun("case2", "vis2")).body);
    expect((await env.authority.session(p2.vaHoldId!))?.status).toBe("released");
    expect((await env.authority.session(p2b.vaHoldId!))?.status).toBe("held");
  });

  it("runs are rate limited at 10/h per visitor", async () => {
    await insertCase(t, { id: "case1", visitorId: "vis1" });
    for (let i = 0; i < 10; i++) expect((await startRun("case1", "vis1")).status).toBe(200);
    const r = await startRun("case1", "vis1");
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("E_RATE_LIMITED");
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------------------------------ #10

  async function armed(o: { armedAgoMs?: number; failureAgoMs?: number | null; retries?: number; plan?: boolean } = {}) {
    await insertCase(t, { id: "caseA", visitorId: "visA" });
    let holdId: string | null = null;
    if (o.plan !== false) holdId = RunPlanSchema.parse((await startRun("caseA", "visA")).body).vaHoldId;
    await t.db.update(cases).set({ status: "armed" }).where(eq(cases.id, "caseA"));
    await insertTakeover(t, {
      id: "tkoA",
      caseId: "caseA",
      armedAt: new Date(Date.now() - (o.armedAgoMs ?? 1000)),
      retries: o.retries ?? 0,
      lastFailureAt: o.failureAgoMs == null ? null : new Date(Date.now() - o.failureAgoMs),
    });
    return holdId;
  }
  const mint = async (attempt: 0 | 1, takeoverId = "tkoA") =>
    call(vaTokenPost, { headers: await caseAuthHeaders("caseA", "visA", { takeoverId }), body: { takeoverId, attempt } });

  it("attempt 0 within 30 s of arm: the run's held slot becomes open under va_<tko>_0 with its reservation", async () => {
    const holdId = await armed();
    const heldLedger = (await env.authority.session(holdId!))?.ledgerId;
    expect(heldLedger).toBeTruthy();
    const r = await mint(0);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ expiresInSeconds: 10, liveSessionId: vaSessionIdFor("tkoA", 0) });
    expect(r.body.token).toMatch(/^fake-va-token/);
    const hold = await env.authority.session(holdId!);
    const open = await env.authority.session(vaSessionIdFor("tkoA", 0));
    expect(hold?.status).toBe("released");
    expect(open).toMatchObject({ status: "open", caseId: "caseA", capMs: 600_000, ledgerId: heldLedger });
    expect(hold?.ledgerId).toBeNull(); // the reservation moved to the open row
    // A second attempt-0 mint for the same takeover is refused.
    const again = await mint(0);
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.body.error.fallback).toBe("recorded_ai_session");
  });

  it("attempt 0 is refused after 30 s; attempt 1 without a recorded failure is refused", async () => {
    await armed({ armedAgoMs: 31_000 });
    const late = await mint(0);
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({ code: "E_CASE_STATE", fallback: "recorded_ai_session" });
    expect((await mint(1)).status).toBe(409);
  });

  it("attempt 1 once within 30 s of last_failure_at: releases the failed slot first, sets retries=1 atomically", async () => {
    await armed();
    expect((await mint(0)).status).toBe(200);
    // Fill every other slot so only the takeover's own zombie slot could block the retry.
    for (const tko of ["o1", "o2"]) await env.authority.vaAcquire({ takeoverId: tko, attempt: 0, capMs: 600_000, source: "judge", deployId: "dev-test" });
    expect(await env.authority.vaFree()).toBe(0);
    await t.db.update(takeovers).set({ lastFailureAt: new Date(Date.now() - 5000) }).where(eq(takeovers.id, "tkoA"));
    const r = await mint(1);
    expect(r.status).toBe(200);
    expect(r.body.liveSessionId).toBe(vaSessionIdFor("tkoA", 1));
    expect((await env.authority.session(vaSessionIdFor("tkoA", 0)))?.status).toBe("released");
    const [tk] = await t.db.select({ retries: takeovers.retries }).from(takeovers).where(eq(takeovers.id, "tkoA"));
    expect(tk?.retries).toBe(1);
    const retrySlot = await env.authority.session(vaSessionIdFor("tkoA", 1));
    expect(retrySlot?.ledgerId).toBeTruthy(); // a fresh reservation for the retry
    // Only once.
    expect((await mint(1)).status).toBe(409);
    expect((await mint(0)).status).toBe(409);
  });

  it("attempt 1 is refused 30 s after the failure", async () => {
    await armed({ failureAgoMs: 31_000 });
    expect((await mint(1)).status).toBe(409);
  });

  it("parallel retries: exactly one wins the retry budget", async () => {
    await armed({ failureAgoMs: 2000 });
    const rs = await Promise.all([mint(1), mint(1), mint(1)]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it("a missing heartbeat for 30 s frees the takeover's slot", async () => {
    await armed();
    expect((await mint(0)).status).toBe(200);
    const sid = vaSessionIdFor("tkoA", 0);
    await env.authority.heartbeat(sid);
    const later = new DbLimitsAuthority({ db: t.db, config: defaultLimitsConfig(), now: () => Date.now() + 31_000 });
    expect((await sweepRegistry(later)).staleVa).toBe(1);
    expect((await env.authority.session(sid))?.status).toBe("stale");
    expect(await env.authority.vaFree()).toBe(3);
  });

  it("wrong takeover in the token → 403; case not armed → 409; recorded run → 409", async () => {
    await armed();
    const wrong = await call(vaTokenPost, { headers: await caseAuthHeaders("caseA", "visA", { takeoverId: "other" }), body: { takeoverId: "tkoA", attempt: 0 } });
    expect(wrong.status).toBe(403);
    await t.db.update(cases).set({ status: "shadowing" }).where(eq(cases.id, "caseA"));
    expect((await mint(0)).status).toBe(409);
  });

  it("a balance/credit mint error → E_AAI_BALANCE, the slot is released, and the mode flips to replay_only", async () => {
    const { setTokenMinter } = await import("@/server/aai/tokens");
    const { VoiceAgentHttpError } = await import("@/server/aai/va-node");
    setTokenMinter(
      fakeMinter({
        va: async () => {
          throw new VoiceAgentHttpError("mint-token", 402, { detail: "Insufficient account balance: add credits" });
        },
      }),
    );
    await armed();
    const r = await mint(0);
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ code: "E_AAI_BALANCE", fallback: "recorded_ai_session" });
    expect((await env.authority.session(vaSessionIdFor("tkoA", 0)))?.status).toBe("released");
    expect(await env.authority.flags()).toMatchObject({ mode: "replay_only", reason: "aai_balance" });
  });
});

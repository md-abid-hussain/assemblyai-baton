import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AssemblyAIHttpError } from "@/server/aai/async";
import { jobs, liveSessions, takeovers, verifications } from "@/server/db/schema";
import {
  createVerifyStep,
  enqueueVerificationWith,
  normalizeVerifyState,
  VERIFY_PRICES,
  VERIFY_TIMING,
} from "@/server/jobs/verify-takeover";
import { createTestDb, endedSession, HAS_DB, harness, seedTakeover, type Harness, type TestDb } from "./helpers";

const d = HAS_DB ? describe : describe.skip;

d("F3 verify_takeover (DB)", () => {
  let t: TestDb;
  let h: Harness;
  beforeAll(async () => {
    t = await createTestDb("wp8verify");
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    h = harness(t.db);
    h.runner.register("verify_takeover", createVerifyStep(() => h.ports));
    // Isolate the in-flight count (S2) from jobs other tests left in await_transcript.
    await t.db.update(jobs).set({ status: "done" }).where(eq(jobs.kind, "verify_takeover"));
  });

  const jobRow = async (id: string) => (await t.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
  const verRow = async (tko: string) => (await t.db.select().from(verifications).where(eq(verifications.takeoverId, tko)))[0];
  /** Advance, then move the clock past run_after (the test plays the ticker). */
  const step = async (jobId: string) => {
    const st = await h.runner.advance(jobId);
    const j = await jobRow(jobId);
    h.clock.t = Math.max(h.clock.t, j.runAfter.getTime());
    return st;
  };

  it("happy path (poll-only): artifacts → submit (keyterms, no webhook on localhost) → poll → compute", async () => {
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_ok", metrics: { hud: { click_to_first_audible: 900 }, other: 1 } });
    await t.db.insert(liveSessions).values({ id: `va_${takeoverId}_0`, kind: "va", capMs: 600_000, deployId: "zp-prod", status: "closed", providerSessionId: "sess_ok", ledgerId: "led_va" });
    h.ledger.rows.set("led_va", { estUsd: 0.53, status: "reserved", provider: "aai_va", refId: `va_${takeoverId}_0` });
    h.rest.sessions.set("sess_ok", endedSession("sess_ok", { audio: false }));

    const jobId = (await enqueueVerificationWith(h.ports, takeoverId, "sess_ok"))!;
    expect(jobId).toBeTruthy();
    expect((await verRow(takeoverId))?.status).toBe("pending");
    const j0 = await jobRow(jobId);
    expect(j0.runAfter.getTime() - h.clock.t).toBe(VERIFY_TIMING.FIRST_RUN_AFTER_MS);
    expect(await h.runner.advance(jobId)).toBe("pending"); // not due yet: nothing ran
    expect(h.rest.calls).toEqual([]);
    h.clock.advance(VERIFY_TIMING.FIRST_RUN_AFTER_MS);

    expect(await step(jobId)).toBe("pending"); // S1: no audio yet
    expect(normalizeVerifyState((await jobRow(jobId)).state, takeoverId, 0)).toMatchObject({ step: "await_artifacts", tries: 1 });
    h.rest.sessions.set("sess_ok", endedSession("sess_ok", { duration: 61.2 }));
    expect(await step(jobId)).toBe("pending"); // S1 → submit
    const s1 = normalizeVerifyState((await jobRow(jobId)).state, takeoverId, 0);
    expect(s1).toMatchObject({ step: "submit", durationSec: 61.2, vaSettled: true });
    expect(h.ledger.rows.get("led_va")).toMatchObject({ status: "settled", actual: 61.2 * VERIFY_PRICES.VA_USD_PER_SEC });

    expect(await step(jobId)).toBe("pending"); // S2 submit
    expect(h.async.submitted).toHaveLength(1);
    const sub = h.async.submitted[0]!;
    expect(sub).toMatchObject({ speech_models: ["universal-3-5-pro"], multichannel: true });
    expect(sub.audio_url).toMatch(/audio\.ogg/);
    expect(sub.webhook_url).toBeUndefined();
    expect(sub.keyterms_prompt).toContain("Mark Delgado");
    const asyncRow = [...h.ledger.rows.values()].find((r) => r.provider === "aai_async")!;
    expect(asyncRow.estUsd).toBeCloseTo(2 * 61.2 * VERIFY_PRICES.ASYNC_USD_PER_CH_SEC, 8);
    expect((await verRow(takeoverId))?.aaiTranscriptId).toBe("tr_1");

    expect(await step(jobId)).toBe("pending"); // S3: processing
    expect(await step(jobId)).toBe("done"); // S3 completed → S4 compute
    const v = (await verRow(takeoverId))!;
    expect(v.status).toBe("completed");
    expect(v.qa).toMatchObject({ provisional: false, reAsked: 1, verifiedReconfirmed: 1, clickToFirstAudibleMs: 900, aiSeconds: 61.2 });
    const [tko] = await t.db.select({ metrics: takeovers.metrics }).from(takeovers).where(eq(takeovers.id, takeoverId));
    expect(tko!.metrics).toMatchObject({ other: 1, hud: { click_to_first_audible: 900 }, verification: { status: "completed", transcriptId: "tr_1", reAsked: 1 } });
    expect(asyncRow).toBeDefined();
    const settledAsync = [...h.ledger.rows.values()].find((r) => r.provider === "aai_async")!;
    expect(settledAsync.status).toBe("settled");
    expect(settledAsync.actual).toBeCloseTo(62.5 * 2 * VERIFY_PRICES.ASYNC_USD_PER_CH_SEC, 8);
    expect(h.timelineFetches).toHaveLength(1);
  });

  it("uses the webhook on a public https APP_URL", async () => {
    h = harness(t.db, { config: () => ({ appUrl: "https://baton.zerops.app", webhookSecret: "whsec", deployId: "zp-prod", vaMaxConcurrent: 3 }) });
    h.runner.register("verify_takeover", createVerifyStep(() => h.ports));
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_wh" });
    h.rest.sessions.set("sess_wh", endedSession("sess_wh"));
    const jobId = (await enqueueVerificationWith(h.ports, takeoverId, null))!; // sid resolved from the takeover row
    h.clock.advance(VERIFY_TIMING.FIRST_RUN_AFTER_MS);
    await step(jobId);
    await step(jobId);
    const sub = h.async.submitted.at(-1)!;
    expect(sub.webhook_url).toBe(`https://baton.zerops.app/api/webhooks/assemblyai?job=${jobId}`);
    expect(sub.webhook_auth_header_name).toBe("X-Baton-Webhook");
    expect(sub.webhook_auth_header_value).toBe("whsec");
  });

  it("a 400 with keyterms_prompt resubmits once without it", async () => {
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_kt" });
    h.rest.sessions.set("sess_kt", endedSession("sess_kt"));
    h.async.submitError = (p) => (p.keyterms_prompt ? new AssemblyAIHttpError("POST", "x", 400, { error: "keyterms_prompt not supported with multichannel" }) : null);
    const jobId = (await enqueueVerificationWith(h.ports, takeoverId, "sess_kt"))!;
    h.clock.advance(VERIFY_TIMING.FIRST_RUN_AFTER_MS);
    await step(jobId);
    await step(jobId);
    expect(h.async.submitted).toHaveLength(2);
    expect(h.async.submitted[1]!.keyterms_prompt).toBeUndefined();
    const st = normalizeVerifyState((await jobRow(jobId)).state, takeoverId, 0);
    expect(st).toMatchObject({ step: "await_transcript", keyterms: false, keytermsDropped: true, transcriptId: "tr_2" });
  });

  it("three consecutive failures → failed with a plain reason; the ledger reservation is settled at the estimate", async () => {
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_fail" });
    h.rest.sessions.set("sess_fail", endedSession("sess_fail"));
    const jobId = (await enqueueVerificationWith(h.ports, takeoverId, "sess_fail"))!;
    h.clock.advance(VERIFY_TIMING.FIRST_RUN_AFTER_MS);
    await step(jobId);
    await step(jobId); // submitted
    h.async.getError = new Error("ECONNRESET");
    expect(await step(jobId)).toBe("pending");
    expect(await step(jobId)).toBe("pending");
    expect(await step(jobId)).toBe("failed");
    const j = await jobRow(jobId);
    expect(j.status).toBe("failed");
    const st = normalizeVerifyState(j.state, takeoverId, 0);
    expect(st).toMatchObject({ failures: 3, reason: "await_transcript_failed" });
    expect(st.lastError).toMatch(/ECONNRESET/);
    const v = (await verRow(takeoverId))!;
    expect(v.status).toBe("failed");
    expect(v.qa).toBeNull();
    const [tko] = await t.db.select({ metrics: takeovers.metrics }).from(takeovers).where(eq(takeovers.id, takeoverId));
    expect((tko!.metrics as { verification: { reason: string } }).verification.reason).toBe("The transcription status could not be read.");
    const asyncRow = [...h.ledger.rows.values()].find((r) => r.provider === "aai_async" && r.refId === takeoverId)!;
    expect(asyncRow.status).toBe("settled");
  });

  it("a transcript error is permanent and releases the async reservation", async () => {
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_err" });
    h.rest.sessions.set("sess_err", endedSession("sess_err"));
    h.async.completeWith = (id) => ({ id, status: "error", error: "audio too short", audio_url: "" });
    const jobId = (await enqueueVerificationWith(h.ports, takeoverId, "sess_err"))!;
    h.clock.advance(VERIFY_TIMING.FIRST_RUN_AFTER_MS);
    await step(jobId);
    await step(jobId);
    await step(jobId); // processing
    expect(await step(jobId)).toBe("failed");
    expect((await verRow(takeoverId))!.status).toBe("failed");
    const asyncRow = [...h.ledger.rows.values()].find((r) => r.provider === "aai_async" && r.refId === takeoverId)!;
    expect(asyncRow.status).toBe("released");
  });

  it("S3 gives up after 60 s of polling", async () => {
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_slow" });
    h.rest.sessions.set("sess_slow", endedSession("sess_slow"));
    h.async.pollsUntilDone = 1000;
    const jobId = (await enqueueVerificationWith(h.ports, takeoverId, "sess_slow"))!;
    h.clock.advance(VERIFY_TIMING.FIRST_RUN_AFTER_MS);
    await step(jobId);
    await step(jobId);
    let last = "pending";
    for (let i = 0; i < 40 && last === "pending"; i++) last = await step(jobId);
    expect(last).toBe("failed");
    expect(normalizeVerifyState((await jobRow(jobId)).state, takeoverId, 0).reason).toBe("transcript_timeout");
    expect(h.async.submitted.length).toBe(1);
  });

  it("S1 gives up after 30 polls without artifacts", async () => {
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_noart" });
    h.rest.sessions.set("sess_noart", endedSession("sess_noart", { audio: false }));
    const jobId = (await enqueueVerificationWith(h.ports, takeoverId, "sess_noart"))!;
    h.clock.advance(VERIFY_TIMING.FIRST_RUN_AFTER_MS);
    let last = "pending";
    let n = 0;
    while (last === "pending" && n < 40) {
      last = await step(jobId);
      n++;
    }
    expect(last).toBe("failed");
    expect(n).toBe(VERIFY_TIMING.ARTIFACT_MAX_TRIES);
    expect(normalizeVerifyState((await jobRow(jobId)).state, takeoverId, 0).reason).toBe("artifacts_timeout");
  });

  it("waits while 3 other async jobs are in flight", async () => {
    for (let i = 0; i < 3; i++) {
      await h.runner.enqueue("verify_takeover", `other_${i}`, { runAfterMs: 3_600_000, state: { step: "await_transcript" } });
    }
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_busy" });
    h.rest.sessions.set("sess_busy", endedSession("sess_busy"));
    const jobId = (await enqueueVerificationWith(h.ports, takeoverId, "sess_busy"))!;
    h.clock.advance(VERIFY_TIMING.FIRST_RUN_AFTER_MS);
    await step(jobId);
    const before = h.async.submitted.length;
    await step(jobId);
    expect(h.async.submitted.length).toBe(before);
    expect(normalizeVerifyState((await jobRow(jobId)).state, takeoverId, 0)).toMatchObject({ step: "submit", tries: 1 });
  });

  it("accepts WP2's sweeper state and resolves the session id from the takeover", async () => {
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_sw" });
    h.rest.sessions.set("sess_sw", endedSession("sess_sw"));
    const jobId = await h.runner.enqueue("verify_takeover", takeoverId, { state: { vaSessionId: null, from: "sweeper" } });
    await step(jobId);
    const st = normalizeVerifyState((await jobRow(jobId)).state, takeoverId, 0);
    expect(st).toMatchObject({ from: "sweeper", vaSessionId: "sess_sw", step: "submit" });
  });

  it("no VA session → nothing to verify; enqueue is idempotent", async () => {
    const none = await seedTakeover(t.db, { vaSessionId: null });
    expect(await enqueueVerificationWith(h.ports, none.takeoverId, null)).toBeNull();
    expect(await enqueueVerificationWith(h.ports, "tko_missing", "sess_x")).toBeNull();
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_idem" });
    const a = await enqueueVerificationWith(h.ports, takeoverId, "sess_idem");
    const b = await enqueueVerificationWith(h.ports, takeoverId, "sess_idem", "sweeper");
    expect(a).toBe(b);
  });

  it("without a wired runner, enqueue returns null (and logs)", async () => {
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_norun" });
    expect(await enqueueVerificationWith({ ...h.ports, runner: () => null }, takeoverId, "sess_norun")).toBeNull();
  });

  it("an unwired QA engine fails the verification with a plain reason", async () => {
    h = harness(t.db, { computeQa: null });
    h.runner.register("verify_takeover", createVerifyStep(() => h.ports));
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_noqa" });
    h.rest.sessions.set("sess_noqa", endedSession("sess_noqa"));
    h.async.pollsUntilDone = 0;
    const jobId = (await enqueueVerificationWith(h.ports, takeoverId, "sess_noqa"))!;
    h.clock.advance(VERIFY_TIMING.FIRST_RUN_AFTER_MS);
    await step(jobId);
    await step(jobId);
    expect(await step(jobId)).toBe("failed");
    expect(normalizeVerifyState((await jobRow(jobId)).state, takeoverId, 0).reason).toBe("qa_not_wired");
  });

  it("a budget refusal fails at once without submitting", async () => {
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_budget" });
    h.rest.sessions.set("sess_budget", endedSession("sess_budget"));
    h.ledger.refuse = true;
    const jobId = (await enqueueVerificationWith(h.ports, takeoverId, "sess_budget"))!;
    h.clock.advance(VERIFY_TIMING.FIRST_RUN_AFTER_MS);
    await step(jobId);
    expect(await step(jobId)).toBe("failed");
    expect(h.async.submitted).toHaveLength(0);
    expect(normalizeVerifyState((await jobRow(jobId)).state, takeoverId, 0).reason).toBe("budget");
  });
});

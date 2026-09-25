import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { VerificationViewSchema } from "@/core/contracts/api";
import { jobs, verifications, webhookEvents } from "@/server/db/schema";
import { createVerifyStep, enqueueVerificationWith, normalizeVerifyState, VERIFY_TIMING } from "@/server/jobs/verify-takeover";
import { handleAaiWebhook, handleVaAudio, handleVerificationGet } from "@/server/qa/routes";
import { markVerificationFailed } from "@/server/qa/verification";
import { createTestDb, endedSession, HAS_DB, harness, seedTakeover, tokenFor, type Harness, type TestDb } from "./helpers";

const d = HAS_DB ? describe : describe.skip;

const get = (url: string, token?: string) => new Request(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });

d("WP8 routes #19-#21 (DB)", () => {
  let t: TestDb;
  let h: Harness;
  beforeAll(async () => {
    t = await createTestDb("wp8routes");
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    h = harness(t.db);
    h.runner.register("verify_takeover", createVerifyStep(() => h.ports));
    await t.db.update(jobs).set({ status: "done" }).where(eq(jobs.kind, "verify_takeover"));
  });

  const view = async (res: Response) => VerificationViewSchema.parse(await res.json());

  describe("#20 GET /api/verifications/[takeoverId]", () => {
    it("401 without a token, 403 with a token for another takeover", async () => {
      const { caseId, takeoverId } = await seedTakeover(t.db);
      expect((await handleVerificationGet(get("http://x/api/verifications/a"), takeoverId, h.ports)).status).toBe(401);
      const other = await tokenFor({ caseId, takeoverId: "tko_other" });
      expect((await handleVerificationGet(get("http://x", other), takeoverId, h.ports)).status).toBe(403);
      const noTko = await tokenFor({ caseId });
      expect((await handleVerificationGet(get("http://x", noTko), takeoverId, h.ports)).status).toBe(403);
      const bad = (await tokenFor({ caseId, takeoverId })).slice(0, -3) + "abc";
      expect((await handleVerificationGet(get("http://x", bad), takeoverId, h.ports)).status).toBe(401);
    });

    it("404 when there is no verification", async () => {
      const { caseId, takeoverId } = await seedTakeover(t.db, { vaSessionId: null });
      const res = await handleVerificationGet(get("http://x", await tokenFor({ caseId, takeoverId })), takeoverId, h.ports);
      expect(res.status).toBe(404);
    });

    it("advances the job when due (portable background) until completed; 1/s rate limit", async () => {
      const { caseId, takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_r20", endedAt: new Date(h.clock.t) });
      h.rest.sessions.set("sess_r20", endedSession("sess_r20"));
      h.async.pollsUntilDone = 0;
      const jobId = (await enqueueVerificationWith(h.ports, takeoverId, "sess_r20"))!;
      const tok = await tokenFor({ caseId, takeoverId });

      let res = await handleVerificationGet(get("http://x", tok), takeoverId, h.ports);
      expect(res.status).toBe(200);
      let v = await view(res);
      expect(v).toMatchObject({ status: "pending", qa: null, elapsedMs: 0 });
      expect(h.rest.calls).toEqual([]); // not due for 7 s

      res = await handleVerificationGet(get("http://x", tok), takeoverId, h.ports);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("1");

      const statuses: string[] = [];
      for (let i = 0; i < 6; i++) {
        const j = (await t.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!;
        h.clock.t = Math.max(h.clock.t + 1000, j.runAfter.getTime());
        v = await view(await handleVerificationGet(get("http://x", tok), takeoverId, h.ports));
        statuses.push(v.status);
        if (v.status !== "pending") break;
      }
      expect(statuses.at(-1)).toBe("completed");
      expect(v.qa).toMatchObject({ provisional: false, reAsked: 1 });
      expect(v.elapsedMs).toBeGreaterThanOrEqual(VERIFY_TIMING.FIRST_RUN_AFTER_MS);
    });

    it("failed → status failed, qa null, plain reason (the UI keeps its provisional numbers)", async () => {
      const { caseId, takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_r20f" });
      await t.db.insert(verifications).values({ takeoverId, status: "pending" });
      await markVerificationFailed(t.db, takeoverId, "The call recording was not ready in time.", { now: h.clock.t });
      const v = await view(await handleVerificationGet(get("http://x", await tokenFor({ caseId, takeoverId })), takeoverId, h.ports));
      expect(v).toMatchObject({ status: "failed", qa: null, reason: "The call recording was not ready in time." });
    });

    it("reconciles a job the runner marked failed while the row is still pending", async () => {
      const { caseId, takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_r20r" });
      await t.db.insert(verifications).values({ takeoverId, status: "pending" });
      await h.runner.enqueue("verify_takeover", takeoverId, { state: { vaSessionId: "sess_r20r" } });
      await t.db.update(jobs).set({ status: "failed" }).where(eq(jobs.refId, takeoverId));
      const v = await view(await handleVerificationGet(get("http://x", await tokenFor({ caseId, takeoverId })), takeoverId, h.ports));
      expect(v.status).toBe("failed");
      expect(v.reason).toBe("The call recording could not be fetched.");
    });
  });

  describe("#19 POST /api/webhooks/assemblyai?job=", () => {
    const hook = (jobId: string | null, body: unknown, secret = "whsec-test") =>
      new Request(`http://x/api/webhooks/assemblyai${jobId ? `?job=${jobId}` : ""}`, {
        method: "POST",
        headers: { "x-baton-webhook": secret, "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

    async function submittedJob(sid: string): Promise<{ takeoverId: string; caseId: string; jobId: string; transcriptId: string }> {
      const { caseId, takeoverId } = await seedTakeover(t.db, { vaSessionId: sid });
      h.rest.sessions.set(sid, endedSession(sid));
      h.async.pollsUntilDone = 1000; // polling alone never completes: only the webhook path can
      const jobId = (await enqueueVerificationWith(h.ports, takeoverId, sid))!;
      h.clock.advance(VERIFY_TIMING.FIRST_RUN_AFTER_MS);
      await h.runner.advance(jobId);
      await h.runner.advance(jobId);
      const st = normalizeVerifyState((await t.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!.state, takeoverId, 0);
      expect(st.step).toBe("await_transcript");
      return { takeoverId, caseId, jobId, transcriptId: st.transcriptId! };
    }

    it("401 on a wrong secret, 400 on a missing job or a bad body", async () => {
      const defer = () => undefined;
      expect((await handleAaiWebhook(hook("j", { transcript_id: "a", status: "completed" }, "nope"), defer, h.ports)).status).toBe(401);
      expect((await handleAaiWebhook(hook(null, { transcript_id: "a", status: "completed" }), defer, h.ports)).status).toBe(400);
      expect((await handleAaiWebhook(hook("j", "not json"), defer, h.ports)).status).toBe(400);
      expect((await handleAaiWebhook(hook("j", { status: "queued" }), defer, h.ports)).status).toBe(400);
    });

    it("webhook path: 200 at once, then the deferred advance completes the verification; duplicates are ignored", async () => {
      const { takeoverId, jobId, transcriptId } = await submittedJob("sess_wh1");
      // Job sleeps on its 3 s poll; the webhook makes it due now.
      await t.db.update(jobs).set({ runAfter: new Date(Date.now() + 60_000) }).where(eq(jobs.id, jobId));
      h.async.pollsUntilDone = 0; // AssemblyAI now reports completed
      const deferred: (() => Promise<void>)[] = [];
      const res = await handleAaiWebhook(hook(jobId, { transcript_id: transcriptId, status: "completed" }), (fn) => deferred.push(fn), { ...h.ports, now: () => Date.now() + 1000 });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(deferred).toHaveLength(1);
      h.clock.t = Date.now() + 1000;
      await deferred[0]!();
      const v = (await t.db.select().from(verifications).where(eq(verifications.takeoverId, takeoverId)))[0]!;
      expect(v.status).toBe("completed");
      const ev = (await t.db.select().from(webhookEvents).where(eq(webhookEvents.id, `aai:${transcriptId}:completed`)))[0]!;
      expect(ev.processedAt).not.toBeNull();
      expect(ev.error).toBeNull();

      const dup = await handleAaiWebhook(hook(jobId, { transcript_id: transcriptId, status: "completed" }), () => undefined, h.ports);
      expect(await dup.json()).toEqual({ ok: true, duplicate: true });
    });

    it("a transcript that does not match the job is recorded and ignored (200, no retry storm)", async () => {
      const { jobId } = await submittedJob("sess_wh2");
      const res = await handleAaiWebhook(hook(jobId, { transcript_id: "tr_other", status: "completed" }), () => undefined, h.ports);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: "transcript does not match the job" });
      const res2 = await handleAaiWebhook(hook("job_unknown", { transcript_id: "tr_zzz", status: "error" }), () => undefined, h.ports);
      expect(await res2.json()).toEqual({ ok: true, ignored: "unknown job" });
    });
  });

  describe("#21 GET /api/va-sessions/[vaSessionId]/audio", () => {
    it("302 to a fresh pre-signed URL for the owner, with #t= for the seek; 403 for others", async () => {
      const { caseId, takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_audio" });
      h.rest.sessions.set("sess_audio", endedSession("sess_audio"));
      const tok = await tokenFor({ caseId, takeoverId });
      const res = await handleVaAudio(get("http://x/api/va-sessions/sess_audio/audio?t=12.25", tok), "sess_audio", h.ports);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://s3.example.test/sess_audio/audio.ogg?Signature=x&Expires=1#t=12.25");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const plain = await handleVaAudio(get("http://x/api/va-sessions/sess_audio/audio", tok), "sess_audio", h.ports);
      expect(plain.headers.get("location")).not.toContain("#t=");

      const other = await seedTakeover(t.db, { vaSessionId: "sess_other_owner" });
      const otherTok = await tokenFor({ caseId: other.caseId, takeoverId: other.takeoverId });
      expect((await handleVaAudio(get("http://x", otherTok), "sess_audio", h.ports)).status).toBe(403);
      expect((await handleVaAudio(get("http://x", tok), "sess_nobody", h.ports)).status).toBe(403);
      expect((await handleVaAudio(get("http://x"), "sess_audio", h.ports)).status).toBe(401);
    });

    it("404 while the recording is not ready or after it was deleted; 429 past 30/min", async () => {
      const { caseId, takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_audio2" });
      const tok = await tokenFor({ caseId, takeoverId, visitorId: "v_audio2" });
      h.rest.sessions.set("sess_audio2", endedSession("sess_audio2", { audio: false }));
      const notReady = await handleVaAudio(get("http://x", tok), "sess_audio2", h.ports);
      expect(notReady.status).toBe(404);
      expect(notReady.headers.get("retry-after")).toBe("3");
      h.rest.sessions.delete("sess_audio2");
      expect((await handleVaAudio(get("http://x", tok), "sess_audio2", h.ports)).status).toBe(404);
      h.rest.sessions.set("sess_audio2", endedSession("sess_audio2"));
      let last = 0;
      for (let i = 0; i < 31; i++) last = (await handleVaAudio(get("http://x", tok), "sess_audio2", h.ports)).status;
      expect(last).toBe(429);
    });
  });
});

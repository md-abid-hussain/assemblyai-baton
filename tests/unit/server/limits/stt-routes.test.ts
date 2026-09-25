/**
 * Routes #5 (STT token), #6 (queue cancel) and #7 (session report) in-process against real Postgres, with a fake
 * token minter (no network). Shapes are checked with the frozen contract schemas.
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SttTokenResponseSchema } from "@/core/contracts/api";
import { POST as reportPost } from "@/app/api/sessions/report/route";
import { DELETE as queueDelete } from "@/app/api/stt/queue/[ticket]/route";
import { POST as sttPost } from "@/app/api/stt/token/route";
import { setTokenMinter } from "@/server/aai/tokens";
import { StreamingHttpError } from "@/server/aai/va-node";
import { liveSessions, spendLedger, streamQueue } from "@/server/db/schema";
import { STT_USD_PER_SEC } from "@/server/limits/config";
import { createTestDb, HAS_DB, type TestDb } from "./helpers/test-db";
import { call, caseAuthHeaders, fakeMinter, insertCase, setupRouteEnv, truncateAll, type RouteEnv } from "./helpers/routes";

describe.skipIf(!HAS_DB)("STT token (#5), queue cancel (#6), session report (#7)", () => {
  let t: TestDb;
  let env: RouteEnv;

  beforeAll(async () => {
    t = await createTestDb("sttroutes");
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await truncateAll(t);
    env = await setupRouteEnv(t);
    await insertCase(t, { id: "caseS", visitorId: "visS" });
  });
  afterEach(async () => {
    await env.restore();
  });

  const token = async (body: Record<string, unknown>, o: { caseId?: string; visitorId?: string; ip?: string } = {}) =>
    call(sttPost, {
      headers: await caseAuthHeaders(o.caseId ?? "caseS", o.visitorId ?? "visS", { ip: o.ip ?? "203.0.113.9" }),
      body: { caseId: o.caseId ?? "caseS", runId: "run1", n: 2, ...body },
    });

  it("granted: one 10 s token, per-channel params, our live-session ids by channel, one reservation per session", async () => {
    const r = await token({});
    expect(r.status).toBe(200);
    const b = SttTokenResponseSchema.parse(r.body);
    if (b.status !== "granted") throw new Error(`expected granted, got ${b.status}`);
    expect(b.token).toMatch(/^fake-stt-token/);
    expect(Date.parse(b.expiresAt) - Date.now()).toBeLessThanOrEqual(10_000);
    expect(b.params.rep).toMatchObject({ speech_model: "universal-3-5-pro", mode: "min_latency", inactivity_timeout: 30 });
    expect(b.params.customer.keyterms_prompt).toEqual(expect.arrayContaining(["Maya", "Chen", "Highlander", "learner's permit"]));
    const ids = [b.sessionIds.rep!, b.sessionIds.customer!];
    for (const id of ids) {
      const [row] = await t.db.select().from(liveSessions).where(eq(liveSessions.id, id));
      expect(row).toMatchObject({ kind: "stt", status: "open", caseId: "caseS", visitorId: "visS", runId: "run1" });
      const [l] = await t.db.select().from(spendLedger).where(eq(spendLedger.id, row!.ledgerId!));
      expect(l).toMatchObject({ provider: "aai_stt", status: "reserved" });
    }
  });

  it("n=1 (reconnect) names its channel and gets only that session id", async () => {
    const b = SttTokenResponseSchema.parse((await token({ n: 1, channel: "customer", reconnect: true })).body);
    if (b.status !== "granted") throw new Error("expected granted");
    expect(Object.keys(b.sessionIds)).toEqual(["customer"]);
    expect((await token({ n: 1 })).status).toBe(400); // channel is required when n = 1
  });

  it("queued (ETA ≤ 15 s) → poll → cancel via #6; denied carries the cached-replay fallback", async () => {
    await env.authority.sttAcquire({ n: 2, visitorId: "x", ipKey: "x", source: "script", deployId: "dev-test" });
    await env.authority.sttAcquire({ n: 2, visitorId: "y", ipKey: "y", source: "script", deployId: "dev-test" });
    const denied = SttTokenResponseSchema.parse((await token({})).body);
    expect(denied).toMatchObject({ status: "denied", code: "E_QUEUE_TIMEOUT", fallback: "cached_turn_replay" });
    // Move the opens 50 s into the past so the window frees within 10 s → queued.
    await t.db.update(liveSessions).set({ createdAt: new Date(Date.now() - 50_000) }).where(eq(liveSessions.kind, "stt"));
    const q = SttTokenResponseSchema.parse((await token({})).body);
    if (q.status !== "queued") throw new Error(`expected queued, got ${q.status}`);
    expect(q.pollMs).toBe(2000);
    expect(q.etaMs).toBeLessThanOrEqual(15_000);
    // Another visitor cannot cancel it.
    await insertCase(t, { id: "caseT", visitorId: "visT" });
    const foreign = await call(queueDelete, { method: "DELETE", headers: await caseAuthHeaders("caseT", "visT"), params: { ticket: q.ticket } });
    expect(foreign.status).toBe(403);
    const mine = await call(queueDelete, { method: "DELETE", headers: await caseAuthHeaders("caseS", "visS"), params: { ticket: q.ticket } });
    expect(mine.body).toEqual({ ok: true });
    const [row] = await t.db.select().from(streamQueue).where(eq(streamQueue.ticket, q.ticket));
    expect(row?.status).toBe("cancelled");
  });

  it("grants are rate limited: 6/h per visitor (queued polls do not count)", async () => {
    for (let i = 0; i < 6; i++) {
      await t.db.update(liveSessions).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(liveSessions.kind, "stt"));
      expect(SttTokenResponseSchema.parse((await token({})).body).status).toBe("granted");
    }
    await t.db.update(liveSessions).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(liveSessions.kind, "stt"));
    const r = await token({});
    expect(SttTokenResponseSchema.parse(r.body)).toMatchObject({ status: "denied", code: "E_RATE_LIMITED" });
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("mint failures are denials with the fallback (never a bare 502); balance texts flip replay_only (aai_balance)", async () => {
    setTokenMinter(fakeMinter({ stt: async () => { throw new StreamingHttpError(500, "internal error"); } }));
    const r1 = SttTokenResponseSchema.parse((await token({})).body);
    expect(r1).toMatchObject({ status: "denied", code: "E_QUEUE_TIMEOUT", fallback: "cached_turn_replay" });
    // The failed grant released its rows and reservations: nothing counts against the window.
    const rows = await t.db.select().from(liveSessions);
    expect(rows.every((x) => x.status === "released")).toBe(true);
    const ledger = await t.db.select().from(spendLedger);
    expect(ledger.every((x) => x.status === "released")).toBe(true);

    setTokenMinter(fakeMinter({ stt: async () => { throw new StreamingHttpError(402, { detail: "Your account has insufficient credits" }); } }));
    const r2 = SttTokenResponseSchema.parse((await token({})).body);
    expect(r2).toMatchObject({ status: "denied", code: "E_AAI_BALANCE" });
    expect(await env.authority.flags()).toMatchObject({ mode: "replay_only", reason: "aai_balance" });
    expect(SttTokenResponseSchema.parse((await token({})).body)).toMatchObject({ status: "denied", code: "E_AAI_BALANCE" });
  });

  it("#7 report: opened then closed settles the reservation from billed seconds; another case's session is 403", async () => {
    const b = SttTokenResponseSchema.parse((await token({})).body);
    if (b.status !== "granted") throw new Error("expected granted");
    const rep = b.sessionIds.rep!;
    const h = await caseAuthHeaders("caseS", "visS");
    expect((await call(reportPost, { headers: h, body: { sessionId: rep, kind: "stt", event: "opened", providerSessionId: "aai-1" } })).body).toEqual({ ok: true });
    expect(
      (await call(reportPost, { headers: h, body: { sessionId: rep, kind: "stt", event: "closed", billedSeconds: 181.25, closeCode: 1000 } })).body,
    ).toEqual({ ok: true });
    const [row] = await t.db.select().from(liveSessions).where(eq(liveSessions.id, rep));
    expect(row).toMatchObject({ status: "closed", billedSeconds: 181.25, providerSessionId: "aai-1" });
    const [l] = await t.db.select().from(spendLedger).where(eq(spendLedger.id, row!.ledgerId!));
    expect(l?.status).toBe("settled");
    expect(l?.actualUsd).toBeCloseTo(181.25 * STT_USD_PER_SEC, 4);

    await insertCase(t, { id: "caseT", visitorId: "visT" });
    const foreign = await call(reportPost, { headers: await caseAuthHeaders("caseT", "visT"), body: { sessionId: b.sessionIds.customer, kind: "stt", event: "closed" } });
    expect(foreign.status).toBe(403);
    expect((await call(reportPost, { headers: h, body: { sessionId: "nope", kind: "stt", event: "closed" } })).status).toBe(404);
    expect((await call(reportPost, { headers: h, body: { sessionId: rep, kind: "stt", event: "bogus" } })).status).toBe(400);
  });

  it("a case that is no longer shadowing gets no STT token; a stale runId is refused", async () => {
    const { cases } = await import("@/server/db/schema");
    await t.db.update(cases).set({ runPlan: { runId: "current" } as Record<string, unknown> }).where(eq(cases.id, "caseS"));
    expect((await token({ runId: "old" })).status).toBe(403);
    await t.db.update(cases).set({ status: "armed" }).where(eq(cases.id, "caseS"));
    expect((await token({ runId: "current" })).status).toBe(409);
  });
});

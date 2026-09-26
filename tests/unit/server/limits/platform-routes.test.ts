/**
 * Routes #2 (status), #26 (cron), #27 (admin flags/ledger), and acceptance 6 end to end through a real route.
 * No network: token minting is faked and OPENAI/POLAR keys are absent (those probes report E_CONFIG).
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppFlagsSchema, CronResponseSchema, LedgerSummarySchema, RunPlanSchema, StatusResponseSchema } from "@/core/contracts/api";
import { GET as flagsGet, POST as flagsPost } from "@/app/api/admin/flags/route";
import { GET as ledgerGet } from "@/app/api/admin/ledger/route";
import { POST as cronPost } from "@/app/api/internal/cron/route";
import { POST as runsPost } from "@/app/api/runs/route";
import { GET as statusGet } from "@/app/api/status/route";
import { cases, healthChecks, jobs, rateEvents } from "@/server/db/schema";
import { setLogSink } from "@/server/log";
import { createTestDb, HAS_DB, type TestDb } from "./helpers/test-db";
import { call, caseAuthHeaders, insertCase, setupRouteEnv, TEST_SECRETS, truncateAll, type RouteEnv } from "./helpers/routes";

describe.skipIf(!HAS_DB)("status, cron, admin routes (+ acceptance 6 through a route)", () => {
  let t: TestDb;
  let env: RouteEnv;

  beforeAll(async () => {
    t = await createTestDb("platform");
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await truncateAll(t);
    env = await setupRouteEnv(t);
  });
  afterEach(async () => {
    await env.restore();
  });

  const admin = { "x-admin-key": TEST_SECRETS.ADMIN_KEY, "content-type": "application/json" };
  const cron = (kind: string, secret: string = TEST_SECRETS.CRON_SECRET) => call(cronPost, { path: `/api/internal/cron?kind=${kind}`, headers: { "x-cron-secret": secret } });

  it("GET /api/status: the contract shape; AI availability follows slots and mode", async () => {
    const r = await call(statusGet, { method: "GET", headers: { "x-forwarded-for": "192.0.2.1" } });
    expect(r.status).toBe(200);
    const s = StatusResponseSchema.parse(r.body);
    expect(s).toMatchObject({ mode: "live", aiHalfAvailable: true, sttQueueDepth: 0, deployId: "dev-test", limits: { sttOpensPerMin: 4, vaMaxConcurrent: 3 } });
    expect(s.lastChecks).toEqual({ light: null, full: null });
    for (const tko of ["a", "b", "c"]) await env.authority.vaAcquire({ takeoverId: tko, attempt: 0, capMs: 600_000, source: "judge", deployId: "dev-test" });
    expect(StatusResponseSchema.parse((await call(statusGet, { method: "GET" })).body).aiHalfAvailable).toBe(false);
    await env.flags.set({ mode: "replay_only", notice: "Back at 10:00 UTC" }, "operator");
    const s2 = StatusResponseSchema.parse((await call(statusGet, { method: "GET" })).body);
    expect(s2).toMatchObject({ mode: "replay_only", reason: "operator", notice: "Back at 10:00 UTC", aiHalfAvailable: false });
  });

  it("GET /api/status is rate limited at 60/min per IP", async () => {
    // QA-FIX: the buckets key on the balancer-set `X-Real-IP`. A bare `X-Forwarded-For` is client-controlled
    // and no longer buys a bucket of its own — which is the whole point of the fix, and is asserted below.
    for (let i = 0; i < 60; i++) await call(statusGet, { method: "GET", headers: { "x-real-ip": "192.0.2.99" } });
    const r = await call(statusGet, { method: "GET", headers: { "x-real-ip": "192.0.2.99" } });
    expect(r.status).toBe(429);
    expect((await call(statusGet, { method: "GET", headers: { "x-real-ip": "198.51.100.100" } })).status).toBe(200); // another /24
  });

  it("QA-FIX: a rotated X-Forwarded-For cannot escape a tripped status bucket", async () => {
    for (let i = 0; i < 61; i++) await call(statusGet, { method: "GET", headers: { "x-forwarded-for": `203.0.113.${i % 250}` } });
    // Every one of those requests keyed on the same "unknown" hop, so the bucket is spent for all of them.
    for (const spoof of ["198.18.0.9", "1.2.3.4", "8.8.8.8"]) {
      expect((await call(statusGet, { method: "GET", headers: { "x-forwarded-for": spoof } })).status).toBe(429);
    }
  });

  it("P-0: rotating a spoofed leftmost X-Forwarded-For entry does not escape the status bucket; the probe logs classes only", async () => {
    // What Zerops delivers: the client chain + the appended client hop, X-Real-IP overwritten with the client.
    const spoofed = (i: number) => ({ "x-forwarded-for": `203.0.113.${i}, 8.8.4.4`, "x-real-ip": "8.8.4.4" });
    for (let i = 0; i < 60; i++) await call(statusGet, { method: "GET", headers: spoofed(i) });
    expect((await call(statusGet, { method: "GET", headers: spoofed(99) })).status).toBe(429);
    const lines: string[] = [];
    const restore = setLogSink((_l, line) => lines.push(line));
    try {
      await call(statusGet, { method: "GET", headers: { ...spoofed(7), "x-ipkey-probe": "1" } });
    } finally {
      restore();
    }
    const probe = lines.find((l) => l.includes("ipkey_probe"));
    expect(probe).toBeTruthy();
    expect(probe).toContain('"realIp":"public"');
    expect(probe).toContain('"xffLeft":"testnet"');
    expect(probe).not.toContain("8.8.4.4");
    expect(probe).not.toContain("203.0.113");
  });

  it("admin flags: key required; a balance below the reserve flips replay_only (aai_balance); mode live clears", async () => {
    expect((await call(flagsPost, { headers: { "x-admin-key": "wrong" }, body: { mode: "replay_only" } })).status).toBe(403);
    const low = AppFlagsSchema.parse((await call(flagsPost, { headers: admin, body: { aaiBalanceUsd: 4.1 } })).body);
    expect(low).toMatchObject({ mode: "replay_only", reason: "aai_balance", aaiBalanceUsd: 4.1 });
    const ok = AppFlagsSchema.parse((await call(flagsPost, { headers: admin, body: { aaiBalanceUsd: 27.4, mode: "live" } })).body);
    expect(ok).toMatchObject({ mode: "live", reason: null, aaiBalanceUsd: 27.4 });
    const kill = AppFlagsSchema.parse((await call(flagsPost, { headers: admin, body: { mode: "replay_only", notice: "maintenance at 3pm" } })).body);
    expect(kill).toMatchObject({ mode: "replay_only", reason: "operator", notice: "maintenance at 3pm" });
    expect(AppFlagsSchema.parse((await call(flagsGet, { method: "GET", headers: admin })).body).mode).toBe("replay_only");
    expect((await call(flagsPost, { headers: admin, body: { mode: "sideways" } })).status).toBe(400);
  });

  it("admin ledger: the LedgerSummary", async () => {
    await env.authority.ledger.reserve({ provider: "aai_va", action: "x", refId: "x", estUsd: 0.5, env: "dev-test" });
    const s = LedgerSummarySchema.parse((await call(ledgerGet, { method: "GET", headers: admin })).body);
    expect(s.todayUsd.aai_va).toBeCloseTo(0.5, 5);
    expect(s.byEnv["dev-test"]).toBeCloseTo(0.5, 5);
    expect((await call(ledgerGet, { method: "GET", headers: {} })).status).toBe(403);
  });

  it("cron: secret required; unknown kind 400; tick runs sweep + budget guard + jobs", async () => {
    expect((await cron("tick", "wrong")).status).toBe(403);
    expect((await cron("bogus")).status).toBe(400);
    const r = CronResponseSchema.parse((await cron("tick")).body);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.details)).toEqual(expect.arrayContaining(["sweep", "budget", "jobs"]));
  });

  it("cron light stores a health check (probes without keys report E_CONFIG) and /api/status shows it", async () => {
    const r = CronResponseSchema.parse((await cron("light")).body);
    const light = r.details.light as { ok: boolean; details: Record<string, { ok: boolean; code?: string }> };
    expect(light.details.db?.ok).toBe(true);
    expect(light.details.flags?.ok).toBe(true);
    expect(light.details.mintStt?.ok).toBe(true); // fake minter
    expect(light.details.mintVa?.ok).toBe(true);
    expect(light.details.openai).toMatchObject({ ok: false, code: "E_CONFIG" });
    expect(light.details.polar).toMatchObject({ ok: false, code: "E_CONFIG" });
    expect(r.ok).toBe(false);
    const s = StatusResponseSchema.parse((await call(statusGet, { method: "GET" })).body);
    expect(s.lastChecks.light).toMatchObject({ ok: false });
    expect(s.lastChecks.light!.ageSec).toBeLessThan(10);
  });

  it("cron purge: old judge cases, rate events and health checks go; spot cases stay", async () => {
    const old = new Date(Date.now() - 15 * 86_400_000);
    await insertCase(t, { id: "old-watch", visitorId: "v" });
    await insertCase(t, { id: "old-spot", visitorId: "v" });
    await insertCase(t, { id: "new-watch", visitorId: "v" });
    await t.db.update(cases).set({ createdAt: old }).where(sql`${cases.id} in ('old-watch','old-spot')`);
    await t.db.update(cases).set({ mode: "spot" }).where(eq(cases.id, "old-spot"));
    await t.db.insert(rateEvents).values({ bucket: "b", key: "k", ts: new Date(Date.now() - 3 * 86_400_000) });
    await t.db.insert(healthChecks).values({ id: "hc-old", kind: "light", ok: true, createdAt: new Date(Date.now() - 31 * 86_400_000) });
    const r = CronResponseSchema.parse((await cron("purge")).body);
    expect(r.details.purge).toMatchObject({ status: "done" });
    expect(r.ok).toBe(true);
    const left = (await t.db.select({ id: cases.id }).from(cases)).map((c) => c.id).sort();
    expect(left).toEqual(["new-watch", "old-spot"]);
    expect(await t.db.select().from(rateEvents).where(eq(rateEvents.bucket, "b"))).toHaveLength(0);
    expect(await t.db.select().from(healthChecks).where(eq(healthChecks.id, "hc-old"))).toHaveLength(0);
    const [job] = await t.db.select().from(jobs).where(eq(jobs.kind, "purge"));
    expect(job?.status).toBe("done");
  });

  it("acceptance 6 through POST /api/runs: wrong vid → 403, expired → 401, cookie-less header → 200", async () => {
    await insertCase(t, { id: "case6", visitorId: "vis6" });
    const body = { caseId: "case6", callId: "s01_take1", express: false };
    const good = await caseAuthHeaders("case6", "vis6");
    const wrongVid = { ...(await caseAuthHeaders("case6", "vis6")), cookie: (await caseAuthHeaders("case6", "intruder")).cookie! };
    const w = await call(runsPost, { headers: wrongVid, body });
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe("E_FORBIDDEN");
    const expired = await caseAuthHeaders("case6", "vis6", { now: Date.now() - 46 * 60_000 });
    const e = await call(runsPost, { headers: expired, body });
    expect(e.status).toBe(401);
    expect(e.body.error.code).toBe("E_CASE_TOKEN");
    const cookieless = await caseAuthHeaders("case6", "vis6", { cookieless: true });
    expect(cookieless.cookie).toBeUndefined();
    const ok = await call(runsPost, { headers: cookieless, body });
    expect(ok.status).toBe(200);
    expect(RunPlanSchema.parse(ok.body).caseId).toBe("case6");
    expect((await call(runsPost, { headers: good, body: { caseId: "case6" } })).status).toBe(400);
  });
});

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { liveSessions, takeovers, verifications } from "@/server/db/schema";
import { AUDIT, isIgnoredDeploy, isRunning, markerOf, resetVaAuditCache, runVaAudit } from "@/server/jobs/va-audit";
import { VERIFY_PRICES } from "@/server/jobs/verify-takeover";
import { purgeVaRecordings } from "@/server/qa/purge";
import { createTestDb, endedSession, HAS_DB, harness, seedTakeover, type Harness, type TestDb } from "./helpers";

const marker = (id: string) => `You are the assistant.\nRules...\n(internal ref: baton-deploy=${id}; never mention this)`;

describe("marker parsing (pure)", () => {
  it("reads the deploy id from the last marker line", () => {
    expect(markerOf(marker("zp-prod"))).toBe("zp-prod");
    expect(markerOf(`${marker("dev-x")}\n${marker("zp-prod")}`)).toBe("zp-prod");
    expect(markerOf("no marker here")).toBeNull();
    expect(markerOf(undefined)).toBeNull();
  });
  it("ignores dev-* and the Vercel mirror", () => {
    expect(isIgnoredDeploy("dev-wp8")).toBe(true);
    expect(isIgnoredDeploy("vercel-mirror")).toBe(true);
    expect(isIgnoredDeploy("zp-prod")).toBe(false);
  });
  it("treats a running session as T-D1-0b saw it (status created, ended_at null)", () => {
    expect(isRunning({ status: "created", ended_at: null })).toBe(true);
    expect(isRunning({ status: "completed", ended_at: "2026-09-25T00:00:00Z" })).toBe(false);
    expect(isRunning({ status: "completed", ended_at: null })).toBe(false);
  });
});

const d = HAS_DB ? describe : describe.skip;

d("F6 VA audit (DB)", () => {
  let t: TestDb;
  let h: Harness;
  beforeAll(async () => {
    t = await createTestDb("wp8audit");
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    resetVaAuditCache();
    h = harness(t.db, { now: () => Date.now() });
    await t.db.delete(liveSessions);
  });

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const running = (id: string, deploy: string, createdAgoMs = 5 * 60_000) =>
    endedSession(id, { prompt: marker(deploy), status: "created", endedAt: null, audio: false, createdAt: ago(createdAgoMs) });

  it("a synthetic marker-bearing session unknown to the registry flips replay_only", async () => {
    h.rest.sessions.set("sess_rogue", running("sess_rogue", "zp-prod"));
    const r = await runVaAudit(h.ports);
    expect(r.ok).toBe(false);
    expect(r.anomalies).toEqual([expect.objectContaining({ kind: "unknown_session", sessionId: "sess_rogue" })]);
    expect(h.tripped).toEqual(["va_audit_anomaly"]);
    expect(r.tripped).toBe(true);
    expect(r.deleted).toEqual([]); // T-D1-0b: DELETE does not end a live session, so the audit never deletes
    expect(h.rest.deleted).toEqual([]);
  });

  it("dev-* and vercel-mirror sessions (and unmarked ones) are ignored", async () => {
    h.rest.sessions.set("sess_dev", running("sess_dev", "dev-wp5b"));
    h.rest.sessions.set("sess_mirror", running("sess_mirror", "vercel-mirror"));
    h.rest.sessions.set("sess_plain", endedSession("sess_plain", { prompt: "no marker", status: "created", endedAt: null }));
    const r = await runVaAudit(h.ports);
    expect(r).toMatchObject({ ok: true, scanned: 3, ours: 0, anomalies: [] });
    expect(h.tripped).toEqual([]);
  });

  it("follows has_more pagination and fetches each new id's config once (the list has no config)", async () => {
    for (const id of ["s1", "s2", "s3"]) h.rest.sessions.set(id, endedSession(id, { prompt: marker("zp-prod"), createdAt: ago(10 * 60_000) }));
    const list = (id: string) => ({ id, status: "completed", created_at: ago(10 * 60_000), ended_at: ago(9 * 60_000) });
    h.rest.pages = [
      { sessions: [list("s1")], hasMore: true, nextCursor: "c1" },
      { sessions: [list("s2")], hasMore: true, nextCursor: "c2" },
      { sessions: [list("s3"), { id: "old", created_at: ago(2 * AUDIT.WINDOW_MS) }], hasMore: true, nextCursor: "c3" },
    ];
    const r = await runVaAudit(h.ports);
    expect(r.pages).toBe(3);
    expect(r.scanned).toBe(3);
    expect(r.ours).toBe(3);
    expect(r.anomalies.map((a) => a.kind)).toEqual(["unknown_session", "unknown_session", "unknown_session"]);
    expect(h.rest.calls.filter((c) => c.startsWith("get:"))).toEqual(["get:s1", "get:s2", "get:s3"]);
    h.rest.calls = [];
    await runVaAudit(h.ports);
    expect(h.rest.calls.filter((c) => c.startsWith("get:"))).toEqual([]); // markers cached
  });

  it("known sessions are fine; a young unknown one is within grace; ended known ones are settled", async () => {
    const { takeoverId } = await seedTakeover(t.db, { vaSessionId: "sess_known_tko" });
    void takeoverId;
    await t.db.insert(liveSessions).values({ id: "va_x_0", kind: "va", capMs: 600_000, deployId: "zp-prod", status: "closed", providerSessionId: "sess_known", ledgerId: "led_known" });
    h.ledger.rows.set("led_known", { estUsd: 0.5, status: "settled", provider: "aai_va", refId: "va_x_0", actual: 0.5 });
    h.rest.sessions.set("sess_known", endedSession("sess_known", { prompt: marker("zp-prod"), duration: 100 }));
    h.rest.sessions.set("sess_known_tko", running("sess_known_tko", "zp-prod"));
    h.rest.sessions.set("sess_young", running("sess_young", "zp-prod", 20_000));
    const r = await runVaAudit(h.ports);
    expect(r).toMatchObject({ ok: true, ours: 3, running: 2, anomalies: [], settled: 1 });
    expect(h.ledger.rows.get("led_known")!.actual).toBeCloseTo(100 * VERIFY_PRICES.VA_USD_PER_SEC, 8);
    const again = await runVaAudit(h.ports);
    expect(again.settled).toBe(0); // once per session
  });

  it("a running session whose row is closed/stale is an anomaly (after the grace)", async () => {
    await t.db.insert(liveSessions).values({ id: "va_y_0", kind: "va", capMs: 600_000, deployId: "zp-prod", status: "stale", providerSessionId: "sess_zombie", closedAt: new Date(Date.now() - 5 * 60_000) });
    await t.db.insert(liveSessions).values({ id: "va_z_0", kind: "va", capMs: 600_000, deployId: "zp-prod", status: "closed", providerSessionId: "sess_just_closed", closedAt: new Date(Date.now() - 5_000) });
    h.rest.sessions.set("sess_zombie", running("sess_zombie", "zp-prod"));
    h.rest.sessions.set("sess_just_closed", running("sess_just_closed", "zp-prod"));
    const r = await runVaAudit(h.ports);
    expect(r.anomalies).toEqual([expect.objectContaining({ kind: "running_but_closed", sessionId: "sess_zombie" })]);
    expect(h.tripped).toEqual(["va_audit_anomaly"]);
  });

  it("more running marker-bearing sessions than VA_MAX_CONCURRENT is an anomaly", async () => {
    for (let i = 0; i < 4; i++) {
      await t.db.insert(liveSessions).values({ id: `va_c${i}_0`, kind: "va", capMs: 600_000, deployId: "zp-prod", status: "open", providerSessionId: `sess_c${i}` });
      h.rest.sessions.set(`sess_c${i}`, running(`sess_c${i}`, "zp-prod"));
    }
    const r = await runVaAudit(h.ports);
    expect(r.anomalies.map((a) => a.kind)).toEqual(["over_concurrency"]);
    expect(r.running).toBe(4);
  });

  it("skips when not live, and on a dev deploy (no network calls)", async () => {
    h.rest.sessions.set("sess_rogue2", running("sess_rogue2", "zp-prod"));
    expect(await runVaAudit({ ...h.ports, flags: async () => ({ mode: "replay_only", reason: "operator" }) })).toMatchObject({ skipped: "not_live" });
    expect(await runVaAudit({ ...h.ports, config: () => ({ appUrl: null, webhookSecret: null, deployId: "dev-wp8", vaMaxConcurrent: 3 }) })).toMatchObject({ skipped: "not_production" });
    expect(h.rest.calls).toEqual([]);
  });

  it("a session deleted between list and get is skipped (not cached), not fatal", async () => {
    h.rest.pages = [{ sessions: [{ id: "sess_gone", status: "completed", created_at: ago(10 * 60_000) }], hasMore: false, nextCursor: null }];
    const r = await runVaAudit(h.ports);
    expect(r).toMatchObject({ ok: true, scanned: 1, ours: 0 });
    h.rest.sessions.set("sess_gone", running("sess_gone", "zp-prod"));
    expect((await runVaAudit(h.ports)).ours).toBe(1);
  });

  it("without a flag store it still reports the anomaly (and logs), never throws", async () => {
    h.rest.sessions.set("sess_rogue3", running("sess_rogue3", "zp-prod"));
    const r = await runVaAudit({ ...h.ports, tripReplayOnly: null });
    expect(r).toMatchObject({ ok: false, tripped: false });
  });
});

d("recording purge step (DB)", () => {
  let t: TestDb;
  let h: Harness;
  beforeAll(async () => {
    t = await createTestDb("wp8purge");
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("deletes judge VA sessions + transcripts older than 7 days once; keeps spot cases and young ones", async () => {
    h = harness(t.db, { now: () => Date.now() });
    const old = new Date(Date.now() - 8 * 86_400_000);
    const a = await seedTakeover(t.db, { vaSessionId: "sess_old", armedAt: old, mode: "live" });
    await t.db.insert(verifications).values({ takeoverId: a.takeoverId, aaiTranscriptId: "tr_old", status: "completed" });
    await seedTakeover(t.db, { vaSessionId: "sess_spot", armedAt: old, mode: "spot" });
    await seedTakeover(t.db, { vaSessionId: "sess_young", armedAt: new Date(Date.now() - 86_400_000) });
    await seedTakeover(t.db, { vaSessionId: null, armedAt: old });
    h.rest.sessions.set("sess_old", endedSession("sess_old"));
    const r = await purgeVaRecordings({}, h.ports);
    expect(r).toEqual({ vaSessions: 1, transcripts: 1, failed: 0 });
    expect(h.rest.deleted).toEqual(["sess_old"]);
    expect(h.async.deleted).toEqual(["tr_old"]);
    const [row] = await t.db.select({ metrics: takeovers.metrics }).from(takeovers).where(eq(takeovers.id, a.takeoverId));
    expect(row!.metrics).toHaveProperty("recordingPurgedAt");
    expect(await purgeVaRecordings({}, h.ports)).toEqual({ vaSessions: 0, transcripts: 0, failed: 0 });
  });
});

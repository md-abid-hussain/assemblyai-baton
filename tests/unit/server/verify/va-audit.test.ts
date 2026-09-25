import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { liveSessions, takeovers, verifications } from "@/server/db/schema";
import { AUDIT, isIgnoredDeploy, isRunning, markerOf, matchDevLeases, readPublishedAgents, resetVaAuditCache, runVaAudit } from "@/server/jobs/va-audit";
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
  it("matchDevLeases: one lease per session, only inside [lease − skew, lease + lead], maximal", () => {
    const L = (id: string, at: number) => ({ id, createdAtMs: at });
    const S = (id: string, at: number) => ({ id, createdAtMs: at });
    const o = { skewMs: 10, leadMs: 100 };
    expect([...matchDevLeases([S("a", 50)], [L("l1", 0)], o)]).toEqual([["a", "l1"]]);
    expect(matchDevLeases([S("a", 50), S("b", 60)], [L("l1", 0)], o).size).toBe(1); // count-matched
    expect(matchDevLeases([S("late", 150)], [L("l1", 0)], o).size).toBe(0); // opened too long after the grant
    expect(matchDevLeases([S("early", 0)], [L("l1", 20)], o).size).toBe(0); // created before the grant (beyond skew)
    expect(matchDevLeases([S("skewed", 15)], [L("l1", 20)], o).size).toBe(1); // within the clock-skew allowance
    // Greedy must not waste the early lease on the later session: a@10 can only use l1; b@95 can use l1 or l2.
    expect([...matchDevLeases([S("b", 95), S("a", 10)], [L("l2", 90), L("l1", 0)], o)].sort()).toEqual([["a", "l1"], ["b", "l2"]]);
    expect(matchDevLeases([S("nodate", NaN)], [L("l1", 0)], o).size).toBe(1);
    expect(matchDevLeases([S("a", 50)], [], o).size).toBe(0);
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

  // ------------------------------------------------------------------ v2.1 tightened audit (PLATFORM §8.4, WP18·0)

  it("v2.1: RUNNING dev-*, vercel-mirror and unmarked sessions with no registration are flagged (whatever the marker)", async () => {
    h.rest.sessions.set("sess_dev", running("sess_dev", "dev-wp5b"));
    h.rest.sessions.set("sess_mirror", running("sess_mirror", "vercel-mirror"));
    h.rest.sessions.set("sess_plain", endedSession("sess_plain", { prompt: "no marker", status: "created", endedAt: null }));
    const r = await runVaAudit(h.ports);
    expect(r).toMatchObject({ ok: false, scanned: 3, ours: 0, accountRunning: 3 });
    expect(r.anomalies.map((a) => [a.kind, a.sessionId])).toEqual([
      ["unregistered_session", "sess_dev"],
      ["unregistered_session", "sess_mirror"],
      ["unregistered_session", "sess_plain"],
    ]);
    expect(h.tripped).toEqual(["va_audit_anomaly"]);
    expect(h.rest.deleted).toEqual([]);
  });

  it("v2.1: ENDED dev/unmarked sessions stay ignored (the spend is over and was not this deploy's)", async () => {
    h.rest.sessions.set("sess_dev_done", endedSession("sess_dev_done", { prompt: marker("dev-wp99") }));
    h.rest.sessions.set("sess_plain_done", endedSession("sess_plain_done", { prompt: "no marker" }));
    const r = await runVaAudit(h.ports);
    expect(r).toMatchObject({ ok: true, scanned: 2, anomalies: [], accountRunning: 0 });
    expect(h.tripped).toEqual([]);
  });

  it("v2.1 acceptance 4: an unregistered session in a fake /v1/sessions trips replay_only; a registered one does not", async () => {
    await t.db.insert(liveSessions).values({ id: "va_ok_0", kind: "va", capMs: 600_000, deployId: "zp-prod", status: "open", providerSessionId: "sess_registered" });
    h.rest.sessions.set("sess_registered", running("sess_registered", "zp-prod"));
    expect(await runVaAudit(h.ports)).toMatchObject({ ok: true, matched: { registry: 1 } });
    h.rest.sessions.set("sess_replayed", endedSession("sess_replayed", { prompt: "You are a helpful assistant.", status: "created", endedAt: null }));
    const r = await runVaAudit(h.ports);
    expect(r.anomalies).toEqual([expect.objectContaining({ kind: "unregistered_session", sessionId: "sess_replayed" })]);
    expect(h.tripped).toEqual(["va_audit_anomaly"]);
  });

  it("v2.1: an open dev lease covers ONE running session (count-matched); a second one is flagged", async () => {
    const leaseAt = Date.now() - 5 * 60_000 - 2_000; // granted 2 s before the session below was created
    await t.db.insert(liveSessions).values({ id: "va_dev_lease", kind: "va", capMs: 300_000, deployId: "dev-wp99", source: "script", status: "open", createdAt: new Date(leaseAt) });
    h.rest.sessions.set("sess_dev_a", running("sess_dev_a", "dev-wp99"));
    let r = await runVaAudit(h.ports);
    expect(r).toMatchObject({ ok: true, devLeases: 1, matched: { dev_lease: 1 }, anomalies: [] });
    h.rest.sessions.set("sess_dev_b", endedSession("sess_dev_b", { prompt: marker("dev-wp99"), status: "created", endedAt: null, createdAt: ago(4 * 60_000) }));
    r = await runVaAudit(h.ports);
    expect(r.anomalies).toEqual([expect.objectContaining({ kind: "unregistered_session", sessionId: "sess_dev_b" })]);
  });

  it("v2.1: a copied dev marker buys nothing - no lease, a closed lease, a non-dev lease or a lease bound to another session", async () => {
    await t.db.insert(liveSessions).values([
      { id: "va_closed_lease", kind: "va", capMs: 300_000, deployId: "dev-x", status: "closed", createdAt: new Date(Date.now() - 5 * 60_000) },
      { id: "va_prod_open", kind: "va", capMs: 300_000, deployId: "zp-prod", status: "open", createdAt: new Date(Date.now() - 5 * 60_000) },
      { id: "va_bound_lease", kind: "va", capMs: 300_000, deployId: "dev-y", status: "open", providerSessionId: "sess_elsewhere", createdAt: new Date(Date.now() - 5 * 60_000) },
    ]);
    h.rest.sessions.set("sess_copycat", running("sess_copycat", "dev-wp5b"));
    const r = await runVaAudit(h.ports);
    expect(r.devLeases).toBe(0);
    expect(r.anomalies.map((a) => [a.kind, a.sessionId])).toEqual([["unregistered_session", "sess_copycat"]]);
  });

  it("v2.1: a dev lease never covers a session carrying THIS deploy's marker (unknown_session, as in v2.0)", async () => {
    await t.db.insert(liveSessions).values({ id: "va_dev_l2", kind: "va", capMs: 300_000, deployId: "dev-z", status: "open", createdAt: new Date(Date.now() - 5 * 60_000) });
    h.rest.sessions.set("sess_prodmark", running("sess_prodmark", "zp-prod"));
    const r = await runVaAudit(h.ports);
    expect(r.anomalies.map((a) => [a.kind, a.sessionId])).toEqual([["unknown_session", "sess_prodmark"]]);
  });

  it("v2.1: a publication's active run covers one running stored-agent session; a second one, or one with no active run, is flagged", async () => {
    const agent = (id: string, agentId: string, createdAgoMs: number) => ({ ...running(id, "zp-prod", createdAgoMs), agent_id: agentId });
    const pubs = [
      { publicationId: "pub_1", agentId: "agent_live", activeRunId: "tko_1", activeUntilMs: Date.now() + 20_000 },
      { publicationId: "pub_2", agentId: "agent_idle", activeRunId: null, activeUntilMs: null },
    ];
    const ports = { ...h.ports, publishedAgents: async () => pubs };
    h.rest.sessions.set("sess_pub_a", agent("sess_pub_a", "agent_live", 5 * 60_000));
    expect(await runVaAudit(ports)).toMatchObject({ ok: true, matched: { publication: 1 } });
    h.rest.sessions.set("sess_pub_b", agent("sess_pub_b", "agent_live", 3 * 60_000));
    h.rest.sessions.set("sess_pub_idle", agent("sess_pub_idle", "agent_idle", 3 * 60_000));
    const r = await runVaAudit(ports);
    expect(r.anomalies.map((a) => [a.kind, a.sessionId]).sort()).toEqual([
      ["unknown_session", "sess_pub_b"],
      ["unknown_session", "sess_pub_idle"],
    ]);
    // An ENDED session of a known publication agent is accounted for.
    h.rest.sessions.delete("sess_pub_b");
    h.rest.sessions.delete("sess_pub_idle");
    h.rest.sessions.set("sess_pub_done", { ...endedSession("sess_pub_done", { prompt: marker("zp-prod") }), agent_id: "agent_idle" });
    expect(await runVaAudit(ports)).toMatchObject({ ok: true });
  });

  it("v2.1: an unmatched session inside the grace is counted, not flagged", async () => {
    h.rest.sessions.set("sess_new", endedSession("sess_new", { prompt: "no marker", status: "created", endedAt: null, createdAt: ago(20_000) }));
    const r = await runVaAudit(h.ports);
    expect(r).toMatchObject({ ok: true, inGrace: 1, anomalies: [] });
  });

  it("v2.1: over_concurrency counts every marker, but not sessions whose row closed seconds ago", async () => {
    for (let i = 0; i < 3; i++) {
      await t.db.insert(liveSessions).values({ id: `va_m${i}_0`, kind: "va", capMs: 600_000, deployId: "zp-prod", status: "open", providerSessionId: `sess_m${i}` });
      h.rest.sessions.set(`sess_m${i}`, running(`sess_m${i}`, i === 0 ? "dev-wp99" : "zp-prod"));
    }
    await t.db.insert(liveSessions).values({ id: "va_ending_0", kind: "va", capMs: 600_000, deployId: "zp-prod", status: "closed", providerSessionId: "sess_ending", closedAt: new Date(Date.now() - 3_000) });
    h.rest.sessions.set("sess_ending", running("sess_ending", "zp-prod"));
    expect(await runVaAudit(h.ports)).toMatchObject({ ok: true, accountRunning: 3 });
    await t.db.insert(liveSessions).values({ id: "va_m3_0", kind: "va", capMs: 600_000, deployId: "dev-wp5b", status: "open", providerSessionId: "sess_m3" });
    h.rest.sessions.set("sess_m3", running("sess_m3", "dev-wp5b"));
    const r = await runVaAudit(h.ports);
    expect(r.anomalies.map((a) => a.kind)).toEqual(["over_concurrency"]);
    expect(r.accountRunning).toBe(4);
  });

  it("v2.1: readPublishedAgents is [] without relay_publications and reads the live rows once 0001 exists", async () => {
    expect(await readPublishedAgents(t.db)).toEqual([]);
    await t.db.execute(sql`create table relay_publications (
      id text primary key, relay_id text not null, version_id text not null, aai_agent_id text, share_slug text not null unique,
      key_hash text not null, status text not null, pinned boolean not null default false, active_run_id text, active_until timestamptz,
      last_used_at timestamptz, created_at timestamptz not null default now(), deleted_at timestamptz)`);
    try {
      const until = new Date(Date.now() + 20_000);
      await t.db.execute(sql`insert into relay_publications (id, relay_id, version_id, aai_agent_id, share_slug, key_hash, status, active_run_id, active_until) values
        ('pub_a', 'r1', 'v1', 'agent_a', 'slug-a', 'h', 'live', 'tko_a', ${until}),
        ('pub_b', 'r1', 'v2', 'agent_b', 'slug-b', 'h', 'live', null, null),
        ('pub_c', 'r2', 'v1', 'agent_c', 'slug-c', 'h', 'deleted', null, null),
        ('pub_d', 'r3', 'v1', null, 'slug-d', 'h', 'creating', null, null)`);
      const rows = (await readPublishedAgents(t.db)).sort((a, b) => a.publicationId.localeCompare(b.publicationId));
      expect(rows).toEqual([
        { publicationId: "pub_a", agentId: "agent_a", activeRunId: "tko_a", activeUntilMs: until.getTime() },
        { publicationId: "pub_b", agentId: "agent_b", activeRunId: null, activeUntilMs: null },
      ]);
      // The audit's default reader sees it too.
      h.rest.sessions.set("sess_pa", { ...running("sess_pa", "zp-prod"), agent_id: "agent_a" });
      expect(await runVaAudit(h.ports)).toMatchObject({ ok: true, matched: { publication: 1 } });
    } finally {
      await t.db.execute(sql`drop table relay_publications`);
    }
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

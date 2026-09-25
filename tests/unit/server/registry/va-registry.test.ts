/**
 * WP2 acceptance 4/5 (registry half): VA holds and slots, heartbeats and staleness (F5), hold expiry, ledger
 * settlement on reports, and the F8 1008 rule. Real Postgres, fake clock.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { liveSessions, spendLedger } from "@/server/db/schema";
import { DbFlagStore } from "@/server/flags";
import { defaultLimitsConfig, VA_USD_PER_SEC } from "@/server/limits/config";
import { DbLimitsAuthority, vaSessionIdFor } from "@/server/limits/db-authority";
import { registerStaleVaHandler, sweepRegistry, takeoverIdOfVaSession } from "@/server/registry/sweeper";
import { createTestDb, fakeClock, HAS_DB, type TestDb } from "../limits/helpers/test-db";

describe.skipIf(!HAS_DB)("VA registry + F5 sweeper (real Postgres)", () => {
  let t: TestDb;
  let clock: ReturnType<typeof fakeClock>;
  let a: DbLimitsAuthority;

  beforeAll(async () => {
    t = await createTestDb("registry");
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.execute(sql`truncate live_sessions, stream_queue, spend_ledger, rate_events`);
    clock = fakeClock("2026-10-01T10:00:00.000Z");
    const flags = new DbFlagStore(t.db, clock.now);
    await flags.set({ mode: "live", aaiBalanceUsd: null }, "test");
    a = new DbLimitsAuthority({ db: t.db, config: defaultLimitsConfig({ ledger: { epochMs: null } }), now: clock.now, flags });
  });
  afterEach(() => registerStaleVaHandler(null));

  const hold = (runId: string, ttlMs = 5 * 60_000) =>
    a.vaHold({ runId, visitorId: `v-${runId}`, ipKey: "ip", expiresAt: new Date(clock.now() + ttlMs).toISOString(), estUsd: 0.525, deployId: "dev-test", caseId: `c-${runId}` });
  const row = async (id: string) => (await t.db.select().from(liveSessions).where(eq(liveSessions.id, id)))[0];
  const ledgerOf = async (id: string | null | undefined) => (id ? (await t.db.select().from(spendLedger).where(eq(spendLedger.id, id)))[0] : undefined);

  it("3 slots: holds count; the 4th is refused with E_VA_CAPACITY and a plain message", async () => {
    for (const r of ["r1", "r2", "r3"]) expect((await hold(r)).ok).toBe(true);
    const fourth = await hold("r4");
    expect(fourth).toMatchObject({ ok: false, code: "E_VA_CAPACITY" });
    if (!fourth.ok) expect(fourth.message).toMatch(/busy/i);
    expect(await a.vaFree()).toBe(0);
  });

  it("vaAcquire consumes the run's hold (reservation moves to the open row); a second acquire for the same attempt is refused", async () => {
    const h = await hold("r1");
    if (!h.ok) throw new Error("hold");
    const held = await row(h.holdId);
    const r = await a.vaAcquireDetailed({ holdId: h.holdId, takeoverId: "tko1", attempt: 0, capMs: 600_000, source: "judge", deployId: "dev-test" });
    expect(r).toMatchObject({ ok: true, liveSessionId: vaSessionIdFor("tko1", 0), ledgerId: held?.ledgerId });
    expect((await row(h.holdId))?.status).toBe("released");
    const open = await row(vaSessionIdFor("tko1", 0));
    expect(open).toMatchObject({ status: "open", caseId: "c-r1", runId: "r1", capMs: 600_000 });
    expect(await a.vaFree()).toBe(2);
    expect(await a.vaAcquire({ holdId: h.holdId, takeoverId: "tko1", attempt: 0, capMs: 600_000, source: "judge", deployId: "dev-test" })).toMatchObject({
      ok: false,
      code: "E_VA_CAPACITY",
    });
  });

  it("without a usable hold, vaAcquire needs a free slot", async () => {
    for (const r of ["r1", "r2", "r3"]) await hold(r);
    expect(await a.vaAcquire({ takeoverId: "x", attempt: 0, capMs: 600_000, source: "judge", deployId: "dev-test" })).toMatchObject({
      ok: false,
      code: "E_VA_CAPACITY",
    });
  });

  it("a missing heartbeat for 30 s frees the slot (stale), settles at the reserved amount, and runs the stale-VA handler", async () => {
    const seen: [string, string | null][] = [];
    registerStaleVaHandler(async (tko, sid) => {
      seen.push([tko, sid]);
    });
    for (const r of ["r1", "r2", "r3"]) await hold(r);
    const h = await hold("r0");
    expect(h.ok).toBe(false);
    const holds = await t.db.select().from(liveSessions).where(eq(liveSessions.status, "held"));
    const r = await a.vaAcquireDetailed({ holdId: holds[0]!.id, takeoverId: "tkoA", attempt: 0, capMs: 600_000, source: "judge", deployId: "dev-test" });
    if (!r.ok) throw new Error("acquire");
    await a.report({ sessionId: r.liveSessionId, kind: "va", event: "opened", providerSessionId: "sess_A" });
    clock.advance(25_000);
    await a.heartbeat(r.liveSessionId);
    clock.advance(25_000); // 25 s since the last heartbeat
    expect((await sweepRegistry(a)).staleVa).toBe(0);
    clock.advance(6_000); // 31 s
    const s = await sweepRegistry(a);
    expect(s.staleVa).toBe(1);
    expect((await row(r.liveSessionId))?.status).toBe("stale");
    expect(await a.vaFree()).toBe(1);
    const l = await ledgerOf(r.ledgerId);
    expect(l).toMatchObject({ status: "settled", actualUsd: 0.525 });
    expect(seen).toEqual([["tkoA", "sess_A"]]);
    expect(takeoverIdOfVaSession(vaSessionIdFor("tkoA", 1))).toBe("tkoA");
  });

  it("a hold past hold_expires_at is released by the sweeper and its reservation released", async () => {
    const h = await hold("r1", 60_000);
    if (!h.ok) throw new Error("hold");
    clock.advance(59_000);
    expect((await sweepRegistry(a)).holdsReleased).toBe(0);
    clock.advance(2_000);
    expect((await sweepRegistry(a)).holdsReleased).toBe(1);
    const held = await row(h.holdId);
    expect(held?.status).toBe("released");
    expect((await ledgerOf(held?.ledgerId))?.status).toBe("released");
    // An expired hold can no longer be consumed; the acquire takes a free slot instead (no reservation attached).
    const r = await a.vaAcquireDetailed({ holdId: h.holdId, takeoverId: "late", attempt: 0, capMs: 600_000, source: "judge", deployId: "dev-test" });
    expect(r).toMatchObject({ ok: true, ledgerId: null });
  });

  it("any open row past cap_ms + 60 s becomes stale (STT too)", async () => {
    const g = await a.sttAcquire({ n: 1, visitorId: "v", ipKey: "ip", source: "judge", deployId: "dev-test" });
    if (g.status !== "granted") throw new Error("grant");
    const id = g.sessionIds[0]!;
    await a.ledger.reserve({ provider: "aai_stt", action: "t", refId: id, estUsd: 0.05, env: "dev-test" });
    expect((await row(id))?.ledgerId).toBeTruthy(); // reserve links refId = session id
    await a.report({ sessionId: id, kind: "stt", event: "opened", providerSessionId: "s1" });
    clock.advance(600_000 + 59_000);
    expect((await sweepRegistry(a)).staleStt).toBe(0);
    clock.advance(2_000);
    expect((await sweepRegistry(a)).staleStt).toBe(1);
  });

  it("reports settle the ledger: billed seconds when given, else wall time + tail; never-opened releases", async () => {
    const r = await a.vaAcquireDetailed({ takeoverId: "t1", attempt: 0, capMs: 600_000, source: "judge", deployId: "dev-test" });
    if (!r.ok) throw new Error("acquire");
    const res = await a.ledger.reserve({ provider: "aai_va", action: "t", refId: r.liveSessionId, estUsd: 0.525, env: "dev-test" });
    if (!res.ok) throw new Error("reserve");
    await a.report({ sessionId: r.liveSessionId, kind: "va", event: "opened", providerSessionId: "sess_1" });
    clock.advance(120_000);
    await a.report({ sessionId: r.liveSessionId, kind: "va", event: "closed", billedSeconds: 101.25 });
    expect(await ledgerOf(res.id)).toMatchObject({ status: "settled", actualUsd: Math.round(101.25 * VA_USD_PER_SEC * 1e5) / 1e5 });
    expect((await row(r.liveSessionId))?.billedSeconds).toBe(101.25);
    expect(await a.vaFree()).toBe(3);

    const r2 = await a.vaAcquireDetailed({ takeoverId: "t2", attempt: 0, capMs: 600_000, source: "judge", deployId: "dev-test" });
    if (!r2.ok) throw new Error("acquire");
    const res2 = await a.ledger.reserve({ provider: "aai_va", action: "t", refId: r2.liveSessionId, estUsd: 0.525, env: "dev-test" });
    if (!res2.ok) throw new Error("reserve");
    await a.report({ sessionId: r2.liveSessionId, kind: "va", event: "closed", closeCode: 1006 });
    expect((await ledgerOf(res2.id))?.status).toBe("released");
  });

  it("release: a held slot releases its reservation; an opened one settles from wall time", async () => {
    const h = await hold("r1");
    if (!h.ok) throw new Error("hold");
    await a.release(h.holdId, "run_release");
    expect((await ledgerOf((await row(h.holdId))?.ledgerId))?.status).toBe("released");

    const h2 = await hold("r2");
    if (!h2.ok) throw new Error("hold");
    const r = await a.vaAcquireDetailed({ holdId: h2.holdId, takeoverId: "t9", attempt: 0, capMs: 600_000, source: "judge", deployId: "dev-test" });
    if (!r.ok) throw new Error("acquire");
    await a.report({ sessionId: r.liveSessionId, kind: "va", event: "opened" });
    clock.advance(10_000);
    await a.release(r.liveSessionId, "retry");
    const l = await ledgerOf(r.ledgerId);
    expect(l?.status).toBe("settled");
    expect(l?.actualUsd).toBeCloseTo(40 * VA_USD_PER_SEC, 4); // 10 s + the 30 s bare-close tail
    expect(await a.vaFree()).toBe(3);
  });

  it("F8: three fresh-token 1008 closes within 10 min flip replay_only (aai_balance); a good close resets the count", async () => {
    const open = async (tko: string) => {
      const r = await a.vaAcquire({ takeoverId: tko, attempt: 0, capMs: 600_000, source: "judge", deployId: "dev-test" });
      if (!r.ok) throw new Error("acquire");
      return r.liveSessionId;
    };
    await a.report({ sessionId: await open("a"), kind: "va", event: "closed", closeCode: 1008 });
    await a.report({ sessionId: await open("b"), kind: "va", event: "closed", closeCode: 1008 });
    await a.report({ sessionId: await open("c"), kind: "va", event: "closed", closeCode: 1000, billedSeconds: 30 });
    await a.report({ sessionId: await open("d"), kind: "va", event: "closed", closeCode: 1008 });
    expect((await a.flags()).mode).toBe("live");
    await a.report({ sessionId: await open("e"), kind: "va", event: "closed", closeCode: 1008 });
    clock.advance(60_000);
    await a.report({ sessionId: await open("f"), kind: "va", event: "closed", closeCode: 1008 });
    expect(await a.flags()).toMatchObject({ mode: "replay_only", reason: "aai_balance" });
  });
});

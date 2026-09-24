/**
 * WP2 acceptance 1 (TASKS §3 WP2): the STT stream-slot broker against real Postgres.
 * 10 parallel sttAcquire({n:2}) never grant more than 4 opens per rolling 60 s; FIFO; ETA > 15 s → denied
 * (E_QUEUE_TIMEOUT); a ticket not polled for 3 intervals expires; a third ticket from one ipKey is refused.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SlotResult } from "@/core/contracts/services";
import { liveSessions, streamQueue } from "@/server/db/schema";
import { DbFlagStore } from "@/server/flags";
import { defaultLimitsConfig } from "@/server/limits/config";
import { DbLimitsAuthority } from "@/server/limits/db-authority";
import { createTestDb, fakeClock, HAS_DB, type TestDb } from "./helpers/test-db";

const T0 = "2026-10-01T10:00:00.000Z";

describe.skipIf(!HAS_DB)("STT broker (real Postgres)", () => {
  let t: TestDb;
  let clock: ReturnType<typeof fakeClock>;
  let a: DbLimitsAuthority;

  beforeAll(async () => {
    t = await createTestDb("broker");
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.execute(sql`truncate live_sessions, stream_queue, spend_ledger, rate_events`);
    await t.db.execute(sql`update app_flags set value = '"live"'::jsonb, reason = 'test' where key = 'mode'`);
    clock = fakeClock(T0);
    a = new DbLimitsAuthority({ db: t.db, config: defaultLimitsConfig(), now: clock.now });
  });

  const req = (over: Partial<Parameters<DbLimitsAuthority["sttAcquire"]>[0]> = {}) => ({
    n: 2 as const,
    visitorId: "v1",
    ipKey: "ip1",
    source: "judge" as const,
    deployId: "dev-test",
    ...over,
  });

  const openRowsInWindow = async () => {
    const [r] = await t.db
      .select({ n: sql<string>`count(*)` })
      .from(liveSessions)
      .where(and(eq(liveSessions.kind, "stt"), gt(liveSessions.createdAt, new Date(clock.now() - 60_000))));
    return Number(r?.n ?? 0);
  };

  it("10 parallel n=2 acquires grant at most 4 opens; the rest are refused with E_QUEUE_TIMEOUT (ETA 60 s > 15 s)", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => a.sttAcquire(req({ visitorId: `v${i}`, ipKey: `ip${i}` }))));
    const granted = results.filter((r) => r.status === "granted");
    expect(granted).toHaveLength(2);
    expect(granted.flatMap((g) => (g.status === "granted" ? g.sessionIds : []))).toHaveLength(4);
    expect(results.filter((r) => r.status === "denied" && r.code === "E_QUEUE_TIMEOUT")).toHaveLength(8);
    expect(await openRowsInWindow()).toBe(4);
    // Every granted session id is a live_sessions row (G0: one row per open, created at grant time).
    for (const g of granted) {
      if (g.status !== "granted") continue;
      for (const id of g.sessionIds) {
        const [row] = await t.db.select().from(liveSessions).where(eq(liveSessions.id, id));
        expect(row?.kind).toBe("stt");
        expect(row?.status).toBe("open");
      }
    }
  });

  it("stress: 10 parallel rounds against the real clock never exceed 4 opens in any rolling 60 s", async () => {
    const real = new DbLimitsAuthority({ db: t.db, config: defaultLimitsConfig() });
    const all: SlotResult[] = [];
    for (let round = 0; round < 3; round++) {
      all.push(...(await Promise.all(Array.from({ length: 10 }, (_, i) => real.sttAcquire(req({ n: i % 2 === 0 ? 1 : 2, ipKey: `r${round}-${i}` }))))));
    }
    const opens = all.reduce((s, r) => s + (r.status === "granted" ? r.sessionIds.length : 0), 0);
    expect(opens).toBeLessThanOrEqual(4);
    const [r] = await t.db.select({ n: sql<string>`count(*)` }).from(liveSessions).where(eq(liveSessions.kind, "stt"));
    expect(Number(r?.n)).toBe(opens);
  });

  it("the window is rolling: full at +59.9 s, free again at +60 s", async () => {
    expect((await a.sttAcquire(req())).status).toBe("granted");
    expect((await a.sttAcquire(req())).status).toBe("granted");
    clock.advance(59_900);
    const mid = await a.sttAcquire(req({ n: 1, ipKey: "other" }));
    expect(mid.status).toBe("queued");
    if (mid.status === "queued") expect(mid.etaMs).toBeLessThanOrEqual(250);
    clock.advance(100);
    const r = await a.sttAcquire(req({ n: 1, ipKey: "other", ...(mid.status === "queued" ? { ticket: mid.ticket } : {}) }));
    expect(r.status).toBe("granted");
  });

  it("FIFO: a later ticket polling first is not granted before the ticket ahead of it", async () => {
    await a.sttAcquire(req());
    await a.sttAcquire(req());
    clock.advance(50_000); // window frees at +60 s → ETA 10 s ≤ 15 s → queue
    const A = await a.sttAcquire(req({ visitorId: "A", ipKey: "ipA" }));
    const B = await a.sttAcquire(req({ visitorId: "B", ipKey: "ipB" }));
    const C = await a.sttAcquire(req({ visitorId: "C", ipKey: "ipC" }));
    expect(A).toMatchObject({ status: "queued", position: 0 });
    expect(B).toMatchObject({ status: "queued", position: 1 });
    // C would need 6 opens in the window: never possible within 15 s.
    expect(C).toMatchObject({ status: "denied", code: "E_QUEUE_TIMEOUT" });
    if (A.status !== "queued" || B.status !== "queued") throw new Error("unreachable");

    for (let i = 0; i < 3; i++) {
      clock.advance(2000); // +52, +54, +56 s: both poll every 2 s
      expect((await a.sttAcquire(req({ ticket: B.ticket }))).status).toBe("queued");
      expect((await a.sttAcquire(req({ ticket: A.ticket }))).status).toBe("queued");
    }
    clock.advance(4500); // +60.5 s: slots free. B polls FIRST but A is ahead of it.
    const b1 = await a.sttAcquire(req({ ticket: B.ticket }));
    expect(b1).toMatchObject({ status: "queued", position: 1 });
    const a1 = await a.sttAcquire(req({ ticket: A.ticket }));
    expect(a1.status).toBe("granted");
    const b2 = await a.sttAcquire(req({ ticket: B.ticket }));
    expect(b2.status).toBe("granted");
    expect(await openRowsInWindow()).toBe(4);
  });

  it("a ticket not polled for 3 intervals (6 s) expires and loses its place", async () => {
    await a.sttAcquire(req());
    await a.sttAcquire(req());
    clock.advance(50_000);
    const A = await a.sttAcquire(req({ n: 1, visitorId: "A", ipKey: "ipA" }));
    if (A.status !== "queued") throw new Error(`expected queued, got ${A.status}`);
    clock.advance(6_100); // A missed 3 polls
    const B = await a.sttAcquire(req({ n: 1, visitorId: "B", ipKey: "ipB" }));
    expect(B).toMatchObject({ status: "queued", position: 0 });
    const [row] = await t.db.select().from(streamQueue).where(eq(streamQueue.ticket, A.ticket));
    expect(row?.status).toBe("expired");
    // A comes back with its dead ticket: it is treated as a new request, behind B.
    const A2 = await a.sttAcquire(req({ n: 1, visitorId: "A", ipKey: "ipA", ticket: A.ticket }));
    expect(A2).toMatchObject({ status: "queued", position: 1 });
    if (A2.status === "queued") expect(A2.ticket).not.toBe(A.ticket);
  });

  it("a third queued ticket from one ipKey is refused (E_RATE_LIMITED)", async () => {
    await a.sttAcquire(req());
    await a.sttAcquire(req());
    clock.advance(50_000);
    const one = await a.sttAcquire(req({ n: 1, ipKey: "office" }));
    const two = await a.sttAcquire(req({ n: 1, ipKey: "office" }));
    const three = await a.sttAcquire(req({ n: 1, ipKey: "office" }));
    expect(one.status).toBe("queued");
    expect(two.status).toBe("queued");
    expect(three).toMatchObject({ status: "denied", code: "E_RATE_LIMITED" });
    // Another network is still queued fine.
    expect((await a.sttAcquire(req({ n: 1, ipKey: "home" }))).status).toBe("queued");
  });

  it("a reconnect may use the free tier's 5th slot and jumps new-call tickets", async () => {
    await a.sttAcquire(req());
    await a.sttAcquire(req());
    const r = await a.sttAcquire(req({ n: 1, reconnect: true }));
    expect(r.status).toBe("granted");
    expect(await openRowsInWindow()).toBe(5);
    clock.advance(50_000);
    const normal = await a.sttAcquire(req({ n: 1, ipKey: "n1" }));
    const rc = await a.sttAcquire(req({ n: 1, ipKey: "n2", reconnect: true }));
    expect(normal).toMatchObject({ status: "queued", position: 0 });
    expect(rc).toMatchObject({ status: "queued", position: 0 });
  });

  it("released grants (mint failed, nothing opened) do not count against the window", async () => {
    const g = await a.sttAcquire(req());
    if (g.status !== "granted") throw new Error("expected grant");
    for (const id of g.sessionIds) await a.release(id, "mint_failed");
    await a.sttAcquire(req());
    expect((await a.sttAcquire(req())).status).toBe("granted");
  });

  it("mode gates opens: replay_only → E_MODE_REPLAY_ONLY, aai_balance → E_AAI_BALANCE; synthetic checks still run", async () => {
    const flags = new DbFlagStore(t.db, clock.now);
    await flags.set({ mode: "replay_only" }, "synthetic_failed");
    expect(await a.sttAcquire(req())).toMatchObject({ status: "denied", code: "E_MODE_REPLAY_ONLY" });
    expect((await a.sttAcquire(req({ n: 1, source: "synthetic" }))).status).toBe("granted");
    await flags.set({ mode: "replay_only" }, "aai_balance");
    expect(await a.sttAcquire(req())).toMatchObject({ status: "denied", code: "E_AAI_BALANCE" });
    expect(await a.sttAcquire(req({ n: 1, source: "synthetic" }))).toMatchObject({ status: "denied", code: "E_AAI_BALANCE" });
  });

  it("sttCancel removes a queued ticket; sttPeek reports ETA and depth without mutating", async () => {
    await a.sttAcquire(req());
    await a.sttAcquire(req());
    clock.advance(50_000);
    const q = await a.sttAcquire(req({ n: 1 }));
    if (q.status !== "queued") throw new Error("expected queued");
    expect((await a.sttPeek(1)).queueDepth).toBe(1);
    await a.sttCancel(q.ticket);
    const p = await a.sttPeek(2);
    expect(p.queueDepth).toBe(0);
    expect(p.etaMs).toBe(10_000);
    expect(p.usedInWindow).toBe(4);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireSttSlots, OpenRefusedError } from "../../../scripts/lib/aai-open";
import { LocalOpenGuard } from "../../../scripts/lib/local-open-guard";

const base = { visitorId: "v", ipKey: "k", source: "test" as const, deployId: "dev-test" };

describe("LocalOpenGuard (laptop file guard)", () => {
  let dir: string;
  let t: number;
  const clock = () => t;
  const make = (o: Partial<ConstructorParameters<typeof LocalOpenGuard>[0]> = {}) =>
    new LocalOpenGuard({ dir, now: clock, sttOpensPerMin: 4, sttQueueMaxWaitMs: 15_000, vaMax: 1, dailyCapUsd: 1, ...o });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "baton-guard-"));
    t = Date.parse("2026-09-25T10:00:00Z");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("grants at most 4 STT opens per rolling 60 s, shared across instances (processes)", async () => {
    const a = make();
    const b = make(); // a second "process" over the same directory
    expect((await a.sttAcquire({ ...base, n: 2 })).status).toBe("granted");
    expect((await b.sttAcquire({ ...base, n: 2 })).status).toBe("granted");
    const third = await a.sttAcquire({ ...base, n: 1 });
    // Window is full until t+60 s: ETA 60 s > 15 s → denied, never queued forever.
    expect(third).toMatchObject({ status: "denied", code: "E_QUEUE_TIMEOUT" });
    t += 60_001;
    expect((await b.sttAcquire({ ...base, n: 2 })).status).toBe("granted");
  });

  it("queues FIFO when a slot frees within 15 s, and grants the ticket holder first", async () => {
    const g = make();
    expect((await g.sttAcquire({ ...base, n: 2 })).status).toBe("granted");
    t += 50_000;
    expect((await g.sttAcquire({ ...base, n: 2 })).status).toBe("granted");
    const q1 = await g.sttAcquire({ ...base, n: 2 });
    expect(q1).toMatchObject({ status: "queued", position: 0 });
    const q2 = await g.sttAcquire({ ...base, n: 1 });
    expect(q2.status === "queued" || q2.status === "denied").toBe(true);
    const ticket = q1.status === "queued" ? q1.ticket : "";
    t += 5_000; // clients poll every 2 s; an un-polled ticket expires after 10 s
    expect(await g.sttAcquire({ ...base, n: 2, ticket })).toMatchObject({ status: "queued", position: 0 });
    t += 5_001; // the first pair left the window
    // A newcomer without a ticket must not jump the queue.
    const jumper = await g.sttAcquire({ ...base, n: 1 });
    expect(jumper.status).not.toBe("granted");
    const first = await g.sttAcquire({ ...base, n: 2, ticket });
    expect(first.status).toBe("granted");
  });

  it("expires tickets that are not polled", async () => {
    const g = make();
    await g.sttAcquire({ ...base, n: 2 });
    t += 50_000;
    await g.sttAcquire({ ...base, n: 2 });
    const q = await g.sttAcquire({ ...base, n: 2 });
    expect(q.status).toBe("queued");
    t += 11_000; // > TICKET_TTL_MS without a poll
    const snap = await g.snapshot();
    expect(snap.sttQueue).toHaveLength(0);
  });

  it("allows one Voice Agent session at a time and frees it on release", async () => {
    const g = make();
    const a = await g.vaAcquire({ attempt: 0, capMs: 60_000, source: "test", deployId: "dev-test" });
    expect(a.ok).toBe(true);
    const b = await g.vaAcquire({ attempt: 0, capMs: 60_000, source: "test", deployId: "dev-test" });
    expect(b).toMatchObject({ ok: false, code: "E_VA_CAPACITY" });
    if (a.ok) await g.release(a.liveSessionId, "done");
    expect((await g.vaAcquire({ attempt: 0, capMs: 60_000, source: "test", deployId: "dev-test" })).ok).toBe(true);
  });

  it("converts a hold into an open session, and frees stale sessions (no heartbeat, dead pid)", async () => {
    const g = make();
    const hold = await g.vaHold({ runId: "r1", visitorId: "v", ipKey: "k", expiresAt: new Date(t + 120_000).toISOString(), estUsd: 0.5, deployId: "dev-test" });
    expect(hold.ok).toBe(true);
    const other = await g.vaAcquire({ attempt: 0, capMs: 60_000, source: "test", deployId: "dev-test" });
    expect(other.ok).toBe(false);
    const open = await g.vaAcquire({ holdId: hold.ok ? hold.holdId : "", attempt: 0, capMs: 60_000, source: "judge", deployId: "dev-test" });
    expect(open.ok).toBe(true);
    t += 31_000; // no heartbeat for > 30 s
    expect((await g.snapshot()).va).toHaveLength(0);

    const dead = make({ isPidAlive: () => false });
    await dead.vaAcquire({ attempt: 0, capMs: 60_000, source: "test", deployId: "dev-test" });
    expect((await dead.snapshot()).va).toHaveLength(0);
  });

  it("refuses everything in replay_only mode (local kill switch)", async () => {
    const g = make();
    await g.setMode("replay_only", "test");
    expect(await g.sttAcquire({ ...base, n: 1 })).toMatchObject({ status: "denied", code: "E_MODE_REPLAY_ONLY" });
    expect(await g.vaAcquire({ attempt: 0, capMs: 1000, source: "test", deployId: "d" })).toMatchObject({ ok: false, code: "E_MODE_REPLAY_ONLY" });
    await g.setMode("live", null);
    expect((await g.sttAcquire({ ...base, n: 1 })).status).toBe("granted");
  });

  it("ledger enforces the local daily AssemblyAI cap and summarises spend", async () => {
    const g = make({ dailyCapUsd: 1 });
    const r1 = await g.ledger.reserve({ provider: "aai_va", action: "x", refId: "a", estUsd: 0.6, env: "dev-test" });
    expect(r1.ok).toBe(true);
    const r2 = await g.ledger.reserve({ provider: "aai_stt", action: "x", refId: "b", estUsd: 0.6, env: "dev-test" });
    expect(r2).toEqual({ ok: false, code: "E_BUDGET" });
    if (r1.ok) await g.ledger.settle(r1.id, 0.1);
    const r3 = await g.ledger.reserve({ provider: "aai_stt", action: "x", refId: "c", estUsd: 0.6, env: "dev-test" });
    expect(r3.ok).toBe(true);
    expect((await g.ledger.reserve({ provider: "openai", action: "x", refId: "d", estUsd: 5, env: "dev-test" })).ok).toBe(true);
    const s = await g.ledger.summary();
    expect(s.todayUsd.aai_va).toBeCloseTo(0.1);
    expect(s.byEnv["dev-test"]).toBeCloseTo(5.7);
  });

  it("holds under concurrent acquires: 10 parallel n=2 requests never exceed 4 opens", async () => {
    const guards = Array.from({ length: 10 }, () => make());
    const results = await Promise.all(guards.map((g) => g.sttAcquire({ ...base, n: 2 })));
    const granted = results.filter((r) => r.status === "granted").length;
    expect(granted).toBe(2);
    const snap = await guards[0]!.snapshot();
    expect(snap.sttOpens.reduce((a, o) => a + o.n, 0)).toBe(4);
  });

  it("acquireSttSlots fails fast with maxWaitMs 0 when the window is full", async () => {
    const g = make();
    await g.sttAcquire({ ...base, n: 2 });
    await g.sttAcquire({ ...base, n: 2 });
    await expect(acquireSttSlots(1, { authority: g, maxWaitMs: 0 })).rejects.toBeInstanceOf(OpenRefusedError);
  });
});

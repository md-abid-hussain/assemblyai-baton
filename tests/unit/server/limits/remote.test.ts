/**
 * WP2 acceptance 2: the broker scenarios of acceptance 1, through RemoteLimitsAuthority → route #28 handlers (the
 * HTTP layer is exercised in-process: the client's fetch dispatches to the real route module), same results.
 * Plus: key and role checks, and the split-budget fallback when the authority is unreachable.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { LimitsAuthority, SlotResult } from "@/core/contracts/services";
import { LimitsHttpError, RemoteLimitsAuthority } from "@/server/limits/remote-authority";
import { POST as limitsPost } from "@/app/api/internal/limits/[op]/route";
import { createTestDb, fakeClock, HAS_DB, type TestDb } from "./helpers/test-db";
import { setupRouteEnv, TEST_SECRETS, truncateAll, type RouteEnv } from "./helpers/routes";

const BASE = "https://authority.test";

/** A fetch that dispatches `${BASE}/api/internal/limits/<op>` to the route handler. */
const routeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const op = url.pathname.split("/").pop()!;
  const req = new Request(url, init as RequestInit);
  return limitsPost(req, { params: Promise.resolve({ op }) });
};

describe.skipIf(!HAS_DB)("RemoteLimitsAuthority → route #28 (real Postgres)", () => {
  let t: TestDb;
  let env: RouteEnv;
  let clock: ReturnType<typeof fakeClock>;
  let remote: RemoteLimitsAuthority;

  beforeAll(async () => {
    t = await createTestDb("remote");
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await truncateAll(t);
    clock = fakeClock("2026-10-01T10:00:00.000Z");
    env = await setupRouteEnv(t, { now: clock.now });
    remote = new RemoteLimitsAuthority(BASE, TEST_SECRETS.LIMITS_AUTHORITY_KEY, { fetchImpl: routeFetch });
  });
  afterEach(async () => {
    await env.restore();
  });

  const req = (over: Partial<Parameters<LimitsAuthority["sttAcquire"]>[0]> = {}) => ({
    n: 2 as const,
    visitorId: "v1",
    ipKey: "ip1",
    source: "script" as const,
    deployId: "dev-test",
    ...over,
  });

  it("10 parallel n=2 acquires over HTTP: 2 grants (4 opens), 8 × E_QUEUE_TIMEOUT", async () => {
    const results: SlotResult[] = await Promise.all(Array.from({ length: 10 }, (_, i) => remote.sttAcquire(req({ ipKey: `ip${i}` }))));
    expect(results.filter((r) => r.status === "granted")).toHaveLength(2);
    expect(results.reduce((s, r) => s + (r.status === "granted" ? r.sessionIds.length : 0), 0)).toBe(4);
    expect(results.filter((r) => r.status === "denied" && r.code === "E_QUEUE_TIMEOUT")).toHaveLength(8);
  });

  it("FIFO, ETA and ticket expiry behave the same over HTTP", async () => {
    await remote.sttAcquire(req());
    await remote.sttAcquire(req());
    clock.advance(50_000);
    const A = await remote.sttAcquire(req({ ipKey: "a" }));
    const B = await remote.sttAcquire(req({ ipKey: "b" }));
    expect(A).toMatchObject({ status: "queued", position: 0 });
    expect(B).toMatchObject({ status: "queued", position: 1 });
    expect(await remote.sttAcquire(req({ ipKey: "c" }))).toMatchObject({ status: "denied", code: "E_QUEUE_TIMEOUT" });
    if (A.status !== "queued" || B.status !== "queued") throw new Error("unreachable");
    clock.advance(5000);
    await remote.sttAcquire(req({ ticket: A.ticket }));
    await remote.sttAcquire(req({ ticket: B.ticket }));
    clock.advance(5500); // +60.5 s
    expect(await remote.sttAcquire(req({ ticket: B.ticket }))).toMatchObject({ status: "queued", position: 1 });
    expect((await remote.sttAcquire(req({ ticket: A.ticket }))).status).toBe("granted");
    expect((await remote.sttAcquire(req({ ticket: B.ticket }))).status).toBe("granted");

    // Expiry: a ticket not polled for 6 s loses its place.
    clock.advance(50_000);
    const X = await remote.sttAcquire(req({ n: 1, ipKey: "x" }));
    if (X.status !== "queued") throw new Error(`expected queued, got ${X.status}`);
    clock.advance(6_100);
    expect(await remote.sttAcquire(req({ n: 1, ipKey: "y" }))).toMatchObject({ status: "queued", position: 0 });
    const X2 = await remote.sttAcquire(req({ n: 1, ipKey: "x", ticket: X.ticket }));
    expect(X2).toMatchObject({ status: "queued", position: 1 });
  });

  it("a third queued ticket from one ipKey is refused over HTTP too", async () => {
    await remote.sttAcquire(req());
    await remote.sttAcquire(req());
    clock.advance(50_000);
    expect((await remote.sttAcquire(req({ n: 1, ipKey: "office" }))).status).toBe("queued");
    expect((await remote.sttAcquire(req({ n: 1, ipKey: "office" }))).status).toBe("queued");
    expect(await remote.sttAcquire(req({ n: 1, ipKey: "office" }))).toMatchObject({ status: "denied", code: "E_RATE_LIMITED" });
  });

  it("the rest of the interface round-trips: VA hold/acquire/heartbeat/release, report, ledger, flags", async () => {
    const h = await remote.vaHold({ runId: "r1", visitorId: "v", ipKey: "i", expiresAt: new Date(clock.now() + 60_000).toISOString(), estUsd: 0.5, deployId: "dev-test" });
    if (!h.ok) throw new Error("hold");
    const s = await remote.vaAcquire({ holdId: h.holdId, attempt: 0, capMs: 600_000, source: "script", deployId: "dev-test" });
    if (!s.ok) throw new Error("acquire");
    await remote.heartbeat(s.liveSessionId);
    await remote.report({ sessionId: s.liveSessionId, kind: "va", event: "opened", providerSessionId: "sess" });
    await remote.report({ sessionId: s.liveSessionId, kind: "va", event: "closed", billedSeconds: 12.5 });
    await remote.release(s.liveSessionId, "done");
    const r = await remote.ledger.reserve({ provider: "aai_stt", action: "t", refId: "x", estUsd: 0.01, env: "dev-test" });
    if (!r.ok) throw new Error("reserve");
    await remote.ledger.settle(r.id, 0.005);
    await remote.ledger.release(r.id);
    const sum = await remote.ledger.summary();
    expect(sum.todayUsd.aai_va).toBeCloseTo(12.5 * (4.5 / 3600), 4); // numeric(10,5)
    expect(sum.todayUsd.aai_stt).toBeCloseTo(0.005, 5);
    expect((await remote.flags()).mode).toBe("live");
    const g = await remote.sttAcquire(req({ n: 1 }));
    if (g.status !== "granted") throw new Error("grant");
    await remote.sttCancel("tq_nonexistent");
  });

  it("a wrong key is 403 and a non-authority process is 404 (never a second authority)", async () => {
    const bad = new RemoteLimitsAuthority(BASE, "wrong-key-0123456789", { fetchImpl: routeFetch });
    await expect(bad.flags()).rejects.toMatchObject({ name: "LimitsHttpError", status: 403 });
    process.env.LIMITS_ROLE = "remote";
    const { resetEnvCache } = await import("@/server/env");
    resetEnvCache();
    await expect(remote.flags()).rejects.toBeInstanceOf(LimitsHttpError);
    await expect(remote.flags()).rejects.toMatchObject({ status: 404 });
  });

  it("unreachable authority → the split-budget fallback answers (and 4xx never falls back)", async () => {
    const calls: string[] = [];
    const fallback = {
      sttAcquire: async () => (calls.push("stt"), { status: "granted", grantId: "fb", sessionIds: ["fb1"] }),
      flags: async () => (calls.push("flags"), { mode: "live", reason: null, notice: null, paymentsModeOverride: null, aaiBalanceUsd: null }),
    } as unknown as LimitsAuthority;
    const down = new RemoteLimitsAuthority(BASE, "k-0123456789", {
      fetchImpl: async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
      fallback,
      onWarn: () => undefined,
    });
    expect(await down.sttAcquire(req({ n: 1 }))).toMatchObject({ status: "granted", grantId: "fb" });
    expect((await down.flags()).mode).toBe("live");
    expect(calls).toEqual(["stt", "flags"]);
    const noFallback = new RemoteLimitsAuthority(BASE, "k-0123456789", { fetchImpl: async () => new Response("nope", { status: 503 }) });
    await expect(noFallback.flags()).rejects.toBeInstanceOf(LimitsHttpError);
  });
});

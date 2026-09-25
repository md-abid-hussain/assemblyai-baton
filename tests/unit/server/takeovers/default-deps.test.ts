/**
 * The production wiring of the takeover routes (G1): importing `default-deps` installs a lazy factory over the real
 * WP1/WP2/WP3/WP8 modules. Nothing here touches the network or the database (the limiter is injected, the store and
 * the case repository resolve the DB only when a query runs).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ApiErrorSchema } from "../../../../src/core/contracts/errors";
import type { RateLimiter } from "../../../../src/core/contracts/services";
import { issueCaseToken, signVisitorId, VISITOR_HEADER } from "../../../../src/server/auth";
import { setRateLimiter } from "../../../../src/server/limits";
import { defaultTakeoverRouteDeps, takeoverRouteDeps } from "../../../../src/server/takeovers/default-deps";
import { compileHandler, endHandler } from "../../../../src/server/takeovers/routes";
import { TakeoverServiceImpl } from "../../../../src/server/takeovers/service";
import { setDefaultTakeoverRouteDeps, setTakeoverRouteDeps } from "../../../../src/server/takeovers/wiring";
import { drainFor } from "./_fakes";

const limiter: RateLimiter = { hit: async () => ({ ok: true, retryAfterSec: 0 }) };

const SECRETS = { VISITOR_SECRET: "wp5-test-visitor-secret-0123456789abcdef", CASE_TOKEN_SECRET: "wp5-test-case-token-secret-0123456789abcdef" };
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(SECRETS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

beforeEach(() => {
  setRateLimiter(limiter);
  setTakeoverRouteDeps(null);
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setTakeoverRouteDeps(null);
  setDefaultTakeoverRouteDeps(null);
  setRateLimiter(null);
});

describe("default takeover route deps (G1 wiring)", () => {
  it("builds the real service on first use and keeps it", () => {
    const d = takeoverRouteDeps();
    expect(d.service).toBeInstanceOf(TakeoverServiceImpl);
    expect(d.rateLimiter).toBe(limiter);
    expect(takeoverRouteDeps()).toBe(d);
  });

  it("an explicit override wins; resetting it falls back to the factory again", () => {
    const fake = defaultTakeoverRouteDeps();
    setTakeoverRouteDeps(fake);
    expect(takeoverRouteDeps()).toBe(fake);
    setTakeoverRouteDeps(null);
    const rebuilt = takeoverRouteDeps();
    expect(rebuilt).not.toBe(fake);
    expect(rebuilt.service).toBeInstanceOf(TakeoverServiceImpl);
  });

  it("the routes authorize with WP2's real requireCase (not 'not wired')", async () => {
    const compile = compileHandler(takeoverRouteDeps);
    const noToken = await compile(
      new Request("http://x/api/takeovers/tko_1/compile", { method: "POST", body: JSON.stringify({ drain: drainFor(40_000) }) }),
      { params: Promise.resolve({ id: "tko_1" }) },
    );
    expect(noToken.status).toBe(401);
    expect(ApiErrorSchema.parse(await noToken.json()).error.code).toBe("E_CASE_TOKEN");

    // A real takeover token for another takeover of the same visitor → 403 E_FORBIDDEN from WP2's requireCase.
    const token = await issueCaseToken({ caseId: "case_1", visitorId: "vis_1", takeoverId: "tko_other" });
    const end = endHandler(takeoverRouteDeps);
    const res = await end(
      new Request("http://x/api/takeovers/tko_1/end", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, [VISITOR_HEADER]: signVisitorId("vis_1"), "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify({ outcome: "abandoned", vaSessionId: null, reason: "pagehide" }),
      }),
      { params: Promise.resolve({ id: "tko_1" }) },
    );
    expect(res.status).toBe(403);
    expect(ApiErrorSchema.parse(await res.json()).error).toMatchObject({ code: "E_FORBIDDEN", message: "The token is not for this takeover." });
  });
});

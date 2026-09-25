/**
 * Route handlers #9, #11, #12, #13 (DESIGN §4.4) with a fake auth, a fake rate limiter and the real service over the
 * in-memory store.
 */
import { afterEach, describe, expect, it } from "vitest";

import { ArmResponseSchema, CompiledTakeoverSchema, EndTakeoverResponseSchema } from "../../../../src/core/contracts/api";
import { ApiErrorSchema, BatonError } from "../../../../src/core/contracts/errors";
import type { RateLimiter } from "../../../../src/core/contracts/services";
import { armHandler, compileHandler, endHandler, eventsHandler, TAKEOVER_RATE, type TakeoverRouteDeps } from "../../../../src/server/takeovers/routes";
import { setTakeoverRouteDeps, takeoverRouteDeps } from "../../../../src/server/takeovers/wiring";
import { armReq, drainFor, harness, recordedPlan } from "./_fakes";

/** Bearer "<caseId>|<visitorId>|<takeoverId or ->" stands in for WP2's JWT. */
function fakeRequireCase(req: Request, want: { caseId?: string; takeoverId?: string }) {
  const h = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!h) return Promise.reject(new BatonError("E_CASE_TOKEN", "Missing case token."));
  const [caseId = "", visitorId = "", tko = "-"] = h.split("|");
  if (want.caseId !== undefined && want.caseId !== caseId) return Promise.reject(new BatonError("E_FORBIDDEN", "The token is for another case."));
  if (want.takeoverId !== undefined && want.takeoverId !== tko) return Promise.reject(new BatonError("E_FORBIDDEN", "The token is not for this takeover."));
  return Promise.resolve({ caseId, visitorId, ipKey: "ip_1", takeoverId: tko === "-" ? null : tko });
}

class FakeLimiter implements RateLimiter {
  counts = new Map<string, number>();
  hits: { bucket: string; key: string; limit: number; windowSec: number }[] = [];
  broken = false;
  async hit(bucket: string, key: string, limit: number, windowSec: number) {
    if (this.broken) throw new Error("rate_events unavailable");
    this.hits.push({ bucket, key, limit, windowSec });
    const k = `${bucket}:${key}`;
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    return { ok: n <= limit, retryAfterSec: n <= limit ? 0 : 42 };
  }
}

function setup() {
  const h = harness();
  h.store.addCase({ id: "case_1" });
  const limiter = new FakeLimiter();
  const deps: TakeoverRouteDeps = { service: h.svc, requireCase: fakeRequireCase, rateLimiter: limiter };
  const get = () => deps;
  return { h, limiter, deps, arm: armHandler(get), compile: compileHandler(get), events: eventsHandler(get), end: endHandler(get) };
}

const post = (url: string, body: unknown, auth?: string) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const armBody = () => {
  const { visitorId: _v, ...b } = armReq();
  return b;
};

async function armed(s: ReturnType<typeof setup>) {
  const res = await s.arm(post("/api/takeovers", armBody(), "case_1|vis_1|-"));
  const body = ArmResponseSchema.parse(await res.json());
  return { id: body.takeoverId, auth: `case_1|vis_1|${body.takeoverId}` };
}

afterEach(() => setTakeoverRouteDeps(null));

describe("#9 POST /api/takeovers", () => {
  it("200 ArmResponse with the case token of the body's case", async () => {
    const s = setup();
    const res = await s.arm(post("/api/takeovers", armBody(), "case_1|vis_1|-"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(ArmResponseSchema.parse(await res.json())).toEqual({ takeoverId: "tko_1", takeoverToken: "jwt.tko_1", leadMs: 900 });
    expect(s.limiter.hits[0]).toEqual({ bucket: TAKEOVER_RATE.arm.bucket, key: "case_1", limit: 10, windowSec: 3600 });
  });

  it("400 on a bad body, 401 without a token, 403 for another case", async () => {
    const s = setup();
    const bad = await s.arm(post("/api/takeovers", { caseId: "case_1" }, "case_1|vis_1|-"));
    expect(bad.status).toBe(400);
    expect(ApiErrorSchema.parse(await bad.json()).error.code).toBe("E_BAD_REQUEST");
    expect((await s.arm(post("/api/takeovers", "{nope", "case_1|vis_1|-"))).status).toBe(400);
    expect((await s.arm(post("/api/takeovers", armBody()))).status).toBe(401);
    const other = await s.arm(post("/api/takeovers", armBody(), "case_9|vis_1|-"));
    expect(other.status).toBe(403);
  });

  it("409 with the recorded fallback for aiHalf:recorded runs", async () => {
    const s = setup();
    s.h.store.addCase({ id: "case_1", runPlan: recordedPlan("case_1") });
    const res = await s.arm(post("/api/takeovers", armBody(), "case_1|vis_1|-"));
    expect(res.status).toBe(409);
    expect(ApiErrorSchema.parse(await res.json()).error).toMatchObject({ code: "E_CASE_STATE", fallback: "recorded_ai_session" });
  });

  it("429 with Retry-After when the limiter refuses", async () => {
    const s = setup();
    s.limiter.counts.set(`${TAKEOVER_RATE.arm.bucket}:case_1`, 10);
    const res = await s.arm(post("/api/takeovers", armBody(), "case_1|vis_1|-"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(ApiErrorSchema.parse(await res.json()).error).toMatchObject({ code: "E_RATE_LIMITED", retryAfterMs: 42_000 });
  });
});

describe("#11 POST /api/takeovers/[id]/compile", () => {
  it("returns a CompiledTakeover for the takeover token of the path id", async () => {
    const s = setup();
    const { id, auth } = await armed(s);
    const res = await s.compile(post(`/api/takeovers/${id}/compile`, { drain: drainFor(61_234.5) }, auth), params(id));
    expect(res.status).toBe(200);
    const c = CompiledTakeoverSchema.parse(await res.json());
    expect(c.compiledBy).toBe("server");
    expect(s.h.calls.validate).toHaveLength(1);
  });

  it("403 for a token of another takeover (or the plain case token); 404 for an unknown id", async () => {
    const s = setup();
    const { id } = await armed(s);
    expect((await s.compile(post(`/api/takeovers/${id}/compile`, { drain: drainFor(61_234.5) }, "case_1|vis_1|-"), params(id))).status).toBe(403);
    expect((await s.compile(post(`/api/takeovers/${id}/compile`, { drain: drainFor(61_234.5) }, "case_1|vis_1|tko_other"), params(id))).status).toBe(403);
    const unknown = await s.compile(post(`/api/takeovers/tko_x/compile`, { drain: drainFor(1) }, "case_1|vis_1|tko_x"), params("tko_x"));
    expect(unknown.status).toBe(404);
  });

  it("500 E_VA_CONFIG when the first update does not validate", async () => {
    const s = setup();
    s.h.deps.validateFirstUpdate = () => {
      throw new BatonError("E_VA_CONFIG", "bad schema keyword");
    };
    const { id, auth } = await armed(s);
    const res = await s.compile(post(`/api/takeovers/${id}/compile`, { drain: drainFor(61_234.5) }, auth), params(id));
    expect(res.status).toBe(500);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe("E_VA_CONFIG");
  });

  it("3 compiles per takeover", async () => {
    const s = setup();
    const { id, auth } = await armed(s);
    for (let i = 0; i < 3; i++) expect((await s.compile(post(`/api/takeovers/${id}/compile`, { drain: drainFor(61_234.5) }, auth), params(id))).status).toBe(200);
    expect((await s.compile(post(`/api/takeovers/${id}/compile`, { drain: drainFor(61_234.5) }, auth), params(id))).status).toBe(429);
  });
});

describe("#12 POST /api/takeovers/[id]/events", () => {
  it("{ok:true}; heartbeats reach the limits authority; a broken limiter fails open", async () => {
    const s = setup();
    const { id, auth } = await armed(s);
    const res = await s.events(post(`/api/takeovers/${id}/events`, { heartbeat: true, vaSessionId: "sess_A" }, auth), params(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    s.limiter.broken = true;
    expect((await s.events(post(`/api/takeovers/${id}/events`, { heartbeat: true }, auth), params(id))).status).toBe(200);
    expect(s.h.calls.heartbeat).toEqual([`va_${id}_0`, `va_${id}_0`]);
  });

  it("400 for an unknown phase or error code", async () => {
    const s = setup();
    const { id, auth } = await armed(s);
    expect((await s.events(post(`/api/takeovers/${id}/events`, { phase: "flying" }, auth), params(id))).status).toBe(400);
    expect((await s.events(post(`/api/takeovers/${id}/events`, { failure: { code: "E_NOPE" } }, auth), params(id))).status).toBe(400);
  });
});

describe("#13 POST /api/takeovers/[id]/end", () => {
  it("{ok:true, verificationJobId}; 2 per takeover", async () => {
    const s = setup();
    const { id, auth } = await armed(s);
    const res = await s.end(post(`/api/takeovers/${id}/end`, { outcome: "completed", vaSessionId: "sess_A", reason: "close_ready" }, auth), params(id));
    expect(res.status).toBe(200);
    expect(EndTakeoverResponseSchema.parse(await res.json())).toEqual({ ok: true, verificationJobId: "job_1" });
    expect((await s.end(post(`/api/takeovers/${id}/end`, { outcome: "abandoned", vaSessionId: null, reason: "pagehide" }, auth), params(id))).status).toBe(200);
    expect((await s.end(post(`/api/takeovers/${id}/end`, { outcome: "abandoned", vaSessionId: null }, auth), params(id))).status).toBe(429);
  });
});

describe("wiring", () => {
  it("before G1 the routes answer 500 'not wired' instead of crashing", async () => {
    setTakeoverRouteDeps(null);
    const res = await armHandler(takeoverRouteDeps)(post("/api/takeovers", armBody(), "case_1|vis_1|-"));
    expect(res.status).toBe(500);
    expect(ApiErrorSchema.parse(await res.json()).error.message).toMatch(/not wired/);
  });

  it("setTakeoverRouteDeps installs the wired dependencies", async () => {
    const s = setup();
    setTakeoverRouteDeps(s.deps);
    const res = await armHandler(takeoverRouteDeps)(post("/api/takeovers", armBody(), "case_1|vis_1|-"));
    expect(res.status).toBe(200);
  });

  it("an unexpected error is a generic 500 (no internals leaked)", async () => {
    const s = setup();
    s.deps.service = { ...s.deps.service, arm: async () => { throw new Error("secret internals"); } } as never;
    const res = await s.arm(post("/api/takeovers", armBody(), "case_1|vis_1|-"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret internals/);
  });
});

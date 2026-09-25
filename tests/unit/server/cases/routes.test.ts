/**
 * Routes #3, #4, #8 end to end (handlers called directly; real Postgres; stand-in platform; fake luna; $0).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CaseViewSchema, CreateCaseResponseSchema, ExtractResponseSchema } from "@/core/contracts/api";
import { ApiErrorSchema } from "@/core/contracts/errors";
import { MemoryCaseDataSource } from "@/server/data";
import { setCasesDeps } from "@/server/cases";
import { stubEngine } from "@/server/cases/engine-stub";
import { createStubPlatform } from "@/server/cases/platform-stub";
import { POST as createRoute } from "@/app/api/cases/route";
import { GET as viewRoute } from "@/app/api/cases/[caseId]/route";
import { POST as extractRoute } from "@/app/api/extract/route";
import { callEntry, dialog, FakeExtractor, FakeVerifier, policyOf, turnOf } from "./helpers/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "./helpers/test-db";

const SECRETS = { VISITOR_SECRET: "test-visitor-secret-0123456789abcdef", CASE_TOKEN_SECRET: "test-case-token-secret-0123456789abcdef" };

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = (url: string, headers: Record<string, string> = {}) => new Request(`http://localhost${url}`, { headers: { "x-forwarded-for": "203.0.113.7", ...headers } });
const params = (caseId: string) => ({ params: Promise.resolve({ caseId }) });

describe.skipIf(!HAS_DB)("routes #3 #4 #8", () => {
  let t: TestDb;
  let extractor: FakeExtractor;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    t = await createTestDb("wp3_routes");
    for (const [k, v] of Object.entries(SECRETS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    extractor = new FakeExtractor(stubEngine);
    setCasesDeps({
      db: t.db, engine: stubEngine, platform: createStubPlatform(), extractor, verifier: new FakeVerifier(() => []),
      data: new MemoryCaseDataSource({
        policies: { s01: policyOf("s01") },
        calls: [callEntry("s01_take1"), callEntry("s02_private", { featured: false, publishAudio: false, assets: null })],
      }),
      verifierEnabled: () => false,
    });
  });
  afterAll(async () => {
    setCasesDeps(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await t?.drop();
  });

  async function start(headers: Record<string, string> = {}) {
    const res = await createRoute(post("/api/cases", { mode: "watch", callId: "s01_take1" }, headers), undefined as never);
    expect(res.status).toBe(200);
    return CreateCaseResponseSchema.parse(await res.json());
  }

  it("#3 creates a Watch case: token, policy, manifest entry, assets, visitor token", async () => {
    const c = await start();
    expect(c.call?.callId).toBe("s01_take1");
    expect(c.assets.rep).toMatch(/^\/calls\/s01_take1\/rep\./);
    expect(c.policy.policyNumber).toBe("NBM-4418207");
    expect(c.state.readiness.requiredTotal).toBe(10);
    expect(c.visitorToken).toMatch(/\./);
    expect(c.cachedTurnsUrl).toBeNull();
    // no callId → the featured call
    const f = await createRoute(post("/api/cases", { mode: "watch" }), undefined as never);
    expect(CreateCaseResponseSchema.parse(await f.json()).call?.callId).toBe("s01_take1");
  });

  it("#3 errors: unknown call 404, unpublished audio 409, bad body 400, 11th case per visitor per hour 429", async () => {
    const unknown = await createRoute(post("/api/cases", { mode: "watch", callId: "nope" }), undefined as never);
    expect(unknown.status).toBe(404);
    expect(ApiErrorSchema.parse(await unknown.json()).error.code).toBe("E_NOT_FOUND");
    const priv = await createRoute(post("/api/cases", { mode: "watch", callId: "s02_private" }), undefined as never);
    expect(priv.status).toBe(409);
    const bad = await createRoute(post("/api/cases", { mode: "karaoke" }), undefined as never);
    expect(bad.status).toBe(400);
    expect(ApiErrorSchema.parse(await bad.json()).error.code).toBe("E_BAD_REQUEST");
    const first = await start({ "x-forwarded-for": "198.51.100.9" });
    const vh = { "x-baton-visitor": first.visitorToken!, "x-forwarded-for": "198.51.100.9" };
    let last: Response | null = null;
    for (let i = 0; i < 10; i++) last = await createRoute(post("/api/cases", { mode: "watch", callId: "s01_take1" }, vh), undefined as never);
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("#8 extracts with case auth; #4 returns the CaseView; auth failures are 401/403", async () => {
    const c = await start({ "x-forwarded-for": "192.0.2.1" });
    const auth = { authorization: `Bearer ${c.caseToken}`, "x-baton-visitor": c.visitorToken!, "x-forwarded-for": "192.0.2.1" };
    const turn = turnOf(c.caseId, dialog.turns[3]!);
    const r = await extractRoute(post("/api/extract", { turn }, auth), undefined as never);
    expect(r.status).toBe(200);
    const body = ExtractResponseSchema.parse(await r.json());
    expect(body.events.map((e) => e.field)).toEqual(["driver_full_name", "driver_dob", "driver_age"]);
    expect(body.state.version).toBe(1);
    const dup = ExtractResponseSchema.parse(await (await extractRoute(post("/api/extract", { turn }, auth), undefined as never)).json());
    expect(dup.skipped).toBe("duplicate");

    const v = await viewRoute(get(`/api/cases/${c.caseId}`, auth), params(c.caseId));
    expect(v.status).toBe(200);
    const view = CaseViewSchema.parse(await v.json());
    expect(view.turns.map((x) => x.turnId)).toEqual(["customer-1"]);
    expect(view.facts).toHaveLength(3);
    expect(view.takeover).toBeNull();
    expect(view.payment).toBeNull();

    expect((await viewRoute(get(`/api/cases/${c.caseId}`), params(c.caseId))).status).toBe(401);
    const other = await start({ "x-forwarded-for": "192.0.2.2" });
    // a token for another case
    expect((await viewRoute(get(`/api/cases/${c.caseId}`, { ...auth, authorization: `Bearer ${other.caseToken}`, "x-baton-visitor": other.visitorToken! }), params(c.caseId))).status).toBe(403);
    // the right token from another visitor
    expect((await viewRoute(get(`/api/cases/${c.caseId}`, { ...auth, "x-baton-visitor": other.visitorToken! }), params(c.caseId))).status).toBe(403);
    // a turn for another case with this case's token
    const foreign = await extractRoute(post("/api/extract", { turn: turnOf(other.caseId, dialog.turns[1]!) }, auth), undefined as never);
    expect(foreign.status).toBe(403);
    // invalid turn id format → 400
    const badId = await extractRoute(post("/api/extract", { turn: { ...turn, turnId: "customer-c1" } }, auth), undefined as never);
    expect(badId.status).toBe(400);
    expect((await extractRoute(post("/api/extract", "{not json", auth), undefined as never)).status).toBe(400);
  });
});

/**
 * G1 integration of the takeover routes over Postgres: arm (#9) → compile (#11) → events (#12) → end (#13) → arm again,
 * through `buildTakeoverRouteDeps` with the REAL collaborators merged at G1:
 *   WP1 compileTakeover / buildFirstUpdate / validateFirstUpdate and the case engine (applyExtraction, deriveCaseState);
 *   WP2 issueCaseToken / requireCase / vaSessionIdFor;
 *   WP3 PgCaseRepository (create, turns, events, run plan, freezeSnapshot under the case lock).
 * Only the limits authority, the rate limiter and WP8's enqueue are fakes (they would need live-session rows and the
 * job runner). $0: a throwaway local database, no network. Skips without DATABASE_URL.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyExtraction, buildExtractorInput, deriveCaseState, emptyCaseState, verifierDisagreementEvents,
} from "../../../../src/core/case";
import { buildFirstUpdate, compileTakeover, validateFirstUpdate } from "../../../../src/core/compiler";
import { ArmResponseSchema, CompiledTakeoverSchema, EndTakeoverResponseSchema, type ArmRequest } from "../../../../src/core/contracts/api";
import type { FieldId } from "../../../../src/core/contracts/case";
import type { DrainReport } from "../../../../src/core/contracts/takeover";
import { issueCaseToken, requireCase, signVisitorId, VISITOR_HEADER } from "../../../../src/server/auth";
import type { CaseEngine } from "../../../../src/server/cases/engine";
import { PgCaseRepository } from "../../../../src/server/cases/repository";
import { cases, takeovers } from "../../../../src/server/db/schema";
import { vaSessionIdFor } from "../../../../src/server/limits";
import { armHandler, compileHandler, endHandler, eventsHandler } from "../../../../src/server/takeovers/routes";
import { buildTakeoverRouteDeps } from "../../../../src/server/takeovers/wiring";
import { runPlan } from "../../contracts/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "./_db";
import { kit, passPoints, policyOf, snapshotAt, synthCall } from "./_scenarios";

const SECRETS = { VISITOR_SECRET: "wp5-g1-visitor-secret-0123456789abcdef", CASE_TOKEN_SECRET: "wp5-g1-case-token-secret-0123456789abcdef" };
const CASE_ID = "case_g1_s01";
const VISITOR = "vis_g1";

/** WP1's engine behind WP3's CaseEngine seam (the same binding wp3-to-integrator.md §1 gives for defaults.ts). */
const wp1Engine = {
  impl: "wp1",
  emptyCaseState, deriveCaseState, applyExtraction, verifierDisagreementEvents, buildExtractorInput,
  extractor: { prompt: "", format: {}, model: "", effort: "", version: "", maxNewTurns: 4, recentTurns: 6 },
} as unknown as CaseEngine;

describe.skipIf(!HAS_DB)("G1: takeover routes over Postgres with WP1, WP2 and WP3", () => {
  let t: TestDb;
  const saved: Record<string, string | undefined> = {};
  const heartbeats: string[] = [];
  const releases: [string, string][] = [];
  const enqueued: [string, string | null][] = [];
  const s = kit("s01");
  const policy = policyOf(s);
  const call = synthCall(s, policy, CASE_ID);
  const tArmMs = passPoints(call).middle;
  let repo: PgCaseRepository;
  let deps: ReturnType<typeof buildTakeoverRouteDeps>;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(SECRETS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    t = await createTestDb("wp5g1");
    repo = new PgCaseRepository({ db: t.db, engine: wp1Engine, policyOf: async () => policy, newCaseId: () => CASE_ID });
    await repo.create({ mode: "watch", callId: null, scenarioId: "s01", visitorId: VISITOR, ipKey: "ip_g1" });
    for (const turn of call.turns) expect(await repo.insertTurn(turn)).toBe("inserted");
    await repo.applyEvents(CASE_ID, 0, call.events);
    await repo.setRunPlan(CASE_ID, { ...runPlan, caseId: CASE_ID });
    deps = buildTakeoverRouteDeps({
      getDb: () => t.db,
      requireCase: (req, want) => requireCase(req, { ...want, scope: "case" }),
      issueCaseToken: (i) => issueCaseToken(i),
      getLimitsAuthority: () => ({
        heartbeat: async (id: string) => void heartbeats.push(id),
        release: async (id: string, reason: string) => void releases.push([id, reason]),
      }),
      getRateLimiter: null,
      vaSessionIdFor,
      caseRepository: () => repo,
      compileTakeover,
      buildFirstUpdate,
      validateFirstUpdate,
      enqueueVerification: async (tko, vaSid) => {
        enqueued.push([tko, vaSid]);
        return `job_${tko}`;
      },
      config: { deployId: "dev-wp5-g1", voice: "alba", keytermsEnabled: true, payToolMode: "push", capEnv: { baseMs: 150_000, perFieldMs: 15_000, maxMs: 420_000 } },
    });
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await t?.drop();
  });

  const post = (path: string, token: string, body: unknown) =>
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, [VISITOR_HEADER]: signVisitorId(VISITOR), "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(body),
    });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const arm = async (tArm: number) => {
    const caseToken = await issueCaseToken({ caseId: CASE_ID, visitorId: VISITOR });
    const body: ArmRequest = { caseId: CASE_ID, runId: runPlan.runId, tArmMs: tArm, midUtterance: false, source: "manual" };
    return armHandler(() => deps)(post("/api/takeovers", caseToken, body));
  };

  it("arm → compile (WP3 freeze + WP1 compile) → events → end → arm again", async () => {
    // #9 arm
    const armRes = await arm(tArmMs);
    expect(armRes.status).toBe(200);
    const armed = ArmResponseSchema.parse(await armRes.json());
    expect(armed.leadMs).toBe(900);
    expect((await repo.load(CASE_ID))!.status).toBe("armed");

    // #11 compile with the takeover token; the plain case token is refused
    const drain: DrainReport = {
      tArmMs, tCutMs: tArmMs + 400, capHit: false, midUtterance: false, completedTurnIds: [], pendingTurnIds: [], cutTurnIds: [],
      waitedMs: 150, timings: { armed: 0, sealed: 400, finals: 650, drained: 800 },
    };
    const caseToken = await issueCaseToken({ caseId: CASE_ID, visitorId: VISITOR });
    expect((await compileHandler(() => deps)(post(`/api/takeovers/${armed.takeoverId}/compile`, caseToken, { drain }), ctx(armed.takeoverId))).status).toBe(403);
    const compileRes = await compileHandler(() => deps)(post(`/api/takeovers/${armed.takeoverId}/compile`, armed.takeoverToken, { drain }), ctx(armed.takeoverId));
    expect(compileRes.status).toBe(200);
    const compiled = CompiledTakeoverSchema.parse(await compileRes.json());
    expect(() => validateFirstUpdate(buildFirstUpdate(compiled), { keytermsEnabled: true })).not.toThrow();
    expect(compiled.compiledBy).toBe("server");
    expect(compiled.keyterms.length).toBeGreaterThan(0);

    // The frozen snapshot: exactly the fields VERIFIED by tArm (turns after tArm were marked late and cannot verify).
    const verified = (fields: Record<string, { status: string }>) => Object.entries(fields).filter(([, f]) => f.status === "VERIFIED").map(([k]) => k as FieldId).sort();
    const expected = snapshotAt(call, policy, CASE_ID, tArmMs);
    expect(verified(compiled.snapshot.fields)).toEqual(verified(expected.fields));
    expect(verified(compiled.snapshot.fields).length).toBeGreaterThan(0);
    expect(verified(compiled.snapshot.fields).length).toBeLessThan(verified(snapshotAt(call, policy, CASE_ID, passPoints(call).handoff).fields).length);

    const [caseRow] = await t.db.select().from(cases).where(eq(cases.id, CASE_ID));
    expect(caseRow!.status).toBe("ai_active");
    const [tko] = await t.db.select().from(takeovers).where(eq(takeovers.id, armed.takeoverId));
    expect(tko!.snapshot).toEqual(compiled.snapshot);
    expect(tko!.greeting).toBe(compiled.greeting);
    expect(Object.keys(tko!.protocol as Record<string, unknown>)).toEqual(expect.arrayContaining(["freeze", "compile", "source", "runId"]));

    // #12 events: the first audible greeting (timings + provider session id), a heartbeat
    const ev = eventsHandler(() => deps);
    expect((await ev(post(`/api/takeovers/${armed.takeoverId}/events`, armed.takeoverToken, { phase: "active", vaSessionId: "sess_g1", timings: { sessionUpdateSent: 2100, firstAudiblePlayed: 3000 } }), ctx(armed.takeoverId))).status).toBe(200);
    expect((await ev(post(`/api/takeovers/${armed.takeoverId}/events`, armed.takeoverToken, { heartbeat: true }), ctx(armed.takeoverId))).status).toBe(200);
    expect(heartbeats).toEqual([vaSessionIdFor(armed.takeoverId, 0)]);

    // #13 end → WP8 enqueue with the stored provider session id; the case can be passed again
    const endRes = await endHandler(() => deps)(post(`/api/takeovers/${armed.takeoverId}/end`, armed.takeoverToken, { outcome: "handed_back", vaSessionId: null, reason: "hand_back" }), ctx(armed.takeoverId));
    expect(endRes.status).toBe(200);
    expect(EndTakeoverResponseSchema.parse(await endRes.json()).verificationJobId).toBe(`job_${armed.takeoverId}`);
    expect(enqueued).toEqual([[armed.takeoverId, "sess_g1"]]);
    const [ended] = await t.db.select().from(takeovers).where(eq(takeovers.id, armed.takeoverId));
    expect(ended).toMatchObject({ outcome: "handed_back", phase: "done", vaSessionId: "sess_g1" });
    expect(ended!.endedAt).toBeInstanceOf(Date);
    expect((await repo.load(CASE_ID))!.status).toBe("handed_back");

    // Pass the baton again (§1.3 P1 step 9): a second takeover of the same case
    const again = await arm(passPoints(call).handoff);
    expect(again.status).toBe(200);
    const second = ArmResponseSchema.parse(await again.json());
    expect(second.takeoverId).not.toBe(armed.takeoverId);
    expect(second.leadMs).toBe(900);
  });
});

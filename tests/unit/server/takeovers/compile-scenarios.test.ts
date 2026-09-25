/**
 * WP5 acceptance 2: route #11 (/compile) returns a config that passes `validateFirstUpdate` for s01, s02 and s05 at
 * three pass points each, with WP1's REAL compiler and case engine (merged at G1).
 *
 * Snapshot at a pass point: a synthetic, talk-track-shaped call (as WP1's scenarios test) goes through the real
 * `applyExtraction`; the events of turns that ended by tArm are derived with `deriveCaseState(policy, events,
 * {tArmMs})` (what WP3's freezeSnapshot does). The service then freezes (fake repository returning that state),
 * compiles (WP1), validates, and the route returns the JSON, which is parsed with the contract schema and validated
 * again, byte for byte as the client will send it. `g1-integration.pg.test.ts` repeats one point over Postgres with
 * WP3's real freeze.
 */
import { describe, expect, it } from "vitest";

import { CompiledTakeoverSchema, type CompiledTakeover } from "../../../../src/core/contracts/api";
import type { CaseState, PolicyRecord } from "../../../../src/core/contracts/case";
import type { DrainReport } from "../../../../src/core/contracts/takeover";
import { buildFirstUpdate, compileTakeover, validateFirstUpdate } from "../../../../src/core/compiler";
import { compileHandler } from "../../../../src/server/takeovers/routes";
import { TakeoverServiceImpl } from "../../../../src/server/takeovers/service";
import { FakeStore } from "./_fakes";
import { HANDOFF_POINTS, kit, passPoints, policyOf, snapshotAt as snapshotOf, synthCall } from "./_scenarios";

// ------------------------------------------------------------------------------------------------ the route under test

async function compileViaRoute(o: { policy: PolicyRecord; snapshotAt: (tArm: number) => CaseState; tArmMs: number; keytermsEnabled: boolean; payToolMode: "hold" | "push" }): Promise<CompiledTakeover> {
  const store = new FakeStore();
  store.addCase({ id: "case_x", policy: o.policy });
  const svc = new TakeoverServiceImpl({
    store,
    cases: { freezeSnapshot: async (_caseId, _tko, drain) => o.snapshotAt(drain.tArmMs) },
    compileTakeover,
    buildFirstUpdate,
    validateFirstUpdate,
    issueTakeoverToken: async () => "jwt",
    limits: { heartbeat: async () => undefined, release: async () => undefined },
    liveSessionIdFor: (id, a) => `va_${id}_${a}`,
    enqueueVerification: async () => null,
    config: { deployId: "dev-wp5", voice: "alba", keytermsEnabled: o.keytermsEnabled, payToolMode: o.payToolMode, capEnv: { baseMs: 150_000, perFieldMs: 15_000, maxMs: 420_000 } },
  });
  const { takeoverId } = await svc.arm({ caseId: "case_x", runId: "run_1", tArmMs: o.tArmMs, midUtterance: false, source: "manual", visitorId: "vis_1" });
  const drain: DrainReport = { tArmMs: o.tArmMs, tCutMs: o.tArmMs + 400, capHit: false, midUtterance: false, completedTurnIds: [], pendingTurnIds: [], cutTurnIds: [], waitedMs: 150, timings: { armed: 0, sealed: 400, finals: 650, drained: 800 } };
  const route = compileHandler(() => ({ service: svc, requireCase: async () => ({ caseId: "case_x", visitorId: "vis_1", ipKey: "ip", takeoverId }), rateLimiter: null }));
  const res = await route(
    new Request(`http://localhost/api/takeovers/${takeoverId}/compile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ drain }) }),
    { params: Promise.resolve({ id: takeoverId }) },
  );
  const body: unknown = await res.json();
  if (res.status !== 200) throw new Error(`compile ${res.status}: ${JSON.stringify(body)}`);
  return CompiledTakeoverSchema.parse(body);
}

describe("acceptance 2: /compile passes validateFirstUpdate for s01, s02, s05 at 3 pass points", () => {
  for (const id of ["s01", "s02", "s05"]) {
    const s = kit(id);
    const policy = policyOf(s);
    const caseId = `case_${id}`;
    const call = synthCall(s, policy, caseId);
    const points = passPoints(call);
    const snapshotAt = (tArm: number): CaseState => snapshotOf(call, policy, caseId, tArm);

    for (const point of HANDOFF_POINTS) {
      for (const keytermsEnabled of [false, true]) {
        it(`${id} @ ${point} (keyterms ${keytermsEnabled ? "on" : "off"})`, async () => {
          const tArmMs = points[point];
          const snap = snapshotAt(tArmMs);
          const t0 = performance.now();
          const compiled = await compileViaRoute({ policy, snapshotAt, tArmMs, keytermsEnabled, payToolMode: "push" });
          const routeMs = performance.now() - t0;
          // what the client sends: the first update built from the route's JSON
          const msg = buildFirstUpdate(compiled);
          expect(() => validateFirstUpdate(msg, { keytermsEnabled })).not.toThrow();
          expect(compiled.compiledBy).toBe("server");
          expect(compiled.snapshot).toEqual(snap);
          expect(compiled.greeting.length).toBeGreaterThan(20);
          expect(compiled.deployMarker).toContain("dev-wp5");
          expect(compiled.systemPrompt).toContain("dev-wp5");
          expect(compiled.keyterms.length > 0).toBe(keytermsEnabled);
          expect(compiled.vaSessionCapMs).toBeGreaterThanOrEqual(150_000);
          expect(compiled.vaSessionCapMs).toBeLessThanOrEqual(420_000);
          if (process.env.WP5_REPORT) {
            const verified = Object.values(snap.fields).filter((f) => f.status === "VERIFIED").length;
            console.info(`[wp5] ${id} @${point} kt=${keytermsEnabled ? 1 : 0} tArm=${tArmMs} verified=${verified} stage=${compiled.stage} mode=${compiled.transcriptionMode} cap=${compiled.vaSessionCapMs} greetingWords=${compiled.greeting.split(/\s+/).length} keyterms=${compiled.keyterms.length} prompt=${compiled.systemPrompt.length} routeMs=${routeMs.toFixed(1)}`);
          }
        });
      }
    }

    it(`${id}: the snapshot grows along the call (more VERIFIED fields at the handoff than early)`, () => {
      const verified = (st: CaseState) => Object.values(st.fields).filter((f) => f.status === "VERIFIED").length;
      expect(verified(snapshotAt(points.handoff))).toBeGreaterThan(verified(snapshotAt(points.early)));
    });
  }

  it("hold pay mode compiles and validates too (s02 at the handoff)", async () => {
    const s = kit("s02");
    const policy = policyOf(s);
    const call = synthCall(s, policy, "case_s02");
    const tArm = call.turns.at(-1)!.endMs + 150;
    const snapshotAt = (t: number) => snapshotOf(call, policy, "case_s02", t);
    const compiled = await compileViaRoute({ policy, snapshotAt, tArmMs: tArm, keytermsEnabled: true, payToolMode: "hold" });
    expect(() => validateFirstUpdate(buildFirstUpdate(compiled), { keytermsEnabled: true })).not.toThrow();
  });
});

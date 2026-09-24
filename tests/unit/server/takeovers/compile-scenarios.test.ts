/**
 * WP5 acceptance 2: route #11 (/compile) returns a config that passes `validateFirstUpdate` for s01, s02 and s05 at
 * three pass points each, with WP1's REAL compiler and case engine.
 *
 * WP1's modules (src/core/compiler, src/core/case) are merged at G1. Until then this suite loads them from WP1's
 * worktree when `BATON_WP1_ROOT` points at it (read-only), e.g.
 *   BATON_WP1_ROOT=../wp1 npx vitest run tests/unit/server/takeovers/compile-scenarios.test.ts
 * and skips otherwise. After the G1 merge it runs from this repo automatically.
 *
 * Snapshot at a pass point: a synthetic, talk-track-shaped call (as WP1's scenarios test) goes through the real
 * `applyExtraction`; the events of turns that ended by tArm are derived with `deriveCaseState(policy, events,
 * {tArmMs})` (what WP3's freezeSnapshot does). The service then freezes (fake repository returning that state),
 * compiles (WP1), validates, and the route returns the JSON, which is parsed with the contract schema and validated
 * again, byte for byte as the client will send it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CompiledTakeoverSchema, type CompiledTakeover } from "../../../../src/core/contracts/api";
import type { CaseState, FactEvent, FieldId, FieldStatus, PolicyRecord } from "../../../../src/core/contracts/case";
import { turnIdOf } from "../../../../src/core/contracts/turns";
import type { TurnInput } from "../../../../src/core/contracts/turns";
import type { DrainReport } from "../../../../src/core/contracts/takeover";
import { compileHandler } from "../../../../src/server/takeovers/routes";
import { TakeoverServiceImpl, type BuildFirstUpdateFn, type CompileTakeoverFn } from "../../../../src/server/takeovers/service";
import { FakeStore } from "./_fakes";

const HERE = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const WP1_ROOT = resolve(process.env.BATON_WP1_ROOT ? resolve(HERE, process.env.BATON_WP1_ROOT) : HERE);
const COMPILER = join(WP1_ROOT, "src/core/compiler/index.ts");
const CASE = join(WP1_ROOT, "src/core/case/index.ts");
const HAS_WP1 = existsSync(COMPILER) && existsSync(CASE);

interface Wp1Compiler {
  compileTakeover: CompileTakeoverFn;
  buildFirstUpdate: BuildFirstUpdateFn;
  validateFirstUpdate: (m: { type: "session.update"; session: Record<string, unknown> }, o: { keytermsEnabled: boolean }) => void;
}
interface RawPatchEvent { field: FieldId; kind: string; value: string | null; quote: string; acknowledges_turn_id: string | null; confidence: "high" | "medium" | "low"; turn_id: string }
interface Wp1Case {
  applyExtraction: (raw: { no_facts: boolean; events: RawPatchEvent[] }, turns: TurnInput[], ctx: { caseId: string; policy: PolicyRecord }) => Omit<FactEvent, "seq">[];
  deriveCaseState: (policy: PolicyRecord, events: (Omit<FactEvent, "seq"> & { seq: number })[], ctx: { caseId: string; tArmMs?: number }) => CaseState;
}

const load = async <T>(p: string): Promise<T> => (await import(/* @vite-ignore */ p.replace(/\\/g, "/"))) as T;
const wp1 = HAS_WP1 ? { compiler: await load<Wp1Compiler>(COMPILER), engine: await load<Wp1Case>(CASE) } : null;

// ------------------------------------------------------------------------------------------------ kit scenarios

interface KitFact { value: string | number | boolean; stated_by: "rep" | "customer"; status_at_handoff: FieldStatus; say_it?: string }
interface KitScenario {
  id: string; call_date: string; rep: { name: string; agency: string };
  customer: { name: string; policy_number: string; carrier: string; address: { street: string; city: string; state: string; zip: string };
    existing_drivers: { name: string; relation: string }[]; vehicles: { id: string; year: number; make: string; model: string }[]; current_premium_monthly_usd: number };
  facts: Partial<Record<FieldId, KitFact>>;
}

const kit = (id: string): KitScenario => JSON.parse(readFileSync(join(HERE, "data", "scenarios", `${id}.json`), "utf8")) as KitScenario;

/** The PolicyRecord WP9's normalizeScenario produces (same mapping as WP1's test fixtures). */
function policyOf(s: KitScenario): PolicyRecord {
  const [first = "", ...rest] = s.customer.name.split(" ");
  return {
    policyNumber: s.customer.policy_number, carrier: s.customer.carrier, agencyName: s.rep.agency, repFirstName: s.rep.name.split(" ")[0]!,
    policyholder: { firstName: first, lastName: rest.join(" ") }, phoneOnFileLast4: s.customer.policy_number.replace(/\D/g, "").slice(-4),
    address: s.customer.address, existingDrivers: s.customer.existing_drivers,
    vehicles: s.customer.vehicles.map((v) => ({ id: v.id, year: v.year, make: v.make, model: v.model, label: `${v.year} ${v.make} ${v.model}` })),
    currentMonthlyPremiumUsd: s.customer.current_premium_monthly_usd, callDate: s.call_date,
  };
}

const WORD_MS = 250;

/** A synthetic call: every fact stated by its party (and acknowledged when VERIFIED at the handoff). */
function synthCall(engine: Wp1Case, s: KitScenario, policy: PolicyRecord, caseId: string) {
  const counters = { rep: 0, customer: 0 };
  let t = 5_000;
  const turns: TurnInput[] = [];
  const events: Omit<FactEvent, "seq">[] = [];
  const say = (channel: "rep" | "customer", text: string, raw: Omit<RawPatchEvent, "turn_id">[]) => {
    const words = text.split(/\s+/).map((w, i) => ({ text: w, startMs: t + i * WORD_MS, endMs: t + (i + 1) * WORD_MS - 20, confidence: 0.95 }));
    const turn: TurnInput = {
      caseId, turnId: turnIdOf(channel, counters[channel]++), channel, text, startMs: t, endMs: words.at(-1)!.endMs, words,
      source: "stt_live", recvMs: words.at(-1)!.endMs + 400, cut: false, late: false,
    };
    t = turn.endMs + 300;
    turns.push(turn);
    events.push(...engine.applyExtraction({ no_facts: raw.length === 0, events: raw.map((r) => ({ ...r, turn_id: turn.turnId })) }, [turn], { caseId, policy }));
    return turn;
  };
  const facts = Object.entries(s.facts) as [FieldId, KitFact][];
  const ordered = [...facts.filter(([, f]) => f.status_at_handoff === "VERIFIED"), ...facts.filter(([, f]) => f.status_at_handoff === "PENDING")];
  for (const [field, fact] of ordered) {
    const sayIt = fact.say_it ?? String(fact.value);
    const stated = say(fact.stated_by, `${sayIt}.`, [{ field, kind: "stated", value: String(fact.value), quote: sayIt, acknowledges_turn_id: null, confidence: "high" }]);
    if (fact.status_at_handoff !== "VERIFIED") continue;
    if (fact.stated_by === "customer") say("rep", `${sayIt}, got it.`, [{ field, kind: "readback", value: String(fact.value), quote: sayIt, acknowledges_turn_id: null, confidence: "high" }]);
    else say("customer", "Yes, that's right.", [{ field, kind: "ack", value: null, quote: "Yes, that's right", acknowledges_turn_id: stated.turnId, confidence: "high" }]);
  }
  return { turns, events };
}

// ------------------------------------------------------------------------------------------------ the route under test

const HANDOFF_POINTS = ["early", "middle", "handoff"] as const;

async function compileViaRoute(o: { policy: PolicyRecord; snapshotAt: (tArm: number) => CaseState; tArmMs: number; keytermsEnabled: boolean; payToolMode: "hold" | "push" }): Promise<CompiledTakeover> {
  const c = wp1!.compiler;
  const store = new FakeStore();
  store.addCase({ id: "case_x", policy: o.policy });
  const svc = new TakeoverServiceImpl({
    store,
    cases: { freezeSnapshot: async (_caseId, _tko, drain) => o.snapshotAt(drain.tArmMs) },
    compileTakeover: c.compileTakeover,
    buildFirstUpdate: c.buildFirstUpdate,
    validateFirstUpdate: c.validateFirstUpdate,
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

describe.skipIf(!HAS_WP1)("acceptance 2: /compile passes validateFirstUpdate for s01, s02, s05 at 3 pass points", () => {
  for (const id of ["s01", "s02", "s05"]) {
    const s = kit(id);
    const policy = policyOf(s);
    const caseId = `case_${id}`;
    const call = wp1 ? synthCall(wp1.engine, s, policy, caseId) : { turns: [], events: [] };
    const n = call.turns.length;
    const points: Record<(typeof HANDOFF_POINTS)[number], number> = {
      early: (call.turns[Math.max(0, Math.floor(n / 4) - 1)]?.endMs ?? 0) + 150,
      middle: (call.turns[Math.floor(n / 2)]?.endMs ?? 0) + 150,
      handoff: (call.turns.at(-1)?.endMs ?? 0) + 150,
    };
    const snapshotAt = (tArm: number): CaseState => {
      const seqd = call.events.filter((e) => e.turnEndMs <= tArm).map((e, i) => ({ ...e, seq: i + 1 }));
      return wp1!.engine.deriveCaseState(policy, seqd, { caseId, tArmMs: tArm });
    };

    for (const point of HANDOFF_POINTS) {
      for (const keytermsEnabled of [false, true]) {
        it(`${id} @ ${point} (keyterms ${keytermsEnabled ? "on" : "off"})`, async () => {
          const tArmMs = points[point];
          const snap = snapshotAt(tArmMs);
          const t0 = performance.now();
          const compiled = await compileViaRoute({ policy, snapshotAt, tArmMs, keytermsEnabled, payToolMode: "push" });
          const routeMs = performance.now() - t0;
          // what the client sends: the first update built from the route's JSON
          const msg = wp1!.compiler.buildFirstUpdate(compiled);
          expect(() => wp1!.compiler.validateFirstUpdate(msg, { keytermsEnabled })).not.toThrow();
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
    const call = synthCall(wp1!.engine, s, policy, "case_s02");
    const tArm = call.turns.at(-1)!.endMs + 150;
    const snapshotAt = (t: number) => wp1!.engine.deriveCaseState(policy, call.events.filter((e) => e.turnEndMs <= t).map((e, i) => ({ ...e, seq: i + 1 })), { caseId: "case_s02", tArmMs: t });
    const compiled = await compileViaRoute({ policy, snapshotAt, tArmMs: tArm, keytermsEnabled: true, payToolMode: "hold" });
    expect(() => wp1!.compiler.validateFirstUpdate(wp1!.compiler.buildFirstUpdate(compiled), { keytermsEnabled: true })).not.toThrow();
  });
});

describe.skipIf(HAS_WP1)("acceptance 2 (pending WP1)", () => {
  it("skips until WP1's compiler is merged (or BATON_WP1_ROOT points at WP1's worktree)", () => {
    expect(HAS_WP1).toBe(false);
  });
});

/**
 * In-memory fakes for the takeover service and route tests (no Postgres, no WP1/WP2/WP3/WP8). Not a test file.
 */
import type { CaseState, CaseStatus } from "../../../../src/core/contracts/case";
import type { CompiledTakeover, DrainReport } from "../../../../src/core/contracts/takeover";
import type { RunPlan } from "../../../../src/core/contracts/run";
import { TakeoverServiceImpl, type TakeoverServiceDeps } from "../../../../src/server/takeovers/service";
import type { CompiledPatch, EndPatch, EventsPatch, TakeoverCase, TakeoverRecord, TakeoverStore } from "../../../../src/server/takeovers/store";
import { caseState, compiled as compiledFixture, policy, runPlan } from "../../contracts/fixtures";

export class FakeStore implements TakeoverStore {
  cases = new Map<string, TakeoverCase>();
  rows = new Map<string, TakeoverRecord>();
  leadTimings: Record<string, number>[] = [];
  failLead = false;

  addCase(o: Partial<TakeoverCase> & { id: string }): TakeoverCase {
    const c: TakeoverCase = { status: "shadowing", visitorId: "vis_1", runPlan: { ...runPlan, caseId: o.id }, policy, callId: "call_s01", scenarioId: "s01", ...o };
    this.cases.set(c.id, c);
    return c;
  }

  async loadCase(caseId: string) {
    const c = this.cases.get(caseId);
    return c ? { ...c } : null;
  }

  async createArmed(i: { id: string; caseId: string; tArmMs: number; midUtterance: boolean; protocol: Record<string, unknown>; fromStatuses: readonly CaseStatus[]; maxPerCase: number; now: Date }) {
    const c = this.cases.get(i.caseId);
    if (!c || !i.fromStatuses.includes(c.status)) return "conflict" as const;
    if ([...this.rows.values()].filter((r) => r.caseId === i.caseId).length >= i.maxPerCase) return "limit" as const;
    this.rows.set(i.id, {
      id: i.id, caseId: i.caseId, armedAt: i.now, tArmMs: i.tArmMs, midUtterance: i.midUtterance, phase: "armed", protocol: { ...i.protocol },
      hasSnapshot: false, greeting: null, stage: null, vaSessionId: null, retries: 0, lastFailureAt: null, vaSessionCapMs: null, outcome: null,
      metrics: {}, endedAt: null,
    });
    c.status = "armed";
    return "ok" as const;
  }

  async load(id: string) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }

  async saveCompiled(id: string, p: CompiledPatch) {
    const r = this.rows.get(id)!;
    Object.assign(r, { greeting: p.greeting, stage: p.stage, vaSessionCapMs: p.vaSessionCapMs, phase: p.phase, protocol: { ...r.protocol, ...p.protocol }, promptVersion: p.promptVersion });
    (r as unknown as Record<string, unknown>).systemPromptHash = p.systemPromptHash;
  }

  async recordEvents(id: string, p: EventsPatch) {
    const r = this.rows.get(id)!;
    if (p.phase) r.phase = p.phase;
    if (p.vaSessionId) r.vaSessionId = p.vaSessionId;
    if (p.failureAt) r.lastFailureAt = p.failureAt;
    if (p.timings) r.protocol = { ...r.protocol, timings: { ...((r.protocol.timings as object) ?? {}), ...p.timings } };
    if (p.hud) r.metrics = { ...r.metrics, hud: { ...((r.metrics.hud as object) ?? {}), ...p.hud } };
    if (p.provisionalQa !== undefined) r.metrics = { ...r.metrics, provisionalQa: p.provisionalQa };
  }

  async end(id: string, p: EndPatch) {
    const r = this.rows.get(id);
    if (!r) return { first: false, record: null };
    if (r.endedAt) return { first: false, record: structuredClone(r) };
    Object.assign(r, { outcome: p.outcome, endedAt: p.endedAt, phase: p.phase, ...(p.vaSessionId ? { vaSessionId: p.vaSessionId } : {}) });
    const c = this.cases.get(r.caseId)!;
    if (c.status === "armed" || c.status === "ai_active") c.status = p.outcome;
    return { first: true, record: structuredClone(r) };
  }

  async setVerificationJob(id: string, jobId: string) {
    const r = this.rows.get(id)!;
    r.metrics = { ...r.metrics, verificationJobId: jobId };
  }

  async recentLeadTimings(limit: number) {
    if (this.failLead) throw new Error("db down");
    return this.leadTimings.slice(0, limit);
  }
}

export interface Harness {
  store: FakeStore;
  svc: TakeoverServiceImpl;
  calls: {
    freeze: { caseId: string; takeoverId: string; drain: DrainReport }[];
    compile: { snapshot: CaseState; opts: unknown }[];
    validate: unknown[];
    tokens: { caseId: string; visitorId: string; takeoverId: string }[];
    heartbeat: string[];
    release: { id: string; reason: string }[];
    verify: { takeoverId: string; vaSessionId: string | null }[];
  };
  clock: { t: number };
  deps: TakeoverServiceDeps;
}

export function harness(o: { verificationJobId?: string | null; validate?: (m: unknown) => void; compile?: (s: CaseState) => CompiledTakeover } = {}): Harness {
  const store = new FakeStore();
  const clock = { t: Date.parse("2026-09-25T10:00:00Z") };
  const calls: Harness["calls"] = { freeze: [], compile: [], validate: [], tokens: [], heartbeat: [], release: [], verify: [] };
  let n = 0;
  const deps: TakeoverServiceDeps = {
    store,
    cases: {
      async freezeSnapshot(caseId, takeoverId, drain) {
        calls.freeze.push({ caseId, takeoverId, drain });
        const c = store.cases.get(caseId)!;
        c.status = "ai_active";
        return { ...caseState(caseId), callClockMs: drain.tArmMs };
      },
    },
    compileTakeover: (snapshot, _policy, opts) => {
      calls.compile.push({ snapshot, opts });
      return o.compile ? o.compile(snapshot) : { ...compiledFixture(), snapshot };
    },
    buildFirstUpdate: (c) => ({ type: "session.update", session: { system_prompt: c.systemPrompt, greeting: c.greeting } }),
    validateFirstUpdate: (m) => {
      calls.validate.push(m);
      o.validate?.(m);
    },
    issueTakeoverToken: async (i) => {
      calls.tokens.push(i);
      return `jwt.${i.takeoverId}`;
    },
    limits: {
      heartbeat: async (id) => void calls.heartbeat.push(id),
      release: async (id, reason) => void calls.release.push({ id, reason }),
    },
    liveSessionIdFor: (id, attempt) => `va_${id}_${attempt}`,
    enqueueVerification: async (takeoverId, vaSessionId) => {
      calls.verify.push({ takeoverId, vaSessionId });
      return o.verificationJobId === undefined ? "job_1" : o.verificationJobId;
    },
    config: { deployId: "dev-wp5", voice: "alba", keytermsEnabled: true, payToolMode: "push", capEnv: { baseMs: 150_000, perFieldMs: 15_000, maxMs: 420_000 } },
    newId: () => `tko_${++n}`,
    now: () => clock.t,
  };
  return { store, svc: new TakeoverServiceImpl(deps), calls, clock, deps };
}

export const armReq = (o: Partial<{ caseId: string; runId: string; tArmMs: number; midUtterance: boolean; source: "manual" | "auto_handoff"; visitorId: string }> = {}) => ({
  caseId: "case_1",
  runId: runPlan.runId,
  tArmMs: 61_234.5,
  midUtterance: true,
  source: "manual" as const,
  visitorId: "vis_1",
  ...o,
});

export function drainFor(tArmMs: number, o: Partial<DrainReport> = {}): DrainReport {
  return { tArmMs, tCutMs: tArmMs + 300, capHit: false, midUtterance: true, completedTurnIds: ["rep-3"], pendingTurnIds: [], cutTurnIds: [], waitedMs: 120, timings: { armed: 0, sealed: 300, finals: 650, drained: 770 }, ...o };
}

export const recordedPlan = (caseId: string): RunPlan => ({ ...runPlan, caseId, aiHalf: "recorded", vaHoldId: null });

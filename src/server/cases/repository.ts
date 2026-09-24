import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";

import type {
  CaseMode, CaseState, CaseStatus, Channel, Evidence, FactEvent, NewFactEvent, PolicyRecord,
} from "../../core/contracts/case";
import type { VerifierResult } from "../../core/contracts/extract";
import type { RunPlan } from "../../core/contracts/run";
import type { CaseRepository } from "../../core/contracts/services";
import type { DrainReport } from "../../core/contracts/takeover";
import type { TurnInput, TurnSource, WordTiming } from "../../core/contracts/turns";
import { BatonError } from "../../core/contracts/errors";
import { newId } from "../../lib/ids";
import type { Db } from "../db/client";
import { cases, factEvents, takeovers, turns, verifierRuns } from "../db/schema";
import type { CaseEngine, EngineDeriveCtx } from "./engine";
import type { PrefillPlan } from "./prefill";

/**
 * `CaseRepository` on Postgres (TASKS §2; DESIGN §4.2, §4.5 F1/F2, §5.5.4 rule 2).
 *
 * Every write that changes `cases.state` runs in ONE short transaction under `pg_advisory_xact_lock(hashtext(caseId))`
 * and re-derives the whole state from the append-only `fact_events` (pure `deriveCaseState`), so concurrent writers
 * (F1 extractions, F2 verifier, WP6 tool updates, WP5 freeze) serialize per case, `seq` is gap-tolerant but never
 * duplicated (unique index), and a late-finishing extraction of an earlier turn lands in `(turnEndMs, seq)` order.
 * No method holds a connection across a network call.
 */

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

export interface CaseRow {
  id: string;
  mode: CaseMode;
  callId: string | null;
  scenarioId: string;
  policy: PolicyRecord;
  state: CaseState;
  version: number;
  status: CaseStatus;
  visitorId: string;
  ipKey: string;
  tArmMs: number | null;
  runPlan: RunPlan | null;
}

export type ExtractStatus = "pending" | "done" | "failed" | "skipped";

export interface TurnRow extends TurnInput {
  extractStatus: ExtractStatus;
  extractMs: number | null;
}

/** Takeover freeze bookkeeping, kept under `takeovers.protocol.freeze` (jsonb merge; never overwrites other keys). */
export interface FreezeInfo {
  takeoverId: string;
  frozenAt: string;
  pendingTurnIds: string[];
  cutTurnIds: string[];
  tArmMs: number;
}

export interface CommitResult {
  state: CaseState;
  version: number;
  /** The events inserted by this commit, with their `seq`. */
  inserted: FactEvent[];
}

export interface TurnUpdate {
  turnId: string;
  status: ExtractStatus;
  extractMs: number | null;
}

const HUMAN_KINDS = ["stated", "readback", "ack", "corrected", "denied"];
const TERMINAL_OR_AI: ReadonlySet<CaseStatus> = new Set(["ai_active", "completed", "handed_back", "abandoned", "failed"]);
/** F1 "after takeover": a case whose snapshot is frozen (WP5 compile → freezeSnapshot flips it to ai_active). */
export const isFrozenStatus = (s: CaseStatus): boolean => TERMINAL_OR_AI.has(s);

const turnRowId = (caseId: string, turnId: string): string => `${caseId}:${turnId}`;

function caseOf(r: typeof cases.$inferSelect): CaseRow {
  return {
    id: r.id, mode: r.mode, callId: r.callId, scenarioId: r.scenarioId, policy: r.policy as unknown as PolicyRecord,
    state: r.state as unknown as CaseState, version: r.version, status: r.status, visitorId: r.visitorId, ipKey: r.ipKey,
    tArmMs: r.tArmMs, runPlan: (r.runPlan as unknown as RunPlan | null) ?? null,
  };
}

export function turnOf(r: typeof turns.$inferSelect): TurnRow {
  return {
    caseId: r.caseId, turnId: r.id.slice(r.caseId.length + 1), channel: r.channel as Channel, text: r.text,
    startMs: r.startMs, endMs: r.endMs, words: r.words as WordTiming[], source: r.source as TurnSource, recvMs: r.recvMs,
    cut: r.cut, late: r.late, extractStatus: r.extractStatus, extractMs: r.extractMs,
  };
}

export const plainTurn = (t: TurnRow): TurnInput => {
  const { extractStatus: _s, extractMs: _m, ...rest } = t;
  void _s;
  void _m;
  return rest;
};

export function factOf(r: typeof factEvents.$inferSelect): FactEvent {
  return {
    id: r.id, caseId: r.caseId, field: r.field as FactEvent["field"], kind: r.kind as FactEvent["kind"], party: r.party as FactEvent["party"],
    valueRaw: r.valueRaw, valueNorm: r.valueNorm, acknowledgesTurnId: r.acknowledgesTurnId, confidence: r.confidence, turnId: r.turnId,
    turnEndMs: r.turnEndMs, late: r.late, cut: r.cut, evidence: (r.evidence as unknown as Evidence | null) ?? null,
    extractor: r.extractor as FactEvent["extractor"], seq: r.seq,
  };
}

const factRow = (e: NewFactEvent, seq: number): typeof factEvents.$inferInsert => ({
  id: e.id, caseId: e.caseId, turnId: e.turnId, turnEndMs: e.turnEndMs, seq, field: e.field, kind: e.kind, party: e.party,
  valueRaw: e.valueRaw, valueNorm: e.valueNorm, acknowledgesTurnId: e.acknowledgesTurnId, confidence: e.confidence, late: e.late,
  cut: e.cut, evidence: (e.evidence as unknown as Record<string, unknown> | null) ?? null, extractor: e.extractor,
});

const turnRow = (t: TurnInput, status: ExtractStatus, extractMs: number | null = null): typeof turns.$inferInsert => ({
  id: turnRowId(t.caseId, t.turnId), caseId: t.caseId, channel: t.channel, source: t.source, text: t.text, startMs: t.startMs,
  endMs: t.endMs, recvMs: t.recvMs, words: t.words, cut: t.cut, late: t.late, extractStatus: status, extractMs,
});

export interface PgCaseRepositoryDeps {
  db: Db;
  engine: CaseEngine;
  /** Resolves a scenario's policy for `create` (data source). */
  policyOf: (scenarioId: string) => Promise<PolicyRecord | null>;
  /** Express prefill source (§5.1.6); `create` applies it when `prefillUntilMs` is given. */
  prefillPlan?: (i: { caseId: string; callId: string; untilMs: number }) => Promise<PrefillPlan | null>;
  newCaseId?: () => string;
  /** Wall clock (ms) for `frozenAt` (the F1 late-pending window). */
  now?: () => number;
}

export class PgCaseRepository implements CaseRepository {
  constructor(private readonly d: PgCaseRepositoryDeps) {}

  get db(): Db {
    return this.d.db;
  }

  // ------------------------------------------------------------------------------------------ CaseRepository

  async create(input: {
    mode: CaseMode; callId: string | null; scenarioId: string; visitorId: string; ipKey: string; prefillUntilMs?: number;
  }): Promise<{ caseId: string; state: CaseState; policy: PolicyRecord }> {
    const policy = await this.d.policyOf(input.scenarioId);
    if (!policy) throw new BatonError("E_NOT_FOUND", `Unknown scenario ${input.scenarioId}.`);
    const caseId = this.d.newCaseId?.() ?? newId();
    const state = this.d.engine.deriveCaseState(policy, [], { caseId, version: 0 });
    await this.d.db.insert(cases).values({
      id: caseId, mode: input.mode, callId: input.callId, scenarioId: input.scenarioId, policy: policy as unknown as Record<string, unknown>,
      state: state as unknown as Record<string, unknown>, version: 0, status: "shadowing", visitorId: input.visitorId, ipKey: input.ipKey,
    });
    if (input.prefillUntilMs !== undefined && input.prefillUntilMs > 0 && input.callId && this.d.prefillPlan) {
      const plan = await this.d.prefillPlan({ caseId, callId: input.callId, untilMs: input.prefillUntilMs });
      if (plan && plan.turns.length) {
        const r = await this.prefill(caseId, plan.turns, plan.events);
        return { caseId, state: r.state, policy };
      }
    }
    return { caseId, state, policy };
  }

  async load(caseId: string): Promise<{
    state: CaseState; version: number; policy: PolicyRecord; status: CaseStatus; tArmMs: number | null; scenarioId: string;
    callId: string | null; runPlan: RunPlan | null;
  } | null> {
    const r = await this.loadRow(caseId);
    if (!r) return null;
    return { state: r.state, version: r.version, policy: r.policy, status: r.status, tArmMs: r.tArmMs, scenarioId: r.scenarioId, callId: r.callId, runPlan: r.runPlan };
  }

  async insertTurn(t: TurnInput): Promise<"inserted" | "duplicate"> {
    return this.insertTurnWithStatus(t, "pending");
  }

  async applyEvents(caseId: string, expectedVersion: number, events: Omit<FactEvent, "seq">[]): Promise<{ state: CaseState; version: number }> {
    const r = await this.commit(caseId, expectedVersion, events, []);
    return { state: r.state, version: r.version };
  }

  async recompute(caseId: string, ctx: { tArmMs?: number } = {}): Promise<CaseState> {
    return this.d.db.transaction(async (tx) => {
      const row = await this.lockCase(tx, caseId);
      const next = await this.deriveAndSave(tx, row, ctx.tArmMs !== undefined ? { tArmMs: ctx.tArmMs } : {});
      return next;
    });
  }

  /**
   * WP5 compile (DESIGN §5.5.4 rule 2): set `cases.t_arm_ms`, mark late (endMs > tArm) and cut turns and their
   * events, re-derive, freeze `takeovers.snapshot` (immutable: a second call returns the stored snapshot), flip the
   * case to `ai_active`, and keep the drain's pending ids for the 3 s late-pending window of F1.
   */
  async freezeSnapshot(caseId: string, takeoverId: string, drain: DrainReport): Promise<CaseState> {
    return this.d.db.transaction(async (tx) => {
      const row = await this.lockCase(tx, caseId);
      const [tko] = await tx.select({ id: takeovers.id, caseId: takeovers.caseId, snapshot: takeovers.snapshot })
        .from(takeovers).where(eq(takeovers.id, takeoverId)).for("update");
      if (!tko || tko.caseId !== caseId) throw new BatonError("E_NOT_FOUND", "Unknown takeover for this case.");
      if (tko.snapshot) return tko.snapshot as unknown as CaseState;
      const tArm = drain.tArmMs;
      const cut = drain.cutTurnIds.filter((id) => id.length > 0);
      await tx.update(turns).set({ late: sql`${turns.late} or ${turns.endMs} > ${tArm}` }).where(eq(turns.caseId, caseId));
      await tx.update(factEvents).set({ late: true })
        .where(and(eq(factEvents.caseId, caseId), inArray(factEvents.kind, HUMAN_KINDS), sql`${factEvents.turnEndMs} > ${tArm}`));
      if (cut.length) {
        await tx.update(turns).set({ cut: true }).where(inArray(turns.id, cut.map((id) => turnRowId(caseId, id))));
        await tx.update(factEvents).set({ cut: true }).where(and(eq(factEvents.caseId, caseId), inArray(factEvents.turnId, cut)));
      }
      const frozen = await this.deriveAndSave(tx, { ...row, tArmMs: tArm }, { tArmMs: tArm, status: "ai_active" });
      const freeze: FreezeInfo = {
        takeoverId, frozenAt: new Date((this.d.now ?? Date.now)()).toISOString(), pendingTurnIds: drain.pendingTurnIds, cutTurnIds: cut, tArmMs: tArm,
      };
      await tx.update(takeovers).set({
        snapshot: frozen as unknown as Record<string, unknown>,
        protocol: sql`coalesce(${takeovers.protocol}, '{}'::jsonb) || ${JSON.stringify({ freeze })}::jsonb`,
      }).where(eq(takeovers.id, takeoverId));
      return frozen;
    });
  }

  async setRunPlan(caseId: string, plan: RunPlan): Promise<void> {
    await this.d.db.update(cases).set({ runPlan: plan as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(cases.id, caseId));
  }

  /**
   * The non-derivable parts of `CaseState` (stage, disclosures, payment, confirmation number; WP6 tools), written
   * under the same case lock and re-derived, so a concurrent extraction can never overwrite them (or be overwritten).
   * Never write `cases.state` directly.
   */
  async setCaseExtras(
    caseId: string,
    patch: Partial<Pick<CaseState, "stage" | "disclosuresGiven" | "payment" | "confirmationNumber">>,
  ): Promise<CaseState> {
    return this.d.db.transaction(async (tx) => {
      const row = await this.lockCase(tx, caseId);
      return this.deriveAndSave(tx, { ...row, state: { ...row.state, ...patch } }, {});
    });
  }

  // ------------------------------------------------------------------------------------------ WP3 extensions

  async loadRow(caseId: string, exec: Exec = this.d.db): Promise<CaseRow | null> {
    const [r] = await exec.select().from(cases).where(eq(cases.id, caseId));
    return r ? caseOf(r) : null;
  }

  async insertTurnWithStatus(t: TurnInput, status: ExtractStatus, extractMs: number | null = null): Promise<"inserted" | "duplicate"> {
    const r = await this.d.db.insert(turns).values(turnRow(t, status, extractMs)).onConflictDoNothing({ target: turns.id }).returning({ id: turns.id });
    return r.length ? "inserted" : "duplicate";
  }

  async getTurn(caseId: string, turnId: string): Promise<TurnRow | null> {
    const [r] = await this.d.db.select().from(turns).where(eq(turns.id, turnRowId(caseId, turnId)));
    return r ? turnOf(r) : null;
  }

  async listTurns(caseId: string): Promise<TurnRow[]> {
    const rows = await this.d.db.select().from(turns).where(eq(turns.caseId, caseId)).orderBy(asc(turns.endMs), asc(turns.recvMs));
    return rows.map(turnOf);
  }

  /** The last `limit` finals that ended before `beforeEndMs` (§5.3 RECENT), oldest first. */
  async recentTurns(caseId: string, beforeEndMs: number, limit: number, excludeTurnIds: readonly string[] = []): Promise<TurnInput[]> {
    const ex = excludeTurnIds.map((id) => turnRowId(caseId, id));
    const rows = await this.d.db.select().from(turns)
      .where(and(eq(turns.caseId, caseId), lt(turns.endMs, beforeEndMs), ex.length ? notInArray(turns.id, ex) : undefined))
      .orderBy(desc(turns.endMs)).limit(limit);
    return rows.map((r) => plainTurn(turnOf(r))).reverse();
  }

  async listFacts(caseId: string): Promise<FactEvent[]> {
    const rows = await this.d.db.select().from(factEvents).where(eq(factEvents.caseId, caseId)).orderBy(asc(factEvents.turnEndMs), asc(factEvents.seq));
    return rows.map(factOf);
  }

  async factsOfTurn(caseId: string, turnId: string): Promise<FactEvent[]> {
    const rows = await this.d.db.select().from(factEvents)
      .where(and(eq(factEvents.caseId, caseId), eq(factEvents.turnId, turnId))).orderBy(asc(factEvents.seq));
    return rows.map(factOf);
  }

  async setTurnStatus(caseId: string, updates: readonly TurnUpdate[]): Promise<void> {
    for (const u of updates) {
      await this.d.db.update(turns).set({ extractStatus: u.status, extractMs: u.extractMs }).where(eq(turns.id, turnRowId(caseId, u.turnId)));
    }
  }

  /**
   * F1 step 4 / F2 step 3-4: ONE short transaction under the case advisory lock: insert `events` with the next
   * `seq`s (an id that already exists is skipped, so a replayed patch is harmless), update the turns' extract status,
   * re-derive from ALL events (so newer events that landed since `expectedVersion` are included) and save
   * `version + 1`.
   */
  async commit(caseId: string, expectedVersion: number, events: readonly NewFactEvent[], turnUpdates: readonly TurnUpdate[]): Promise<CommitResult> {
    void expectedVersion; // informational: the state is always re-derived from every event under the lock
    return this.d.db.transaction(async (tx) => {
      const row = await this.lockCase(tx, caseId);
      const inserted: FactEvent[] = [];
      if (events.length) {
        const [m] = await tx.select({ max: sql<number | null>`max(${factEvents.seq})` }).from(factEvents).where(eq(factEvents.caseId, caseId));
        let seq = Number(m?.max ?? 0);
        for (const e of events) {
          if (e.caseId !== caseId) throw new BatonError("E_INTERNAL", "event for another case");
          const r = await tx.insert(factEvents).values(factRow(e, seq + 1)).onConflictDoNothing({ target: factEvents.id }).returning();
          if (r[0]) {
            seq += 1;
            inserted.push(factOf(r[0]));
          }
        }
      }
      for (const u of turnUpdates) {
        await tx.update(turns).set({ extractStatus: u.status, extractMs: u.extractMs }).where(eq(turns.id, turnRowId(caseId, u.turnId)));
      }
      const state = await this.deriveAndSave(tx, row, {});
      return { state, version: state.version, inserted };
    });
  }

  /** Express prefill (§5.1.6): cached turns + cached events in one transaction, one derive, 0 LLM calls. */
  async prefill(caseId: string, cachedTurns: readonly { turn: TurnInput; status: ExtractStatus; extractMs: number | null }[], events: readonly NewFactEvent[]): Promise<CommitResult> {
    return this.d.db.transaction(async (tx) => {
      const row = await this.lockCase(tx, caseId);
      if (cachedTurns.length) await tx.insert(turns).values(cachedTurns.map((c) => turnRow(c.turn, c.status, c.extractMs))).onConflictDoNothing({ target: turns.id });
      const inserted: FactEvent[] = [];
      if (events.length) {
        const [m] = await tx.select({ max: sql<number | null>`max(${factEvents.seq})` }).from(factEvents).where(eq(factEvents.caseId, caseId));
        const base = Number(m?.max ?? 0);
        const rows = await tx.insert(factEvents).values(events.map((e, i) => factRow(e, base + i + 1))).onConflictDoNothing({ target: factEvents.id }).returning();
        inserted.push(...rows.map(factOf));
      }
      const state = await this.deriveAndSave(tx, row, {});
      return { state, version: state.version, inserted };
    });
  }

  /** The freeze of the case's takeover (F1 after_takeover), or null. */
  async freezeInfo(caseId: string): Promise<FreezeInfo | null> {
    const rows = await this.d.db.select({ protocol: takeovers.protocol }).from(takeovers)
      .where(and(eq(takeovers.caseId, caseId), isNotNull(takeovers.snapshot))).orderBy(desc(takeovers.armedAt)).limit(1);
    const f = (rows[0]?.protocol as { freeze?: FreezeInfo } | undefined)?.freeze;
    return f && typeof f.frozenAt === "string" ? f : null;
  }

  // ------------------------------------------------------------------------------------------ verifier runs (F2)

  async verifierStats(caseId: string): Promise<{ runs: number; lastCreatedAt: Date | null; lastUptoRecvMs: number | null; lastMs: number | null }> {
    const [r] = await this.d.db.select({
      runs: sql<number>`count(*)::int`,
      last: sql<Date | null>`max(${verifierRuns.createdAt})`,
    }).from(verifierRuns).where(eq(verifierRuns.caseId, caseId));
    const [latest] = await this.d.db.select({ upto: verifierRuns.uptoTurnRecvMs, ms: verifierRuns.ms }).from(verifierRuns)
      .where(eq(verifierRuns.caseId, caseId)).orderBy(desc(verifierRuns.createdAt)).limit(1);
    const last = r?.last ? new Date(r.last) : null;
    return { runs: Number(r?.runs ?? 0), lastCreatedAt: last, lastUptoRecvMs: latest?.upto ?? null, lastMs: latest?.ms ?? null };
  }

  /** Newest final's recvMs (≥1 new final since the last run, F2). */
  async maxRecvMs(caseId: string): Promise<number | null> {
    const [r] = await this.d.db.select({ m: sql<number | null>`max(${turns.recvMs})` }).from(turns).where(eq(turns.caseId, caseId));
    return r?.m === null || r?.m === undefined ? null : Number(r.m);
  }

  /**
   * F2 steps 2-4 in one transaction: store the run (`result.applied` = whether it touched the state), and, only if the
   * case is still `shadowing`, insert the disagreement events and re-derive with this result as the verifier overlay.
   * `disagreements` is computed by the caller against the state it read; re-checked here under the lock.
   */
  async commitVerifierRun(
    caseId: string,
    run: { result: VerifierResult; ms: number; usd: number },
    disagreementsOf: (state: CaseState, turnsSeen: readonly TurnInput[]) => NewFactEvent[],
    turnsSeen: readonly TurnInput[],
  ): Promise<{ applied: boolean; state: CaseState; inserted: FactEvent[] }> {
    return this.d.db.transaction(async (tx) => {
      const row = await this.lockCase(tx, caseId);
      const applied = row.status === "shadowing";
      const events = applied ? disagreementsOf(row.state, turnsSeen) : [];
      await tx.insert(verifierRuns).values({
        id: newId(), caseId, uptoTurnRecvMs: run.result.uptoRecvMs, result: { ...run.result, applied } as unknown as Record<string, unknown>,
        disagreements: events.map((e) => ({ field: e.field, value: e.valueNorm, confidence: e.confidence })), ms: run.ms, usd: run.usd,
      });
      if (!applied) return { applied, state: row.state, inserted: [] };
      const inserted: FactEvent[] = [];
      if (events.length) {
        const [m] = await tx.select({ max: sql<number | null>`max(${factEvents.seq})` }).from(factEvents).where(eq(factEvents.caseId, caseId));
        let seq = Number(m?.max ?? 0);
        for (const e of events) {
          const r = await tx.insert(factEvents).values(factRow(e, seq + 1)).onConflictDoNothing({ target: factEvents.id }).returning();
          if (r[0]) {
            seq += 1;
            inserted.push(factOf(r[0]));
          }
        }
      }
      const state = await this.deriveAndSave(tx, row, {});
      return { applied, state, inserted };
    });
  }

  // ------------------------------------------------------------------------------------------ internals

  private async lockCase(tx: Tx, caseId: string): Promise<CaseRow> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${caseId}))`);
    const row = await this.loadRow(caseId, tx);
    if (!row) throw new BatonError("E_NOT_FOUND", "Unknown case.");
    return row;
  }

  /** The latest verifier result applied while shadowing (DeriveCtx.verifier; late runs are stored with applied:false). */
  private async appliedVerifier(tx: Tx, caseId: string): Promise<VerifierResult | null> {
    const [r] = await tx.select({ result: verifierRuns.result }).from(verifierRuns)
      .where(and(eq(verifierRuns.caseId, caseId), sql`coalesce(${verifierRuns.result}->>'applied', 'true') <> 'false'`))
      .orderBy(desc(verifierRuns.createdAt)).limit(1);
    if (!r) return null;
    const { applied: _a, ...result } = r.result as unknown as VerifierResult & { applied?: boolean };
    void _a;
    return result;
  }

  private async deriveAndSave(tx: Tx, row: CaseRow, o: { tArmMs?: number; status?: CaseStatus }): Promise<CaseState> {
    const evRows = await tx.select().from(factEvents).where(eq(factEvents.caseId, row.id)).orderBy(asc(factEvents.turnEndMs), asc(factEvents.seq));
    const events = evRows.map(factOf);
    const tArmMs = o.tArmMs ?? row.tArmMs;
    const version = row.version + 1;
    const ctx: EngineDeriveCtx = {
      caseId: row.id,
      version,
      tArmMs,
      verifier: await this.appliedVerifier(tx, row.id),
      stage: row.state.stage ?? null,
      disclosuresGiven: row.state.disclosuresGiven ?? [],
      payment: row.state.payment ?? null,
      confirmationNumber: row.state.confirmationNumber ?? null,
    };
    const state = this.d.engine.deriveCaseState(row.policy, events, ctx);
    await tx.update(cases).set({
      state: state as unknown as Record<string, unknown>,
      version,
      updatedAt: new Date(),
      ...(o.tArmMs !== undefined ? { tArmMs: o.tArmMs } : {}),
      ...(o.status ? { status: o.status } : {}),
    }).where(eq(cases.id, row.id));
    return state;
  }
}

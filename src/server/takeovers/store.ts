import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { CaseStatus, PolicyRecord } from "../../core/contracts/case";
import type { RunPlan } from "../../core/contracts/run";
import type { TakeoverOutcome } from "../../core/contracts/takeover";
import type { TakeoverPhase } from "../../core/contracts/events";
import type { Db } from "../db/client";
import { cases, takeovers } from "../db/schema";

/**
 * Row access for the takeover routes (DESIGN §4.2 `takeovers`, the case status flips of §4.4 #9/#13).
 *
 * Ownership: WP5 owns the `takeovers` row lifecycle (arm, compile bookkeeping, events, end). The snapshot freeze
 * (`takeovers.snapshot`, `protocol.freeze`, `cases.t_arm_ms`, the `ai_active` flip) is WP3's
 * `CaseRepository.freezeSnapshot`. Every jsonb write here MERGES (`||`), never overwrites, because WP3 (protocol.freeze),
 * WP6 (metrics.disclosures) and WP8 read and write keys in the same columns.
 */

export interface TakeoverCase {
  id: string;
  status: CaseStatus;
  visitorId: string;
  runPlan: RunPlan | null;
  policy: PolicyRecord;
  callId: string | null;
  scenarioId: string;
}

export interface TakeoverRecord {
  id: string;
  caseId: string;
  armedAt: Date;
  tArmMs: number;
  midUtterance: boolean;
  phase: string;
  protocol: Record<string, unknown>;
  hasSnapshot: boolean;
  greeting: string | null;
  stage: string | null;
  vaSessionId: string | null;
  retries: number;
  lastFailureAt: Date | null;
  vaSessionCapMs: number | null;
  outcome: TakeoverOutcome | null;
  metrics: Record<string, unknown>;
  endedAt: Date | null;
}

export interface CompiledPatch {
  greeting: string;
  systemPromptHash: string;
  promptVersion: string;
  stage: string;
  vaSessionCapMs: number;
  phase: TakeoverPhase;
  /** Merged into `protocol` (top-level keys). */
  protocol: Record<string, unknown>;
}

export interface EventsPatch {
  phase?: TakeoverPhase;
  /** Merged into `protocol.timings`. */
  timings?: Record<string, number>;
  vaSessionId?: string;
  /** Merged into `metrics.hud`. */
  hud?: Record<string, number>;
  provisionalQa?: unknown;
  failureAt?: Date;
  /** Merged into `protocol.failures` as `{[iso]: code}`. */
  failureCode?: string;
}

export interface EndPatch {
  outcome: TakeoverOutcome;
  vaSessionId: string | null;
  reason: string | null;
  endedAt: Date;
  phase: TakeoverPhase;
}

export interface TakeoverStore {
  loadCase(caseId: string): Promise<TakeoverCase | null>;
  /**
   * Insert the armed takeover and flip the case to `armed` in one transaction, only if the case is still in one of
   * `fromStatuses` (a concurrent second arm loses). "conflict" = the case status moved.
   */
  createArmed(i: { id: string; caseId: string; tArmMs: number; midUtterance: boolean; protocol: Record<string, unknown>; fromStatuses: readonly CaseStatus[]; maxPerCase: number; now: Date }): Promise<"ok" | "conflict" | "limit">;
  load(takeoverId: string): Promise<TakeoverRecord | null>;
  saveCompiled(takeoverId: string, patch: CompiledPatch): Promise<void>;
  recordEvents(takeoverId: string, patch: EventsPatch): Promise<void>;
  /** Idempotent: `first` is false when the takeover had already ended (nothing is written then). */
  end(takeoverId: string, patch: EndPatch): Promise<{ first: boolean; record: TakeoverRecord | null }>;
  /** Merged into `metrics.verificationJobId`. */
  setVerificationJob(takeoverId: string, jobId: string): Promise<void>;
  /** `protocol.timings` of the most recent takeovers that reached a first audible greeting (§5.5.4 rule 5). */
  recentLeadTimings(limit: number): Promise<Record<string, number>[]>;
}

/** Case statuses a pass may start from: shadowing, or after a hand-back ("Pass the baton again", §1.3 P1 step 9). */
export const ARMABLE_CASE_STATUSES: readonly CaseStatus[] = ["shadowing", "handed_back"];
/** Case statuses an ending takeover may overwrite with its outcome. */
const ENDABLE_CASE_STATUSES: readonly CaseStatus[] = ["armed", "ai_active"];

const json = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;

function recordOf(r: typeof takeovers.$inferSelect): TakeoverRecord {
  return {
    id: r.id,
    caseId: r.caseId,
    armedAt: r.armedAt,
    tArmMs: r.tArmMs,
    midUtterance: r.midUtterance,
    phase: r.phase,
    protocol: (r.protocol ?? {}) as Record<string, unknown>,
    hasSnapshot: r.snapshot !== null && r.snapshot !== undefined,
    greeting: r.greeting,
    stage: r.stage,
    vaSessionId: r.vaSessionId,
    retries: r.retries,
    lastFailureAt: r.lastFailureAt,
    vaSessionCapMs: r.vaSessionCapMs,
    outcome: r.outcome,
    metrics: (r.metrics ?? {}) as Record<string, unknown>,
    endedAt: r.endedAt,
  };
}

export class DrizzleTakeoverStore implements TakeoverStore {
  constructor(private readonly db: () => Db) {}

  async loadCase(caseId: string): Promise<TakeoverCase | null> {
    const [r] = await this.db()
      .select({
        id: cases.id,
        status: cases.status,
        visitorId: cases.visitorId,
        runPlan: cases.runPlan,
        policy: cases.policy,
        callId: cases.callId,
        scenarioId: cases.scenarioId,
      })
      .from(cases)
      .where(eq(cases.id, caseId));
    if (!r) return null;
    return { ...r, runPlan: (r.runPlan as unknown as RunPlan | null) ?? null, policy: r.policy as unknown as PolicyRecord };
  }

  async createArmed(i: { id: string; caseId: string; tArmMs: number; midUtterance: boolean; protocol: Record<string, unknown>; fromStatuses: readonly CaseStatus[]; maxPerCase: number; now: Date }): Promise<"ok" | "conflict" | "limit"> {
    return this.db().transaction(async (tx) => {
      // Lock the case row: concurrent arms of one case serialize here.
      const [c] = await tx.select({ status: cases.status }).from(cases).where(eq(cases.id, i.caseId)).for("update");
      if (!c || !i.fromStatuses.includes(c.status)) return "conflict";
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(takeovers).where(eq(takeovers.caseId, i.caseId));
      if ((n?.n ?? 0) >= i.maxPerCase) return "limit";
      await tx.insert(takeovers).values({
        id: i.id,
        caseId: i.caseId,
        armedAt: i.now,
        tArmMs: i.tArmMs,
        midUtterance: i.midUtterance,
        phase: "armed",
        protocol: i.protocol,
      });
      await tx.update(cases).set({ status: "armed", updatedAt: i.now }).where(eq(cases.id, i.caseId));
      return "ok";
    });
  }

  async load(takeoverId: string): Promise<TakeoverRecord | null> {
    const [r] = await this.db().select().from(takeovers).where(eq(takeovers.id, takeoverId));
    return r ? recordOf(r) : null;
  }

  async saveCompiled(takeoverId: string, p: CompiledPatch): Promise<void> {
    await this.db()
      .update(takeovers)
      .set({
        greeting: p.greeting,
        systemPromptHash: p.systemPromptHash,
        promptVersion: p.promptVersion,
        stage: p.stage,
        vaSessionCapMs: Math.round(p.vaSessionCapMs),
        phase: p.phase,
        protocol: sql`coalesce(${takeovers.protocol}, '{}'::jsonb) || ${json(p.protocol)}`,
      })
      .where(eq(takeovers.id, takeoverId));
  }

  async recordEvents(takeoverId: string, p: EventsPatch): Promise<void> {
    const set: Record<string, unknown> = {};
    if (p.phase) set.phase = p.phase;
    if (p.vaSessionId) set.vaSessionId = p.vaSessionId;
    if (p.failureAt) set.lastFailureAt = p.failureAt;
    let protocol = sql`coalesce(${takeovers.protocol}, '{}'::jsonb)`;
    let touchedProtocol = false;
    if (p.timings && Object.keys(p.timings).length) {
      protocol = sql`jsonb_set(${protocol}, '{timings}', coalesce(${takeovers.protocol} -> 'timings', '{}'::jsonb) || ${json(p.timings)})`;
      touchedProtocol = true;
    }
    if (p.failureAt && p.failureCode) {
      protocol = sql`jsonb_set(${protocol}, '{failures}', coalesce(${takeovers.protocol} -> 'failures', '{}'::jsonb) || ${json({ [p.failureAt.toISOString()]: p.failureCode })})`;
      touchedProtocol = true;
    }
    if (touchedProtocol) set.protocol = protocol;
    let metrics = sql`coalesce(${takeovers.metrics}, '{}'::jsonb)`;
    let touchedMetrics = false;
    if (p.hud && Object.keys(p.hud).length) {
      metrics = sql`jsonb_set(${metrics}, '{hud}', coalesce(${takeovers.metrics} -> 'hud', '{}'::jsonb) || ${json(p.hud)})`;
      touchedMetrics = true;
    }
    if (p.provisionalQa !== undefined) {
      metrics = sql`${metrics} || ${json({ provisionalQa: p.provisionalQa })}`;
      touchedMetrics = true;
    }
    if (touchedMetrics) set.metrics = metrics;
    if (!Object.keys(set).length) return;
    await this.db().update(takeovers).set(set).where(eq(takeovers.id, takeoverId));
  }

  async end(takeoverId: string, p: EndPatch): Promise<{ first: boolean; record: TakeoverRecord | null }> {
    return this.db().transaction(async (tx) => {
      const [t] = await tx.select().from(takeovers).where(eq(takeovers.id, takeoverId)).for("update");
      if (!t) return { first: false, record: null };
      if (t.endedAt) return { first: false, record: recordOf(t) };
      const [u] = await tx
        .update(takeovers)
        .set({
          outcome: p.outcome,
          endedAt: p.endedAt,
          phase: p.phase,
          ...(p.vaSessionId ? { vaSessionId: p.vaSessionId } : {}),
          protocol: sql`coalesce(${takeovers.protocol}, '{}'::jsonb) || ${json({ end: { outcome: p.outcome, reason: p.reason, at: p.endedAt.toISOString() } })}`,
        })
        .where(eq(takeovers.id, takeoverId))
        .returning();
      // The case takes the outcome of its latest takeover (only from armed / ai_active).
      await tx
        .update(cases)
        .set({ status: p.outcome, updatedAt: p.endedAt })
        .where(and(eq(cases.id, t.caseId), inArray(cases.status, [...ENDABLE_CASE_STATUSES])));
      return { first: true, record: u ? recordOf(u) : null };
    });
  }

  async setVerificationJob(takeoverId: string, jobId: string): Promise<void> {
    await this.db()
      .update(takeovers)
      .set({ metrics: sql`coalesce(${takeovers.metrics}, '{}'::jsonb) || ${json({ verificationJobId: jobId })}` })
      .where(eq(takeovers.id, takeoverId));
  }

  async recentLeadTimings(limit: number): Promise<Record<string, number>[]> {
    const rows = await this.db()
      .select({ timings: sql<Record<string, number> | null>`${takeovers.protocol} -> 'timings'` })
      .from(takeovers)
      .where(sql`(${takeovers.protocol} -> 'timings') ?& array['sessionUpdateSent', 'firstAudiblePlayed']`)
      .orderBy(desc(takeovers.armedAt))
      .limit(limit);
    return rows.map((r) => r.timings ?? {});
  }
}

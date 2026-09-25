import "server-only";

import { and, eq, sql } from "drizzle-orm";

import type { CaseStatus, PolicyRecord } from "../../core/contracts/case";
import type { RunPlan } from "../../core/contracts/run";
import type { Db } from "../db/client";
import { cases, takeovers } from "../db/schema";

/**
 * The minimal reads/writes WP2's routes need on the case and takeover tables. WP3 owns the case logic
 * (`CaseRepository`) and WP5 the takeover logic; these are plain row accesses on the shared schema, kept here so
 * the platform routes do not wait on either. `saveRunPlan` equals `CaseRepository.setRunPlan` (a jsonb write).
 */

export interface CaseRow {
  id: string;
  mode: "watch" | "live" | "spot" | "synthetic";
  callId: string | null;
  scenarioId: string;
  status: CaseStatus;
  visitorId: string;
  ipKey: string;
  policy: PolicyRecord;
  runPlan: RunPlan | null;
}

export async function loadCaseRow(db: Db, caseId: string): Promise<CaseRow | null> {
  const [r] = await db
    .select({
      id: cases.id,
      mode: cases.mode,
      callId: cases.callId,
      scenarioId: cases.scenarioId,
      status: cases.status,
      visitorId: cases.visitorId,
      ipKey: cases.ipKey,
      policy: cases.policy,
      runPlan: cases.runPlan,
    })
    .from(cases)
    .where(eq(cases.id, caseId));
  if (!r) return null;
  return { ...r, policy: r.policy as unknown as PolicyRecord, runPlan: (r.runPlan as unknown as RunPlan | null) ?? null };
}

export async function saveRunPlan(db: Db, caseId: string, plan: RunPlan, now = Date.now()): Promise<void> {
  await db
    .update(cases)
    .set({ runPlan: plan as unknown as Record<string, unknown>, updatedAt: new Date(now) })
    .where(eq(cases.id, caseId));
}

export interface TakeoverRow {
  id: string;
  caseId: string;
  armedAt: Date;
  retries: number;
  lastFailureAt: Date | null;
  endedAt: Date | null;
}

/**
 * Lock the takeover row and run `fn` in the same transaction (route #10: check the retry budget and set
 * `retries=1` atomically).
 */
export async function withTakeoverLocked<T>(
  db: Db,
  takeoverId: string,
  fn: (t: TakeoverRow | null, c: { status: CaseStatus; runPlan: RunPlan | null } | null, markRetry: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [t] = await tx
      .select({
        id: takeovers.id,
        caseId: takeovers.caseId,
        armedAt: takeovers.armedAt,
        retries: takeovers.retries,
        lastFailureAt: takeovers.lastFailureAt,
        endedAt: takeovers.endedAt,
      })
      .from(takeovers)
      .where(eq(takeovers.id, takeoverId))
      .for("update");
    let c: { status: CaseStatus; runPlan: RunPlan | null } | null = null;
    if (t) {
      const [cr] = await tx.select({ status: cases.status, runPlan: cases.runPlan }).from(cases).where(eq(cases.id, t.caseId));
      if (cr) c = { status: cr.status, runPlan: (cr.runPlan as unknown as RunPlan | null) ?? null };
    }
    const markRetry = async (): Promise<boolean> => {
      const r = await tx
        .update(takeovers)
        .set({ retries: sql`${takeovers.retries} + 1` })
        .where(and(eq(takeovers.id, takeoverId), eq(takeovers.retries, 0)))
        .returning({ id: takeovers.id });
      return r.length === 1;
    };
    return fn(t ?? null, c, markRetry);
  });
}

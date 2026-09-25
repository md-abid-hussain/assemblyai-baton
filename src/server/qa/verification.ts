/**
 * server/qa/verification.ts - the `verifications` row and the `takeovers.metrics.verification` key (DESIGN §4.2,
 * §4.5 F3). Short statements only: no transaction is held across a network call.
 */
import "server-only";

import { and, desc, eq, ne, sql } from "drizzle-orm";

import type { QaResult } from "../../core/contracts/events";
import type { TakeoverMetricsVerification } from "../../core/contracts/ext/wp8-verify";
import type { Db } from "../db/client";
import { jobs, takeovers, verifications } from "../db/schema";

export type VerificationRow = typeof verifications.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;

/** Create the `pending` row (idempotent). */
export async function ensurePendingVerification(db: Db, takeoverId: string): Promise<void> {
  await db.insert(verifications).values({ takeoverId, status: "pending" }).onConflictDoNothing();
}

export async function setVerificationTranscript(db: Db, takeoverId: string, transcriptId: string): Promise<void> {
  await db.update(verifications).set({ aaiTranscriptId: transcriptId }).where(eq(verifications.takeoverId, takeoverId));
}

export async function loadVerification(db: Db, takeoverId: string): Promise<VerificationRow | null> {
  const [r] = await db.select().from(verifications).where(eq(verifications.takeoverId, takeoverId));
  return r ?? null;
}

/** The newest `verify_takeover` job for a takeover (any status). */
export async function findVerifyJob(db: Db, takeoverId: string): Promise<JobRow | null> {
  const [r] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "verify_takeover"), eq(jobs.refId, takeoverId)))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return r ?? null;
}

async function mergeMetrics(db: Db, takeoverId: string, patch: TakeoverMetricsVerification): Promise<void> {
  await db
    .update(takeovers)
    .set({ metrics: sql`coalesce(${takeovers.metrics}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(takeovers.id, takeoverId));
}

export async function markVerificationCompleted(
  db: Db,
  takeoverId: string,
  qa: QaResult,
  meta: { transcriptId: string | null; audioDurationSec: number | null; now: number },
): Promise<void> {
  await db
    .insert(verifications)
    .values({ takeoverId, status: "completed", qa: qa as never, completedAt: new Date(meta.now), aaiTranscriptId: meta.transcriptId })
    .onConflictDoUpdate({
      target: verifications.takeoverId,
      set: { status: "completed", qa: qa as never, completedAt: new Date(meta.now), aaiTranscriptId: meta.transcriptId },
    });
  await mergeMetrics(db, takeoverId, {
    verification: {
      status: "completed",
      transcriptId: meta.transcriptId,
      audioDurationSec: meta.audioDurationSec,
      reAsked: qa.reAsked,
      disclosuresOk: qa.disclosures.length ? qa.disclosures.every((d) => d.ok) : null,
      reason: null,
      at: new Date(meta.now).toISOString(),
    },
  });
}

/** `failed` with a plain-words reason (never downgrades a `completed` row). Returns whether it changed the row. */
export async function markVerificationFailed(
  db: Db,
  takeoverId: string,
  reason: string,
  meta: { transcriptId?: string | null; now: number },
): Promise<boolean> {
  await ensurePendingVerification(db, takeoverId);
  const changed = await db
    .update(verifications)
    .set({ status: "failed", completedAt: new Date(meta.now) })
    .where(and(eq(verifications.takeoverId, takeoverId), ne(verifications.status, "completed")))
    .returning({ id: verifications.takeoverId });
  if (!changed.length) return false;
  await mergeMetrics(db, takeoverId, {
    verification: {
      status: "failed",
      transcriptId: meta.transcriptId ?? null,
      audioDurationSec: null,
      reAsked: null,
      disclosuresOk: null,
      reason,
      at: new Date(meta.now).toISOString(),
    },
  });
  return true;
}

/** The failure reason recorded in `takeovers.metrics.verification.reason`, if any. */
export async function failureReason(db: Db, takeoverId: string): Promise<string | null> {
  const [r] = await db.select({ metrics: takeovers.metrics }).from(takeovers).where(eq(takeovers.id, takeoverId));
  const v = (r?.metrics as Partial<TakeoverMetricsVerification> | undefined)?.verification;
  return typeof v?.reason === "string" ? v.reason : null;
}

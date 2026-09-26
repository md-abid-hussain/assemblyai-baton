import "server-only";

/**
 * The audit retention purge (SAAS §9, §3.5, §4.1). WP19·3; called by WP12's purge job.
 *
 * ### The trigger contract
 *
 * `0003_audit_guard` refuses every `DELETE` on `audit_log` **unless** the deleting transaction has run
 * `SET LOCAL changeover.audit_purge = 'on'`. `SET LOCAL` dies with the transaction, so the escape hatch cannot
 * leak into the next statement on that pooled connection — which is exactly why it is `SET LOCAL` and not `SET`.
 * This module is the only place in the product that sets it.
 *
 * ### What is deleted
 *
 * A row is kept for its org's plan window (`PLANS[plan].limits.auditRetentionDays`; 7 / 7 / 90 / 365). Rows whose
 * org no longer exists — §3.5 keeps the log for 30 days *after* the org is gone, and `audit_log.org_id` has no
 * foreign key precisely so they survive the delete — are kept for `ORPHAN_RETENTION_DAYS`. Rows with no org at
 * all (`session.signed_in` before an org is picked) follow the same orphan window.
 *
 * The delete is chunked by org so one enormous org cannot hold a transaction (and the purge escape hatch) open
 * for the whole table.
 */
import { and, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { PlanId } from "../../core/contracts/v3/identity";
import { PLANS } from "../../core/contracts/v3/plans";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { auditLog, orgEntitlements } from "../db/schema-saas";
import { log } from "../log";

const purgeLog = log.child({ component: "audit" });

const DAY_MS = 86_400_000;

/** SAAS §3.5: "keeps the audit rows for 30 days" after the org is deleted. */
export const ORPHAN_RETENTION_DAYS = 30;

/** The Postgres setting `0003_audit_guard` looks for. Built once, here, and nowhere else. */
export const AUDIT_PURGE_SETTING = "changeover.audit_purge";

export interface AuditPurgeResult {
  /** Rows deleted, by reason. */
  byPlan: Record<string, number>;
  orphans: number;
  total: number;
}

/**
 * Delete every audit row past its retention window.
 *
 * `now` is injectable so a test can age rows without waiting; `db` so a test can point at its own database.
 */
export async function purgeAuditRetention(
  db: Db = getDb(),
  now: number = Date.now(),
): Promise<AuditPurgeResult> {
  const result: AuditPurgeResult = { byPlan: {}, orphans: 0, total: 0 };

  // One row per (plan) → the org ids on that plan. Reading entitlements is what makes retention per-plan rather
  // than one flat number; an org with no entitlements row is treated as an orphan below.
  const orgs = await db.select({ orgId: orgEntitlements.orgId, plan: orgEntitlements.plan }).from(orgEntitlements);
  const byPlan = new Map<PlanId, string[]>();
  for (const o of orgs) {
    const plan = (o.plan ?? "free") as PlanId;
    const list = byPlan.get(plan);
    if (list) list.push(o.orgId);
    else byPlan.set(plan, [o.orgId]);
  }

  for (const [plan, orgIds] of byPlan) {
    const days = PLANS[plan]?.limits.auditRetentionDays ?? PLANS.free.limits.auditRetentionDays;
    const cutoff = new Date(now - days * DAY_MS);
    for (const chunk of chunks(orgIds, 200)) {
      const deleted = await deleteInPurgeTx(db, (tx) =>
        tx
          .delete(auditLog)
          .where(and(inArray(auditLog.orgId, chunk), lt(auditLog.occurredAt, cutoff)))
          .returning({ id: auditLog.id }),
      );
      result.byPlan[plan] = (result.byPlan[plan] ?? 0) + deleted;
      result.total += deleted;
    }
  }

  // Orphans: no org id, or an org id with no entitlements row (the org was deleted).
  const orphanCutoff = new Date(now - ORPHAN_RETENTION_DAYS * DAY_MS);
  const known = sql`select 1 from ${orgEntitlements} where ${orgEntitlements.orgId} = ${auditLog.orgId}`;
  result.orphans = await deleteInPurgeTx(db, (tx) =>
    tx
      .delete(auditLog)
      .where(
        and(
          lt(auditLog.occurredAt, orphanCutoff),
          or(isNull(auditLog.orgId), sql`not exists (${known})`),
        ),
      )
      .returning({ id: auditLog.id }),
  );
  result.total += result.orphans;

  purgeLog.info("audit retention purge", { ...result.byPlan, orphans: result.orphans, total: result.total });
  return result;
}

/**
 * Run one delete inside a transaction that has opened the `0003` escape hatch. Everything else about the purge —
 * which rows, how many chunks — stays outside, so the hatch is open for the shortest possible time.
 */
async function deleteInPurgeTx(
  db: Db,
  fn: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<{ id: string }[]>,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local ${AUDIT_PURGE_SETTING} = 'on'`));
    return (await fn(tx)).length;
  });
}

function* chunks<T>(xs: readonly T[], n: number): Generator<T[]> {
  for (let i = 0; i < xs.length; i += n) yield xs.slice(i, i + n);
}

/**
 * The purge step WP12's `registerPurgeStep` mounts. Kept separate from `purgeAuditRetention` so the job wiring
 * and the logic can be tested apart — and so WP12 registers a function with the `PurgeStep` shape, not ours.
 */
export const auditRetentionStep = async (ctx: { db: Db; now: number }): Promise<Record<string, number>> => {
  const r = await purgeAuditRetention(ctx.db, ctx.now);
  return { audit: r.total, auditOrphans: r.orphans };
};

/** How long this plan keeps audit rows. The Audit page shows it beside an empty page, so it is exported. */
export const retentionDaysFor = (plan: PlanId): number =>
  PLANS[plan]?.limits.auditRetentionDays ?? PLANS.free.limits.auditRetentionDays;

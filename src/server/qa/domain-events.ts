import "server-only";

/**
 * server/qa/domain-events.ts - `case.verified` (SAAS §7.1, §12 WP18 row; WP18·1).
 *
 * The async verification job is the only place that knows a run's QA is **non-provisional**, so it is where the
 * `case.verified` domain event is emitted. SAAS §7.1 is explicit that events go out **only when `cases.org_id` is
 * set** ("events are not back-filled"), and that column arrives with WP19's `0002_saas` — TASKS-v3 §2 rule 14 forbids
 * any other WP from adding a migration. So this module feature-detects the column: before 0002 every call is a
 * cheap no-op, and the moment the column exists and carries an org the event flows, with no wiring change.
 *
 * The payload is **thin** (SAAS §7.1): ids, counts and booleans. No field values, no transcript text, no audio URLs.
 * Emission is idempotent on `case.verified:<takeoverId>`, so a retried verification never doubles a delivery.
 */
import { eq, sql } from "drizzle-orm";

import { CaseVerifiedData } from "../../core/contracts/v3/events";
import type { QaResult } from "../../core/contracts/events";
import type { CaseState } from "../../core/contracts/case";
import { cases, relayVersions, takeovers } from "../db/schema";
import type { Db } from "../db/client";
import { log } from "../log";
import { getDomainEvents } from "../saas/ports";

const evLog = log.child({ component: "qa-events" });

type ColumnCache = { db: Db; has: Promise<boolean> } | null;
const g = globalThis as typeof globalThis & { __changeoverCaseOrgColumn?: ColumnCache };

/** Does `cases.org_id` exist yet (WP19's `0002_saas`)? Cached per process, per db handle. */
export function hasCaseOrgColumn(db: Db): Promise<boolean> {
  const cached = g.__changeoverCaseOrgColumn;
  if (cached && cached.db === db) return cached.has;
  const has = (async () => {
    try {
      const r = await db.execute(sql`
        select 1 as ok from information_schema.columns
        where table_schema = 'public' and table_name = 'cases' and column_name = 'org_id'`);
      return r.rows.length > 0;
    } catch (err) {
      evLog.warn("could not check cases.org_id (treated as absent)", { err });
      return false;
    }
  })();
  g.__changeoverCaseOrgColumn = { db, has };
  return has;
}

export function resetCaseOrgColumnCache(): void {
  g.__changeoverCaseOrgColumn = null;
}

/** The org a run is billed to, or null while the SaaS columns are not there yet (SAAS §2.6). */
export async function orgOfCase(db: Db, caseId: string): Promise<string | null> {
  if (!(await hasCaseOrgColumn(db))) return null;
  try {
    const r = await db.execute(sql`select org_id from cases where id = ${caseId}`);
    const org = (r.rows[0] as { org_id?: string | null } | undefined)?.org_id;
    return typeof org === "string" && org ? org : null;
  } catch (err) {
    evLog.warn("could not read cases.org_id", { caseId, err });
    return null;
  }
}

/** Absolute links for the event payload (SAAS §7.1). Relative when `APP_URL` is unset (local, tests). */
export function runLinks(appUrl: string | null, takeoverId: string): { run: string; api: string } {
  const base = (appUrl ?? "").replace(/\/+$/, "");
  return { run: `${base}/app/runs/${takeoverId}`, api: `${base}/api/v1/runs/${takeoverId}` };
}

export interface CaseVerifiedInput {
  takeoverId: string;
  qa: QaResult;
  appUrl: string | null;
}

/**
 * Emit `case.verified` for a finished, non-provisional verification. Returns false (and emits nothing) when the run
 * has no org yet, when the QA is still provisional, or when the outbox refuses — it never throws into the job.
 */
export async function emitCaseVerified(db: Db, i: CaseVerifiedInput): Promise<boolean> {
  if (i.qa.provisional) return false;
  try {
    const [row] = await db
      .select({ caseId: takeovers.caseId, snapshot: takeovers.snapshot, state: cases.state, relayVersionId: cases.relayVersionId })
      .from(takeovers)
      .innerJoin(cases, eq(cases.id, takeovers.caseId))
      .where(eq(takeovers.id, i.takeoverId));
    if (!row) return false;
    const orgId = await orgOfCase(db, row.caseId);
    if (!orgId) return false;

    let relayId: string | null = null;
    if (row.relayVersionId) {
      const [v] = await db.select({ relayId: relayVersions.relayId }).from(relayVersions).where(eq(relayVersions.id, row.relayVersionId));
      relayId = v?.relayId ?? null;
    }
    const snap = (row.snapshot ?? row.state) as unknown as CaseState | null;
    const data = CaseVerifiedData.parse({
      run_id: i.takeoverId,
      relay_id: relayId,
      qa: {
        re_asked: i.qa.reAsked,
        disclosures: i.qa.disclosures.map((d) => ({ id: d.kind, similarity: d.similarity, ok: d.ok })),
        verified_from_recording: true,
        provisional: false,
      },
      fields_at_pass: {
        verified: snap?.readiness?.verified ?? 0,
        required: snap?.readiness?.requiredTotal ?? 0,
      },
      links: runLinks(i.appUrl, i.takeoverId),
    });
    const r = await getDomainEvents().emit({ orgId, type: "case.verified", data, dedupeKey: `case.verified:${i.takeoverId}` });
    if (r.created) evLog.info("case.verified emitted", { takeoverId: i.takeoverId, eventId: r.eventId });
    return r.created;
  } catch (err) {
    evLog.warn("case.verified was not emitted", { takeoverId: i.takeoverId, err });
    return false;
  }
}

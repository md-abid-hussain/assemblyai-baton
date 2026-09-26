import "server-only";

/**
 * server/publish/org.ts - the org hooks of publish (SAAS §2.4, §4.1, §12 WP18 row; TASKS-v3 §7 WP18·1).
 *
 * **`workspace_id` ≡ `organization.id`** (SAAS S1), so a publication's org is its relay's `workspace_id` and nothing
 * here has to re-derive it. SAAS §2.4 also adds a denormalized `relay_publications.org_id` for plan counts, in WP19's
 * migration `0002_saas` — and TASKS-v3 §2 rule 14 says no other WP adds a migration. So this module:
 *
 *  - **writes** `org_id` when the column exists (a no-op before 0002, filled in by WP19's back-fill afterwards), and
 *  - **counts** live publications through the `relays` join, which is correct both before and after 0002.
 *
 * The plan's limits come from the v3 ports (`getEntitlements`, `getUsageMeter`, `getAuditWriter`), so the guest plan's
 * 1 live publication / 24 h idle applies the moment WP19·2 registers the real resolvers, with no change here.
 */
import { sql } from "drizzle-orm";

import type { PlanLimits } from "../../core/contracts/v3/plans";
import type { Db } from "../db/client";
import { log } from "../log";

const orgLog = log.child({ component: "publish-org" });

type ColumnCheck = { db: Db; has: Promise<boolean> } | null;
const g = globalThis as typeof globalThis & { __changeoverPubOrgColumn?: ColumnCheck };

/** Does `relay_publications.org_id` exist yet (WP19's `0002_saas`)? Cached per process, per db handle. */
export function hasPublicationOrgColumn(db: Db): Promise<boolean> {
  const cached = g.__changeoverPubOrgColumn;
  if (cached && cached.db === db) return cached.has;
  const has = (async () => {
    try {
      const r = await db.execute(sql`
        select 1 as ok from information_schema.columns
        where table_schema = 'public' and table_name = 'relay_publications' and column_name = 'org_id'`);
      return r.rows.length > 0;
    } catch (err) {
      orgLog.warn("could not check relay_publications.org_id (treated as absent)", { err });
      return false;
    }
  })();
  g.__changeoverPubOrgColumn = { db, has };
  return has;
}

/** Tests and the migration test re-check after a DDL change. */
export function resetPublicationOrgColumnCache(): void {
  g.__changeoverPubOrgColumn = null;
}

/** Denormalize the org onto the publication row once WP19's column exists; a no-op (and never an error) before that. */
export async function writePublicationOrg(db: Db, publicationId: string, orgId: string): Promise<boolean> {
  if (!(await hasPublicationOrgColumn(db))) return false;
  try {
    await db.execute(sql`update relay_publications set org_id = ${orgId} where id = ${publicationId}`);
    return true;
  } catch (err) {
    orgLog.warn("could not write relay_publications.org_id", { publicationId, err });
    return false;
  }
}

/**
 * How long an idle publication of this plan survives (SAAS §4.1: guest 24 h, free 72 h, pro/business never).
 * `null` = no idle expiry. PLATFORM §8.4's flat 72 h is the Free number, which is what a pre-C3b deployment gets.
 */
export const idleHoursFor = (limits: Pick<PlanLimits, "publicationIdleHours">): number | null => limits.publicationIdleHours;
